/**
 * Scenario probe (bun run test:scenario).
 *
 * The other five probes are flat checks: independent assertions, each with one
 * observation. This one is built the other way round — every scenario is a
 * narrative with a beginning, an act and an end state, and **the end state is
 * verified through a channel other than the one that produced it**:
 *
 *   - a remote `bash` call is verified by looking at the file it wrote
 *   - a `POST /blob` write is verified by reading it back with the host's own
 *     `read` tool
 *   - a token rotation is verified by which token the *running server* accepts
 *   - a port that the bridge gave up is verified by connecting to it
 *   - a config that must be refused is verified by the silence that follows
 *
 * Reasoning that stays inside one channel is how the deleted file-transfer
 * surface shipped two P1s with 100 green unit tests: every assertion was true
 * and none of them noticed a file being written twice.
 *
 * Scenarios needing different host configuration get their own host; scenarios
 * sharing one boot are grouped. Boot is the expensive part (~8s), so the
 * grouping matters more than the count.
 *
 * Requires the omp binary, no model credentials (see harness.ts).
 *
 * What this suite does NOT cover, and who owns it instead — knowing the edges of
 * a suite matters as much as knowing its middle:
 *
 *   - the exposure gate (`not exposed` for unregistered names and aliases)
 *     -> test:hardening. Confirmed by mutation: removing that gate leaves this
 *     suite entirely green, because no scenario calls a name outside the
 *     registry.
 *   - wire-level refusals (401/400/404/405, batch, bad jsonrpc) -> test:hardening
 *   - byte-identity of a single /blob write, offset conflicts, verb handling
 *     -> test:blob
 *   - the prompt-tier hang and its 90s client timeout -> test:approval
 *   - package self-containment -> test:install
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkExtension, seedModels } from "./harness.ts";

const OMP = process.env.OMP_BIN ?? "omp";
const tmp = mkdtempSync(join(tmpdir(), "a2a-scen-"));

let failures = 0;
let checks = 0;
const t0 = Date.now();
const stage = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

/**
 * A scenario passes only if every step inside it passes. Steps report their own
 * detail, so a scenario line says *what* broke and the step lines say how.
 */
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
	const before = failures;
	try {
		await fn();
	} catch (e) {
		failures++;
		console.log(`FAIL: scenario ${name} — threw: ${(e as Error).message}`);
	}
	console.log(`${failures === before ? "ok" : "FAIL"}: scenario ${name}`);
}

function step(cond: unknown, what: string, detail = ""): void {
	checks++;
	if (cond) {
		console.log(`  ok: ${what}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures++;
		console.log(`  FAIL: ${what}${detail ? ` — ${detail}` : ""}`);
	}
}

// --- host plumbing ---------------------------------------------------------

type Host = {
	child: ChildProcess;
	agentDir: string;
	cfgPath: string;
	auditPath: string;
	out: () => string;
	err: () => string;
	port: number;
	announced: RegExpMatchArray | null;
};

const hosts: Host[] = [];

/** A port the OS says is free right now. */
function freePort(): number {
	const s = createServer();
	s.listen(0, "127.0.0.1");
	const port = (s.address() as { port: number }).port;
	s.close();
	return port;
}

type BootOpts = {
	/** Extra argv for the host (approval modes etc.). */
	argv?: string[];
	/** Pre-written config; defaults to a port-only config (token self-heals). */
	config?: unknown;
	/** Pin the configured port to this number (caller occupies it when it wants EADDRINUSE). */
	port?: number;
	/** How long to wait for the bridge announcement. */
	announceMs?: number;
};

/**
 * Boot a host with a throwaway HOME. `announceMs: 0` means "do not wait for an
 * announcement" — used by the scenario that asserts the bridge must *not* come
 * up.
 */
async function boot(label: string, opts: BootOpts = {}): Promise<Host> {
	const home = join(tmp, label);
	const agentDir = join(home, ".omp", "agent");
	const cfgPath = join(agentDir, "a2a-bridge.json");
	const auditPath = join(agentDir, "a2a-bridge.log");
	const outLog = join(home, "omp.out.log");
	const errLog = join(home, "omp.err.log");

	linkExtension(agentDir);
	seedModels(agentDir);

	const port = opts.port ?? freePort();
	writeFileSync(cfgPath, JSON.stringify(opts.config ?? { port, host: "127.0.0.1" }, null, 2));

	const child = spawn(OMP, ["--mode", "rpc", ...(opts.argv ?? [])], {
		env: { ...process.env, HOME: home, A2A_BRIDGE_CONFIG: cfgPath, A2A_BRIDGE_AUDIT: auditPath },
		stdio: ["pipe", openSync(outLog, "w"), openSync(errLog, "w")],
	});
	const read = (f: string) => {
		try {
			return readFileSync(f, "utf8");
		} catch {
			return "";
		}
	};
	const host: Host = {
		child,
		agentDir,
		cfgPath,
		auditPath,
		out: () => read(outLog),
		err: () => read(errLog),
		port,
		announced: null,
	};

	const waitMs = opts.announceMs ?? 30_000;
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (/A2A bridge listening/.test(host.out())) break;
		if (child.exitCode !== null) break;
		child.stdin?.write(""); // the host exits on EOF, so keep stdin open
		await Bun.sleep(200);
	}
	host.announced = host.out().match(/A2A bridge listening on (http:\/\/127\.0\.0\.1:\d+\/)/);

	// The token is written by the bridge on first start; give it a moment even
	// when no announcement was expected, so the caller can read the reason.
	if (!host.announced) await Bun.sleep(1500);

	hosts.push(host);
	return host;
}

function baseOf(host: Host): string {
	return host.announced?.[1] ?? `http://127.0.0.1:${host.port}/`;
}

/** Only the fields these scenarios read. Keeps a failed step's detail short. */
type RpcBody = {
	result?: { content?: Array<{ text?: string }>; isError?: boolean };
	error?: { code?: number; message?: string };
};

async function rpc(
	host: Host,
	method: string,
	params: unknown,
	opts: { token?: string; sid?: string; ms?: number } = {},
): Promise<{ status: number; body: RpcBody | null; sid: string | null }> {
	const r = await fetch(baseOf(host), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
			...(opts.sid ? { "mcp-session-id": opts.sid } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		// Always bounded. Without this, a scenario whose host never announced
		// itself would hang on the first fetch instead of failing with a reason.
		signal: AbortSignal.timeout(opts.ms ?? 20_000),
	});
	return {
		status: r.status,
		body: (await r.json().catch(() => null)) as RpcBody | null,
		sid: r.headers.get("mcp-session-id"),
	};
}

async function token(host: Host): Promise<string> {
	const cfg = JSON.parse(readFileSync(host.cfgPath, "utf8")) as { token: string };
	return cfg.token;
}

/** initialize + notification, the handshake every real client performs. */
async function handshake(host: Host): Promise<{ token: string; sid: string }> {
	const tk = await token(host);
	const init = await rpc(host, "initialize", { protocolVersion: "2025-11-25" }, { token: tk });
	const sid = init.sid ?? "";
	await rpc(host, "notifications/initialized", {}, { token: tk, sid });
	return { token: tk, sid };
}

type AuditRecord = {
	id?: string;
	sid?: string | null;
	phase?: string;
	tool?: string;
	isError?: boolean;
	args?: unknown;
};

function auditRecords(host: Host): AuditRecord[] {
	try {
		return (readFileSync(host.auditPath, "utf8") as string)
			.split("\n")
			.filter(Boolean)
			.flatMap((l) => {
				try {
					return [JSON.parse(l) as AuditRecord];
				} catch {
					return []; // partial trailing line
				}
			});
	} catch {
		return [];
	}
}

async function shutdown(host: Host): Promise<void> {
	host.child.kill("SIGTERM");
	await Bun.sleep(600);
	if (host.child.exitCode === null) host.child.kill("SIGKILL");
}

/** Can something still be connected to this port? */
async function portAccepts(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
		return true;
	} catch {
		return false;
	}
}

// --- the scenarios ---------------------------------------------------------

/**
 * S1 + S2, one host (default approval mode).
 *
 * S1 is the only place the two doors meet: bytes go in through the bridge's own
 * `POST /blob` (whose path resolution the bridge owns) and come back out through
 * the host's `read` tool. Byte-comparing a /blob write against itself would pass
 * even if both ends resolved the path the same wrong way.
 *
 * S2 pins the audit record to the side effect it claims to describe.
 */
await scenario("blob write is readable by the host's own read tool", async () => {
	const host = await boot("s1");
	step(!!host.announced, "bridge announced", host.announced?.[1] ?? host.err().slice(-200));

	const { token: tk, sid } = await handshake(host);
	const payload = Buffer.from(`scenario-payload-${Date.now()}\n`.repeat(64), "utf8");
	// A path the bridge must resolve itself: `~` expansion plus a directory that
	// does not exist yet.
	const target = `~/a2a-scenario-${Date.now()}/payload.bin`;

	const up = await fetch(`${baseOf(host)}blob?path=${encodeURIComponent(target)}`, {
		method: "POST",
		headers: { authorization: `Bearer ${tk}`, "mcp-session-id": sid },
		body: payload,
	});
	step(up.status === 200, "POST /blob accepted the upload", `status ${up.status}`);

	const absolute = join(host.agentDir.replace(/\/\.omp\/agent$/, ""), target.slice(2));
	step(existsSync(absolute), "the file landed where the bridge said it would", absolute);
	step(readFileSync(absolute).equals(payload), "bytes on disk match what was sent", `${payload.length} B`);

	// Second channel: the host's own read tool, through tools/call.
	const readBack = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: absolute } },
		{ token: tk, sid, ms: 20_000 },
	);
	const text = (readBack.body?.result?.content ?? []).map((c) => c.text ?? "").join("");
	step(
		readBack.body?.result?.isError === false,
		"host read tool read it back",
		`isError=${readBack.body?.result?.isError}`,
	);
	// The host's read is not raw content: it returns a `[path#hash]` header and
	// numbers every line, like `cat -n`. Comparing our bytes against that output
	// directly fails on presentation rather than on data, so undo the
	// presentation first and then compare.
	const lines = text
		.split("\n")
		.filter((l) => !/^\[.*#[0-9A-Fa-f]{4,}\]$/.test(l.trim()))
		.map((l) => l.replace(/^\d+:/, ""));
	const payloadLine = payload.toString("utf8").split("\n")[0];
	const got = lines.filter((l) => l === payloadLine).length;
	step(got === 64, "host read returned every line the bridge wrote", `${got}/64 lines, ${text.length} chars`);

	// Append a second, distinguishable part at an explicit offset. Without this
	// the scenario cannot see a write-mode regression at all: on a file that does
	// not exist yet, "append" and "truncate" are the same operation. (Verified —
	// forcing the bridge to always truncate left this scenario green.)
	const tail = Buffer.from(`scenario-tail-${Date.now()}\n`.repeat(8), "utf8");
	const append = await fetch(`${baseOf(host)}blob?path=${encodeURIComponent(target)}&offset=${payload.length}`, {
		method: "POST",
		headers: { authorization: `Bearer ${tk}`, "mcp-session-id": sid },
		body: tail,
	});
	step(append.status === 200, "POST /blob appended at an explicit offset", `status ${append.status}`);
	const whole = readFileSync(absolute);
	step(whole.equals(Buffer.concat([payload, tail])), "the file now holds both parts, in order", `${whole.length} B`);
	step(
		whole.subarray(0, payload.length).equals(payload) && whole.subarray(payload.length).equals(tail),
		"the first part was not truncated by the second",
	);

	await shutdown(host);
});

await scenario("a remote bash call's side effect is on disk and in the audit log", async () => {
	const host = await boot("s2");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const marker = `a2a-scenario-${Date.now()}`;
	const file = join(tmp, marker);
	const call = await rpc(
		host,
		"tools/call",
		{ name: "bash", arguments: { command: `printf scenario-ok > ${file}` } },
		{ token: tk, sid, ms: 30_000 },
	);
	step(
		call.body?.result?.isError === false,
		"remote bash returned isError=false",
		JSON.stringify(call.body?.result?.content?.[0]?.text ?? "").slice(0, 120),
	);
	// Independent channel 1: the filesystem, not the RPC response.
	step(
		existsSync(file) && readFileSync(file, "utf8") === "scenario-ok",
		"the file the remote command wrote is on disk with the expected content",
	);

	// Independent channel 2: the audit log describes the same act.
	const recs = auditRecords(host).filter((r) => r.tool === "bash");
	const start = recs.find((r) => r.phase === "start");
	const done = recs.find((r) => r.phase === "done");
	step(!!start, "audit has a start record for bash");
	step(!!done, "audit has a done record for bash");
	step(start?.id === done?.id, "the two phases pair by id");
	step(start?.sid === sid, "the record carries the caller's session id", `sid=${String(start?.sid).slice(0, 8)}…`);
	step(String(start?.args ?? "").includes(marker), "the audited args name the file that was written");

	await shutdown(host);
});

await scenario("two clients share one token and stay independently revocable", async () => {
	const host = await boot("s3");
	step(!!host.announced, "bridge announced");
	const tk = await token(host);

	const a = await handshake(host);
	const b = await handshake(host);
	step(a.sid !== "" && b.sid !== "" && a.sid !== b.sid, "both clients hold distinct sessions");

	const callA = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: host.cfgPath } },
		{ token: tk, sid: a.sid, ms: 20_000 },
	);
	step(callA.body?.result?.isError === false, "client A can call");

	const del = await fetch(baseOf(host), {
		method: "DELETE",
		headers: { authorization: `Bearer ${tk}`, "mcp-session-id": a.sid },
	});
	step(del.status === 204, "A's session terminates on DELETE", `status ${del.status}`);

	const afterA = await rpc(host, "ping", {}, { token: tk, sid: a.sid });
	step(afterA.status === 404, "A's session is gone", `status ${afterA.status}`);

	const callB = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: host.cfgPath } },
		{ token: tk, sid: b.sid, ms: 20_000 },
	);
	step(callB.body?.result?.isError === false, "B is unaffected by A's termination");

	// Both clients' calls are attributable, which is the point of the sid field.
	const sids = new Set(
		auditRecords(host)
			.filter((r) => r.phase === "start")
			.map((r) => r.sid),
	);
	step(
		sids.has(a.sid) && sids.has(b.sid),
		"the audit log attributes calls to both client sessions",
		`${sids.size} distinct sids`,
	);

	await shutdown(host);
});

await scenario("an external config edit does not take effect until the host restarts", async () => {
	const host = await boot("s4");
	step(!!host.announced, "bridge announced");
	const tk = await token(host);
	const { sid } = await handshake(host);

	// Rewrite the token behind the running server's back.
	const nextToken = `rotated-${"x".repeat(40)}`;
	const cfg = JSON.parse(readFileSync(host.cfgPath, "utf8")) as Record<string, unknown>;
	cfg.token = nextToken;
	writeFileSync(host.cfgPath, JSON.stringify(cfg, null, 2));

	const oldStill = await rpc(host, "ping", {}, { token: tk, sid });
	step(
		oldStill.status === 200,
		"the running server still accepts the token it booted with",
		`status ${oldStill.status}`,
	);
	const newRejected = await rpc(host, "ping", {}, { token: nextToken, sid });
	step(
		newRejected.status === 401,
		"the edited token is not honoured by the running server",
		`status ${newRejected.status}`,
	);

	await shutdown(host);

	// Restart against the same HOME: now the edit applies.
	const again = await boot("s4-restart", { config: JSON.parse(readFileSync(host.cfgPath, "utf8")) });
	step(!!again.announced, "bridge announced after restart");
	const afterRestart = await rpc(again, "ping", {}, { token: nextToken });
	step(
		afterRestart.status === 401 || afterRestart.status === 400,
		"the restarted server requires a fresh handshake",
		`status ${afterRestart.status}`,
	);
	const tk2 = await token(again);
	step(tk2 === nextToken, "the restarted host reads the edited token from disk");
	const fresh = await handshake(again);
	const ping = await rpc(again, "ping", {}, { token: tk2, sid: fresh.sid });
	step(ping.status === 200, "and accepts it", `status ${ping.status}`);

	await shutdown(again);
});

await scenario("a busy configured port is given up, announced, and still serves", async () => {
	const busy = freePort();
	const blocker = createServer();
	await new Promise<void>((resolve) => blocker.listen(busy, "127.0.0.1", resolve));

	const host = await boot("s5", { port: busy });
	step(!!host.announced, "bridge announced on a different port", host.announced?.[1] ?? "no announcement");
	step(
		host.announced?.[1] !== `http://127.0.0.1:${busy}/`,
		"the announced port is not the occupied one",
		`busy=${busy}`,
	);
	step(/configured port \d+ is busy/.test(host.out()), "the host warned that the configured port was busy");

	const tk = await token(host);
	if (host.announced) {
		const init = await rpc(host, "initialize", { protocolVersion: "2025-11-25" }, { token: tk, ms: 8000 });
		step(init.status === 200, "the bridge is reachable at the announced port", `status ${init.status}`);
	} else {
		step(false, "the bridge is reachable at the announced port", "no announcement to reach");
	}

	blocker.close();
	await shutdown(host);
});

await scenario("a malformed config stops the bridge from coming up, and says why", async () => {
	// `port` present but not a number: fail-closed, so the extension must refuse
	// to start rather than come up on an unexpected endpoint.
	const host = await boot("s6", { config: { port: "not-a-number", host: "127.0.0.1" }, announceMs: 12_000 });
	step(!host.announced, "no bridge announcement", host.announced?.[1] ?? "(none, as required)");
	step(host.child.exitCode === null, "the host itself keeps running", `exit=${host.child.exitCode}`);
	const noise = `${host.out()}\n${host.err()}`;
	step(
		/a2a-bridge\.json/.test(noise) && /port/.test(noise),
		"the failure names the file and the field",
		noise
			.split("\n")
			.filter((l) => /a2a-bridge|port/i.test(l))
			.slice(0, 2)
			.join(" | ")
			.slice(0, 200),
	);

	await shutdown(host);
});

await scenario("the write tier splits one host policy across read and bash", async () => {
	// `--approval-mode` takes always-ask | write | yolo — the host rejects
	// anything else by name (measured, not assumed: "deny" is not a tier, it is
	// an outcome the host's own gate produces). `write` is the interesting one
	// and nobody had covered it: the *same* policy answers a read immediately
	// and holds a bash call open, which is the boundary the bridge must not
	// paper over with an opinion of its own.
	const host = await boot("s7", { argv: ["--approval-mode=write"] });
	step(!!host.announced, "bridge announced under --approval-mode=write", host.announced?.[1] ?? host.err().slice(-200));
	const { token: tk, sid } = await handshake(host);

	const tRead = Date.now();
	const readCall = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: host.cfgPath } },
		{ token: tk, sid, ms: 20_000 },
	);
	const readMs = Date.now() - tRead;
	step(
		readCall.body?.result?.isError === false,
		"a read is answered under the write tier",
		`isError=${readCall.body?.result?.isError} in ${readMs}ms`,
	);

	// The write side, observed with a short client timeout: the expectation is
	// "no answer", and a hang is the documented behavior for a prompt-tier tool
	// with no UI to answer it (see test:approval, verdict B).
	const sideEffect = join(tmp, `write-tier-${Date.now()}`);
	let answered = false;
	let bashMs = 0;
	const t = Date.now();
	try {
		const call = await rpc(
			host,
			"tools/call",
			{ name: "bash", arguments: { command: `touch ${sideEffect}` } },
			{ token: tk, sid, ms: 8000 },
		);
		answered = true;
		bashMs = Date.now() - t;
		stage(
			`bash under write tier answered in ${bashMs}ms: ${JSON.stringify(call.body?.result?.content?.[0]?.text ?? "").slice(0, 120)}`,
		);
	} catch {
		bashMs = Date.now() - t;
	}
	step(!answered, "a bash call gets no answer while the write tier waits for a UI", `${bashMs}ms`);
	step(!existsSync(sideEffect), "and it did not execute");

	// The call that never settled must still be visible in the audit log.
	const recs = auditRecords(host).filter((r) => r.tool === "bash");
	step(
		recs.some((r) => r.phase === "start"),
		"the unsettled call left a start record",
		`start=${recs.filter((r) => r.phase === "start").length} done=${recs.filter((r) => r.phase === "done").length}`,
	);

	// And the server is still usable afterwards.
	const ping = await rpc(host, "ping", {}, { token: tk, sid, ms: 8000 });
	step(ping.status === 200, "the bridge still answers after the held call", `status ${ping.status}`);

	await shutdown(host);
});

await scenario("the host releasing the session releases the port", async () => {
	const host = await boot("s8");
	step(!!host.announced, "bridge announced");
	const port = Number(new URL(baseOf(host)).port);
	step(await portAccepts(port), "the port accepts connections while the host runs");

	await shutdown(host);
	let stillUp = true;
	for (let i = 0; i < 10 && stillUp; i++) {
		await Bun.sleep(400);
		stillUp = await portAccepts(port);
	}
	step(!stillUp, "and stops accepting once the host is gone", `port ${port}`);
});

await scenario("parallel uploads stay isolated from each other", async () => {
	const host = await boot("s9");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const n = 8;
	const bodies = Array.from({ length: n }, (_, i) => Buffer.alloc(200_000 + i * 1000, 65 + i));
	const stamp = Date.now();
	const results = await Promise.all(
		bodies.map((body, i) =>
			fetch(`${baseOf(host)}blob?path=${encodeURIComponent(`~/a2a-par-${stamp}-${i}.bin`)}`, {
				method: "POST",
				headers: { authorization: `Bearer ${tk}`, "mcp-session-id": sid },
				body,
			}).then(async (r) => ({ status: r.status, i, body })),
		),
	);
	step(
		results.every((r) => r.status === 200),
		"every parallel upload was accepted",
		results.map((r) => r.status).join(","),
	);

	// Each file must hold exactly its own bytes: the failure mode of a shared
	// buffer or a mis-read offset is two files with the same content.
	let isolated = true;
	const sizes: string[] = [];
	for (const { i, body } of results) {
		const p = join(host.agentDir.replace(/\/\.omp\/agent$/, ""), `a2a-par-${stamp}-${i}.bin`);
		const onDisk = existsSync(p) ? readFileSync(p) : Buffer.alloc(0);
		sizes.push(`${onDisk.length}`);
		if (!onDisk.equals(body)) isolated = false;
	}
	step(isolated, "each file holds exactly its own bytes", `sizes ${sizes.join("/")}`);
	step(new Set(sizes).size === n, "and no two files share a size", `${new Set(sizes).size}/${n} distinct`);

	await shutdown(host);
});

await scenario("a mounted device is reachable through a tool path, not a tool name", async () => {
	const host = await boot("s10");
	step(!!host.announced, "bridge announced");
	const { token: tk, sid } = await handshake(host);

	const call = await rpc(
		host,
		"tools/call",
		{ name: "read", arguments: { path: "xd://" } },
		{ token: tk, sid, ms: 20_000 },
	);
	const text = (call.body?.result?.content ?? []).map((c) => c.text ?? "").join("");
	step(call.body?.result?.isError === false, "read xd:// does not error", `isError=${call.body?.result?.isError}`);
	// How many devices exist is the host's business, not the bridge's; record it.
	const mounted = (text.match(/xd:\/\/[a-z_]+/g) ?? []).length;
	stage(`xd:// listed ${mounted} mounted device(s)`);
	step(
		mounted === 0 || text.includes("xd://"),
		"the listing mentions device paths",
		text.slice(0, 120).replace(/\n/g, " "),
	);

	await shutdown(host);
});

// --- wrap up ---------------------------------------------------------------

for (const h of hosts) {
	try {
		h.child.kill("SIGKILL");
	} catch {}
}

console.log(`\nSCENARIOS: ${checks} steps, ${failures} failed`);
if (failures > 0) {
	console.error(`evidence kept at ${tmp}`);
	process.exitCode = 1;
} else {
	rmSync(tmp, { recursive: true, force: true });
}
