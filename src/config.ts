import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
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
	let parsed: Partial<BridgeConfig>;
	try {
		parsed = JSON.parse(raw) as Partial<BridgeConfig>;
	} catch (e) {
		throw new Error(`Invalid config JSON at ${file}: ${(e as Error).message}`);
	}
	return { ...DEFAULTS, token: generateToken(), ...parsed };
}

export async function saveConfig(cfg: BridgeConfig, env?: NodeJS.ProcessEnv): Promise<void> {
	const file = configPath(env);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(cfg, null, "\t") + "\n");
	await chmod(file, 0o600);
}

export function isDenied(cfg: BridgeConfig, name: string): boolean {
	return cfg.deny.includes(name) || (cfg.denyMCPTools && name.startsWith("mcp__"));
}
