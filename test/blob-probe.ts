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
 * One request carries at most 128 MB: `maxRequestBodySize` on `Bun.serve` in
 * src/server.ts caps every request on this port, MCP included. The endpoint does
 * not raise it — that would let concurrent uploads each buffer up to the new
 * ceiling. So a larger image still chunks, but the chunk is raw bytes rather than
 * base64, which is ~33% less to send and skips the encode/decode on both sides.
 * The measured memory cost of the cap is in the RSS block near the end of this
 * probe, and what the docs conclude from it is in `docs/protocol.md`.
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

	// Upload-only. GET must not read the file back (it holds whatever was just
	// written) and DELETE must not remove it — an earlier routing slip answered
	// `DELETE /blob` with 400 "empty body", which reads like a malformed upload
	// rather than a method this endpoint does not have.
	const spy = at("spy.bin");
	await post(`?path=${encodeURIComponent(spy)}`, "still-here");
	for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
		const r = await fetch(`${base}/blob?path=${encodeURIComponent(spy)}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "mcp-session-id": SID },
		});
		check(`${method} /blob → 405`, r.status === 405, `http=${r.status}`);
	}
	check("nothing read it back or deleted it", readFileSync(spy, "utf8") === "still-here");
	unlinkSync(spy);

	// A firmware upload should not have to guess whether ~/flash exists.
	const deep = at("nested/dir/fw.bin");
	const rDeep = await post(`?path=${encodeURIComponent(deep)}`, "deep");
	check("missing parent directories are created", rDeep.status === 200 && existsSync(deep), `http=${rDeep.status}`);

	// Audit: present, tagged, and free of the payload.
	await Bun.sleep(400);
	const log = await Bun.file(join(agentDir, "a2a-bridge.log")).text();
	check("the write is audited as blob:write", log.includes('"tool":"blob:write"'));
	check("the audit record holds no payload", !log.includes(bytes.subarray(0, 48).toString("base64")));

	/**
	 * RSS across a big upload.
	 *
	 * docs/protocol.md carries measured host-RSS numbers next to the request-body
	 * cap. Those were taken once, on host 18.6.1, and the host has moved on since
	 * — a memory claim in the docs that nothing re-checks rots quietly. This
	 * measures them again and writes `rss-<hostversion>.json` next to the probe
	 * (last run wins), so the docs table is refreshed from a run rather than from
	 * memory.
	 *
	 * RSS is the host *process*, read from /proc, so it includes the host itself
	 * and only the deltas mean anything. Settled readings take the lowest of
	 * three (Bun returns memory to the OS lazily); the *peaks* are sampled while
	 * the uploads are still in flight.
	 *
	 * No threshold is asserted, and the reason is worth keeping: this was going to
	 * gate on "concurrent bodies cost less than the sum", and measurement killed
	 * that idea. Settled deltas for a single 8 MB body across seven runs on an idle
	 * box were +11, +26, +171, +165, +10, +18, and −6 MB — the last one below the
	 * idle reading, i.e. the host holding *less* memory after an upload than before
	 * it. The concurrent pair settled at +147, +148 and +44 MB, its peak at +245,
	 * +248 and +44 MB. Nothing here is reproducible enough to gate on. That spread
	 * is Bun's allocator — arena growth plus memory returned lazily from the 100 MB
	 * upload a few lines earlier — not whether this handler holds the body, so any
	 * threshold would be measuring the allocator and would redden a busy CI runner
	 * for reasons that have nothing to do with the bridge.
	 *
	 * So the numbers are printed and archived to `rss-<hostversion>.json`, which
	 * is what the docs table gets refreshed from. What *is* asserted is that the
	 * uploads succeed at the sizes the docs promise (100 MB in one request), since
	 * that part is deterministic. The docs' warning about concurrency comes from
	 * the per-request cap, not from these numbers.
	 */
	const rssMb = async (): Promise<number> => {
		let lowest = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 3; i++) {
			const now = rssNow();
			if (!Number.isFinite(now)) return Number.NaN; // no /proc: nothing to report
			lowest = Math.min(lowest, now);
			await Bun.sleep(300);
		}
		return lowest;
	};

	const bigBody = Buffer.alloc(100 * 1024 * 1024, 0x5a);

	const rssNow = (): number => {
		// Synchronous on purpose. An async read resolves after the fact, so a
		// fast upload can finish before the first sample lands — which is exactly
		// what happened with an 8 MB body and a 200 ms interval: peak stayed 0.
		try {
			const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${host.pid}/status`, "utf8"));
			return m ? Number(m[1]) / 1024 : Number.NaN;
		} catch {
			return Number.NaN;
		}
	};
	/**
	 * Peak, not settled — settled cannot see an in-flight body at all.
	 *
	 * This ordering matters and is not accidental: an earlier version sampled
	 * settled RSS only, which cannot distinguish a body that streamed to disk from
	 * one held whole in memory, because Bun has released both by then. Peak is
	 * the only reading that looks while the body is still there.
	 *
	 * Note the claim in the header about a mutant peaking near 2x was **not**
	 * reproducible — two attempted mutants (delaying the write, delaying the read)
	 * both stayed within the same noise band as the real path. Hence no threshold.
	 * The peak sampling stays because it is the honest instrument; it just does
	 * not get to pretend to be a verdict.
	 */
	const peakWhile = async (run: () => Promise<unknown>): Promise<number> => {
		let peak = 0;
		// 5 ms: an 8 MB upload lands in ~200 ms, and the whole point is to catch
		// the moment the body is in flight.
		const sampler = setInterval(() => {
			const now = rssNow();
			if (Number.isFinite(now)) peak = Math.max(peak, now);
		}, 5);
		try {
			await run();
		} finally {
			// One last sample before stopping, in case the body never overlapped a
			// tick (the very first upload can already be finished on a fast disk).
			const now = rssNow();
			if (Number.isFinite(now)) peak = Math.max(peak, now);
			clearInterval(sampler);
		}
		return peak;
	};

	const idle = await rssMb();
	const tRss = Date.now();

	/**
	 * 8 MB bodies rather than 100 MB, so the deltas sit above the allocator's
	 * noise floor instead of being swamped by it. The 100 MB path is exercised
	 * right after, and that one *is* asserted.
	 */
	const probeBody = Buffer.alloc(8 * 1024 * 1024, 0x5a);

	const peakOne = await peakWhile(() => post(`?path=${encodeURIComponent(at("rss-single.bin"))}`, probeBody));
	const afterOne = await rssMb();
	const rssConc: Response[] = [];
	const peakTwo = await peakWhile(() =>
		Promise.all([
			post(`?path=${encodeURIComponent(at("rss-c1.bin"))}`, probeBody).then((r) => rssConc.push(r)),
			post(`?path=${encodeURIComponent(at("rss-c2.bin"))}`, probeBody).then((r) => rssConc.push(r)),
		]),
	);
	const afterTwo = await rssMb();

	// The 100 MB path must still work while we are measuring; the byte-identity
	// assertion for it lives earlier in this probe.
	const hundredStatus = (await post(`?path=${encodeURIComponent(at("rss-hundred.bin"))}`, bigBody)).status;

	console.log(
		`      RSS idle ${idle.toFixed(0)} MB | peak: one 8 MB body ${peakOne.toFixed(0)} MB ` +
			`(+${(peakOne - idle).toFixed(0)}) | two concurrent ${peakTwo.toFixed(0)} MB ` +
			`(+${(peakTwo - idle).toFixed(0)}) | settled ${afterOne.toFixed(0)}/${afterTwo.toFixed(0)} MB | ` +
			`100 MB still ${hundredStatus} | ${((Date.now() - tRss) / 1000).toFixed(1)}s | ` +
			`http=${rssConc.map((r) => r.status).join("/")}`,
	);

	const finite = Number.isFinite(idle) && Number.isFinite(peakOne) && Number.isFinite(peakTwo) && peakOne > 0;
	check(
		"the concurrent uploads were accepted while measuring RSS",
		rssConc.length === 2 && rssConc.every((r) => r.status === 200),
	);
	check("the 100 MB single request still works in this run", hundredStatus === 200, `http=${hundredStatus}`);
	// Deliberately no threshold on the numbers above — the reason is in the header
	// of this block. What is gated is only what is deterministic: that the uploads
	// the docs promise actually happened.
	if (finite) {
		const versionOut = await new Response(Bun.spawn(["omp", "--version"]).stdout).text();
		const hostVersion = versionOut.trim().replace(/^omp\//, "");
		await Bun.write(
			join(import.meta.dir, `rss-${hostVersion}.json`),
			`${JSON.stringify(
				{
					hostVersion,
					measuredAt: new Date().toISOString().slice(0, 10),
					probeBodyMB: probeBody.length / 1024 / 1024,
					hundredMBStatus: hundredStatus,
					idleMB: Math.round(idle),
					peakOneUploadMB: Math.round(peakOne),
					peakTwoConcurrentMB: Math.round(peakTwo),
					settledAfterOneMB: Math.round(afterOne),
					settledAfterTwoMB: Math.round(afterTwo),
					peakDeltaOneMB: Math.round(peakOne - idle),
					peakDeltaTwoMB: Math.round(peakTwo - idle),
					settledDeltaOneMB: Math.round(afterOne - idle),
					settledDeltaTwoMB: Math.round(afterTwo - idle),
				},
				null,
				"\t",
			)}\n`,
		);
		console.log(`      wrote test/rss-${hostVersion}.json — refresh the protocol.md table from it`);
	} else {
		// The docs promise the table is refreshed per run, so say when it was not:
		// no /proc means any rss-<version>.json on disk is from an earlier machine,
		// not from this run.
		console.log(
			"      SKIP  RSS not archived (no /proc for the host process) — an existing test/rss-*.json is stale, not this run",
		);
	}
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
