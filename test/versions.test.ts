import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Version guard: the "pin == host omp version" invariant is hand-maintained
// and silently drifted before (host 18.2.11 vs pin 18.2.10, node_modules
// desynced from its own lock). Assert everything checkable locally; only warn
// when the host binary disagrees — that requires the operator to upgrade.
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

	test("host omp version vs pins (warn only; skipped when omp absent)", () => {
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
		if (m[1] !== pin) {
			console.warn(`[versions] host omp ${m[1]} != pinned ${pin} — update devDependencies and re-run bun install`);
		}
	});
});
