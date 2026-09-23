import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { auditLogPath } from "../src/audit.ts";
import { buildCallTool, buildToolCatalog } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import type { McpContent } from "../src/server.ts";

interface FakeTool {
	name: string;
	description: string;
	parameters: unknown;
}

function makePi(names: string[]): ExtensionAPI {
	const tools: FakeTool[] = names.map(name => ({
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" } } },
	}));
	return { getAllTools: () => tools } as unknown as ExtensionAPI;
}

// Rejection paths return before touching session/UI state; the Main-session
// lookup is exercised for its absent-session branch only (the real execution
// path needs a live host and is covered by test/smoke.ts).
const extCtx = {} as ExtensionContext;

const cfg: BridgeConfig = {
	port: 0,
	token: "t",
	host: "127.0.0.1",
	deny: ["hidden_tool"],
	denyMCPTools: true,
};

const savedEnv = { ...process.env };

afterAll(() => {
	if (savedEnv.A2A_BRIDGE_AUDIT === undefined) delete process.env.A2A_BRIDGE_AUDIT;
	else process.env.A2A_BRIDGE_AUDIT = savedEnv.A2A_BRIDGE_AUDIT;
});

/** auditCall is fire-and-forget; poll until the async flush lands. */
async function readLines(file: string, min: number): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + 2000;
	let lines: Array<Record<string, unknown>> = [];
	while (Date.now() < deadline) {
		try {
			lines = (await readFile(file, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(l => JSON.parse(l) as Record<string, unknown>);
			if (lines.length >= min) return lines;
		} catch {
			// not flushed yet
		}
		await Bun.sleep(10);
	}
	return lines;
}

async function callText(
	call: (n: string, a: unknown) => Promise<{ content: McpContent[]; isError: boolean }>,
	name: string,
) {
	const r = await call(name, {});
	return { isError: r.isError, text: r.content.map(c => (c.type === "text" ? c.text : "")).join("\n") };
}

describe("buildToolCatalog", () => {
	test("exposes everything except denied and mcp__ tools", async () => {
		const pi = makePi(["read", "hidden_tool", "mcp__srv__tool"]);
		const catalog = await buildToolCatalog(pi, cfg)();
		expect(catalog.map(t => t.name)).toEqual(["read"]);
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object" });
	});

	test("denyMCPTools off keeps mcp tools", async () => {
		const pi = makePi(["mcp__srv__tool"]);
		const catalog = await buildToolCatalog(pi, { ...cfg, denyMCPTools: false })();
		expect(catalog.map(t => t.name)).toEqual(["mcp__srv__tool"]);
	});
});

describe("buildCallTool exposure gate", () => {
	test("denied tool -> not exposed", async () => {
		const call = buildCallTool(makePi(["read", "hidden_tool"]), extCtx, cfg);
		const r = await callText(call, "hidden_tool");
		expect(r.isError).toBe(true);
		expect(r.text).toContain("not exposed");
	});

	test("name outside the advertised catalog -> not exposed (alias/hidden-name probe)", async () => {
		const call = buildCallTool(makePi(["read"]), extCtx, cfg);
		for (const name of ["xd://read", "guessed_tool", "mcp__srv__tool"]) {
			const r = await callText(call, name);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("not exposed");
		}
	});

	test("advertised tool with no Main session -> clear error, not a throw", async () => {
		const call = buildCallTool(makePi(["read"]), extCtx, cfg);
		const r = await callText(call, "read");
		expect(r.isError).toBe(true);
		expect(r.text).toBe("main session not available");
	});
});

describe("audit log", () => {
	test("records tool, outcome, and args as JSONL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "a2a-audit-"));
		process.env.A2A_BRIDGE_AUDIT = join(dir, "audit.log");
		try {
			const call = buildCallTool(makePi(["read"]), extCtx, cfg);
			await call("read", { path: "/etc/hostname" });
			await call("guessed_tool", {});

			const lines = await readLines(auditLogPath(), 2);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatchObject({ tool: "read", isError: true });
			expect(String(lines[0]?.args)).toContain("/etc/hostname");
			expect(lines[1]).toMatchObject({ tool: "guessed_tool", isError: true });
			expect(typeof lines[0]?.ts).toBe("string");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
