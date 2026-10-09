/**
 * The other half of `buildCallTool`: handing a call to a live Main session.
 *
 * `AgentRegistry.register` takes any object as `session`, and
 * `resetGlobalForTests` exists for exactly this, so the path is reachable without
 * spawning a host. Until now it had no deterministic check at all: `test/smoke.ts`
 * drives these lines against a real host, but the tools a probe can call there
 * return text — so the image branch, the context wiring and the event pairing were
 * only ever covered by whatever the probe happened to print.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import { auditLogPath } from "../src/audit.ts";
import { buildCallTool } from "../src/bridge.ts";

const savedEnv = { ...process.env };
let auditDir: string;

beforeAll(async () => {
	auditDir = await mkdtemp(join(tmpdir(), "a2a-hostcall-"));
	process.env.A2A_BRIDGE_AUDIT = join(auditDir, "audit.log");
});

afterAll(async () => {
	if (savedEnv.A2A_BRIDGE_AUDIT === undefined) delete process.env.A2A_BRIDGE_AUDIT;
	else process.env.A2A_BRIDGE_AUDIT = savedEnv.A2A_BRIDGE_AUDIT;
	await rm(auditDir, { recursive: true, force: true });
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

/** Poll the fire-and-forget audit log until some record matches. */
async function untilRecord(pred: (l: Record<string, unknown>) => boolean) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		try {
			const lines = (await readFile(auditLogPath(), "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const hit = lines.find(pred);
			if (hit) return hit;
		} catch {
			// not flushed yet
		}
		await Bun.sleep(10);
	}
	return undefined;
}

type Recorded = { toolCallId: string; args: unknown; signal: unknown; onUpdate: unknown; ctx: Record<string, unknown> };

interface Harness {
	session: Record<string, unknown>;
	/** What the host tool was called with, in call order. */
	seen: Recorded[];
	/** What the bridge emitted into the host's event bus. */
	events: Array<Record<string, unknown>>;
	controls: Record<string, unknown>;
	call: (name: string, args: unknown, sid?: string | null) => Promise<{ content: unknown[]; isError: boolean }>;
}

function mount(opts: {
	toolName?: string;
	/** Extra names advertised by the catalog but absent from the session. */
	catalogOnly?: string[];
	result?: { content: unknown[]; isError?: boolean };
	throws?: Error;
	/** Thrown from the host's event sink, to model a host that cannot take the event. */
	emitThrows?: Error;
}): Harness {
	const name = opts.toolName ?? "read";
	const seen: Recorded[] = [];
	const events: Array<Record<string, unknown>> = [];
	const session = {
		sessionManager: { which: "sessionManager" },
		modelRegistry: { which: "modelRegistry" },
		model: { which: "model" },
		settings: { which: "settings" },
		getToolByName(tool: string) {
			if (tool !== name) return undefined;
			return {
				name,
				execute: async (
					toolCallId: string,
					args: unknown,
					signal?: unknown,
					onUpdate?: unknown,
					ctx?: Record<string, unknown>,
				) => {
					seen.push({ toolCallId, args, signal, onUpdate, ctx: ctx ?? {} });
					if (opts.throws) throw opts.throws;
					return opts.result ?? { content: [{ type: "text", text: "ok from host" }] };
				},
			};
		},
		agent: {
			emitExternalEvent: (e: Record<string, unknown>) => {
				if (opts.emitThrows) throw opts.emitThrows;
				events.push(e);
			},
		},
	};
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: "fake-main",
		kind: "main",
		session: session as never,
	});

	const abort = () => "aborted";
	const isIdle = () => true;
	const hasPendingMessages = () => false;
	const ui = { which: "ui" };
	const localProtocolOptions = { which: "localProtocolOptions" };
	const controls = { abort, isIdle, hasPendingMessages, ui, localProtocolOptions };
	const extCtx = { hasUI: true, ...controls } as unknown as ExtensionContext;
	const pi = {
		getAllTools: () =>
			[name, ...(opts.catalogOnly ?? [])].map((n) => ({
				name: n,
				description: `${n} tool`,
				parameters: { type: "object" },
			})),
	};
	return { session, seen, events, controls, call: buildCallTool(pi as unknown as ExtensionAPI, extCtx) };
}

describe("buildCallTool host hand-off", () => {
	test("a text result passes through with the host's own isError", async () => {
		const h = mount({});
		const r = await h.call("read", { path: "/etc/hostname" });
		expect(r).toEqual({ content: [{ type: "text", text: "ok from host" }], isError: false });
	});

	test("an image block keeps its type, data and mimeType", async () => {
		// Reachable for real: the host's `read` returns image blocks for image files,
		// and browser/image tools do too. Folding it into a text block would hand the
		// caller a base64 blob as prose.
		const h = mount({
			result: { content: [{ type: "image", data: "iVBORw0KGg", mimeType: "image/png", detail: "high" }] },
		});
		const r = await h.call("read", { path: "logo.png" });
		// toEqual, not toMatchObject: `detail` is a host-side OpenAI hint with no
		// place in MCP's image content, and must not ride along.
		expect(r.content).toEqual([{ type: "image", data: "iVBORw0KGg", mimeType: "image/png" }]);
		expect(r.isError).toBe(false);
	});

	test("a block that is neither text nor image becomes JSON text", async () => {
		// The host's tool-result type is text | image, so anything else is a custom
		// tool ignoring it. Flattening is the deliberate answer: an MCP client that
		// gets a content type it does not know is a broken client, not a warning.
		const h = mount({
			result: { content: [{ type: "thing", foo: 1 }, null] },
		});
		const r = await h.call("read", {});
		expect(r.content).toEqual([
			{ type: "text", text: '{"type":"thing","foo":1}' },
			{ type: "text", text: "null" },
		]);
	});

	test("the host's error flag reaches the caller and the audit record", async () => {
		const h = mount({ result: { content: [{ type: "text", text: "no such file" }], isError: true } });
		const r = await h.call("read", { path: "/gone" }, "sess-host-err");
		expect(r.isError).toBe(true);
		const done = await untilRecord((l) => l.sid === "sess-host-err" && l.phase === "done");
		expect(done).toMatchObject({ tool: "read", isError: true });
	});

	test("a successful call is audited as successful", async () => {
		// Every audit record the unit suite had produced so far came from a rejected
		// call, so `isError: false` — the common case in production — was untested.
		const h = mount({});
		await h.call("read", { path: "/etc/hostname" }, "sess-host-ok");
		const start = await untilRecord((l) => l.sid === "sess-host-ok" && l.phase === "start");
		const done = await untilRecord((l) => l.sid === "sess-host-ok" && l.phase === "done");
		expect(start).toMatchObject({ tool: "read" });
		expect(done).toMatchObject({ isError: false, id: start?.id });
	});

	test("args reach the host tool unchanged, and nothing is validated on the way", async () => {
		const args = { path: "/tmp/x", edits: [{ oldText: "a" }] };
		const h = mount({});
		await h.call("read", args);
		expect(h.seen.length).toBe(1);
		// Identity, not equality: the bridge does not copy, filter or schema-check.
		expect(h.seen[0]?.args).toBe(args);
	});

	test("the tool context is the session's state plus the extension's controls", async () => {
		const h = mount({});
		await h.call("read", {});
		const ctx = h.seen[0]?.ctx ?? {};
		expect(ctx.sessionManager).toBe(h.session.sessionManager);
		expect(ctx.modelRegistry).toBe(h.session.modelRegistry);
		expect(ctx.model).toBe(h.session.model);
		expect(ctx.settings).toBe(h.session.settings);
		expect(ctx.ui).toBe(h.controls.ui);
		expect(ctx.hasUI).toBe(true);
		expect(ctx.localProtocolOptions).toBe(h.controls.localProtocolOptions);
		expect(ctx.isIdle).toBe(h.controls.isIdle);
		expect(ctx.abort).toBe(h.controls.abort);
		// The rename is the part a refactor silently drops: the extension calls it
		// `hasPendingMessages`, the tool context field is `hasQueuedMessages`.
		expect(ctx.hasQueuedMessages).toBe(h.controls.hasPendingMessages);
		expect((ctx.hasQueuedMessages as () => boolean)()).toBe(false);
	});

	test("no abort signal and no update callback are handed to the tool", async () => {
		// Deliberate v1 boundary (README「v1 边界」, docs/superpowers/specs): the bridge
		// has no cancellation channel of its own. Recorded here so a change to it is a
		// decision someone made on purpose, not a dropped argument.
		const h = mount({});
		await h.call("read", {});
		expect(h.seen[0]?.signal).toBeUndefined();
		expect(h.seen[0]?.onUpdate).toBeUndefined();
	});

	test("one start and one end event per call, paired by the id the tool was called with", async () => {
		const h = mount({});
		await h.call("read", { path: "/etc/hostname" });
		const [start, end] = h.events;
		expect(h.events.length).toBe(2);
		expect(start).toMatchObject({ type: "tool_execution_start", toolName: "read", args: { path: "/etc/hostname" } });
		expect(end).toMatchObject({ type: "tool_execution_end", toolName: "read", isError: false });
		expect(end?.result).toEqual({ content: [{ type: "text", text: "ok from host" }] });
		expect(start?.toolCallId).toBe(h.seen[0]?.toolCallId);
		expect(end?.toolCallId).toBe(start?.toolCallId);
		// A fresh uuid, not something the caller controls: the host renders one card
		// per id, so a reused id would merge two remote calls into one card.
		expect(String(start?.toolCallId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test("a tool that throws closes the event pair and reports its own message", async () => {
		const h = mount({ throws: new Error("device not present") });
		const r = await h.call("read", {});
		expect(r).toEqual({ content: [{ type: "text", text: "device not present" }], isError: true });
		expect(h.events.length).toBe(2);
		const end = h.events[1];
		expect(end).toMatchObject({
			type: "tool_execution_end",
			isError: true,
			result: { content: [{ type: "text", text: "device not present" }], isError: true },
		});
	});

	test("advertised by the catalog but absent from the session -> unknown tool", async () => {
		// `tools/list` reads the extension's registry; execution resolves through the
		// session. The two can disagree (a tool disabled for the host's own model),
		// and the caller then gets this message — not "not exposed", not a throw.
		const h = mount({ catalogOnly: ["disabled_for_me"] });
		const r = await h.call("disabled_for_me", {});
		expect(r).toEqual({ content: [{ type: "text", text: "unknown tool 'disabled_for_me'" }], isError: true });
		expect(h.seen.length).toBe(0);
	});
});

describe("buildCallTool when the host cannot take the render event", () => {
	// The bridge's own comment says these events "drive rendering only". They are
	// emitted inside the try that decides the call's outcome, so a host that
	// rejects them (a session shape from another version, an emit that throws)
	// stops a call that was about to run, turns a call that DID run into a
	// reported failure, or replaces the tool's real error with the emit's own.
	test("the call still runs when the start event is refused", async () => {
		const h = mount({ emitThrows: new TypeError("session.agent.emitExternalEvent is not a function") });
		const r = await h.call("read", { path: "/etc/hostname" });
		expect(h.seen.length).toBe(1);
		expect(r).toEqual({ content: [{ type: "text", text: "ok from host" }], isError: false });
	});

	test("a successful call keeps its result when the end event is refused", async () => {
		const h = mount({ emitThrows: new TypeError("nope") });
		const r = await h.call("read", {});
		expect(r.isError).toBe(false);
		expect(r.content).toEqual([{ type: "text", text: "ok from host" }]);
	});

	test("a failed call reports the tool's error, not the event sink's", async () => {
		const h = mount({ throws: new Error("permission denied by host"), emitThrows: new TypeError("nope") });
		const r = await h.call("read", {});
		expect(r.content).toEqual([{ type: "text", text: "permission denied by host" }]);
		expect(r.isError).toBe(true);
	});
});
