import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { auditLogPath } from "../src/audit.ts";
import { buildCallTool, buildToolCatalog } from "../src/bridge.ts";
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
	test("passes the host registry through verbatim — nothing filtered", async () => {
		// Including hidden tools, mcp__ names, and anything else the host
		// registered: the bridge holds no opinion on what a caller may see.
		const names = ["read", "hidden_tool", "mcp__srv__tool", "bash"];
		const catalog = await buildToolCatalog(makePi(names))();
		expect(catalog.map((t) => t.name)).toEqual(names);
		expect(catalog[0]?.inputSchema).toMatchObject({ type: "object" });
	});

	test("re-reads the registry on every call so dynamic tools appear", async () => {
		let names = ["read"];
		const pi = { getAllTools: () => names.map((n) => ({ name: n, description: "", parameters: {} })) };
		const catalog = buildToolCatalog(pi as unknown as ExtensionAPI);
		expect((await catalog()).map((t) => t.name)).toEqual(["read"]);
		names = ["read", "added_later"];
		expect((await catalog()).map((t) => t.name)).toEqual(["read", "added_later"]);
	});

	test("a registry entry with no schema still lists, as an empty object", async () => {
		// The host's converter throws on a non-object `parameters` (it caches by
		// WeakMap key), and custom tools can register without one. Falling over here
		// would take the whole catalog down for every client, so the entry degrades to
		// `{type: "object"}` instead.
		const pi = { getAllTools: () => [{ name: "no_schema", description: "", parameters: undefined }] };
		const catalog = await buildToolCatalog(pi as unknown as ExtensionAPI)();
		expect(catalog).toEqual([{ name: "no_schema", description: "", inputSchema: { type: "object" } }]);
	});
});

describe("buildCallTool exposure gate", () => {
	test("name outside the advertised registry -> not exposed (alias/hidden-name probe)", async () => {
		const call = buildCallTool(makePi(["read"]), extCtx);
		for (const name of ["xd://read", "guessed_tool", "mcp__srv__tool"]) {
			const r = await callText(call, name);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("not exposed");
		}
	});

	test("registered tool with no Main session -> clear error, not a throw", async () => {
		const call = buildCallTool(makePi(["read"]), extCtx);
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
		const call = buildCallTool(makePi(["read"]), extCtx);
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
		const call = buildCallTool(makePi(["read"]), extCtx);
		await call("guessed_tool", {});

		const start = await untilRecord((l) => l.phase === "start" && l.tool === "guessed_tool");
		expect(start).toBeDefined();
		expect(typeof start?.id).toBe("string");

		const done = await untilRecord((l) => l.phase === "done" && l.tool === "guessed_tool");
		expect(done).toBeDefined();
		expect(done).toMatchObject({ isError: true });
		expect(done?.id).toBe(start?.id);
	});

	test("oversized string args are redacted to length+hash in the audit line", async () => {
		const payload = "A".repeat(5000);
		const call = buildCallTool(makePi(["read"]), extCtx);
		await call("read", { bytes: payload }, "sess-redact");
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

	/**
	 * The shape that broke the redactor. It stopped at two levels on the reasoning
	 * that nothing nests deeper, and the host's own `edit` tool nests three:
	 * `{path, edits: [{oldText, newText}]}`. So a file body went into the log
	 * verbatim, up to the 1 KB args cap.
	 *
	 * Asserted against the whole log line, and against a *window* of the payload
	 * rather than the payload itself: the args field is truncated at 1024 chars, so
	 * `not.toContain(fullPayload)` was true even while the leak was open. That is
	 * why the test above, written for the shallow case, stayed green.
	 */
	test("nested args are redacted at every depth, not just the top two", async () => {
		const payload = "B".repeat(4000);
		const window = payload.slice(0, 60);
		const shapes: Array<[string, Record<string, unknown>]> = [
			["sess-edit", { path: "/etc/hostname", edits: [{ oldText: payload, newText: "x" }] }],
			["sess-deep", { meta: { inner: { body: payload } } }],
			["sess-list", { files: [{ content: payload }] }],
		];
		const call = buildCallTool(makePi(["read"]), extCtx);
		for (const [sid, args] of shapes) await call("read", args, sid);

		for (const [sid] of shapes) {
			const rec = await untilRecord((l) => l.sid === sid && l.phase === "start");
			expect(rec, `no audit record for ${sid}`).toBeDefined();
			expect(String(rec?.args)).toContain("<len:4000");
			const line = JSON.stringify(rec);
			expect(line.includes(window)).toBe(false);
			expect(line.includes("B".repeat(120))).toBe(false);
		}
	});

	test("one call cannot own the log: args are bounded at 1 KB", async () => {
		// Redaction folds long *values*, but a call with many ordinary-length values is
		// still a wall of text. The cap is what keeps a record near-fixed size, which in
		// turn is what makes the 512 KB rotation window mean something.
		const args = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, "y".repeat(110)]));
		const call = buildCallTool(makePi(["read"]), extCtx);
		await call("read", args, "sess-cap");
		const rec = await untilRecord((l) => l.sid === "sess-cap" && l.phase === "start");
		expect(rec, "no audit record for the wide args").toBeDefined();
		const s = String(rec?.args);
		expect(s.endsWith("…")).toBe(true);
		expect(s.length).toBeLessThanOrEqual(1025);
		// Not a coincidence of the redactor: every value is under the 120-char leaf cap.
		expect(s).toContain("y".repeat(110));
	});

	test("a pathological nesting is omitted instead of described", async () => {
		let args: Record<string, unknown> = { leaf: "C".repeat(4000) };
		for (let i = 0; i < 40; i++) args = { nested: args };
		const call = buildCallTool(makePi(["read"]), extCtx);
		await call("read", args, "sess-depth");

		const rec = await untilRecord((l) => l.sid === "sess-depth" && l.phase === "start");
		expect(String(rec?.args)).toContain("<max-depth>");
		expect(JSON.stringify(rec).includes("C".repeat(60))).toBe(false);
	});
});
