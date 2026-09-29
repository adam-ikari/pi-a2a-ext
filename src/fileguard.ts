import { createHash, randomUUID } from "node:crypto";
import { appendFile, constants, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Stable machine-readable error codes; they surface verbatim to remote callers. */
export type FileOpCode =
	| "invalid_path"
	| "escapes_root"
	| "symlink_refused"
	| "not_found"
	| "is_a_directory"
	| "already_exists"
	| "too_large"
	| "bad_base64"
	| "unknown_transfer"
	| "bad_chunk_order"
	| "size_mismatch";

export class FileOpError extends Error {
	constructor(
		readonly code: FileOpCode,
		message?: string,
	) {
		super(message ?? code);
		this.name = "FileOpError";
	}
}

/** Reserved directory name inside the root: staging area for atomic writes / transfers. */
export const TMP_NAME = ".tmp";

const MAX_SEGMENT_LEN = 255;
const MAX_PATH_LEN = 512;

/**
 * Validate a remote-supplied path as root-relative. Absolute paths, `.`/`..`
 * segments, empty/duplicate separators, NUL and control characters are all
 * rejected before any filesystem call happens. `a..b` is an ordinary name.
 */
export function assertRelativeSegments(rel: unknown): string[] {
	if (typeof rel !== "string" || rel.length === 0 || rel.length > MAX_PATH_LEN) {
		throw new FileOpError("invalid_path", "path must be a non-empty string of at most 512 chars");
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we reject
	if (/[\x00-\x1f]/.test(rel)) throw new FileOpError("invalid_path", "path contains control characters");
	if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel) || rel.startsWith("~")) {
		throw new FileOpError("invalid_path", "path must be relative to the file root");
	}
	const segments = rel.split("/");
	for (const s of segments) {
		if (s === "" || s === "." || s === "..") throw new FileOpError("invalid_path", `invalid path segment: '${s}'`);
		if (s.length > MAX_SEGMENT_LEN) throw new FileOpError("invalid_path", `path segment too long: '${s}'`);
	}
	return segments;
}

/**
 * Canonicalize the *parent* of a root-relative path (realpath of the deepest
 * existing ancestor, so mid-path symlinks cannot redirect outside) and join
 * the final segment lexically. The returned path stays usable for lstat-based
 * symlink checks on the destination itself; parent containment is proven here.
 */
export async function resolveInRoot(rootReal: string, rel: unknown): Promise<string> {
	const segments = assertRelativeSegments(rel);
	const lexical = resolve(rootReal, ...segments);
	const finalName = basename(lexical);
	let probe = dirname(lexical);
	const below: string[] = []; // segment names proven missing, deepest-first
	for (;;) {
		try {
			await lstat(probe);
			break;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			// ENOTDIR: a component exists but is a file — its parent is the
			// deepest existing ancestor.
			if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
			const parent = dirname(probe);
			if (parent === probe) throw new FileOpError("escapes_root", "no existing ancestor for path");
			below.unshift(basename(probe));
			probe = parent;
		}
	}
	// A symlinked ancestor is followed and re-checked; a probe that left the
	// root lexically lands outside after realpath → rejected below.
	const ancestor = await realpath(probe);
	const parent = below.length === 0 ? ancestor : resolve(ancestor, ...below);
	// containment === "" means the parent *is* the root: legitimate.
	const containment = relative(rootReal, parent);
	if (containment.startsWith("..") || isAbsolute(containment)) {
		throw new FileOpError("escapes_root", "path resolves outside the file root");
	}
	return join(parent, finalName);
}

/**
 * Refuse a root whose realpath would put secrets under it: the root must not
 * be an ancestor of the config file (token) or the audit log.
 */
export function assertRootDoesNotContain(rootReal: string, protectedPaths: string[]): void {
	for (const p of protectedPaths) {
		const r = relative(rootReal, resolve(p));
		if (r !== "" && !r.startsWith("..") && !r.startsWith(sep)) {
			throw new FileOpError("escapes_root", `file root must not contain ${p}`);
		}
	}
}

/** Create (0700) and canonicalize the file root; purge stale staging files. */
export async function ensureRoot(fileRoot: string, protectedPaths: string[] = []): Promise<string> {
	const lexical = resolve(fileRoot);
	const existing = await lstat(lexical).catch(() => null);
	if (existing) {
		if (existing.isSymbolicLink()) throw new FileOpError("symlink_refused", "file root must not be a symlink");
		if (!existing.isDirectory()) throw new FileOpError("invalid_path", "file root is not a directory");
	} else {
		await mkdir(lexical, { recursive: true, mode: 0o700 });
	}
	const rootReal = await realpath(lexical);
	assertRootDoesNotContain(rootReal, protectedPaths);
	const tmp = join(rootReal, TMP_NAME);
	await mkdir(tmp, { recursive: true, mode: 0o700 });
	for (const name of await readdir(tmp).catch(() => [])) {
		await rm(join(tmp, name), { recursive: true, force: true }).catch(() => {});
	}
	return rootReal;
}

/**
 * Write via a temp file inside `<root>/.tmp` (same filesystem → atomic
 * rename) with mode 0600. Refuses to follow a symlink at the destination and
 * to clobber an existing file unless `overwrite` is set.
 */
export async function writeFileAtomic(
	rootReal: string,
	rel: string,
	data: Uint8Array,
	options: { overwrite?: boolean } = {},
): Promise<{ abs: string; bytes: number; sha256: string }> {
	const abs = await resolveInRoot(rootReal, rel);
	const dest = await lstat(abs).catch((e: NodeJS.ErrnoException) => {
		if (e.code !== "ENOENT") throw e;
		return null;
	});
	if (dest?.isSymbolicLink()) throw new FileOpError("symlink_refused", "destination is a symlink");
	if (dest?.isDirectory()) throw new FileOpError("is_a_directory");
	if (dest && !options.overwrite) throw new FileOpError("already_exists", "file exists; pass overwrite to replace");
	await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
	const tmpPath = join(rootReal, TMP_NAME, `${randomUUID()}.part`);
	await writeFile(tmpPath, data, { mode: 0o600 });
	await rename(tmpPath, abs);
	return { abs, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
}

/** Read a byte slice; refuses directories and symlinks, reports the whole-file size. */
export async function readSlice(
	rootReal: string,
	rel: string,
	offset = 0,
	limit?: number,
): Promise<{ buf: Buffer; total: number }> {
	const abs = await resolveInRoot(rootReal, rel);
	const lst = await lstat(abs).catch((e: NodeJS.ErrnoException) => {
		if (e.code === "ENOENT") throw new FileOpError("not_found");
		throw e;
	});
	if (lst.isSymbolicLink()) throw new FileOpError("symlink_refused", "refusing to read through a symlink");
	if (lst.isDirectory()) throw new FileOpError("is_a_directory");
	const fh = await open(abs, constants.O_RDONLY);
	try {
		const st = await fh.stat();
		if (offset < 0 || offset > st.size) throw new FileOpError("invalid_path", `offset ${offset} out of range`);
		const length = limit === undefined ? st.size - offset : Math.min(limit, st.size - offset);
		const buf = Buffer.allocUnsafe(length);
		const { bytesRead } = await fh.read(buf, 0, length, offset);
		return { buf: bytesRead === length ? buf : buf.subarray(0, bytesRead), total: st.size };
	} finally {
		await fh.close();
	}
}

/** sha256 of a whole file, streamed in 1MiB windows (memory stays flat). */
export async function sha256File(abs: string): Promise<string> {
	const fh = await open(abs, constants.O_RDONLY);
	try {
		const h = createHash("sha256");
		const buf = Buffer.allocUnsafe(1024 * 1024);
		let position = 0;
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, buf.length, position);
			if (bytesRead === 0) break;
			h.update(buf.subarray(0, bytesRead));
			position += bytesRead;
		}
		return h.digest("hex");
	} finally {
		await fh.close();
	}
}

/** Append a chunk to a staging .part file (0600 from creation). */
export async function appendPart(partPath: string, data: Uint8Array): Promise<void> {
	await appendFile(partPath, data, { mode: 0o600 });
}
