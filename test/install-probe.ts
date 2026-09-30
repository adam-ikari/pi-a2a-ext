/**
 * Cross-machine install probe: install the extension the way a *different*
 * machine would, then drive it as a remote MCP client.
 *
 *   bun run test:install
 *
 * Why this exists separately from test/file-transfer.ts: that probe links the
 * extension into a sandboxed agent dir itself, so it proves the bridge works but
 * says nothing about installability. This one goes through omp's own plugin
 * manager from a git URL, into a throwaway HOME, and checks the whole chain —
 * manifest, packaged files, first-start config/token/sandbox generation, MCP
 * handshake, a file round-trip, the sandbox boundaries, auth, and the audit log.
 *
 * Env:
 *   A2A_INSTALL_SPEC  what to hand `omp install` (default: the origin git URL)
 *   OMP_BIN           host binary (default: omp)
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const OMP = process.env.OMP_BIN ?? "omp";
const SPEC = process.env.A2A_INSTALL_SPEC ?? "https://github.com/adam-ikari/pi-a2a-ext.git";

let failures = 0;
function check(cond: unknown, label: string, extra = ""): void {
	console.log(`${cond ? "ok" : "FAIL"}: ${label}${extra ? ` (${extra})` : ""}`);
	if (!cond) failures++;
}
function fail(msg: string): never {
	console.log(`FAIL: ${msg}`);
	process.exit(1);
}

// A machine that has never seen this project.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "a2a-install-"));
const env = { ...process.env, HOME: FAKE_HOME };
mkdirSync(join(FAKE_HOME, ".omp", "agent"), { recursive: true });
// omp exits before loading extensions when no model is configured, so a real
// second machine would have one. Without this the probe reports a false
// negative on a bridge that is actually fine.
const models = join(process.env.HOME ?? "", ".omp", "agent", "models.yml");
if (existsSync(models)) copyFileSync(models, join(FAKE_HOME, ".omp", "agent", "models.yml"));

console.log(`install spec : ${SPEC}`);
console.log(`simulated HOME: ${FAKE_HOME}\n`);

console.log("--- install via omp ---");
let out = "";
try {
	out = execFileSync(OMP, ["install", SPEC], { env, encoding: "utf8", timeout: 180_000 });
} catch (e) {
	fail(`omp install failed: ${(e as { stderr?: string }).stderr ?? e}`);
}
console.log(`  ${out.trim().split("\n")[0]}`);

const plugDir = join(FAKE_HOME, ".omp", "plugins", "node_modules", "pi-a2a-ext");
check(existsSync(plugDir), "installed into the fresh machine's plugin dir");
if (!existsSync(plugDir)) fail("plugin dir missing after install");
const mf = JSON.parse(readFileSync(join(plugDir, "package.json"), "utf8")) as {
	version?: string;
	pi?: { extensions?: string[] };
};
check(typeof mf.version === "string", "manifest carries a version (else omp reports @undefined)", mf.version);
check(
	Array.isArray(mf.pi?.extensions),
	"manifest declares pi.extensions (the load switch)",
	JSON.stringify(mf.pi?.extensions),
);
// The entry imports ../src/*.ts; shipping one without the other installs fine
// and then fails to load.
check(existsSync(join(plugDir, "src", "server.ts")), "shipped package includes src/");
check(existsSync(join(plugDir, "extensions", "a2a-bridge.ts")), "shipped package includes extensions/");

console.log("\n--- start the host omp on that machine ---");
// rpc mode with no prompt, stdin held open. `omp --mode rpc --print <prompt>`
// finishes the turn and exits, taking the bridge down with it.
const proc = spawn(OMP, ["--mode", "rpc"], { env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let errBuf = "";
proc.stdout.on("data", (d: Buffer) => {
	buf += d.toString();
});
proc.stderr.on("data", (d: Buffer) => {
	errBuf += d.toString();
});
let exited = false;
proc.on("exit", () => {
	exited = true;
});

const announce = /A2A bridge listening on (http:\/\/127\.0\.0\.1:\d+\/)/;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline && !exited && !announce.test(buf)) {
	await Bun.sleep(250);
}
// One more look after exit: the last chunk can land after the exit event.
await Bun.sleep(300);
const announced = announce.exec(buf);
check(!!announced, "host announced the bridge", announced?.[1] ?? `${buf.slice(0, 200)} ${errBuf.slice(0, 200)}`);
if (!announced) fail("bridge never came up on the fresh machine");
check(/A2A file transfer enabled/.test(buf), "host announced file transfer");

const base = announced[1];
const cfgPath = join(FAKE_HOME, ".omp", "agent", "a2a-bridge.json");
check(existsSync(cfgPath), "host generated its own config on first start");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { token?: string; port?: number };
check(typeof cfg.token === "string" && (cfg.token as string).length > 20, "token generated for this machine");

console.log("\n--- act as a remote MCP client ---");
const JSON_HDR: Record<string, string> = { "content-type": "application/json" };

let sid: string | null = null;
async function rpc(method: string, params: unknown): Promise<{ status: number; body: Record<string, never> }> {
	const r = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, authorization: `Bearer ${cfg.token}`, ...(sid ? { "mcp-session-id": sid } : {}) },
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
	});
	sid = r.headers.get("mcp-session-id") ?? sid;
	return { status: r.status, body: (await r.json()) as Record<string, never> };
}
async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
	const { body } = await rpc("tools/call", { name, arguments: args });
	const res = (body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
	if (!res) fail(`tools/call ${name} returned no result`);
	return JSON.parse(res.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}
async function callText(name: string, args: unknown): Promise<string> {
	const { body } = await rpc("tools/call", { name, arguments: args });
	const res = (body as { result?: { content?: Array<{ text?: string }> } }).result;
	return res?.content?.[0]?.text ?? "";
}

// Poll by actually calling the server rather than scraping stdout: chunk
// boundaries in the notification stream make a scrape flaky, and an HTTP probe
// is what a real client does anyway.
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
	try {
		const r = await rpc("initialize", { protocolVersion: "2025-11-25" });
		ready = r.status === 200 && !!sid;
	} catch {
		await Bun.sleep(500);
	}
}
check(ready, "MCP initialize succeeds over HTTP", sid ? "session issued" : "no session");
const initBody = (await rpc("initialize", { protocolVersion: "2025-11-25" })).body as {
	result?: { protocolVersion?: string };
};
check(initBody.result?.protocolVersion === "2025-11-25", "negotiates protocol 2025-11-25");
// The announced port is where the remote client must actually connect.
check(base.includes(`:${cfg.port ?? 0}/`) || cfg.port === 0, "announced URL is the one remote clients use", base);

const listBody = (await rpc("tools/list", {})).body as { result?: { tools?: Array<{ name: string }> } };
const names = (listBody.result?.tools ?? []).map((t) => t.name);
check(names.filter((n) => n.startsWith("a2a_file_")).length === 6, "tools/list exposes the 6 bridge file tools");
check(
	names.some((n) => n === "read" || n === "bash"),
	"tools/list exposes host tools",
	`${names.length} total`,
);

console.log("\n--- file round-trip through the sandbox ---");
const put = await call("a2a_file_put", {
	path: "inbox/note.md",
	file: { mimeType: "text/markdown", bytes: Buffer.from("hello from another machine").toString("base64") },
});
check(put.ok === true, "a2a_file_put succeeds", JSON.stringify(put).slice(0, 80));
const got = await call("a2a_file_get", { path: "inbox/note.md" });
check(
	Buffer.from(String(got.bytes), "base64").toString() === "hello from another machine",
	"a2a_file_get returns the same bytes",
);
const ls = await call("a2a_file_list", { path: "inbox" });
check(
	(ls.entries as Array<{ path: string }>).some((e) => e.path === "inbox/note.md"),
	"a2a_file_list shows the file",
);

console.log("\n--- sandbox boundaries hold on this machine too ---");
check(/invalid_path/.test(await callText("a2a_file_get", { path: ".tmp/x.part" })), "staging dir is not addressable");
await call("a2a_file_put", { path: "plain", file: { bytes: Buffer.from("x").toString("base64") } });
const notdir = await callText("a2a_file_get", { path: "plain/child" });
check(/^a2a_file_error [a-z_]+: /.test(notdir), "host fs errors carry a code", notdir.slice(0, 60));
check(!notdir.includes(FAKE_HOME) && !/ENOTDIR/.test(notdir), "...and leak no host path");
const cid = String((await call("a2a_file_put_start", { path: "race.bin" })).transferId);
const chunk = Buffer.alloc(64, 0xcd).toString("base64");
await Promise.all([
	call("a2a_file_put_chunk", { transferId: cid, seq: 0, bytes: chunk }),
	call("a2a_file_put_chunk", { transferId: cid, seq: 0, bytes: chunk }),
]);
const cend = await call("a2a_file_put_end", { transferId: cid });
check(cend.bytes === 64, "concurrent same-seq writes exactly one chunk", JSON.stringify(cend).slice(0, 70));

console.log("\n--- auth still gates everything ---");
const noAuth = await fetch(base, {
	method: "POST",
	headers: JSON_HDR,
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check(noAuth.status === 401, "no token -> 401", String(noAuth.status));
const noSess = await fetch(base, {
	method: "POST",
	headers: { ...JSON_HDR, authorization: `Bearer ${cfg.token}` },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check(noSess.status === 400, "no session header -> 400", String(noSess.status));

console.log("\n--- audit trail on that machine ---");
const audit = join(FAKE_HOME, ".omp", "agent", "a2a-bridge.log");
check(existsSync(audit), "audit log created");
if (existsSync(audit)) {
	const raw = readFileSync(audit, "utf8");
	const recs = raw
		.trim()
		.split("\n")
		.map((l) => {
			try {
				return JSON.parse(l) as { phase?: string; sid?: unknown };
			} catch {
				return null;
			}
		})
		.filter(Boolean) as Array<{ phase?: string; sid?: unknown }>;
	check(
		recs.some((r) => r.phase === "start") && recs.some((r) => r.phase === "done"),
		"start/done pairs present",
		`${recs.length} records`,
	);
	check(
		recs.every((r) => "sid" in r),
		"records carry sid (attribution)",
	);
	check(!raw.includes(chunk), "no raw base64 payload in the log");
}

proc.kill("SIGTERM");
await Bun.sleep(500);
proc.kill("SIGKILL");
rmSync(FAKE_HOME, { recursive: true, force: true });

if (failures > 0) {
	console.log(`\nFAIL: ${failures} install check(s) failed`);
	process.exit(1);
}
console.log(`\nINSTALL OK: 'omp install ${SPEC}' yields a working bridge on a clean machine`);
void REPO;
