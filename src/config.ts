import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

/**
 * The bridge configures the endpoint, nothing else.
 *
 * There is no tool allow/deny list and no file sandbox here on purpose: the
 * bridge exposes whatever the host session's registry holds (`pi.getAllTools()`)
 * and executes through the host's own tools, so the host's permission model is
 * the only one. A second list here could disagree with the host's, and there is
 * no defined precedence between the two.
 */
export interface BridgeConfig {
	port: number; // 0 = random
	token: string; // base64url 32B; loadConfig rejects anything shorter than MIN_TOKEN_CHARS
	host: string; // default "127.0.0.1"
}

/**
 * Floor on a configured token. `generateToken` produces 43 characters (32 random
 * bytes, base64url), so the floor sits well below its own output: it is there to
 * catch a placeholder somebody typed, not to police a secret from a vault.
 */
export const MIN_TOKEN_CHARS = 32;

export function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.A2A_BRIDGE_CONFIG || join(getAgentDir(), "a2a-bridge.json");
}

const DEFAULTS: Omit<BridgeConfig, "token"> = {
	port: 0,
	host: "127.0.0.1",
};

function fieldError(file: string, field: string, expect: string): Error {
	return new Error(`Invalid config at ${file}: field '${field}' must be ${expect}`);
}

/**
 * Load ~/.omp/agent/a2a-bridge.json (or $A2A_BRIDGE_CONFIG).
 *
 * Fail-closed: a present-but-malformed field throws, so the extension refuses
 * to start rather than coming up on an unexpected endpoint. `token` is
 * malformed when it is too short or has whitespace, and it is refused on the
 * same terms. The one exception is a token that is *absent* (or not a string at
 * all): it is regenerated and persisted, because a bridge without a stable token
 * cannot function at all.
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

	if (typeof p.token === "string" && p.token.length > 0) {
		// Same rule as `port` and `host` above: a field that is present but cannot be
		// what it claims is refused rather than worked around. This one is the only
		// gate on an endpoint that writes anywhere the host process can, so a 3-
		// character token is not a weak default to forgive — it is the door left open.
		// Healing is deliberately NOT the answer here: regenerating would overwrite a
		// token somebody chose, and the remote's mcp.json would break with no message
		// and nothing in the log to explain it.
		if (p.token.length < MIN_TOKEN_CHARS || /\s/.test(p.token)) {
			throw fieldError(file, "token", `at least ${MIN_TOKEN_CHARS} characters, no whitespace`);
		}
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
