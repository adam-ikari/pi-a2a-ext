/**
 * The extension entrypoint: what one session's start and shutdown do to a
 * process-level server.
 *
 * The host builds a fresh extension runner per session — a task subagent's, an ACP
 * session's, a persisted revive's — and re-invokes this factory for each, while the
 * module's `server`/`cfg` are shared because the module graph is not re-evaluated.
 * So the events are per session and the resource is per process, and the entrypoint
 * is the only place that has to reconcile them.
 *
 * Nothing here is mocked: `$A2A_BRIDGE_CONFIG` points at a temp file, the port is
 * `0`, and the Main session is a fake registered in the real `AgentRegistry`. Every
 * claim is checked over HTTP against the port the bridge advertised, because that is
 * the only claim a caller can act on.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import a2aBridge from "../extensions/a2a-bridge.ts";
import { configPath } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "a2a-entry-"));
const savedEnv = { ...process.env };
process.env.A2A_BRIDGE_CONFIG = join(dir, "a2a-bridge.json");
process.env.A2A_BRIDGE_AUDIT = join(dir, "audit.log");
// A 0700 dir, not the default 0755 temp dir: the read-only-file test needs the
// non-root owner to be refused, and a group/other-writable dir would let the write
// land from elsewhere.
chmodSync(dir, 0o700);

const TOKEN = "tok-entry-level-fixed-token-0123456789";
function writeConfig(cfg: Record<string, unknown>): void {
	writeFileSync(configPath(), `${JSON.stringify(cfg, null, "\t")}\n`, { mode: 0o600 });
}

/** POST initialize and report the HTTP status, or null when nothing answered. */
async function ping(port: number, token = TOKEN): Promise<number | null> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "entry-test", version: "0" } },
			}),
		});
		return res.status;
	} catch {
		return null;
	}
}

interface Runner {
	notes: Array<{ text: string; level?: string }>;
	start(): Promise<void>;
	shutdown(): Promise<void>;
	command(args: string): Promise<void>;
	commandNames: string[];
	/** The port from the bridge's own announcement — parsed, not injected. */
	advertisedPort(): number | null;
}

const runners: Runner[] = [];

/**
 * One host session's worth of extension state: its own handlers and `ctx`, sharing
 * the module singleton. `uiThrowsOn` models a UI sink that refuses a notification.
 */
function newRunner(uiThrowsOn = ""): Runner {
	const handlers: Record<string, Array<(ev: unknown, ctx: ExtensionContext) => Promise<void>>> = {};
	const commandDefs: Array<{ name: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }> = [];
	const notes: Array<{ text: string; level?: string }> = [];
	const ui = {
		notify: (text: string, level?: string) => {
			notes.push({ text, level });
			if (uiThrowsOn && text.includes(uiThrowsOn)) throw new Error("the ui sink is gone");
		},
	};
	const ctx = { ui, hasUI: true } as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (ev: unknown, c: ExtensionContext) => Promise<void>) => {
			const list = handlers[event] ?? [];
			list.push(handler);
			handlers[event] = list;
		},
		registerCommand: (name: string, def: { handler: (args: string, c: ExtensionContext) => Promise<void> }) => {
			commandDefs.push({ name, handler: def.handler });
		},
		getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
	} as unknown as ExtensionAPI;
	a2aBridge(pi);
	const runner: Runner = {
		notes,
		commandNames: commandDefs.map((c) => c.name),
		start: async () => {
			for (const h of handlers.session_start ?? []) await h({}, ctx);
		},
		shutdown: async () => {
			for (const h of handlers.session_shutdown ?? []) await h({}, ctx);
		},
		command: async (args: string) => {
			for (const c of commandDefs) await c.handler(args, ctx);
		},
		advertisedPort: () => {
			const hit = /http:\/\/127\.0\.0\.1:(\d+)\//g.exec(notes.map((n) => n.text).join("\n"));
			return hit ? Number(hit[1]) : null;
		},
	};
	runners.push(runner);
	return runner;
}

const texts = (r: Runner) => r.notes.map((n) => n.text).join("\n");

function mountMain(): void {
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: "fake-main",
		kind: "main",
		session: { getToolByName: () => undefined } as never,
	});
}

/** The entrypoint's singleton survives across tests, so tear it down the real way. */
async function releaseBridge(): Promise<void> {
	AgentRegistry.resetGlobalForTests();
	for (const r of runners) await r.shutdown();
}

beforeEach(async () => {
	await releaseBridge();
	runners.length = 0;
	mountMain();
	writeConfig({ host: "127.0.0.1", port: 0, token: TOKEN });
});

afterAll(async () => {
	await releaseBridge();
	AgentRegistry.resetGlobalForTests();
	for (const key of ["A2A_BRIDGE_CONFIG", "A2A_BRIDGE_AUDIT"] as const) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	chmodSync(dir, 0o700);
	rmSync(dir, { recursive: true, force: true });
});

describe("session_start", () => {
	test("binds, and the port it advertises is the port that answers", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort();
		expect(port).not.toBeNull();
		expect(await ping(port as number)).toBe(200);
	});

	test("announces a token prefix, never the whole token", async () => {
		const r = newRunner();
		await r.start();
		expect(texts(r)).toContain(`token ${TOKEN.slice(0, 6)}…`);
		expect(texts(r)).not.toContain(TOKEN);
	});

	test("a second session_start leaves one server and says nothing new", async () => {
		const main = newRunner();
		await main.start();
		const port = main.advertisedPort();
		const sub = newRunner();
		await sub.start();
		expect(sub.notes).toEqual([]);
		expect(await ping(port as number)).toBe(200);
	});

	test("warns when the configured port is taken, and serves on the new one", async () => {
		const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
		const wanted = squatter.port as number;
		writeConfig({ host: "127.0.0.1", port: wanted, token: TOKEN });
		const r = newRunner();
		await r.start();
		squatter.stop(true);
		const warning = r.notes.find((n) => n.level === "warning");
		expect(warning?.text).toContain(String(wanted));
		const port = r.advertisedPort();
		expect(port).not.toBe(wanted);
		expect(await ping(port as number)).toBe(200);
	});

	test("warns about binding to every interface", async () => {
		writeConfig({ host: "0.0.0.0", port: 0, token: TOKEN });
		const r = newRunner();
		await r.start();
		expect(r.notes.some((n) => n.level === "warning" && n.text.includes("0.0.0.0"))).toBe(true);
	});

	test("a malformed config binds nothing and names the file and field", async () => {
		writeConfig({ host: "127.0.0.1", port: "8787", token: TOKEN });
		const r = newRunner();
		await r.start();
		expect(r.advertisedPort()).toBeNull();
		const error = r.notes.find((n) => n.level === "error");
		expect(error?.text).toContain("port");
		expect(error?.text).toContain(configPath());
	});

	test("writes a config file when the host has none yet", async () => {
		rmSync(configPath(), { force: true });
		const r = newRunner();
		await r.start();
		expect(existsSync(configPath())).toBe(true);
		const saved = JSON.parse(readFileSync(configPath(), "utf8")) as { token: string };
		expect(saved.token).toHaveLength(43);
		expect(texts(r)).toContain(`token ${saved.token.slice(0, 6)}…`);
	});

	test("two session_starts in flight bind one server, not two", async () => {
		// The host awaits each runner's emit on its own async path, so a subagent's
		// session_start can land while the Main session's is still inside loadConfig.
		const main = newRunner();
		const sub = newRunner();
		await Promise.all([main.start(), sub.start()]);
		const bound = main.advertisedPort();
		expect(bound).not.toBeNull();
		expect(sub.advertisedPort()).toBeNull();
		AgentRegistry.resetGlobalForTests();
		await main.shutdown();
		// The leak is the point: a second bound server is stopped by nobody, because the
		// module only remembers the last one.
		expect(await ping(bound as number)).toBeNull();
	});

	test("a start that fails after binding leaves no half-initialized state", async () => {
		// The announce step throws. Before the catch cleared the module state, `a2a rotate`
		// reported success for a server nobody could reach.
		const r = newRunner("listening on");
		await r.start();
		const port = r.advertisedPort();
		expect(port).not.toBeNull();
		expect(await ping(port as number)).toBeNull();
		expect(r.notes.some((n) => n.level === "error" && n.text.includes("failed to start"))).toBe(true);
		const before = readFileSync(configPath(), "utf8");
		await r.command("rotate");
		expect(texts(r)).toContain("A2A bridge not running");
		expect(readFileSync(configPath(), "utf8")).toBe(before);
	});
});

describe("session_shutdown", () => {
	test("a subagent finishing keeps the endpoint up for the Main session", async () => {
		const main = newRunner();
		await main.start();
		const port = main.advertisedPort();
		const sub = newRunner();
		await sub.start();
		// The subagent's runner is disposed while the Main session is still registered.
		await sub.shutdown();
		expect(await ping(port as number)).toBe(200);
	});

	test("the port is released once no Main session is left", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort();
		AgentRegistry.resetGlobalForTests();
		await r.shutdown();
		expect(await ping(port as number)).toBeNull();
		await r.command("status");
		expect(texts(r)).toContain("A2A bridge not running");
	});

	test("a shutdown landing mid-bind leaves no orphan endpoint", async () => {
		const main = newRunner();
		// Fire the start and let it yield inside `loadConfig`: the bind is still in
		// flight, so the shutdown below sees `server` as null and has nothing to stop.
		const inFlight = main.start();
		AgentRegistry.resetGlobalForTests();
		await main.shutdown();
		await inFlight;
		// What the aborted start must not do is keep a port that already serves nobody:
		// it announced nothing, and the process-level state says the bridge is not running.
		expect(main.advertisedPort()).toBeNull();
		await main.command("status");
		expect(texts(main)).toContain("A2A bridge not running");
		mountMain();
		const next = newRunner();
		await next.start();
		expect(await ping(next.advertisedPort() as number)).toBe(200);
	});

	test("a parked Main releases the port, because nothing can be served through it", async () => {
		const main = newRunner();
		await main.start();
		const port = main.advertisedPort();
		// The host's own sentinel: `AgentRef.session` is null exactly when the slot is
		// parked or aborted. The call path already refuses that state with "main session
		// not available", so the release rule has to read it the same way.
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "parked-main",
			kind: "main",
			status: "parked",
			session: null,
		});
		const sub = newRunner();
		await sub.shutdown();
		expect(await ping(port as number)).toBeNull();
	});

	test("a session_start after that binds a fresh port", async () => {
		const first = newRunner();
		await first.start();
		const old = first.advertisedPort();
		AgentRegistry.resetGlobalForTests();
		await first.shutdown();
		mountMain();
		const next = newRunner();
		await next.start();
		const fresh = next.advertisedPort();
		expect(fresh).not.toBe(old);
		expect(await ping(fresh as number)).toBe(200);
	});
});

describe("the a2a command", () => {
	test("registers as `a2a` on every runner", () => {
		expect(newRunner().commandNames).toEqual(["a2a"]);
	});

	test("rotate persists the new token and the running server takes it", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort() as number;
		await r.command("rotate");
		const rotated = (JSON.parse(readFileSync(configPath(), "utf8")) as { token: string }).token;
		expect(rotated).not.toBe(TOKEN);
		expect(await ping(port, rotated)).toBe(200);
		expect(await ping(port)).toBe(401);
	});

	test("a rotate that cannot write the file leaves the live server on the old token", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort() as number;
		// Read-only file: `open(w)` on it fails for a non-root owner, so the write cannot land.
		chmodSync(configPath(), 0o400);
		try {
			await r.command("rotate");
		} finally {
			chmodSync(configPath(), 0o600);
		}
		expect(r.notes.some((n) => n.level === "error" && n.text.includes("A2A command failed"))).toBe(true);
		expect(await ping(port)).toBe(200);
		expect((JSON.parse(readFileSync(configPath(), "utf8")) as { token: string }).token).toBe(TOKEN);
	});

	test("`token` prints the whole token, status prints the prefix", async () => {
		const r = newRunner();
		await r.start();
		await r.command("token");
		expect(texts(r)).toContain(TOKEN);
		// A different runner reads the same singleton: status shows the prefix, not the token.
		const other = newRunner();
		await other.command("");
		expect(texts(other)).toContain(`token ${TOKEN.slice(0, 6)}…`);
		expect(texts(other)).not.toContain(TOKEN);
	});

	test("every subcommand says not running when the bridge never started", async () => {
		rmSync(configPath(), { force: true });
		writeConfig({ port: "not a number" });
		const r = newRunner();
		await r.start();
		for (const args of ["rotate", "token", "status"]) await r.command(args);
		expect(r.notes.filter((n) => n.text === "A2A bridge not running")).toHaveLength(3);
		// Fail-closed means leaving the file alone, not healing it into something else.
		expect(readFileSync(configPath(), "utf8")).toContain("not a number");
	});
});
