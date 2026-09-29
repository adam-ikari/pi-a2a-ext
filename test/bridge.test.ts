import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { auditLogPath } from "../src/audit.ts";
import { buildCallTool, buildToolCatalog } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import type { BridgeTool } from "../src/filetools.ts";
import type { McpContent } from "../src/server.ts";

interface FakeTool {
	name: string;
	description: string;
	parameters: unknown;
}

function makePi(names: string[]): ExtensionAPI {
	const tools: FakeTool[] = names.map((name) => ({
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
	fileRoot: "/tmp/a2a-bridge-test-files",
	maxFileBytes: 1024 * 1024,
};

// Sandbox the audit log for the WHOLE file, not just the audit test: every
// buildCallTool path (including the exposure-gate rejections) appends, and
// without this the fire-and-forget writes would land in the real
// ~/.omp/agent/a2a-bridge.log of whoever runs the tests.
const savedEnv = { ...process.env };
let auditDir: string;

beforeAll(async () => {
	auditDir = await mkdtemp(join(tmpdir(), "a2a-audit-"));
	process.env.A2A_BRIDGE_AUDIT = join(auditDir, "audit.log");
});

afterAll(async () => {
	if (savedEnv.A2A_BRIDGE_AUDIT === undefined) delete process.env.A2A_BRIDGE_AUDIT;
	else process.env.A2A_BRIDGE_AUDIT = savedEnv.A2A_BRIDGE_AUDIT;
	await rm(auditDir, { recursive: true, force: true });
});

/** auditStart/auditDone are fire-and-forget; poll until the async flush lands. */
async function readLines(file: string): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + 3000;
	let lines: Array<Record<string, unknown>> = [];
	while (Date.now() < deadline) {
		try {
			lines = (await readFile(file, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			if (lines.length > 0) return lines;
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
	return { isError: r.isError, text: r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") };
}

describe("buildToolCatalog", () => {
	test("exposes everything except denied and mcp__ tools", async () => {
		const pi = makePi(["read", "hidden_tool", "mcp__srv__tool"]);
		const catalog = await buildToolCatalog(pi, cfg)();
		expect(catalog.map((t) => t.name)).toEqual(["read"]);
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object" });
	});

	test("denyMCPTools off keeps mcp tools", async () => {
		const pi = makePi(["mcp__srv__tool"]);
		const catalog = await buildToolCatalog(pi, { ...cfg, denyMCPTools: false })();
		expect(catalog.map((t) => t.name)).toEqual(["mcp__srv__tool"]);
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
	/** Poll the log until some record matches; undefined at deadline. */
	async function untilRecord(
		pred: (l: Record<string, unknown>) => boolean,
	): Promise<Record<string, unknown> | undefined> {
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			const hit = (await readLines(auditLogPath())).find(pred);
			if (hit) return hit;
			await Bun.sleep(10);
		}
		return undefined;
	}

	test("phase:start at dispatch + phase:done on completion, paired by id", async () => {
		const call = buildCallTool(makePi(["read"]), extCtx, cfg);
		await call("read", { path: "/etc/hostname" }, "sess-1");

		// Match by content, not position: earlier tests append to this same
		// file, and flush order across fire-and-forget writes is not a contract.
		const start = await untilRecord((l) => l.phase === "start" && String(l.args ?? "").includes("/etc/hostname"));
		expect(start).toBeDefined();
		expect(start).toMatchObject({ tool: "read", sid: "sess-1" });
		expect(typeof start?.id).toBe("string");
		expect(typeof start?.ts).toBe("string");

		const done = await untilRecord((l) => l.phase === "done" && l.id === start?.id);
		expect(done).toBeDefined();
		expect(done).toMatchObject({ tool: "read", isError: true, sid: "sess-1" });
		expect(String(done?.args ?? "")).toContain("/etc/hostname");
		// dispatch precedes completion (ts captured synchronously at each call)
		expect(String(done?.ts) >= String(start?.ts)).toBe(true);
	});

	test("rejected calls are audited with both phases", async () => {
		const call = buildCallTool(makePi(["read"]), extCtx, cfg);
		await call("guessed_tool", {});

		const start = await untilRecord((l) => l.phase === "start" && l.tool === "guessed_tool");
		expect(start).toBeDefined();
		expect(typeof start?.id).toBe("string");

		const done = await untilRecord((l) => l.phase === "done" && l.tool === "guessed_tool");
		expect(done).toBeDefined();
		expect(done).toMatchObject({ isError: true });
		expect(done?.id).toBe(start?.id);
	});
});

function fakeBridgeTool(name: string): BridgeTool {
	return {
		name,
		description: `${name} bridge tool`,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }], isError: false };
		},
	};
}

describe("bridge-owned tools", () => {
	test("advertised after the host catalog when no host tool claims the name", async () => {
		const catalog = await buildToolCatalog(makePi(["read"]), cfg, [fakeBridgeTool("a2a_file_put")])();
		expect(catalog.map((t) => t.name)).toEqual(["read", "a2a_file_put"]);
	});

	test("a host tool with the same name wins: the bridge tool is neither listed nor callable", async () => {
		const pi = makePi(["a2a_file_put"]);
		const tools = [fakeBridgeTool("a2a_file_put")];
		const catalog = await buildToolCatalog(pi, cfg, tools)();
		expect(catalog.map((t) => t.name)).toEqual(["a2a_file_put"]);
		// The single entry is the host tool (host schema, not the bridge's).
		expect(catalog[0]?.description).toBe("a2a_file_put tool");
		// Calling it goes down the host path -> absent Main session, not the bridge handler.
		const call = buildCallTool(pi, extCtx, cfg, tools);
		const r = await callText(call, "a2a_file_put");
		expect(r.text).toBe("main session not available");
	});

	test("deny hides bridge tools too", async () => {
		const tools = [fakeBridgeTool("a2a_file_put")];
		const catalog = await buildToolCatalog(makePi([]), { ...cfg, deny: ["a2a_file_put"] }, tools)();
		expect(catalog).toEqual([]);
		const call = buildCallTool(makePi([]), extCtx, { ...cfg, deny: ["a2a_file_put"] }, tools);
		const r = await call("a2a_file_put", {}, "s");
		expect(r.isError).toBe(true);
		expect(r.content[0]).toMatchObject({ text: "tool 'a2a_file_put' is not exposed by this bridge" });
	});

	test("oversized string args are redacted to length+hash in the audit line", async () => {
		const payload = "A".repeat(5000);
		const call = buildCallTool(makePi(["read"]), extCtx, cfg, [fakeBridgeTool("a2a_echo")]);
		await call("a2a_echo", { bytes: payload }, "sess-redact");
		const deadline = Date.now() + 3000;
		let hit: Record<string, unknown> | undefined;
		while (Date.now() < deadline && !hit) {
			hit = (await readLines(auditLogPath())).find(
				(l) => l.sid === "sess-redact" && l.phase === "start" && String(l.args).includes("<len:5000"),
			);
			if (!hit) await Bun.sleep(10);
		}
		expect(hit).toBeDefined();
		expect(String(hit?.args)).not.toContain(payload);
	});
});
