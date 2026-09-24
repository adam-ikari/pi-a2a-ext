import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export interface BridgeConfig {
	port: number; // 0 = random
	token: string; // base64url 32B
	host: string; // default "127.0.0.1"
	deny: string[]; // tool names to hide
	denyMCPTools: boolean;
}

export function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.A2A_BRIDGE_CONFIG || join(getAgentDir(), "a2a-bridge.json");
}

const DEFAULTS: Omit<BridgeConfig, "token"> = {
	port: 0,
	host: "127.0.0.1",
	deny: [],
	denyMCPTools: false,
};

function fieldError(file: string, field: string, expect: string): Error {
	return new Error(`Invalid config at ${file}: field '${field}' must be ${expect}`);
}

/**
 * Load ~/.omp/agent/a2a-bridge.json (or $A2A_BRIDGE_CONFIG).
 *
 * Fail-closed: a present-but-malformed field throws, so the extension refuses
 * to start rather than silently running with wrong exposure (e.g. a `deny`
 * that isn't an array would otherwise disable filtering entirely). The one
 * exception is `token`: a missing/invalid token is regenerated and persisted,
 * because a bridge without a stable token cannot function at all.
 */
export async function loadConfig(env?: NodeJS.ProcessEnv): Promise<BridgeConfig> {
	const file = configPath(env);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULTS, token: generateToken() };
		}
		throw e;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(`Invalid config JSON at ${file}: ${(e as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid config at ${file}: expected a JSON object`);
	}
	const p = parsed as Record<string, unknown>;
	const cfg: BridgeConfig = { ...DEFAULTS, token: generateToken() };

	if ("port" in p) {
		if (typeof p.port !== "number" || !Number.isInteger(p.port) || p.port < 0 || p.port > 65535) {
			throw fieldError(file, "port", "an integer in [0, 65535]");
		}
		cfg.port = p.port;
	}
	if ("host" in p) {
		if (typeof p.host !== "string" || p.host.length === 0) {
			throw fieldError(file, "host", "a non-empty string");
		}
		cfg.host = p.host;
	}
	if ("deny" in p) {
		if (!Array.isArray(p.deny) || p.deny.some((d) => typeof d !== "string")) {
			throw fieldError(file, "deny", "an array of tool-name strings");
		}
		cfg.deny = p.deny as string[];
	}
	if ("denyMCPTools" in p) {
		if (typeof p.denyMCPTools !== "boolean") {
			throw fieldError(file, "denyMCPTools", "a boolean");
		}
		cfg.denyMCPTools = p.denyMCPTools;
	}

	if (typeof p.token === "string" && p.token.length > 0) {
		cfg.token = p.token;
	} else {
		// Heal: persist the regenerated token now, so the remote side does not
		// face a token that changes on every host restart.
		await saveConfig(cfg, env);
	}
	return cfg;
}

export async function saveConfig(cfg: BridgeConfig, env?: NodeJS.ProcessEnv): Promise<void> {
	const file = configPath(env);
	await mkdir(dirname(file), { recursive: true });
	// `mode` applies at creation (no 0644 window before chmod); chmod keeps
	// rotation correct for a file that already exists with looser permissions.
	await writeFile(file, `${JSON.stringify(cfg, null, "\t")}\n`, { mode: 0o600 });
	await chmod(file, 0o600);
}

export function isDenied(cfg: BridgeConfig, name: string): boolean {
	return cfg.deny.includes(name) || (cfg.denyMCPTools && name.startsWith("mcp__"));
}
