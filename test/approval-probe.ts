/**
 * Approval-boundary probe (bun run test:approval; ~2 min; requires the omp
 * binary, no model credentials — see harness.ts).
 *
 * Discriminates the behavior of a `prompt`-tier tool call (bash) arriving in
 * rpc mode, where the host has no interactive UI to answer the approval:
 *
 *  A. returns isError promptly, no side effect
 *     -> fail-closed; the README approval section must describe it as such.
 *  B. request hangs (client aborts at 90s), no side effect, server stays up,
 *     read still works, and the audit log shows start-without-done
 *     -> CURRENT EXPECTED BEHAVIOR: the command does not execute (safe in the
 *     no-execution sense), but the caller gets no answer — clients must set
 *     their own timeout. This is what README's approval section documents.
 *  C. side-effect file exists
 *     -> FAIL-OPEN (worst case).
 *
 * Exit 1 on verdict C, an unexpected return shape, or broken audit visibility
 * (no start record for the call, or a done record for a call verdicted hung).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { linkExtension, seedModels } from "./harness.ts";

const _REPO = resolve(process.env.REPO ?? join(import.meta.dir, ".."));
const tmp = mkdtempSync(join(tmpdir(), "a2a-apv2-"));
const agentDir = join(tmp, ".omp", "agent");
const _extDir = join(agentDir, "extensions");
const cfgPath = join(agentDir, "a2a-bridge.json");
const outLog = join(tmp, "omp.out.log");
const errLog = join(tmp, "omp.err.log");
const auditPath = join(agentDir, "a2a-bridge.log");
const sideEffect = join(tmp, "SIDE-EFFECT-HAPPENED");

linkExtension(agentDir);

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port ?? 0;
probe.stop(true);
writeFileSync(cfgPath, JSON.stringify({ port: PORT, host: "127.0.0.1" }, null, 2));

// Placeholder provider: this probe hangs a bash call on the host's approval
// prompt, which never reaches a model either.
seedModels(agentDir);

const t0 = Date.now();
const stage = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const child = spawn(process.env.OMP_BIN ?? "omp", ["--mode", "rpc", "--approval-mode=always-ask"], {
	env: { ...process.env, HOME: tmp, A2A_BRIDGE_CONFIG: cfgPath, A2A_BRIDGE_AUDIT: auditPath },
	stdio: ["pipe", openSync(outLog, "w"), openSync(errLog, "w")],
});

const base = `http://127.0.0.1:${PORT}/`;
const AUTH: Record<string, string> = {};

async function post(body: unknown, headers: Record<string, string>, ms?: number): Promise<Response> {
	return fetch(base, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: ms ? AbortSignal.timeout(ms) : undefined,
	});
}

try {
	let token = "";
	const dl = Date.now() + 30000;
	while (Date.now() < dl && !token) {
		try {
			const t = (JSON.parse(readFileSync(cfgPath, "utf8")) as { token?: string }).token;
			if (t) token = t;
		} catch {}
		await Bun.sleep(200);
	}
	if (!token) throw new Error("token heal timeout");
	AUTH.authorization = `Bearer ${token}`;
	stage(`token healed (${token.length} chars)`);

	let sid = "";
	const dl2 = Date.now() + 30000;
	while (Date.now() < dl2 && !sid) {
		try {
			const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, AUTH, 5000);
			if (r.status === 200) {
				sid = r.headers.get("mcp-session-id") ?? "";
				break;
			}
		} catch {}
		await Bun.sleep(300);
	}
	if (!sid) throw new Error("server up timeout");
	const H = { ...AUTH, "mcp-session-id": sid };
	stage("server up, session issued");

	const rn = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, H, 5000);
	stage(`notify -> ${rn.status}`);

	// read-only tool under always-ask: schema says always-ask auto-approves
	// read-only tools -> should return fast. Also proves server is alive.
	const tRead = Date.now();
	try {
		const rr = await post(
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { path: cfgPath } } },
			H,
			15000,
		);
		const rb = (await rr.json()) as { result?: { isError?: boolean } };
		stage(`read call -> http ${rr.status}, isError=${rb.result?.isError} (${Date.now() - tRead}ms)`);
	} catch (e) {
		stage(`read call TIMED OUT (${Date.now() - tRead}ms): ${(e as Error).message}`);
	}

	// THE decisive call: bash under always-ask (prompt) in rpc (no UI).
	const tBash = Date.now();
	let verdict = "";
	try {
		const br = await post(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "bash", arguments: { command: `touch ${sideEffect}` } },
			},
			H,
			90000,
		);
		const bb = (await br.json()) as {
			result?: { isError?: boolean; content: Array<{ text?: string }> };
			error?: unknown;
		};
		const txt = (bb.result?.content ?? [])
			.map((c) => c.text ?? "")
			.join("\n")
			.slice(0, 300);
		stage(
			`bash call RETURNED in ${Date.now() - tBash}ms: http ${br.status} isError=${bb.result?.isError} error=${JSON.stringify(bb.error ?? null)}`,
		);
		stage(`bash text: ${txt}`);
		verdict = bb.result?.isError
			? "A: isError returned promptly -> behavior regressed to fail-closed; update README approval section"
			: "UNEXPECTED: returned but not isError";
		if (!bb.result?.isError) process.exitCode = 1;
	} catch (e) {
		const ms = Date.now() - tBash;
		stage(`bash call THREW after ${ms}ms: ${(e as Error).name} ${(e as Error).message}`);
		verdict = `B: request hung >=${ms}ms (aborted) -> NOT isError; see side-effect below`;
	}

	await Bun.sleep(2000);
	const executed = existsSync(sideEffect);
	stage(`side-effect file exists: ${executed}`);
	if (executed) {
		verdict = "C: FAIL-OPEN — command executed under prompt policy in no-UI mode";
		process.exitCode = 1;
	}

	// server liveness after the blocked call
	try {
		const rr = await post({ jsonrpc: "2.0", id: 4, method: "ping" }, H, 5000);
		stage(`post-bash ping -> ${rr.status} (server ${rr.status === 200 ? "alive" : "degraded"})`);
	} catch (e) {
		stage(`post-bash ping failed: ${(e as Error).message} (server possibly stuck)`);
	}

	// Traceability check: an unsettled call must still leave a start record.
	try {
		const recs: Array<{ id?: string; phase?: string; tool?: string }> = [];
		for (const l of readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean)) {
			try {
				recs.push(JSON.parse(l) as { id?: string; phase?: string; tool?: string });
			} catch {
				// partial trailing line
			}
		}
		const starts = recs.filter((r) => r.tool === "bash" && r.phase === "start").length;
		const dones = recs.filter((r) => r.tool === "bash" && r.phase === "done").length;
		stage(`audit: bash records start=${starts} done=${dones}`);
		if (starts === 0) {
			stage("AUDIT FAIL: call left no start record (dispatch-time audit broken)");
			process.exitCode = 1;
		} else if (verdict.startsWith("B") && dones > 0) {
			stage("AUDIT FAIL: verdict B but a done record exists (call actually settled)");
			process.exitCode = 1;
		} else if (dones === 0) {
			stage("audit OK: start-without-done makes the hang visible");
		} else {
			stage("audit OK: call settled, both phases recorded");
		}
	} catch (e) {
		stage(`AUDIT FAIL: cannot read audit log: ${(e as Error).message}`);
		process.exitCode = 1;
	}

	console.log(`VERDICT: ${verdict}`);
} catch (e) {
	console.error(`FAIL: ${(e as Error).message}`);
	console.error(readFileSync(errLog, "utf8").slice(-600));
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
	await Bun.sleep(400);
	if (child.exitCode === null) child.kill("SIGKILL");
	// keep tmp on failure for inspection
	if (process.exitCode !== 1) rmSync(tmp, { recursive: true, force: true });
	else console.error(`evidence kept at ${tmp}`);
}
