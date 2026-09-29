import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "./config.ts";
import {
	appendPart,
	ensureRoot,
	FileOpError,
	readSlice,
	resolveInRoot,
	sha256File,
	TMP_NAME,
	writeFileAtomic,
} from "./fileguard.ts";
import type { McpContent } from "./server.ts";

/** Inline/chunk payloads stay under the bridge's 1MB request cap. */
export const INLINE_MAX_BYTES = 512 * 1024;
export const CHUNK_MAX_BYTES = 512 * 1024;
/** A single get response is capped; larger files are paged with offset/limit. */
export const GET_MAX_BYTES = 256 * 1024;

const MAX_TRANSFERS = 16;
const TRANSFER_TTL_MS = 30 * 60 * 1000;

export interface BridgeTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** Audit view override: bytes are huge and useless in a log line. */
	auditView?(args: Record<string, unknown>): Record<string, unknown>;
	skipAudit?(name: string, args: unknown): boolean;
	execute(args: unknown, sid: string | null): Promise<{ content: McpContent[]; isError: boolean }>;
}

const OBJECT = (props: Record<string, unknown>, required: string[] = []) => ({
	type: "object",
	properties: props,
	required,
	additionalProperties: false,
});
const STR = { type: "string" };
const INT = { type: "integer" };
const BOOL = { type: "boolean" };
const FILE_PART = {
	type: "object",
	properties: { name: STR, mimeType: STR, bytes: STR },
	required: ["bytes"],
	additionalProperties: false,
};

function ok(payload: Record<string, unknown>): { content: McpContent[]; isError: boolean } {
	return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }) }], isError: false };
}

function fail(code: string, message: string): { content: McpContent[]; isError: boolean } {
	return { content: [{ type: "text", text: `a2a_file_error ${code}: ${message}` }], isError: true };
}

/** A tool call never throws: FileOpError becomes an isError wire result. */
function guarded(
	fn: (args: unknown, sid: string | null) => Promise<{ content: McpContent[]; isError: boolean }>,
): (args: unknown, sid: string | null) => Promise<{ content: McpContent[]; isError: boolean }> {
	return async (args, sid) => {
		try {
			return await fn(args, sid);
		} catch (e) {
			if (e instanceof FileOpError) return fail(e.code, e.message);
			throw e;
		}
	};
}

function badArgs(message: string): never {
	throw new FileOpError("invalid_path", message);
}

function str(args: Record<string, unknown>, key: string): string {
	if (typeof args[key] !== "string") badArgs(`'${key}' must be a string`);
	return args[key] as string;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
	if (args[key] === undefined) return undefined;
	return str(args, key);
}

function optInt(args: Record<string, unknown>, key: string): number | undefined {
	const v = args[key];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) badArgs(`'${key}' must be a non-negative integer`);
	return v;
}

function optBool(args: Record<string, unknown>, key: string): boolean {
	const v = args[key];
	if (v === undefined) return false;
	if (typeof v !== "boolean") badArgs(`'${key}' must be a boolean`);
	return v;
}

function decodeBase64(b64: string, max: number): Buffer {
	if (typeof b64 !== "string" || b64.length === 0) badArgs("'bytes' must be non-empty base64");
	// base64 of N bytes is ~4/3 chars; reject oversized payloads before decoding.
	if (Math.ceil((b64.length + 3) / 4) * 3 > max + 1024) {
		throw new FileOpError("too_large", `payload exceeds ${max} bytes, use a2a_file_put_start`);
	}
	const buf = Buffer.from(b64, "base64");
	if (buf.byteLength > max) throw new FileOpError("too_large", `payload exceeds ${max} bytes`);
	// Buffer.from silently drops invalid characters; re-encode and compare to
	// catch truncated or tampered base64 rather than writing corrupt bytes.
	if (buf.toString("base64") !== b64.replace(/[\r\n\s]/g, "")) {
		throw new FileOpError("bad_base64", "payload is not valid base64");
	}
	return buf;
}

function bytesAuditView(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	const file = args.file;
	if (typeof file === "object" && file !== null && typeof (file as { bytes?: unknown }).bytes === "string") {
		const b = (file as { bytes: string }).bytes;
		out.file = { ...file, bytes: `<base64 len:${b.length}>` };
	}
	if (typeof args.bytes === "string") out.bytes = `<base64 len:${String(args.bytes).length}>`;
	return out;
}

interface Transfer {
	sid: string | null;
	rel: string;
	partPath: string;
	expectedSeq: number;
	received: number;
	totalBytes?: number;
	mimeType?: string;
	overwrite: boolean;
	lastSeenMs: number;
}

/**
 * Build the bridge's own file tools. Unlike host tools these do not go
 * through the host's approval gate, so every path is confined to `fileRoot`
 * (created 0700, symlink-refused) and writes land atomically as 0600.
 */
export function buildFileTools(
	cfg: BridgeConfig,
	deps: { now?(): number; protectedPaths?: string[] } = {},
): {
	tools: BridgeTool[];
	rootReal: () => Promise<string>;
} {
	const now = deps.now ?? Date.now;
	const transfers = new Map<string, Transfer>();
	let rootPromise: Promise<string> | null = null;

	function rootReal(): Promise<string> {
		if (!rootPromise) {
			rootPromise = ensureRoot(cfg.fileRoot, deps.protectedPaths ?? []).catch((e) => {
				rootPromise = null; // a failed init must not be cached forever
				throw e;
			});
		}
		return rootPromise;
	}

	/** Drop idle transfers (and enforce the LRU cap) before each file call. */
	async function sweep(): Promise<void> {
		const t = now();
		for (const [id, tr] of transfers) {
			if (t - tr.lastSeenMs > TRANSFER_TTL_MS) {
				transfers.delete(id);
				await rm(tr.partPath, { force: true }).catch(() => {});
			}
		}
		while (transfers.size >= MAX_TRANSFERS) {
			let oldestId: string | null = null;
			let oldest = Infinity;
			for (const [id, tr] of transfers) {
				if (tr.lastSeenMs < oldest) {
					oldest = tr.lastSeenMs;
					oldestId = id;
				}
			}
			if (oldestId === null) break;
			const dropped = transfers.get(oldestId);
			transfers.delete(oldestId);
			if (dropped) await rm(dropped.partPath, { force: true }).catch(() => {});
		}
	}

	function requireTransfer(id: unknown, sid: string | null): Transfer {
		if (typeof id !== "string") throw new FileOpError("unknown_transfer", "transferId must be a string");
		const tr = transfers.get(id);
		// A wrong/expired id and one owned by another session get the same
		// message: the token holder learns nothing about others' transfers.
		if (!tr || tr.sid !== sid) throw new FileOpError("unknown_transfer");
		return tr;
	}

	const put: BridgeTool = {
		name: "a2a_file_put",
		description:
			"Write a file into the bridge's sandboxed file root (A2A FilePart shape: {name, mimeType, bytes} with base64 bytes). " +
			`Inline payloads are capped at ${INLINE_MAX_BYTES} bytes; larger files must use a2a_file_put_start/chunk/end. Paths are relative to the file root.`,
		inputSchema: OBJECT({ path: STR, file: FILE_PART, overwrite: BOOL }, ["path", "file"]),
		auditView: bytesAuditView,
		async execute(args, _sid) {
			const a = (args ?? {}) as Record<string, unknown>;
			const path = str(a, "path");
			if (typeof a.file !== "object" || a.file === null) badArgs("'file' must be an object");
			const file = a.file as Record<string, unknown>;
			if (typeof file.bytes !== "string") badArgs("'file.bytes' must be a base64 string");
			const mimeType = typeof file.mimeType === "string" ? file.mimeType : undefined;
			if (file.name !== undefined && typeof file.name !== "string") badArgs("'file.name' must be a string");
			const data = decodeBase64(file.bytes, INLINE_MAX_BYTES);
			if (data.byteLength > cfg.maxFileBytes) throw new FileOpError("too_large", `file exceeds maxFileBytes`);
			const root = await rootReal();
			const r = await writeFileAtomic(root, path, data, { overwrite: optBool(a, "overwrite") });
			return ok({ path: r.abs.slice(root.length + 1), bytes: r.bytes, sha256: r.sha256, mimeType: mimeType ?? null });
		},
	};

	const putStart: BridgeTool = {
		name: "a2a_file_put_start",
		description: "Begin a chunked upload into the file root. Returns a transferId for a2a_file_put_chunk calls.",
		inputSchema: OBJECT({ path: STR, totalBytes: INT, mimeType: STR, overwrite: BOOL }, ["path"]),
		async execute(args, sid) {
			const a = (args ?? {}) as Record<string, unknown>;
			const path = str(a, "path");
			const totalBytes = optInt(a, "totalBytes");
			if (totalBytes !== undefined && totalBytes > cfg.maxFileBytes) {
				throw new FileOpError("too_large", `totalBytes exceeds maxFileBytes (${cfg.maxFileBytes})`);
			}
			const root = await rootReal();
			// Validate now so a bad path fails at start, not after 200 chunks.
			const abs = await resolveInRoot(root, path);
			const existing = await lstat(abs).catch(() => null);
			if (existing?.isDirectory()) throw new FileOpError("is_a_directory");
			if (existing?.isSymbolicLink()) throw new FileOpError("symlink_refused", "destination is a symlink");
			if (existing && !optBool(a, "overwrite"))
				throw new FileOpError("already_exists", "file exists; pass overwrite to replace");
			const id = randomUUID();
			const partPath = join(root, TMP_NAME, `${id}.part`);
			transfers.set(id, {
				sid,
				rel: path,
				partPath,
				expectedSeq: 0,
				received: 0,
				totalBytes,
				mimeType: optStr(a, "mimeType"),
				overwrite: optBool(a, "overwrite"),
				lastSeenMs: now(),
			});
			return ok({ transferId: id, path, chunkMaxBytes: CHUNK_MAX_BYTES });
		},
	};

	const putChunk: BridgeTool = {
		name: "a2a_file_put_chunk",
		description: `Append one base64 chunk (<=${CHUNK_MAX_BYTES} decoded bytes) to a transfer. Chunks must arrive in order, starting at seq 0.`,
		inputSchema: OBJECT({ transferId: STR, seq: INT, bytes: STR }, ["transferId", "seq", "bytes"]),
		auditView: bytesAuditView,
		// Per-chunk audit lines would bury every other call in the log; the
		// transfer is already bracketed by start/end records.
		skipAudit: (name, args) =>
			name === "a2a_file_put_chunk" && typeof (args as { transferId?: unknown })?.transferId === "string",
		async execute(args, sid) {
			const a = (args ?? {}) as Record<string, unknown>;
			const tr = requireTransfer(a.transferId, sid);
			const seq = optInt(a, "seq");
			if (seq === undefined || seq !== tr.expectedSeq) {
				throw new FileOpError("bad_chunk_order", `expected seq ${tr.expectedSeq}, got ${String(a.seq)}`);
			}
			if (typeof a.bytes !== "string") badArgs("'bytes' must be a base64 string");
			const data = decodeBase64(a.bytes, CHUNK_MAX_BYTES);
			if (tr.received + data.byteLength > cfg.maxFileBytes) {
				throw new FileOpError("too_large", `transfer exceeds maxFileBytes (${cfg.maxFileBytes})`);
			}
			if (tr.totalBytes !== undefined && tr.received + data.byteLength > tr.totalBytes) {
				throw new FileOpError("size_mismatch", `more bytes than declared totalBytes (${tr.totalBytes})`);
			}
			await appendPart(tr.partPath, data);
			tr.expectedSeq += 1;
			tr.received += data.byteLength;
			tr.lastSeenMs = now();
			return ok({ receivedBytes: tr.received, nextSeq: tr.expectedSeq });
		},
	};

	const putEnd: BridgeTool = {
		name: "a2a_file_put_end",
		description: "Finish a chunked upload: verifies the declared size and atomically moves the staged file into place.",
		inputSchema: OBJECT({ transferId: STR }, ["transferId"]),
		async execute(args, sid) {
			const a = (args ?? {}) as Record<string, unknown>;
			const id = a.transferId;
			const tr = requireTransfer(id, sid);
			if (tr.expectedSeq === 0) throw new FileOpError("size_mismatch", "no chunks were sent");
			if (tr.totalBytes !== undefined && tr.received !== tr.totalBytes) {
				throw new FileOpError("size_mismatch", `received ${tr.received} of ${tr.totalBytes} declared bytes`);
			}
			const root = await rootReal();
			const abs = await resolveInRoot(root, tr.rel);
			const existing = await lstat(abs).catch(() => null);
			if (existing?.isSymbolicLink()) throw new FileOpError("symlink_refused", "destination is a symlink");
			if (existing && !tr.overwrite) throw new FileOpError("already_exists", "file exists; pass overwrite to replace");
			// The transfer staged in .tmp; the destination's parent may not exist
			// yet (put_start only validates the path). abs is containment-checked.
			await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
			await rename(tr.partPath, abs);
			transfers.delete(String(id));
			const r = await stat(abs);
			return ok({ path: tr.rel, bytes: r.size, sha256: await sha256File(abs), mimeType: tr.mimeType ?? null });
		},
	};

	const get: BridgeTool = {
		name: "a2a_file_get",
		description:
			`Read a file from the bridge's file root as base64 (A2A FilePart shape). Responses are capped at ${GET_MAX_BYTES} bytes; ` +
			"page larger files with offset/limit using the returned totalBytes and eof flag.",
		inputSchema: OBJECT({ path: STR, offset: INT, limit: INT }, ["path"]),
		async execute(args, _sid) {
			const a = (args ?? {}) as Record<string, unknown>;
			const path = str(a, "path");
			const offset = optInt(a, "offset") ?? 0;
			const limit = optInt(a, "limit");
			const root = await rootReal();
			const abs = await resolveInRoot(root, path);
			const { buf, total } = await readSlice(root, path, offset, Math.min(limit ?? GET_MAX_BYTES, GET_MAX_BYTES));
			const sha = await sha256File(abs);
			return ok({
				path,
				offset,
				bytes: buf.toString("base64"),
				totalBytes: total,
				eof: offset + buf.byteLength >= total,
				sha256: sha,
			});
		},
	};

	const list: BridgeTool = {
		name: "a2a_file_list",
		description: "List files under a directory of the bridge's file root. The staging directory (.tmp) is hidden.",
		inputSchema: OBJECT({ path: STR, limit: INT }, []),
		async execute(args, _sid) {
			const a = (args ?? {}) as Record<string, unknown>;
			const rel = optStr(a, "path") ?? ".";
			const limit = optInt(a, "limit") ?? 100;
			const root = await rootReal();
			const abs = rel === "." ? root : await resolveInRoot(root, rel);
			const st = await stat(abs).catch(() => null);
			if (!st) throw new FileOpError("not_found");
			if (!st.isDirectory()) throw new FileOpError("is_a_directory", "path is a file, use a2a_file_get");
			const names = (await readdir(abs)).filter((n) => !(rel === "." && n === TMP_NAME));
			const entries: { path: string; bytes: number; mtime: string }[] = [];
			for (const name of names) {
				if (entries.length >= limit) break;
				const child = await lstat(join(abs, name)).catch(() => null);
				if (!child || child.isSymbolicLink()) continue;
				entries.push({
					path: rel === "." ? name : `${rel}/${name}`,
					bytes: child.isDirectory() ? 0 : child.size,
					mtime: child.mtime.toISOString(),
				});
			}
			return ok({ entries, truncated: entries.length >= limit && names.length > entries.length });
		},
	};

	// Every file call is a sweep opportunity: expired transfers are reclaimed
	// lazily, so no timer is needed to keep the staging dir bounded.
	const tools = [put, putStart, putChunk, putEnd, get, list].map((t) => ({
		...t,
		execute: guarded(async (args, sid) => {
			await sweep();
			return t.execute(args, sid);
		}),
	}));
	return { tools, rootReal };
}
