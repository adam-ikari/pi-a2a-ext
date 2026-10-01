/**
 * Real E2E smoke: boots a real omp process loading the a2a extension,
 * then drives the MCP protocol with bare fetch. tools/call read lands in
 * the real Main session. Prints "SMOKE OK" on success.
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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "a2a-smoke-"));
const agentDir = join(tmp, ".omp", "agent");
const extDir = join(agentDir, "extensions");
const cfgPath = join(agentDir, "a2a-bridge.json");
const outLog = join(tmp, "omp.out.log");
const errLog = join(tmp, "omp.err.log");
const payload = `SMOKE-PAYLOAD-${Date.now()}\nsecond line\n`;
const dataFile = join(tmp, "payload.txt");
const TOKEN = "smoke-token";

mkdirSync(extDir, { recursive: true });
symlinkSync(resolve(REPO, "extensions", "a2a-bridge.ts"), join(extDir, "a2a-bridge.ts"));
writeFileSync(dataFile, payload);

// Pick a free port so the config can pin it (port 0 would leave the actual
// port unknown to this script).
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port ?? 0;
probe.stop(true);

// Pre-seed the config so loadConfig reads our token/port rather than
// generating a default (port 0) config.
const cfg = { port: PORT, token: TOKEN, host: "127.0.0.1" };
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// omp refuses to boot without any model auth. Copy the developer's real
// models.yml (provider/api-key catalog) into the temp HOME so the session —
// and hence the extension's session_start — actually runs. Nothing else
// from the real HOME is shared.
const realModelsYml = join(process.env.HOME ?? "", ".omp", "agent", "models.yml");
if (existsSync(realModelsYml)) {
	copyFileSync(realModelsYml, join(agentDir, "models.yml"));
} else {
	fail(`no model config at ${realModelsYml}; cannot boot omp`);
}

const OMP_BIN = process.env.OMP_BIN ?? "omp";
const child = spawn(OMP_BIN, ["--mode", "rpc"], {
	env: { ...process.env, HOME: tmp, A2A_BRIDGE_CONFIG: cfgPath },
	stdio: ["pipe", openSync(outLog, "w"), openSync(errLog, "w")],
});
// Keep stdin open: rpc mode stays alive on the pipe.

function fail(label: string): never {
	console.error(`FAIL: ${label}`);
	console.error(`--- omp stdout tail ---\n${readFileSync(outLog, "utf8").slice(-2000)}`);
	console.error(`--- omp stderr tail ---\n${readFileSync(errLog, "utf8").slice(-2000)}`);
	process.exitCode = 1;
	throw new Error(label);
}

const base = `http://127.0.0.1:${PORT}/`;
const JSON_HDR = { "content-type": "application/json" };

async function waitForServer(): Promise<Response> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(base, {
				method: "POST",
				headers: { ...JSON_HDR, authorization: `Bearer ${TOKEN}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			});
			if (r.status === 200) return r;
		} catch {
			// server not listening yet
		}
		await Bun.sleep(500);
	}
	return fail(`server did not come up in 30s (port ${PORT})`);
}

try {
	const initRes = await waitForServer();
	const init = (await initRes.json()) as { result?: { protocolVersion?: string } };
	if (!init.result?.protocolVersion) {
		fail("initialize result.protocolVersion missing");
	}
	console.log(`ok: initialize -> protocolVersion ${init.result.protocolVersion}`);
	const sid = initRes.headers.get("mcp-session-id");
	if (!sid) fail("initialize missing Mcp-Session-Id header");
	const AUTH = { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid };

	// notification -> 202
	let r = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});
	if (r.status !== 202) fail(`notification expected 202, got ${r.status}`);

	// tools/list contains read
	r = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
	});
	const list = (await r.json()) as { result: { tools: Array<{ name: string }> } };
	if (!list.result?.tools?.some((t) => t.name === "read")) {
		fail(`tools/list missing 'read'; got ${JSON.stringify(list.result?.tools?.map((t) => t.name))}`);
	}
	console.log(`ok: tools/list exposes ${list.result.tools.length} tools incl. read`);

	// real read tool call on Main session
	r = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "read", arguments: { path: dataFile } },
		}),
	});
	const call = (await r.json()) as {
		result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
	};
	const text = call.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
	if (call.result?.isError) fail(`read returned isError: ${text.slice(0, 300)}`);
	const firstLine = payload.split("\n")[0];
	if (!text.includes(firstLine)) {
		console.error(`--- read content (first 500 chars) ---\n${text.slice(0, 500)}`);
		fail("read result missing payload content");
	}
	console.log("ok: tools/call read returned file content from Main session");

	// unknown tool -> isError
	r = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool" } }),
	});
	const unkTool = (await r.json()) as { result?: { isError?: boolean } };
	if (!unkTool.result?.isError) fail("no_such_tool expected isError=true");

	// no token -> 401
	r = await fetch(base, {
		method: "POST",
		headers: JSON_HDR,
		body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }),
	});
	if (r.status !== 401) fail(`no-token initialize expected 401, got ${r.status}`);

	// unknown method -> -32601
	r = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "foo" }),
	});
	const unk = (await r.json()) as { error?: { code?: number } };
	if (unk.error?.code !== -32601) fail(`unknown method expected -32601, got ${JSON.stringify(unk.error)}`);

	console.log("SMOKE OK");
} catch (e) {
	if (e instanceof Error && e.message.startsWith("FAIL:")) {
		// already reported
	} else {
		fail(`unexpected: ${(e as Error)?.message ?? String(e)}`);
	}
} finally {
	child.kill("SIGTERM");
	await Bun.sleep(500);
	if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(tmp, { recursive: true, force: true });
}
