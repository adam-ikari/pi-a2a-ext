/**
 * Shared host bootstrap for the real-host probes.
 *
 * Every probe needs a throwaway HOME with the extension linked in, a config
 * pinning its token and port, and a models.yml. That last one exists only
 * because the host refuses to boot without model configuration — and it is the
 * reason these probes used to be unrunnable anywhere but a developer machine:
 * they copied the developer's real `~/.omp/agent/models.yml`, which means a real
 * provider and a real API key.
 *
 * It does not need a *working* provider. The host only checks that model
 * configuration exists before it starts a session; the probes never ask a model
 * anything, they only drive the bridge over MCP. So this writes a deliberately
 * unreachable provider: the boot succeeds, and nothing in the probe path can
 * reach the network.
 *
 * If you have a real models.yml and prefer it (e.g. to exercise against a real
 * host config), set A2A_PROBE_REAL_MODELS=1.
 */
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Unreachable on purpose — see the note above. */
const FAKE_MODELS_YML = `providers:
  a2a-probe-placeholder:
    baseUrl: http://127.0.0.1:1/v1
    api: anthropic-messages
    apiKey: not-a-real-key
    models:
      - id: a2a-probe/small
        contextWindow: 100000
`;

/**
 * Seed <agentDir>/models.yml so the host will boot. Returns a one-line note
 * about which source was used, for the probe's preamble.
 */
export function seedModels(agentDir: string): string {
	mkdirSync(agentDir, { recursive: true });
	const target = join(agentDir, "models.yml");
	const real = join(homedir(), ".omp", "agent", "models.yml");

	if (process.env.A2A_PROBE_REAL_MODELS === "1" && existsSync(real)) {
		copyFileSync(real, target);
		return "models.yml: copied from the real HOME (A2A_PROBE_REAL_MODELS=1)";
	}
	writeFileSync(target, FAKE_MODELS_YML);
	return "models.yml: placeholder provider (unreachable on purpose; the probes never call a model)";
}

/**
 * Link the extension into `<agentDir>/extensions/` so a throwaway HOME's host
 * actually loads it.
 *
 * This was open-coded in every probe, and `test:blob` shipped without it: it
 * passed locally because `omp install .` had left a copy in the real plugin
 * directory, and failed in CI, where nothing installs the extension. The symptom
 * was "the host came up but the bridge never announced itself" — which reads like
 * a bridge bug and is not one.
 *
 * Note the direction this proves: the host follows HOME for `~/.omp/agent/
 * extensions/` but not for `~/.omp/plugins/`. A probe that relies on the real
 * plugin directory tests whatever is installed there, not this checkout.
 */
export function linkExtension(agentDir: string): void {
	const REPO = resolve(import.meta.dir, "..");
	const extDir = join(agentDir, "extensions");
	mkdirSync(extDir, { recursive: true });
	symlinkSync(resolve(REPO, "extensions", "a2a-bridge.ts"), join(extDir, "a2a-bridge.ts"));
}
