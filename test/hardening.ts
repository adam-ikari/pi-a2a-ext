/**
 * Real-host hardening verification (manual: bun run test:hardening; requires
 * local omp + ~/.omp/agent/models.yml).
 * Boots omp with the a2a extension and asserts the review fixes against the
 * LIVE server: auth placement, mandatory session id, version negotiation,
 * deny/alias exposure gate, healed 0600 token, and the two-phase audit log.
 * Prints "HARDEN OK" on success; exits 1 on any failure.
 */
import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(process.env.REPO ?? join(import.meta.dir, ".."));
const tmp = mkdtempSync(join(tmpdir(), "a2a-harden-"));
const agentDir = join(tmp, ".omp", "agent");
const extDir = join(agentDir, "extensions");
const cfgPath = join(agentDir, "a2a-bridge.json");
const auditPath = join(agentDir, "a2a-bridge.log");
const outLog = join(tmp, "omp.out.log");
const errLog = join(tmp, "omp.err.log");
const dataFile = join(tmp, "payload.txt");
const payload = `HARDEN-PAYLOAD-${Date.now()}\nsecond line\n`;

let failures = 0;
function check(cond: unknown, label: string): void {
	if (cond) {
		console.log(`ok: ${label}`);
	} else {
		console.error(`FAIL: ${label}`);
		failures++;
	}
}

mkdirSync(extDir, { recursive: true });
symlinkSync(join(REPO, "extensions", "a2a-bridge.ts"), join(extDir, "a2a-bridge.ts"));
writeFileSync(dataFile, payload);

// Free port (probe-then-close, same approach as smoke.ts).
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port ?? 0;
probe.stop(true);

// Seed config WITHOUT a token: the app must heal it (generate + persist + 0600)
// while keeping our fixed port.
writeFileSync(
	cfgPath,
	JSON.stringify({ port: PORT, host: "127.0.0.1", deny: ["bash"], denyMCPTools: false }, null, 2),
);

const realModelsYml = join(process.env.HOME ?? "", ".omp", "agent", "models.yml");
if (!existsSync(realModelsYml)) {
	console.error(`FAIL: no model config at ${realModelsYml}`);
	process.exit(1);
}
copyFileSync(realModelsYml, join(agentDir, "models.yml"));

const child = spawn(process.env.OMP_BIN ?? "omp", ["--mode", "rpc"], {
	env: { ...process.env, HOME: tmp, A2A_BRIDGE_CONFIG: cfgPath },
	stdio: ["pipe", openSync(outLog, "w"), openSync(errLog, "w")],
});

function fail(label: string): never {
	console.error(`FAIL: ${label}`);
	console.error(`--- omp stdout tail ---\n${readFileSync(outLog, "utf8").slice(-1500)}`);
	console.error(`--- omp stderr tail ---\n${readFileSync(errLog, "utf8").slice(-1500)}`);
	throw new Error(label);
}

const JSON_HDR = { "content-type": "application/json" };
const base = `http://127.0.0.1:${PORT}/`;

async function until<T>(fn: () => Promise<T | null>, label: string, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const v = await fn().catch(() => null);
		if (v !== null) return v;
		await Bun.sleep(300);
	}
	return fail(`timeout: ${label}`);
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

try {
	// 1. Config self-heal: token persisted by the app.
	await until(async () => {
		const raw = readFileSync(cfgPath, "utf8");
		const parsed = JSON.parse(raw) as { token?: unknown };
		return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
	}, "config token heal");
	const token = (JSON.parse(readFileSync(cfgPath, "utf8")) as { token: string }).token;
	check(token.length === 43, `healed token is 32B base64url (got ${token.length} chars)`);
	check((statSync(cfgPath).mode & 0o777) === 0o600, `config is 0600 after heal (got ${(statSync(cfgPath).mode & 0o777).toString(8)})`);

	const AUTH = { authorization: `Bearer ${token}` };

	// 2. Server accepts initialize (extension fully started).
	const initRes = await until(async () => {
		const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, AUTH);
		return r.status === 200 ? r : null;
	}, "server up");
	const initBody = (await initRes.json()) as { result: { protocolVersion: string } };
	check(initBody.result.protocolVersion === "2025-11-25", "initialize -> 2025-11-25");
	const sid1 = initRes.headers.get("mcp-session-id") ?? "";
	check(sid1 !== "", "Mcp-Session-Id issued");

	// 3. Version negotiation refuses to echo an arbitrary version.
	let r = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, AUTH);
	const neg = (await r.json()) as { result: { protocolVersion: string } };
	const sid2 = r.headers.get("mcp-session-id") ?? "";
	check(r.status === 200 && neg.result.protocolVersion === "2025-11-25", "unsupported requested version -> server version");

	// 4. Session enforcement.
	r = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...AUTH, "mcp-session-id": sid1 });
	check(r.status === 202, "notification with session -> 202");
	r = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, AUTH);
	check(r.status === 400, `notification without session -> 400 (got ${r.status})`);
	r = await post({ jsonrpc: "2.0", id: 3, method: "ping" }, AUTH);
	check(r.status === 400, `request without session -> 400 (got ${r.status})`);
	r = await post({ jsonrpc: "2.0", id: 4, method: "ping" }, { ...AUTH, "mcp-session-id": "bogus" });
	check(r.status === 404, `unknown session -> 404 (got ${r.status})`);

	// 5. Auth placement.
	r = await post({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
	check(r.status === 401, `no token -> 401 (got ${r.status})`);
	r = await post({ jsonrpc: "2.0", id: 6, method: "initialize", params: {} }, { authorization: "Bearer nope" });
	check(r.status === 401, `wrong token -> 401 (got ${r.status})`);
	r = await fetch(base, { method: "DELETE", headers: { "mcp-session-id": sid1 } });
	check(r.status === 401, `unauthenticated DELETE -> 401 (got ${r.status})`);
	r = await post({ jsonrpc: "2.0", id: 7, method: "ping" }, { ...AUTH, "mcp-session-id": sid1 });
	check(r.status === 200, "session survived unauthenticated DELETE");

	// 6. JSON-RPC validation.
	r = await fetch(base);
	check(r.status === 405, `GET -> 405 (got ${r.status})`);
	r = await post("{broken", AUTH);
	check(r.status === 400, `broken JSON -> 400 (got ${r.status})`);
	r = await post({ jsonrpc: "1.0", id: 8, method: "ping" }, AUTH);
	check(r.status === 400, `jsonrpc 1.0 -> 400 (got ${r.status})`);
	r = await post([{ jsonrpc: "2.0", id: 9, method: "ping" }], AUTH);
	check(r.status === 400, `batch -> 400 (got ${r.status})`);

	// 7. Exposure: deny list + catalog intersection.
	r = await post({ jsonrpc: "2.0", id: 10, method: "tools/list" }, { ...AUTH, "mcp-session-id": sid1 });
	const list = (await r.json()) as { result: { tools: Array<{ name: string }> } };
	const names = list.result.tools.map(t => t.name);
	check(names.includes("read"), "tools/list contains read");
	check(!names.includes("bash"), "denied tool absent from tools/list");
	r = await post(
		{ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } },
		{ ...AUTH, "mcp-session-id": sid1 },
	);
	let call = (await r.json()) as { result: { isError: boolean; content: Array<{ text?: string }> } };
	check(
		call.result.isError === true && (call.result.content[0]?.text ?? "").includes("not exposed"),
		"denied tool call -> isError, not exposed",
	);
	r = await post(
		{ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "xd://read", arguments: {} } },
		{ ...AUTH, "mcp-session-id": sid1 },
	);
	call = (await r.json()) as { result: { isError: boolean; content: Array<{ text?: string }> } };
	check(
		call.result.isError === true && (call.result.content[0]?.text ?? "").includes("not exposed"),
		"alias xd://read -> isError, not exposed",
	);

	// 8. Real tool execution on the live Main session.
	r = await post(
		{ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "read", arguments: { path: dataFile } } },
		{ ...AUTH, "mcp-session-id": sid1 },
	);
	call = (await r.json()) as { result: { isError: boolean; content: Array<{ text?: string }> } };
	const text = call.result.content.map(c => c.text ?? "").join("\n");
	check(call.result.isError === false && text.includes(payload.split("\n")[0]!), "tools/call read works on Main session");

	// 9. Audit log: two-phase records — start at dispatch, done on completion.
	const audit = await until(async () => {
		if (!existsSync(auditPath)) return null;
		const content = readFileSync(auditPath, "utf8");
		// wait for done: its dispatch-ordered append implies start has landed
		return content.includes('"phase":"done","tool":"read"') ? content : null;
	}, "audit done record for read");
	check(audit.includes('"phase":"start","tool":"read"'), "audit start record for read");
	check(audit.includes('"phase":"start","tool":"bash"'), "audit start record for denied bash probe");
	const recs: Array<{ id?: string; phase?: string }> = [];
	for (const l of audit.trim().split("\n")) {
		try {
			recs.push(JSON.parse(l) as { id?: string; phase?: string });
		} catch {
			// partial trailing line
		}
	}
	const startIds = new Set(recs.filter(r => r.phase === "start").map(r => r.id));
	check(
		recs.filter(r => r.phase === "done").every(r => startIds.has(r.id)),
		"every done record pairs with a start record",
	);
	check((statSync(auditPath).mode & 0o777) === 0o600, "audit log is 0600");

	// 10. Authenticated DELETE terminates the session (destructive; uses sid2).
	r = await fetch(base, { method: "DELETE", headers: { ...AUTH, "mcp-session-id": sid2 } });
	check(r.status === 204, `authenticated DELETE -> 204 (got ${r.status})`);
	r = await post({ jsonrpc: "2.0", id: 14, method: "ping" }, { ...AUTH, "mcp-session-id": sid2 });
	check(r.status === 404, `deleted session -> 404 (got ${r.status})`);

	if (failures > 0) throw new Error(`${failures} check(s) failed`);
	console.log("HARDEN OK");
} catch (e) {
	if (!(e instanceof Error && e.message.includes("check(s) failed"))) {
		console.error(`FAIL: unexpected: ${(e as Error)?.message ?? String(e)}`);
		console.error(`--- omp stdout tail ---\n${readFileSync(outLog, "utf8").slice(-1500)}`);
	}
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
	await Bun.sleep(500);
	if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(tmp, { recursive: true, force: true });
}
