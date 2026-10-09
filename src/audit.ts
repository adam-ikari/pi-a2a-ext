import { createHash, randomUUID } from "node:crypto";
import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

const MAX_LOG_BYTES = 512 * 1024;
const MAX_ARGS_CHARS = 1024;
/** Args values longer than this are payloads (base64 file bytes), not intent. */
const MAX_VALUE_CHARS = 120;

/** Audit log path: `$A2A_BRIDGE_AUDIT` or `<agentDir>/a2a-bridge.log`. */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.A2A_BRIDGE_AUDIT || join(getAgentDir(), "a2a-bridge.log");
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Beyond this nesting nobody is describing a tool call any more, so the subtree is
 * omitted rather than walked. It exists to bound recursion, not to allow payloads
 * at depth 33: reaching it at all means the caller sent something pathological.
 */
const MAX_REDACT_DEPTH = 32;

/**
 * Redact oversized string leaves (a file's base64 body) down to a length plus
 * a short hash: the log stays a record of *what was called*, not a copy of the
 * payload. This walks to every leaf, and that is the whole point — it used to stop
 * two levels deep on the reasoning that "that is as nested as tool args get", and
 * the host's own `edit` tool breaks it: `{path, edits: [{oldText, newText}]}` puts
 * the file body at depth 3, so up to MAX_ARGS_CHARS of it was written verbatim.
 */
function redact(value: unknown, depth = 0): unknown {
	if (typeof value === "string") {
		return value.length > MAX_VALUE_CHARS ? `<len:${value.length},sha256:${digest(value)}>` : value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (depth >= MAX_REDACT_DEPTH) return "<max-depth>";
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = redact(v, depth + 1);
	return out;
}

function serializeArgs(args: unknown): string {
	try {
		const s = JSON.stringify(redact(args));
		if (s === undefined) return String(args);
		return s.length > MAX_ARGS_CHARS ? `${s.slice(0, MAX_ARGS_CHARS)}…` : s;
	} catch {
		return String(args).slice(0, MAX_ARGS_CHARS);
	}
}

function appendLine(line: string, env?: NodeJS.ProcessEnv): void {
	const file = auditLogPath(env);
	(async () => {
		const s = await stat(file).catch(() => null);
		if (s && s.size + line.length > MAX_LOG_BYTES) await rename(file, `${file}.1`);
		await appendFile(file, line, { mode: 0o600 });
	})().catch(() => {});
}

/**
 * Two JSONL records per remote tools/call, paired by `id`:
 *
 * - `auditStart` fires at dispatch, BEFORE the call runs, so an invocation
 *   that never settles (e.g. an approval prompt waiting for a UI that does
 *   not exist) still leaves evidence: a `start` line with no matching `done`.
 * - `auditDone` fires once the call settles and carries the outcome
 *   (`isError`).
 *
 * Both lines carry the args summary (self-contained for grep) and the
 * Mcp-Session-Id (`sid`, so a shared token's calls are attributable to a
 * client session); `id` is there for pairing, not for lookups.
 * Fire-and-forget: auditing must never fail or delay the call itself, and a
 * log past MAX_LOG_BYTES rotates to `<path>.1` instead of growing forever
 * (a rotation between the two lines of one call may split the pair across
 * `.1` and the current file — when it matters, pair by `id` across both).
 */
export function auditStart(id: string, sid: string | null, tool: string, args: unknown, env?: NodeJS.ProcessEnv): void {
	appendLine(
		`${JSON.stringify({ ts: new Date().toISOString(), id, sid, phase: "start", tool, args: serializeArgs(args) })}\n`,
		env,
	);
}

export function auditDone(
	id: string,
	sid: string | null,
	tool: string,
	args: unknown,
	isError: boolean,
	env?: NodeJS.ProcessEnv,
): void {
	appendLine(
		`${JSON.stringify({ ts: new Date().toISOString(), id, sid, phase: "done", tool, isError, args: serializeArgs(args) })}\n`,
		env,
	);
}

/**
 * One record per `POST /blob` write.
 *
 * A single line rather than a start/done pair: the write either completes or the
 * request fails, and there is no approval prompt that could leave it hanging —
 * the blob endpoint never waits on a UI (see src/blob.ts for why it cannot).
 *
 * `args` carries metadata only. The payload is the file's bytes and never
 * appears here; `bytes` is the count. A failure is recorded with `error` set and
 * `bytes: 0`, so an audit grep distinguishes "wrote 16 MB" from "tried and
 * could not".
 */
export function auditBlob(
	sid: string | null,
	path: string,
	offset: number,
	bytes: number,
	error: string | null,
	env?: NodeJS.ProcessEnv,
): void {
	const args = { path, offset, bytes };
	appendLine(
		`${JSON.stringify({
			ts: new Date().toISOString(),
			id: randomUUID(),
			sid,
			phase: "done",
			tool: "blob:write",
			isError: error !== null,
			args: serializeArgs(args),
			...(error ? { error: error.slice(0, 200) } : {}),
		})}\n`,
		env,
	);
}
