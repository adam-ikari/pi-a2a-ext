import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Version guard: the "pin == host omp version" invariant is hand-maintained and
// has drifted six times. Assert everything checkable locally.
//
// The host comparison *fails* when a host binary is present and disagrees. It
// used to only warn, and that was the whole blind spot: the host upgrades
// itself (`startup.checkUpdate`, on by default), neither CI job can see it
// (one installs from the frozen lockfile, the other installs the pin itself),
// so a warning on the one machine that has a host is the only signal there is.
// A warning that nobody must act on is not a guard.
//
// No host on PATH (CI's `check` job) is not a mismatch — there is nothing to
// compare against, so the check skips. Deliberately testing against a different
// host version is A2A_SKIP_HOST_VERSION_CHECK=1, which logs loudly.
const SKIP_ENV = "A2A_SKIP_HOST_VERSION_CHECK";
const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	devDependencies: Record<string, string>;
};
const PI_PKGS = ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-ai"] as const;

function installedVersion(name: string): string | undefined {
	const file = join(root, "node_modules", name, "package.json");
	if (!existsSync(file)) return undefined;
	return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version;
}

describe("version guard", () => {
	test("pi-* devDependencies are exact versions (no ^ ~ ranges)", () => {
		for (const name of PI_PKGS) expect(pkg.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("installed pi-* matches its pin (node_modules in sync with package.json)", () => {
		// undefined = node_modules missing = run `bun install` first.
		for (const name of PI_PKGS) expect(installedVersion(name)).toBe(pkg.devDependencies[name]);
	});

	test("both pi-* pins agree (released in lockstep)", () => {
		expect(pkg.devDependencies["@oh-my-pi/pi-ai"]).toBe(pkg.devDependencies["@oh-my-pi/pi-coding-agent"]);
	});

	// Spawning the host CLI is not instantaneous (omp boot is ~8s on a loaded
	// box), so this test needs a timeout well above bun's 5s default.
	test("host omp version == pin (skipped when omp absent)", () => {
		let out = "";
		try {
			const r = Bun.spawnSync([process.env.OMP_BIN ?? "omp", "--version"], { stdout: "pipe", stderr: "pipe" });
			if (r.exitCode === 0) out = r.stdout?.toString() ?? "";
		} catch {
			// omp not installed: nothing to compare against.
		}
		const m = /(\d+\.\d+\.\d+)/.exec(out);
		if (!m) {
			console.warn("[versions] omp not found or unparsable — skipped host check");
			return;
		}
		const pin = pkg.devDependencies["@oh-my-pi/pi-coding-agent"];
		if (process.env[SKIP_ENV] === "1") {
			console.warn(`[versions] SKIPPED by ${SKIP_ENV}=1 — host omp ${m[1]} vs pin ${pin} NOT verified`);
			return;
		}
		// The assertion compares strings so the failure message names both
		// versions and the fix; the "received" side is only the mismatch text
		// when there is a mismatch.
		const message =
			m[1] === pin
				? `host omp ${m[1]} == pinned ${pin}`
				: `host omp ${m[1]} != pinned ${pin} — update devDependencies to ${m[1]} and re-run \`bun install\``;
		expect(message).toBe(`host omp ${pin} == pinned ${pin}`);
	}, 30_000);
});
