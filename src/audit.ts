import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

const MAX_LOG_BYTES = 512 * 1024;
const MAX_ARGS_CHARS = 1024;

/** Audit log path: `$A2A_BRIDGE_AUDIT` or `<agentDir>/a2a-bridge.log`. */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.A2A_BRIDGE_AUDIT || join(getAgentDir(), "a2a-bridge.log");
}

function serializeArgs(args: unknown): string {
	try {
		const s = JSON.stringify(args);
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
 * Both lines carry the args summary so each is self-contained for grep; the
 * `id` is there for pairing, not for lookups. Fire-and-forget: auditing must
 * never fail or delay the call itself, and a log past MAX_LOG_BYTES rotates
 * to `<path>.1` instead of growing forever (a rotation between the two lines
 * of one call may split the pair across `.1` and the current file — when it
 * matters, pair by `id` across both).
 */
export function auditStart(id: string, tool: string, args: unknown, env?: NodeJS.ProcessEnv): void {
	appendLine(
		`${JSON.stringify({ ts: new Date().toISOString(), id, phase: "start", tool, args: serializeArgs(args) })}\n`,
		env,
	);
}

export function auditDone(id: string, tool: string, args: unknown, isError: boolean, env?: NodeJS.ProcessEnv): void {
	appendLine(
		`${JSON.stringify({ ts: new Date().toISOString(), id, phase: "done", tool, isError, args: serializeArgs(args) })}\n`,
		env,
	);
}
