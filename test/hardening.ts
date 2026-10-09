/**
 * Real-host hardening verification (bun run test:hardening; requires the omp
 * binary, no model credentials — see harness.ts).
 * Boots omp with the a2a extension and asserts the review fixes against the
 * LIVE server: auth placement, mandatory session id, version negotiation,
 * catalog exposure gate, healed 0600 token, and the two-phase audit log.
 * Prints "HARDEN OK" on success; exits 1 on any failure.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { linkExtension, seedModels } from "./harness.ts";

const _REPO = resolve(process.env.REPO ?? join(import.meta.dir, ".."));
const tmp = mkdtempSync(join(tmpdir(), "a2a-harden-"));
const agentDir = join(tmp, ".omp", "agent");
const _extDir = join(agentDir, "extensions");
const cfgPath = join(agentDir, "a2a-bridge.json");
const auditPath = join(agentDir, "a2a-bridge.log");
const outLog = join(tmp, "omp.out.log");
const errLog = join(tmp, "omp.err.log");
const dataFile = join(tmp, "payload.txt");
const firstLine = `HARDEN-PAYLOAD-${Date.now()}`;
const payload = `${firstLine}\nsecond line\n`;

let failures = 0;
function check(cond: unknown, label: string): void {
	if (cond) {
		console.log(`ok: ${label}`);
	} else {
		console.error(`FAIL: ${label}`);
		failures++;
	}
}

linkExtension(agentDir);
writeFileSync(dataFile, payload);

// Free port (probe-then-close, same approach as smoke.ts).
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port ?? 0;
probe.stop(true);

// Seed config WITHOUT a token: the app must heal it (generate + persist + 0600)
// while keeping our fixed port.
writeFileSync(cfgPath, JSON.stringify({ port: PORT, host: "127.0.0.1" }, null, 2));

// A placeholder provider is enough: the bridge runs tools, it never calls a
// model, so the host only needs *some* model config to boot.
console.log(seedModels(agentDir));

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
	check(
		(statSync(cfgPath).mode & 0o777) === 0o600,
		`config is 0600 after heal (got ${(statSync(cfgPath).mode & 0o777).toString(8)})`,
	);

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
	check(
		r.status === 200 && neg.result.protocolVersion === "2025-11-25",
		"unsupported requested version -> server version",
	);

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

	// 7. Exposure: the catalog is the host registry verbatim, and anything
	// outside it is unreachable (aliases, guessed names).
	r = await post({ jsonrpc: "2.0", id: 10, method: "tools/list" }, { ...AUTH, "mcp-session-id": sid1 });
	const list = (await r.json()) as { result: { tools: Array<{ name: string }> } };
	const names = list.result.tools.map((t) => t.name);
	check(names.includes("read"), "tools/list contains read");
	check(!names.some((n) => n.startsWith("a2a_file_")), "no bridge-owned tools in the catalog");
	r = await post(
		{ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "definitely_not_a_tool", arguments: {} } },
		{ ...AUTH, "mcp-session-id": sid1 },
	);
	let call = (await r.json()) as { result: { isError: boolean; content: Array<{ text?: string }> } };
	check(
		call.result.isError === true && (call.result.content[0]?.text ?? "").includes("not exposed"),
		"unregistered tool call -> isError, not exposed",
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
	const text = call.result.content.map((c) => c.text ?? "").join("\n");
	check(call.result.isError === false && text.includes(firstLine), "tools/call read works on Main session");

	// 9. Audit log: two-phase records — start at dispatch, done on completion.
	const audit = await until(async () => {
		if (!existsSync(auditPath)) return null;
		const content = readFileSync(auditPath, "utf8");
		// wait for done: its dispatch-ordered append implies start has landed
		return content.includes('"phase":"done","tool":"read"') ? content : null;
	}, "audit done record for read");
	check(audit.includes('"phase":"start","tool":"read"'), "audit start record for read");
	// Rejected calls are audited too, with both phases.
	check(
		audit.includes('"phase":"start","tool":"definitely_not_a_tool"'),
		"audit start record for the rejected unregistered-tool call",
	);
	const recs: Array<{ id?: string; phase?: string; sid?: string; tool?: string }> = [];
	for (const l of audit.trim().split("\n")) {
		try {
			recs.push(JSON.parse(l) as { id?: string; phase?: string; sid?: string; tool?: string });
		} catch {
			// partial trailing line
		}
	}
	const startIds = new Set(recs.filter((r) => r.phase === "start").map((r) => r.id));
	check(
		recs.filter((r) => r.phase === "done").every((r) => startIds.has(r.id)),
		"every done record pairs with a start record",
	);
	check(
		recs.some((r) => r.phase === "done" && r.tool === "read" && r.sid === sid1),
		"audit records carry the session id (attribution)",
	);
	check((statSync(auditPath).mode & 0o777) === 0o600, "audit log is 0600");

	// 9a. Arg redaction through the real path. The payload nests three levels, which
	// is the shape the host's own `edit` tool uses (`{path, edits: [{oldText}]`) and
	// where the redactor used to stop walking. Checked off-channel, in the log: the
	// call's own response says nothing about what got recorded.
	const secret = "S".repeat(4000);
	await post(
		{
			jsonrpc: "2.0",
			id: 14,
			method: "tools/call",
			params: {
				name: "read",
				arguments: { path: join(tmp, "gone-secret.txt"), edits: [{ oldText: secret }] },
			},
		},
		{ ...AUTH, "mcp-session-id": sid1 },
	);
	const redacted = await until(async () => {
		if (!existsSync(auditPath)) return null;
		const content = readFileSync(auditPath, "utf8");
		return content.includes("<len:4000") ? content : null;
	}, "audit record with the nested arg folded to length+hash");
	check(redacted.includes("<len:4000,sha256:"), "a long string nested three levels deep is recorded as length+hash");
	check(!redacted.includes(secret.slice(0, 60)), "the nested payload itself never reaches the audit log");

	/**
	 * 9b. Audit rotation. `MAX_LOG_BYTES` (512 KB) renames the log to `<path>.1`,
	 * and nothing in this repo had ever crossed that line. Two properties, and they
	 * are different ones:
	 *
	 * - **A rotation moves the ledger, it does not shrink it.** Every record written
	 *   must still be reachable in one of the two files. Records that vanish are the
	 *   failure, because the audit is the only trace this bridge keeps of itself.
	 *   Only true of ONE crossing: the second rotation overwrites `<path>.1`, so
	 *   older records do disappear eventually. That half is measured in
	 *   test/audit.test.ts, where it takes a second to drive instead of thousands of
	 *   host calls.
	 * - **The live file is not a complete ledger on its own.** Pairing and hang
	 *   detection both need `<path>.1` too, so a caller that reads only
	 *   `a2a-bridge.log` sees `done` records whose `start` sits in the other file. The
	 *   approval probe reads an unpaired `start` as a hang, so pairing and hang
	 *   detection both have to look at both files. That is reported here and
	 *   documented in docs/protocol.md rather than asserted, because the bridge writes
	 *   the two files and never reads them.
	 */
	const parse = (l: string): { id?: number; phase?: string } | null => {
		try {
			return JSON.parse(l) as { id?: number; phase?: string };
		} catch {
			return null;
		}
	};
	// A 1000-char path would NOT fatten a record: redact() turns any string longer
	// than 120 chars into `<len:N,sha256:...>`, about 30 bytes, which is why an
	// earlier version of this burst needed ~1.2k calls to cross 512 KB. Ten values
	// under that leaf cap pass through, serializeArgs truncates the whole args at
	// 1024 chars, and each record lands at ~1.1 KB — the cap then takes ~240 calls.
	const fat = Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`f${k}`, "y".repeat(110)]));
	// Records already in the log before the burst, so the burst can be checked as a
	// volume: `tools/call` appends a start and a done, so N calls must add 2N records
	// somewhere across the two files.
	//
	// Not by id. The audit `id` is a per-call UUID (src/bridge.ts) and the JSON-RPC id
	// is never written, so matching the burst's JSON-RPC ids against the log would be
	// looking for numbers that were never in it — a check that fails no matter what
	// the bridge does.
	const countRecords = (path: string) => {
		const recs: { id?: number; phase?: string }[] = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const rec = parse(line);
			if (rec) recs.push(rec);
		}
		return recs;
	};
	const before = countRecords(auditPath).length;
	let calls = 0;
	let rotated = false;
	for (let i = 0; i < 1500 && !rotated; i++) {
		await post(
			{
				jsonrpc: "2.0",
				id: 90000 + i,
				method: "tools/call",
				params: { name: "read", arguments: { path: join(tmp, `gone-${i}.txt`), ...fat } },
			},
			{ ...AUTH, "mcp-session-id": sid1 },
		);
		calls++;
		rotated = existsSync(`${auditPath}.1`);
	}
	await Bun.sleep(500); // appends are async
	const rolled = rotated ? countRecords(`${auditPath}.1`) : [];
	// Re-read: after a rotation the live path is a new file holding only the records
	// appended since the rename, so the snapshot taken in section 9 is stale.
	const live = countRecords(auditPath);
	check(rotated, "the audit log rotated once it passed 512 KB");
	check(
		rolled.length + live.length >= before + 2 * calls,
		`no record vanished across the rotation (${before} before + ${2 * calls} from ${calls} calls, ${rolled.length} rolled + ${live.length} live)`,
	);
	const liveStartIds = new Set(live.filter((rec) => rec.phase === "start").map((rec) => String(rec.id)));
	const orphansInLive = live.filter((rec) => rec.phase === "done" && !liveStartIds.has(String(rec.id))).length;
	const rolledStartIds = new Set(rolled.filter((rec) => rec.phase === "start").map((rec) => String(rec.id)));
	check(
		live
			.filter((rec) => rec.phase === "done")
			.every((rec) => liveStartIds.has(String(rec.id)) || rolledStartIds.has(String(rec.id))),
		`every done pairs with a start across the two files (${orphansInLive} of them pair only through the rotated file)`,
	);
	check(
		rolled.every((rec) => rec.phase === "start" || rec.phase === "done"),
		"the rotated file is intact JSONL",
	);
	if (orphansInLive > 0) {
		console.log(`      note: ${orphansInLive} done record(s) in the live log have their start only in .1`);
	}

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
	// Keep the scene when a check failed: docs/testing.md promises it, and the temp
	// HOME holds the audit log and host output that explain the failure.
	if (process.exitCode !== 1) rmSync(tmp, { recursive: true, force: true });
	else console.error(`      evidence kept at ${tmp}`);
}
