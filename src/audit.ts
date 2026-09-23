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

/**
 * Append one JSONL record per remote tools/call (timestamp, tool, args
 * summary, outcome) so token-held invocations of host tools are traceable.
 * Fire-and-forget: auditing must never fail or delay the call itself, and a
 * log past MAX_LOG_BYTES rotates to `<path>.1` instead of growing forever.
 */
export function auditCall(tool: string, args: unknown, isError: boolean, env?: NodeJS.ProcessEnv): void {
	const file = auditLogPath(env);
	const line = `${JSON.stringify({ ts: new Date().toISOString(), tool, isError, args: serializeArgs(args) })}\n`;
	(async () => {
		const s = await stat(file).catch(() => null);
		if (s && s.size + line.length > MAX_LOG_BYTES) await rename(file, `${file}.1`);
		await appendFile(file, line, { mode: 0o600 });
	})().catch(() => {});
}
