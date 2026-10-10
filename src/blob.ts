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
 * One consequence of resolving paths here is that the bridge is itself under the
 * root it resolves against: `a2a-bridge.json` and `a2a-bridge.log` live in the
 * agent directory, and so does every relative `path`. Nothing here can *rewrite*
 * either file — writes are append-only and an offset has to equal the current size
 * — but appending junk to the config makes the next `loadConfig` throw and the
 * bridge refuse to come up, and flooding the log drives rotations that drop a
 * retained generation. Both are the bridge's own startup and evidence, not new
 * reach: whoever can do this already holds the token.
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
	/**
	 * Session id of the caller, for the audit record — and only ever one this bridge
	 * actually issued. The audit says `sid` is what attributes a shared token's calls
	 * to a client (src/audit.ts), so a header value nobody here minted is a claim, not
	 * attribution; src/server.ts hands that case over as `null`.
	 */
	sid: string | null;
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
export function resolveBlobPath(input: string): string {
	const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
	// Relative paths resolve against the host agent directory, because that is
	// what a relative path means to the host's own tools.
	return isAbsolute(expanded) ? normalize(expanded) : resolve(getAgentDir(), expanded);
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

	const target = resolveBlobPath(path);
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
	const claimed = explicit ? offset : size;

	const buf = Buffer.from(await req.arrayBuffer());
	if (buf.length === 0) return { status: 400, body: { error: "empty body" } };
	// No size check here: `maxRequestBodySize` on Bun.serve already refused
	// anything larger, with a 413, before this handler ran. A second limit would
	// only risk the two disagreeing about where the boundary is.

	// Parent directories are created for the caller: a firmware upload should not
	// have to guess whether ~/flash/ exists. Failure here is not fatal — the open
	// below reports it with the path in the message.
	await mkdir(dirname(target), { recursive: true }).catch(() => {});

	// Always "a". `w` truncates at open, and the size above was read before the body
	// arrived, so two callers starting the same file both see size 0, both pick `w`,
	// and the second open erases what the first wrote: two 200 responses, half the
	// bytes. `a` creates the file as well, and on an empty file appending at 0 is
	// the same operation as truncating, so nothing is lost by dropping `w`.
	let handle: FileHandle;
	try {
		handle = await open(target, "a");
	} catch (e) {
		auditBlob(deps.sid, path, claimed, 0, `open failed: ${(e as Error).message}`);
		return { status: 500, body: { error: `cannot open ${path}: ${(e as Error).message}` } };
	}
	let at = claimed;
	try {
		// EOF re-read with the file open, since the size above was taken before the
		// body was read and another upload may have grown the file meanwhile.
		//
		// The two request shapes differ here. An offset-less caller asked for "the
		// end", so the new end is what it wanted, and reporting that is the truth. An
		// explicit-offset caller said where the chunk belongs; if the file moved out
		// from under that claim, the append would land somewhere else while the
		// response named the offset that was asked for — so it is refused.
		const current = (await handle.stat()).size;
		if (explicit && offset !== current) {
			return {
				status: 409,
				body: { error: `the file changed while the upload was in flight: offset ${offset}, current size ${current}` },
			};
		}
		at = explicit ? offset : current;
		const { bytesWritten } = await handle.write(buf);
		if (bytesWritten !== buf.length) {
			// A short write is what a full disk or a quota looks like from here. The
			// bytes that landed are real, so the file exists but is smaller than what
			// the caller sent; saying 200 would report the image as complete.
			const now = (await handle.stat()).size;
			auditBlob(deps.sid, path, at, bytesWritten, `wrote ${bytesWritten} of ${buf.length} bytes`);
			return {
				status: 500,
				body: {
					error: `wrote ${bytesWritten} of ${buf.length} bytes to ${path}`,
					offset: at,
					size: now,
				},
			};
		}
	} catch (e) {
		// Audited before the close so the write appears in the log even when the OS
		// refused it: this endpoint bypasses the host's approval gate, and the audit
		// is the only trace of that. A success-only ledger hides exactly the writes
		// a caller would otherwise have no way to learn about.
		auditBlob(deps.sid, path, at, 0, `write failed: ${(e as Error).message}`);
		return { status: 500, body: { error: `cannot write ${path}: ${(e as Error).message}` } };
	} finally {
		await handle.close();
	}

	// Audited BEFORE the size is read back, because that read is a step that can
	// throw on a request whose write already succeeded — the file can be unlinked
	// or its parent made unsearchable in the gap after `close()`. This endpoint's
	// only trace is the audit line, so the record cannot sit behind an unrelated
	// failure: `500` with the bytes on disk and nothing in the log is precisely the
	// outcome this module exists to avoid.
	auditBlob(deps.sid, path, at, buf.length, null);

	// The size is read off the file rather than computed, so the response cannot
	// report a total the file disagrees with. Concurrent uploads to the same path
	// make that read a snapshot of a moving file, not a lock: see docs/protocol.md.
	// If the read fails, `size` is left out rather than guessed — the write did
	// happen, so answering 500 here would send a chunking client into a retry that
	// appends the same bytes twice. `written` and `offset` are still the truth.
	const finalSize = await stat(target).then(
		(s) => s.size,
		() => null,
	);
	const body: Record<string, unknown> = { written: buf.length, offset: at };
	if (finalSize !== null) body.size = finalSize;
	body.path = path;
	return { status: 200, body };
}
