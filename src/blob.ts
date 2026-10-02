/**
 * Raw-byte blob endpoint: `POST /blob`.
 *
 * ## Why this exists
 *
 * `tools/call` cannot carry raw binary. The host's `write` tool takes a string,
 * and its `bash` tool takes a command, so a caller has to base64 the payload
 * first. That costs 33% size, and at a 1 MB body limit it also forces chunking. This
 * endpoint takes the bytes as they are; the body limit now stands at 128 MB, so a
 * 100 MB image is one request.
 *
 * ## What this gives up, and why that is a decision rather than an oversight
 *
 * A `tools/call` write goes through the host: it resolves against the session's
 * registry, executes the host's own `write`, and therefore passes the host's
 * approval gate. A direct write here does not. `ExtensionAPI` has no
 * `requestApproval()` — only `on("tool_approval_requested", …)`, which is the
 * other direction (the host asks, the extension answers). So there is no way for
 * the bridge to raise an approval request of its own; the closest available is
 * to make a `tools/call`, which is the encoding this endpoint exists to avoid.
 *
 * The same applies to paths. The host ships `resolvePath()` and `expandPath()`,
 * but they are internal modules of the host package, reached through no
 * `BridgeDeps` entry — depending on them would break whenever the host moves
 * them. So this module resolves paths itself, which means:
 *
 * **The bridge now writes anywhere the host process can write, with no root and
 * no allowlist.** That is a real change in what the bridge is, and it is
 * documented as such in README under "Security and boundaries". The alternative
 * is no raw-byte path at all.
 *
 * ## What is kept
 *
 * Auditing. Every write is recorded through the same `audit.ts` pair as a
 * `tools/call`, tagged `blob:write`, with the byte count and offset rather than
 * the payload — the audit log must never hold file contents.
 *
 * Auth. One Bearer token, same `authorize()` as the MCP path. The blob endpoint
 * is a second door into the same house, not an unlocked one.
 */
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

import { auditBlob } from "./audit.ts";

export interface BlobDeps {
	/** Session id of the caller, for the audit record. */
	sid: string | null;
	/** Base for relative paths. Defaults to the host agent directory, which is
	 * what a relative path means to the host's own tools. */
	agentDir?: string;
}

export interface BlobResult {
	status: number;
	body?: unknown;
}

/**
 * Resolve a caller-supplied path the way a shell would: `~` and `~/x` against
 * the agent directory, relative paths against it too. No root is imposed — see
 * the header. `normalize` collapses `..` so the resolved path is canonical
 * before any parent directory has to be created.
 */
export function resolveBlobPath(input: string, agentDir: string = getAgentDir()): string {
	const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
	return isAbsolute(expanded) ? normalize(expanded) : resolve(agentDir, expanded);
}

/**
 * Handle one `POST /blob`. Returns the HTTP status and a JSON body.
 *
 * Query:
 *   path    required   target file
 *   offset  optional   byte offset to write at; defaults to the current size
 *                      (append). A value smaller than the current size is
 *                      rejected rather than silently filling a hole.
 */
export async function handleBlob(req: Request, url: URL, deps: BlobDeps): Promise<BlobResult> {
	const path = url.searchParams.get("path");
	if (!path) return { status: 400, body: { error: "path is required" } };

	const target = resolveBlobPath(path, deps.agentDir);
	// No offset means append at EOF. An explicit offset means "the caller knows
	// where this chunk belongs", so honour it — but only at EOF or on a fresh
	// file. Writing into the middle of an existing file would leave the bytes
	// after the write untouched, producing a file that is neither the old one nor
	// the new one; that is refused rather than silently mangled.
	const offsetRaw = url.searchParams.get("offset");
	const explicit = offsetRaw !== null;
	const offset = explicit ? Number(offsetRaw) : Number.NaN;
	if (explicit && (!Number.isInteger(offset) || offset < 0)) {
		return { status: 400, body: { error: "offset must be a non-negative integer" } };
	}

	let size = 0;
	try {
		size = (await stat(target)).size;
	} catch {
		size = 0; // absent file: an offset-0 write creates it
	}
	if (explicit && offset !== size) {
		return {
			status: 409,
			body: { error: `offset ${offset} does not match the current size ${size}; send no offset to append` },
		};
	}
	const at = explicit ? offset : size;

	const buf = Buffer.from(await req.arrayBuffer());
	if (buf.length === 0) return { status: 400, body: { error: "empty body" } };
	// No size check here: `maxRequestBodySize` on Bun.serve already refused
	// anything larger, with a 413, before this handler ran. A second limit would
	// only risk the two disagreeing about where the boundary is.

	// Parent directories are created for the caller: a firmware upload should not
	// have to guess whether ~/flash/ exists. Failure here is not fatal — the open
	// below reports it with the path in the message.
	await mkdir(dirname(target), { recursive: true }).catch(() => {});

	// "a" appends and creates; "w" truncates. `at` is already validated to be the
	// file's current size, so the two branches agree on the result.
	let handle: FileHandle;
	try {
		handle = await open(target, at === 0 ? "w" : "a");
	} catch (e) {
		auditBlob(deps.sid, path, at, 0, `open failed: ${(e as Error).message}`);
		return { status: 500, body: { error: `cannot open ${path}: ${(e as Error).message}` } };
	}
	try {
		await handle.write(buf);
	} finally {
		await handle.close();
	}

	// Audited after the write, so the record carries the real byte count. Args are
	// metadata only — see the header.
	auditBlob(deps.sid, path, at, buf.length, null);
	return { status: 200, body: { written: buf.length, offset: at, size: at + buf.length, path } };
}
