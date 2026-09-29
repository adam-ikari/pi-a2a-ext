/**
 * Real-host file-transfer verification (manual: bun run test:files; requires a
 * local omp + ~/.omp/agent/models.yml).
 * Boots omp with the a2a extension against a live server and drives the bridge's
 * own a2a_file_* tools end to end: inline put/get round trip, chunked upload,
 * the path-sandbox rejections, the size cap, and the audit record shape.
 * Prints "FILES OK" on success; exits 1 on any failure.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
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
const tmp = mkdtempSync(join(tmpdir(), "a2a-files-"));
const agentDir = join(tmp, ".omp", "agent");
const extDir = join(agentDir, "extensions");
const cfgPath = join(agentDir, "a2a-bridge.json");
const auditPath = join(agentDir, "a2a-bridge.log");
const outLog = join(tmp, "omp.out.log");
const errLog = join(tmp, "omp.err.log");
const fileRoot = join(tmp, "files");
const TOKEN = "files-probe-token";

// Small cap on purpose: an oversized upload must be refused without waiting on
// a real 100MB transfer.
const MAX_FILE_BYTES = 1024 * 1024;

let failures = 0;
function check(cond: unknown, label: string): void {
	if (cond) console.log(`ok: ${label}`);
	else {
		console.error(`FAIL: ${label}`);
		failures++;
	}
}

mkdirSync(extDir, { recursive: true });
symlinkSync(join(REPO, "extensions", "a2a-bridge.ts"), join(extDir, "a2a-bridge.ts"));

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port ?? 0;
probe.stop(true);

writeFileSync(
	cfgPath,
	JSON.stringify(
		{
			port: PORT,
			token: TOKEN,
			host: "127.0.0.1",
			deny: [],
			denyMCPTools: false,
			fileRoot,
			maxFileBytes: MAX_FILE_BYTES,
		},
		null,
		2,
	),
);

const realModelsYml = join(process.env.HOME ?? "", ".omp", "agent", "models.yml");
if (!existsSync(realModelsYml)) {
	console.error(`FAIL: no model config at ${realModelsYml}`);
	process.exit(1);
}
copyFileSync(realModelsYml, join(agentDir, "models.yml"));

const child = spawn(process.env.OMP_BIN ?? "omp", ["--mode", "rpc"], {
	env: { ...process.env, HOME: tmp, A2A_BRIDGE_CONFIG: cfgPath, A2A_BRIDGE_AUDIT: auditPath },
	stdio: ["pipe", openSync(outLog, "w"), openSync(errLog, "w")],
});

function fail(label: string): never {
	console.error(`FAIL: ${label}`);
	console.error(`--- omp stdout tail ---\n${readFileSync(outLog, "utf8").slice(-1500)}`);
	console.error(`--- omp stderr tail ---\n${readFileSync(errLog, "utf8").slice(-1500)}`);
	throw new Error(`FAIL: ${label}`);
}

const JSON_HDR = { "content-type": "application/json" };
const base = `http://127.0.0.1:${PORT}/`;
let AUTH: Record<string, string> = {};

async function waitForServer(): Promise<string> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(base, {
				method: "POST",
				headers: { ...JSON_HDR, authorization: `Bearer ${TOKEN}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			});
			const sid = r.headers.get("mcp-session-id");
			if (r.status === 200 && sid) return sid;
		} catch {
			// not listening yet
		}
		await Bun.sleep(500);
	}
	return fail(`server did not come up in 30s (port ${PORT})`);
}

interface CallResult {
	isError?: boolean;
	content?: Array<{ text?: string }>;
}

async function rawCall(name: string, args: unknown): Promise<CallResult> {
	const r = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
	});
	const j = (await r.json()) as { result?: CallResult; error?: { code?: number; message?: string } };
	if (j.error) fail(`tools/call ${name} returned a JSON-RPC error: ${JSON.stringify(j.error)}`);
	return j.result ?? fail(`tools/call ${name} returned no result`);
}

/** `{ok:true,...}` object for a successful call, else null. */
function okPayload(res: CallResult): Record<string, unknown> | null {
	if (res.isError) return null;
	const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
	try {
		const p = JSON.parse(text) as Record<string, unknown>;
		return p.ok === true ? p : null;
	} catch {
		return null;
	}
}

function errorText(res: CallResult): string {
	return (res.content ?? []).map((c) => c.text ?? "").join("\n");
}

/** Stable `a2a_file_error <code>` token, for asserting *why* a call was refused. */
function errorCode(res: CallResult): string {
	const m = /^a2a_file_error ([a-z_]+):/.exec(errorText(res));
	return m ? m[1] : "(not a file error)";
}

const b64 = (s: string | Buffer): string => Buffer.from(s).toString("base64");
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Poll the audit log until a record matches; undefined at the deadline. */
async function untilAudit(pred: (l: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (existsSync(auditPath)) {
			const records = readFileSync(auditPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			const hit = records.find(pred);
			if (hit) return hit;
		}
		await Bun.sleep(50);
	}
	return undefined;
}

function auditRecords(tool: string): string[] {
	return readFileSync(auditPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.filter((l) => (JSON.parse(l) as Record<string, unknown>).tool === tool);
}

try {
	const sid = await waitForServer();
	AUTH = { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid };
	await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	});
	console.log(`ok: bridge up on port ${PORT}, session ${sid.slice(0, 8)}…`);

	// --- tools/list advertises the bridge's own file tools ---
	const listRes = await fetch(base, {
		method: "POST",
		headers: { ...JSON_HDR, ...AUTH },
		body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
	});
	const catalog = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
	const names = new Set((catalog.result?.tools ?? []).map((t) => t.name));
	for (const n of [
		"a2a_file_put",
		"a2a_file_get",
		"a2a_file_list",
		"a2a_file_put_start",
		"a2a_file_put_chunk",
		"a2a_file_put_end",
	]) {
		check(names.has(n), `tools/list advertises ${n}`);
	}

	// --- put: bytes reach the disk, inside the root, as 0600 ---
	const inline = b64(`hello-from-probe-${Date.now()}\n`);
	const put = okPayload(
		await rawCall("a2a_file_put", {
			path: "inbox/hello.txt",
			file: { name: "hello.txt", mimeType: "text/plain", bytes: inline },
		}),
	);
	check(!!put, "a2a_file_put succeeded");
	const putPath = join(fileRoot, "inbox", "hello.txt");
	check(existsSync(putPath), "put file exists on disk under fileRoot");
	check((lstatSync(putPath).mode & 0o777) === 0o600, "put file is 0600");
	const putBuf = readFileSync(putPath);
	check(Buffer.from(inline, "base64").equals(putBuf), "on-disk bytes equal the payload");
	check(put?.sha256 === sha(putBuf), "put sha256 matches the file");
	check(put?.mimeType === "text/plain", "put echoes the declared mimeType");

	// --- overwrite semantics ---
	check(
		errorCode(await rawCall("a2a_file_put", { path: "inbox/hello.txt", file: { bytes: inline } })) === "already_exists",
		"re-put without overwrite -> already_exists",
	);
	check(
		!(await rawCall("a2a_file_put", { path: "inbox/hello.txt", file: { bytes: inline }, overwrite: true })).isError,
		"re-put with overwrite succeeds",
	);

	// --- get: round trip + paging flags ---
	const get = okPayload(await rawCall("a2a_file_get", { path: "inbox/hello.txt" }));
	check(get?.bytes === inline, "get returns the same base64 that was put");
	check(get?.eof === true, "single-shot get reports eof");
	check(get?.sha256 === sha(putBuf), "get sha256 matches the file");
	const getOffset = okPayload(await rawCall("a2a_file_get", { path: "inbox/hello.txt", offset: 2 }));
	check(
		Buffer.from(String(getOffset?.bytes), "base64").equals(putBuf.subarray(2)),
		"get offset returns the sliced tail",
	);
	check(getOffset?.eof === true, "offset get to the end reports eof");

	// --- list hides the staging dir ---
	const listed = okPayload(await rawCall("a2a_file_list", { path: "." }));
	const entries = (listed?.entries ?? []) as Array<{ path: string }>;
	check(
		entries.some((e) => e.path === "inbox"),
		"list shows the directory we wrote into",
	);
	check(!entries.some((e) => e.path.includes(".tmp")), "list hides the .tmp staging dir");

	// --- path sandbox ---
	// `..` is refused lexically (invalid_path) — the realpath containment check
	// (escapes_root) is what catches a symlink that redirects out of the root.
	for (const [bad, want] of [
		["../escape.txt", "invalid_path"],
		["/etc/passwd", "invalid_path"],
		["a/../../escape.txt", "invalid_path"],
		["./x.txt", "invalid_path"],
		["inbox/../inbox/hello.txt", "invalid_path"],
	] as const) {
		check(errorCode(await rawCall("a2a_file_get", { path: bad })) === want, `get '${bad}' -> ${want}`);
	}
	check(
		errorCode(await rawCall("a2a_file_put", { path: "../out.txt", file: { bytes: inline } })) === "invalid_path",
		"put outside the root is refused",
	);

	const outsideDir = join(tmp, "outside-dir");
	mkdirSync(outsideDir, { recursive: true });
	writeFileSync(join(outsideDir, "secret.txt"), "NOT-YOURS\n");
	symlinkSync(outsideDir, join(fileRoot, "dirlink"));
	check(
		errorCode(await rawCall("a2a_file_get", { path: "dirlink/secret.txt" })) === "escapes_root",
		"get through a directory symlink out of the root -> escapes_root",
	);
	check(
		errorCode(await rawCall("a2a_file_put", { path: "dirlink/new.txt", file: { bytes: inline } })) === "escapes_root",
		"put through a directory symlink out of the root -> escapes_root",
	);

	// --- symlink inside the root must not redirect reads or writes ---
	const outside = join(tmp, "outside-target.txt");
	const secret = "SECRET-NOT-FOR-YOU\n";
	writeFileSync(outside, secret);
	mkdirSync(join(fileRoot, "links"), { recursive: true });
	symlinkSync(outside, join(fileRoot, "links", "symlink.txt"));
	check(
		errorCode(await rawCall("a2a_file_get", { path: "links/symlink.txt" })) === "symlink_refused",
		"get through a symlink is refused",
	);
	check(
		errorCode(
			await rawCall("a2a_file_put", { path: "links/symlink.txt", file: { bytes: inline }, overwrite: true }),
		) === "symlink_refused",
		"put through a symlink is refused",
	);
	check(readFileSync(outside, "utf8") === secret, "the symlink target was left untouched");

	// --- chunked upload: in-order chunks, then atomic rename ---
	const total = Math.floor(MAX_FILE_BYTES * 0.9); // > one inline payload, < the cap
	const step = 256 * 1024; // half the advertised max, so the transfer takes 4 chunks
	const blob = Buffer.alloc(total, 0xab);
	const start = okPayload(
		await rawCall("a2a_file_put_start", {
			path: "bulk/blob.bin",
			totalBytes: total,
			mimeType: "application/octet-stream",
		}),
	);
	check(!!start, "put_start succeeded");
	const advertised = Number(start?.chunkMaxBytes);
	check(advertised >= step, `put_start advertises a usable chunkMaxBytes (${advertised})`);
	const transferId = String(start?.transferId);
	let seq = 0;
	for (let off = 0; off < total; off += step) {
		const chunk = okPayload(
			await rawCall("a2a_file_put_chunk", {
				transferId,
				seq,
				bytes: blob.subarray(off, off + step).toString("base64"),
			}),
		);
		check(!!chunk, `chunk ${seq} accepted`);
		seq++;
	}
	check(seq === Math.ceil(total / step), `${seq} chunks covering ${total} bytes`);
	check(
		errorCode(await rawCall("a2a_file_put_chunk", { transferId, seq: 0, bytes: b64("late") })) === "bad_chunk_order",
		"replayed chunk -> bad_chunk_order",
	);
	const end = okPayload(await rawCall("a2a_file_put_end", { transferId }));
	check(!!end, "put_end commits the transfer");
	const bulkPath = join(fileRoot, "bulk", "blob.bin");
	check(existsSync(bulkPath), "chunked file exists on disk");
	check(statSync(bulkPath).size === total, "chunked file size equals the declared totalBytes");
	const bulkBuf = readFileSync(bulkPath);
	check(bulkBuf.equals(blob), "chunked bytes reassemble exactly");
	check(end?.sha256 === sha(bulkBuf), "put_end sha256 matches the file");
	check(
		errorCode(await rawCall("a2a_file_put_end", { transferId })) === "unknown_transfer",
		"second put_end -> unknown_transfer",
	);

	// --- size cap ---
	check(
		errorCode(await rawCall("a2a_file_put_start", { path: "bulk/too-big.bin", totalBytes: MAX_FILE_BYTES + 1 })) ===
			"too_large",
		"declared totalBytes over maxFileBytes -> too_large",
	);

	// --- names outside the advertised catalog are refused ---
	check(
		!/a2a_file_error/.test(errorText(await rawCall("a2a_file_nope", {}))),
		"unknown tool name is refused before any file handling",
	);

	// --- audit: start/done pair, payload redacted, lines stay small ---
	const startRec = await untilAudit((l) => l.phase === "start" && l.tool === "a2a_file_put");
	check(!!startRec, "audit has a phase:start for a2a_file_put");
	const doneRec = await untilAudit((l) => l.phase === "done" && l.tool === "a2a_file_put" && l.id === startRec?.id);
	check(!!doneRec, "audit has the matching phase:done for a2a_file_put");
	const putLines = auditRecords("a2a_file_put");
	check(
		putLines.length > 0 && putLines.every((l) => !l.includes(inline)),
		"audit lines never contain the raw base64 payload",
	);
	check(
		putLines.some((l) => l.includes("<base64 len:")),
		"audit records the payload as a length marker",
	);
	const longest = Math.max(...putLines.map((l) => l.length));
	check(
		putLines.every((l) => l.length < 1200),
		`audit lines stay under 1.2KB (longest ${longest})`,
	);
	check(auditRecords("a2a_file_put_chunk").length === 0, "chunk calls are not audited individually");

	if (failures) fail(`${failures} file-transfer check(s) failed`);
	console.log("FILES OK");
} catch (e) {
	if (!(e instanceof Error && e.message.startsWith("FAIL:"))) fail(`unexpected: ${(e as Error)?.message ?? String(e)}`);
} finally {
	child.kill("SIGTERM");
	await Bun.sleep(500);
	if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(tmp, { recursive: true, force: true });
}
