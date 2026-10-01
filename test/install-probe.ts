/**
 * Package self-containment probe.
 *
 *   bun run test:install
 *
 * ## What it checks
 *
 * That the published tarball can be installed by a machine that has never seen
 * this repo, and that what lands on disk is enough to load. Concretely: the
 * manifest carries a version and the `pi.extensions` load switch, the tarball
 * ships both halves the entry imports (`extensions/` + `src/`), every module
 * the entry pulls in is present, and none of them reaches for a dependency that
 * is not declared.
 *
 * ## What it deliberately does NOT check
 *
 * It does not start a host omp, and it does not drive the MCP endpoint. The
 * earlier version of this probe did, and it was verifying the wrong thing: the
 * host resolves its plugin directory independently of `HOME`, so a throwaway
 * HOME did not isolate plugin discovery — the host kept loading whatever was
 * installed in the *real* `~/.omp/plugins`, and every "fresh machine" assertion
 * was really re-testing that stale copy. `XDG_DATA_HOME`, `OMP_PLUGIN_DIR` and a
 * changed cwd were all tried and none of them redirect plugin discovery.
 *
 * So this probe now stops at the boundary it can actually observe: the package.
 * Whether `omp install` from a git URL end-to-end on a clean machine still works
 * is **not covered by automation** — see docs/testing.md. Restoring that
 * coverage means understanding the host's plugin discovery first, which is its
 * own task; re-implementing an isolation layer on this side would be a second
 * opinion about someone else's directory layout.
 *
 * Env:
 *   A2A_INSTALL_SPEC  the spec under test, reported in the output so a failure
 *                     names what was actually checked (default: origin git URL)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SPEC = process.env.A2A_INSTALL_SPEC ?? "https://github.com/adam-ikari/pi-a2a-ext.git";

let failures = 0;
function check(cond: unknown, label: string, extra = ""): void {
	console.log(`${cond ? "ok" : "FAIL"}: ${label}${extra ? ` (${extra})` : ""}`);
	if (!cond) failures++;
}
function fail(msg: string): never {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

console.log(`spec under test: ${SPEC}\n`);

// --- 1. the manifest is what makes this installable at all -------------------

const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
	name?: string;
	version?: string;
	pi?: { extensions?: string[] };
	files?: string[];
	dependencies?: Record<string, string>;
};

check(typeof manifest.name === "string" && manifest.name.length > 0, "manifest declares a name", manifest.name);
check(
	typeof manifest.version === "string" && manifest.version.length > 0,
	"manifest carries a version (else omp reports @undefined)",
	manifest.version,
);
check(
	Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length > 0,
	"manifest declares pi.extensions (the load switch)",
	JSON.stringify(manifest.pi?.extensions),
);
// The bridge is zero-dependency by design: every import of a runtime package
// has to resolve to the host's own copy or the load fails.
check(
	Object.keys(manifest.dependencies ?? {}).length === 0,
	"no runtime dependencies (the host shim provides @oh-my-pi/*)",
	JSON.stringify(manifest.dependencies ?? {}),
);
// A files list that misses either half installs fine and then fails to load,
// because the entry imports ../src/*.ts.
const files = manifest.files ?? [];
check(files.includes("extensions/"), "files[] ships extensions/", JSON.stringify(files));
check(files.includes("src/"), "files[] ships src/ (the entry imports ../src/*.ts)", JSON.stringify(files));

// --- 2. what actually ships --------------------------------------------------

const stage = mkdtempSync(join(tmpdir(), "a2a-pack-"));
console.log("\n--- pack the tarball ---");
let packOut = "";
try {
	packOut = execFileSync("npm", ["pack", "--pack-destination", stage], {
		cwd: REPO,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
} catch (e) {
	fail(`npm pack failed: ${(e as { stderr?: string }).stderr ?? e}`);
}
const tarball = join(stage, packOut.trim().split("\n").at(-1) ?? "");
check(existsSync(tarball), "npm pack produced a tarball", tarball.split("/").at(-1));
const tarballBytes = existsSync(tarball) ? statSync(tarball).size : 0;
check(tarballBytes > 0 && tarballBytes < 500_000, "tarball is small (ships no node_modules)", `${tarballBytes} B`);

// Unpack it: the check has to be against the tarball, not the working tree —
// the working tree has files that `files[]` may legitimately exclude.
execFileSync("tar", ["-xzf", tarball, "-C", stage], { stdio: ["ignore", "pipe", "pipe"] });
const pkgRoot = join(stage, "package");

check(existsSync(join(pkgRoot, "package.json")), "tarball unpacks to a package/ root");
for (const rel of [
	"extensions/a2a-bridge.ts",
	"src/audit.ts",
	"src/auth.ts",
	"src/bridge.ts",
	"src/config.ts",
	"src/server.ts",
]) {
	check(existsSync(join(pkgRoot, rel)), `tarball ships ${rel}`);
}

// --- 3. the entry's own imports must resolve inside the package --------------

// Walk the relative-import graph from the entry. Anything it reaches has to be
// in the tarball; a module that only exists in the working tree (a dev-only
// file, or one dropped from files[]) installs fine and then throws on load.
const entry = join(pkgRoot, "extensions", "a2a-bridge.ts");
const seen = new Set<string>();
const missing: string[] = [];
const queue = [entry];
while (queue.length > 0) {
	const file = queue.pop() as string;
	if (seen.has(file)) continue;
	seen.add(file);
	if (!existsSync(file)) {
		missing.push(file.slice(pkgRoot.length + 1));
		continue;
	}
	for (const m of readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)) {
		queue.push(resolve(file, "..", m[1]));
	}
}
check(missing.length === 0, "every relative import of the entry resolves inside the package", missing.join(", "));
check(seen.size >= 6, "the entry graph was actually walked", `${seen.size} modules`);

// --- 4. scripts/install.sh, run for real against a throwaway agent dir -------

// This script used to carry a hand-written list of src/*.ts that it required to
// exist. Deleting two modules left that list stale, and every real install then
// died with "incomplete checkout?" on a complete checkout. So exercise the
// script rather than reading it: a clean install must succeed, and moving one
// module out of the graph must make it fail. A check that cannot fail is not a
// check.
const shHome = mkdtempSync(join(tmpdir(), "install-sh-"));
const shAgent = join(shHome, "agent");
mkdirSync(shAgent, { recursive: true });
const sh = (args: string[]) =>
	execFileSync("bash", [join(REPO, "scripts", "install.sh"), ...args], {
		env: { ...process.env, OMP_AGENT_DIR: shAgent },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

try {
	sh([]);
	const link = join(shAgent, "extensions", "a2a-bridge.ts");
	check(
		existsSync(link) && realpathSync(link) === realpathSync(join(REPO, "extensions", "a2a-bridge.ts")),
		"install.sh links the entry into a fresh agent dir",
		link,
	);
	const status = sh(["--status"]);
	// --status prints "repo:" then "status: <state>", so match the state field
	// rather than anchoring on a line start.
	check(/^status:\s+installed\b/m.test(status), "install.sh --status reports installed", status.trim());
} catch (e) {
	check(false, "install.sh succeeds on a complete checkout", String((e as { stderr?: string }).stderr ?? e).trim());
}

// The negative half: pick a module the entry reaches but does not import
// directly, so this proves the script walks transitively rather than only
// checking the entry's own import list.
const transitive = readFileSync(join(REPO, "src", "bridge.ts"), "utf8").match(/from\s+"(\.\/[^"]+)"/);
check(!!transitive, "found a module src/bridge.ts imports to use as the negative case", transitive?.[1] ?? "none");
if (transitive) {
	const victim = join(REPO, "src", transitive[1].replace(/^\.\//, ""));
	const stashed = `${victim}.stashed-by-probe`;
	renameSync(victim, stashed);
	let refused = "";
	try {
		sh([]);
		refused = "install.sh exited 0 with a module missing from the graph";
	} catch (e) {
		const err = String((e as { stderr?: string }).stderr ?? "");
		refused = /unresolvable relative import/.test(err)
			? ""
			: `failed, but not with the expected message: ${err.trim()}`;
	} finally {
		renameSync(stashed, victim);
	}
	check(refused === "", "install.sh refuses when a transitively-imported module is missing", refused);
	// The stash must be gone either way, or a failed check leaves the tree broken.
	if (existsSync(stashed)) renameSync(stashed, victim);
}

sh(["--uninstall"]);
check(!existsSync(join(shAgent, "extensions", "a2a-bridge.ts")), "install.sh --uninstall removes the link", shAgent);
rmSync(shHome, { recursive: true, force: true });

rmSync(stage, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\nPACKAGE: ${failures} check(s) failed`);
	process.exit(1);
}
console.log(`\nPACKAGE OK: the published tarball is self-contained (${SPEC})`);
