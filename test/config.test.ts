import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, isDenied, loadConfig, saveConfig } from "../src/config.ts";

let dir: string;
let file: string;
let env: NodeJS.ProcessEnv;

const VALID: BridgeConfig = {
	port: 1234,
	token: "unit-test-token",
	host: "127.0.0.1",
	deny: ["bash", "write"],
	denyMCPTools: true,
};

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "a2a-cfg-"));
	file = join(dir, "a2a-bridge.json");
	env = { A2A_BRIDGE_CONFIG: file };
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(file, { force: true });
});

describe("loadConfig", () => {
	test("missing file -> defaults with a fresh token", async () => {
		const cfg = await loadConfig(env);
		expect(cfg.port).toBe(0);
		expect(cfg.host).toBe("127.0.0.1");
		expect(cfg.deny).toEqual([]);
		expect(cfg.denyMCPTools).toBe(false);
		expect(cfg.token).toHaveLength(43); // 32 random bytes, base64url
	});

	test("valid config round-trips through save/load", async () => {
		await saveConfig(VALID, env);
		expect(await loadConfig(env)).toEqual(VALID);
		expect(configPath(env)).toBe(file);
	});

	test("saved config is 0600", async () => {
		await saveConfig(VALID, env);
		const s = await stat(file);
		expect(s.mode & 0o777).toBe(0o600);
	});

	test("unknown extra fields are ignored", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, futureField: 42 }));
		expect(await loadConfig(env)).toEqual(VALID);
	});

	test("unparseable JSON -> throws with the file path", async () => {
		await writeFile(file, "{oops");
		await expect(loadConfig(env)).rejects.toThrow(`Invalid config JSON at ${file}`);
	});

	test("non-object JSON -> throws", async () => {
		await writeFile(file, "[1,2,3]");
		await expect(loadConfig(env)).rejects.toThrow("expected a JSON object");
	});

	test("deny of the wrong type -> fail-closed", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, deny: "bash" }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'deny' must be an array`);
	});

	test("port of the wrong type -> fail-closed", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, port: "8080" }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'port' must be an integer`);
	});

	test("port out of range -> fail-closed", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, port: 70000 }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'port' must be an integer`);
	});

	test("denyMCPTools of the wrong type -> fail-closed", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, denyMCPTools: "yes" }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'denyMCPTools' must be a boolean`);
	});

	test("missing token -> regenerated and persisted (stable across restarts)", async () => {
		await writeFile(file, JSON.stringify({ port: 0, host: "127.0.0.1", deny: [], denyMCPTools: false }));
		const first = await loadConfig(env);
		const onDisk = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
		expect(onDisk.token).toBe(first.token);
		const second = await loadConfig(env);
		expect(second.token).toBe(first.token);
	});

	test("non-string token -> regenerated", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, token: 12345 }));
		const cfg = await loadConfig(env);
		expect(typeof cfg.token).toBe("string");
		expect(cfg.token).not.toBe("12345");
	});
});

describe("isDenied", () => {
	const cfg: BridgeConfig = { ...VALID, deny: ["bash"], denyMCPTools: true };

	test("exact deny match", () => expect(isDenied(cfg, "bash")).toBe(true));
	test("denyMCPTools blocks the mcp__ prefix", () => expect(isDenied(cfg, "mcp__srv__tool")).toBe(true));
	test("allowed tool passes", () => expect(isDenied(cfg, "read")).toBe(false));
	test("denyMCPTools off allows mcp tools", () =>
		expect(isDenied({ ...cfg, denyMCPTools: false }, "mcp__srv__tool")).toBe(false));
});

describe("generateToken", () => {
	test("32 bytes, base64url, unique", () => {
		const a = generateToken();
		const b = generateToken();
		expect(a).toHaveLength(43);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
	});
});
