/**
 * Blob endpoint probe: raw-byte upload over `POST /blob`.
 *
 *   bun run test:blob
 *
 * ## What it checks
 *
 * That a caller can put bytes on the host without encoding them, and that the
 * endpoint's refusals hold: no token, no path, empty body, an offset that does
 * not match the file's current size, a body over the server's limit. Also that a
 * write is audited as `blob:write` with metadata only — the payload must never
 * land in the log.
 *
 * The byte-identity assertions are the point. A status of 200 is not proof the
 * bytes arrived, and a size check is not proof of content: an earlier version of
 * this probe asserted only `size === 1_500_000` and passed while the contents
 * were wrong. Every write is compared with `Buffer.equals`.
 *
 * ## The ceiling
 *
 * One request carries at most 1 MB: `maxRequestBodySize` on `Bun.serve` in
 * src/server.ts caps every request on this port, MCP included. The endpoint does
 * not raise it — that would let concurrent uploads each buffer tens of MB. So a
 * large image still chunks, but the chunk is raw bytes rather than base64, which
 * is ~33% less to send and skips the encode/decode on both sides.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkExtension, seedModels } from "./harness";

const home = mkdtempSync(join(tmpdir(), "blob-"));
const agentDir = join(home, ".omp", "agent");
console.log(`  ${seedModels(agentDir)}`);
linkExtension(agentDir);

const host = spawn("omp", ["--mode", "rpc"], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
let out = "";
host.stdout.on("data", (d) => (out += d));
host.stderr.on("data", (d) => (out += d));
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !out.includes("A2A bridge listening")) {
	host.stdin.write("");
	await Bun.sleep(300);
}
const base = out.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
if (!base) {
	console.log("FAIL  the host never announced the bridge");
	console.log(out.slice(0, 400));
	host.kill();
	process.exit(1);
}
const token = JSON.parse(await Bun.file(join(agentDir, "a2a-bridge.json")).text()).token as string;
const initRes = await fetch(base, {
	method: "POST",
	headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
	body: JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "blob", version: "1" } },
	}),
});
const SID = initRes.headers.get("mcp-session-id") ?? "";

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"}  ${label}${cond || !detail ? "" : `  ${detail}`}`);
	if (!cond) failures++;
};

const post = (query: string, body: BodyInit, auth = true) =>
	fetch(`${base}/blob${query}`, {
		method: "POST",
		headers: {
			"content-type": "application/octet-stream",
			...(auth ? { authorization: `Bearer ${token}`, "mcp-session-id": SID } : {}),
		},
		body,
	});

const scratch = mkdtempSync(join(tmpdir(), "blob-files-"));
const at = (name: string) => join(scratch, name);

try {
	// Raw bytes, no encoding. Every byte value, so any accidental UTF-8
	// round-trip through a string would corrupt it.
	const bytes = Buffer.alloc(768 * 1024);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
	const t1 = at("raw.bin");
	const r1 = await post(`?path=${encodeURIComponent(t1)}`, bytes);
	check(
		"raw 768 KB arrives byte-identical, nothing encoded",
		r1.status === 200 && existsSync(t1) && readFileSync(t1).equals(bytes),
		`http=${r1.status}`,
	);

	// The single-request path is the one that matters for firmware: a 100 MB
	// image in one call, byte-identical. This is the assertion that would have
	// caught the old 1 MB cap.
	const hundred = Buffer.alloc(100 * 1024 * 1024);
	for (let i = 0; i < hundred.length; i += 4096)
		hundred.fill((i / (1024 * 1024)) & 0xff, i, Math.min(i + 4096, hundred.length));
	const tBig = at("hundred.bin");
	const t0 = Date.now();
	const rBig = await post(`?path=${encodeURIComponent(tBig)}`, hundred);
	check(
		"a 100 MB image arrives in ONE request, byte-identical",
		rBig.status === 200 &&
			existsSync(tBig) &&
			statSync(tBig).size === hundred.length &&
			readFileSync(tBig).equals(hundred),
		`http=${rBig.status} size=${existsSync(tBig) ? statSync(tBig).size : "none"}`,
	);
	console.log(`      (100 MB in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

	// And the ceiling is a clean 413, not a truncated file.
	const rOver = await post(`?path=${encodeURIComponent(at("over.bin"))}`, Buffer.alloc(129 * 1024 * 1024, 0x41));
	check("a body over maxRequestBodySize is refused with 413", rOver.status === 413, `http=${rOver.status}`);
	unlinkSync(tBig);

	// Chunked upload at EOF, each chunk raw.
	const t2 = at("chunked.bin");
	const parts = [0x40, 0x41, 0x42].map((b) => Buffer.alloc(500 * 1024, b));
	let chunkErr = "";
	for (let i = 0; i < parts.length; i++) {
		const r = await post(`?path=${encodeURIComponent(t2)}`, parts[i]);
		if (r.status !== 200) {
			chunkErr = `chunk ${i + 1}: http=${r.status}`;
			break;
		}
	}
	check(
		"3 chunks of 500 KB concatenate byte-identically",
		chunkErr === "" && existsSync(t2) && readFileSync(t2).equals(Buffer.concat(parts)),
		chunkErr || (existsSync(t2) ? "contents differ" : "no file"),
	);

	// Refusals.
	check("no token → 401", (await post(`?path=${encodeURIComponent(t1)}`, "x", false)).status === 401);
	check("no path → 400", (await post("", "x")).status === 400);
	check("empty body → 400", (await post(`?path=${encodeURIComponent(at("empty.bin"))}`, "")).status === 400);
	const mismatched = await post(`?path=${encodeURIComponent(t1)}&offset=5`, "x");
	check("offset that is not the current size → 409", mismatched.status === 409, `http=${mismatched.status}`);
	check("non-integer offset → 400", (await post(`?path=${encodeURIComponent(t1)}&offset=abc`, "x")).status === 400);

	// A firmware upload should not have to guess whether ~/flash exists.
	const deep = at("nested/dir/fw.bin");
	const rDeep = await post(`?path=${encodeURIComponent(deep)}`, "deep");
	check("missing parent directories are created", rDeep.status === 200 && existsSync(deep), `http=${rDeep.status}`);

	// Audit: present, tagged, and free of the payload.
	await Bun.sleep(400);
	const log = await Bun.file(join(agentDir, "a2a-bridge.log")).text();
	check("the write is audited as blob:write", log.includes('"tool":"blob:write"'));
	check("the audit record holds no payload", !log.includes(bytes.subarray(0, 48).toString("base64")));
} finally {
	host.kill("SIGTERM");
	rmSync(scratch, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nBLOB: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nBLOB OK: raw-byte upload works and every refusal holds");
