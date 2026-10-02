/**
 * Package self-containment + install-path probe.
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
 * is not declared. Then that `omp install` links the bridge where the host looks
 * for it, and that the bridge comes up and serves MCP from a real host.
 *
 * ## On plugin discovery and HOME
 *
 * An earlier version of this probe asserted the host's plugin directory is
 * isolated by `HOME`, and that turned out to be half true. Measured:
 *
 *   ~/.omp/agent/extensions/   follows HOME  (a marker extension planted in a
 *                                        temp HOME does load)
 *   ~/.omp/plugins/            ignores HOME  (the bridge still loads from the
 *                                        real one; OMP_PLUGIN_DIR,
 *                                        OMP_PLUGINS_DIR and XDG_DATA_HOME do
 *                                        not redirect it)
 *
 * So discovery is not redirectable by env var. The end-to-end half below
 * therefore does not pretend to a clean machine: it drives the host over the
 * real plugin directory, which is where an installed bridge actually lives, and
 * asserts on what the bridge does rather than on which directory it came from.
 *
 * A second trap cost an hour and is worth writing down: **the host refuses to
 * create a session without model configuration, and extensions load on
 * `session_start` — so a temp HOME with no models.yml starts no session, loads no
 * extension, and the bridge never announces itself.** That reads exactly like
 * "plugin discovery ignored my HOME" and is not. Every host here is seeded via
 * test/harness.ts. When a probe claims isolation or breakage, check the obvious
 * precondition before believing it.
 *
 * Env:
 *   A2A_INSTALL_SPEC  the spec under test, reported in the output so a failure
 *                     names what was actually checked (default: origin git URL)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { seedModels } from "./harness";

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

// --- 4. the real host, over the real plugin directory -------------------------

// This is the end-to-end that the previous version of this probe gave up on. It
// is not skipped: the host is started, the bridge is discovered through the
// plugin directory an `omp install` writes to, and the MCP surface is driven as
// a remote client would drive it.
//
// What it does NOT claim: that plugin discovery was redirected. It was not, and
// no env var does that (see the header). The assertions are about the bridge's
// behaviour, which is the thing that can actually regress.
const e2eHome = mkdtempSync(join(tmpdir(), "install-e2e-"));
const e2eAgent = join(e2eHome, ".omp", "agent");
const e2eNote = seedModels(e2eAgent);
console.log(`  ${e2eNote}`);

// Reinstall every run, unconditionally. An earlier version skipped the install
// when something was already present, and that was a real hole: `~/.omp/plugins`
// holds a *copy* when installed from a git URL, so after editing the working tree
// the probe went on to test the frozen copy and reported PACKAGE OK. Demonstrated
// by breaking src/bridge.ts in the tree — the probe stayed green, because it never
// looked at the tree.
//
// `omp install .` is the spec, not the git URL, and the difference is the point:
// it links the working tree, so the host loads whatever is there right now. The
// README's git URL installs a copy of master, which cannot test uncommitted work.
// A local install is a test fixture here, not a supported install method.
const installedPlugin = join(homedir(), ".omp", "plugins", "node_modules", "pi-a2a-ext");
let installNote = "";
try {
	// Uninstall first: a leftover git-URL copy is a real directory, and install
	// would treat it as already present.
	execFileSync("omp", ["plugin", "uninstall", "pi-a2a-ext"], { stdio: "ignore" });
} catch {
	// Nothing installed is the normal case on a fresh machine.
}
try {
	const out = execFileSync("omp", ["install", REPO], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	installNote = out.trim().split("\n").pop() ?? "installed";
} catch (e) {
	const err = String((e as { stderr?: string }).stderr ?? "");
	check(false, "omp install links the extension", err.trim() || String(e));
}
check(
	existsSync(installedPlugin),
	"omp install puts pi-a2a-ext in the real plugin directory",
	`looked for ${installedPlugin}; omp install said: ${installNote}`,
);
// The host loads whatever sits in that directory, so if it is not the working
// tree the ten assertions below are about a stale copy. A link is the only shape
// that guarantees that; a copy is frozen at install time.
check(
	realpathSync(installedPlugin) === realpathSync(REPO),
	"the plugin directory points at this working tree, not a copy of it",
	`${installedPlugin} -> ${realpathSync(installedPlugin)}`,
);

const host = spawn("omp", ["--mode", "rpc"], {
	env: { ...process.env, HOME: e2eHome },
	stdio: ["pipe", "pipe", "pipe"],
});
let hostOut = "";
let hostErr = "";
host.stdout.on("data", (d) => (hostOut += d));
host.stderr.on("data", (d) => (hostErr += d));

/** Only the fields these assertions read. Keeps a failed check's detail short. */
type JsonRpcBody = {
	result?: { protocolVersion?: string; tools?: { name: string }[]; content?: { text?: string }[]; isError?: boolean };
};

const rpc = async (method: string, params: unknown, sid?: string) => {
	const r = await fetch(baseUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${e2eToken}`,
			...(sid ? { "mcp-session-id": sid } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return { body: (await r.json()) as JsonRpcBody, sid: r.headers.get("mcp-session-id") };
};

let baseUrl = "";
let e2eToken = "";
try {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline && !hostOut.includes("A2A bridge listening")) {
		host.stdin.write(""); // the host exits on EOF, so keep stdin open
		await Bun.sleep(300);
	}
	const announced = hostOut.match(/A2A bridge listening on (http:\/\/127\.0\.0\.1:\d+\/)/);
	check(
		!!announced,
		"the host announces the bridge (a session needs model config to exist at all)",
		// Detail on failure: short lines that explain a missing announcement. The
		// rpc frame log includes multi-KB command manifests that match nothing
		// useful, so anything over 200 chars is dropped rather than printed.
		[...`${hostOut}\n${hostErr}`.split("\n")]
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && l.length < 200)
			.filter((l) => /error|no model|not available|failed|refus|announc/i.test(l))
			.slice(0, 3)
			.join(" | ") || "no announcement and no short error line",
	);
	baseUrl = announced?.[1] ?? "";
	const cfg = JSON.parse(readFileSync(join(e2eAgent, "a2a-bridge.json"), "utf8"));
	e2eToken = cfg.token as string;
	check(
		Object.keys(cfg).sort().join(",") === "host,port,token",
		"first start writes only host/port/token — no path sandbox fields",
		JSON.stringify(cfg),
	);

	if (baseUrl && e2eToken) {
		const init = await rpc("initialize", { protocolVersion: "2025-11-25" });
		check(
			init.body?.result?.protocolVersion === "2025-11-25",
			"initialize returns the protocol version",
			JSON.stringify(init.body).slice(0, 200),
		);
		const sid = init.sid ?? "";

		const list = await rpc("tools/list", {}, sid);
		const names: string[] = (list.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
		check(names.length > 0, "tools/list returns the host registry", `${names.length} tools`);
		check(
			!names.some((n) => n.startsWith("a2a_")),
			"the bridge contributes no tools of its own",
			names.filter((n) => n.startsWith("a2a_")).join(", "),
		);
		check(
			!names.includes("xd://") && !names.some((n) => n.startsWith("xd://")),
			"mounted devices are not exposed as tool names",
			names.filter((n) => n.startsWith("xd://")).join(", "),
		);

		// The promise the README makes: a remote agent reaches a local toolchain.
		const called = await rpc("tools/call", { name: "bash", arguments: { command: "echo bridge-e2e-ok" } }, sid);
		const text = (called.body?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
		check(
			called.body?.result?.isError !== true && text.includes("bridge-e2e-ok"),
			"a remote tools/call runs on the local machine and returns output",
			JSON.stringify(called.body).slice(0, 200),
		);

		const dev = await rpc("tools/call", { name: "xd://debug", arguments: {} }, sid);
		check(
			dev.body?.result?.isError === true,
			"tools/call on a device name is refused",
			JSON.stringify(dev.body).slice(0, 160),
		);

		const noAuth = await fetch(baseUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		check(noAuth.status === 401, "an unauthenticated request is rejected", `got ${noAuth.status}`);
	}
} finally {
	host.kill("SIGTERM");
	rmSync(e2eHome, { recursive: true, force: true });
}

rmSync(stage, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\nPACKAGE: ${failures} check(s) failed`);
	process.exit(1);
}
console.log(`\nPACKAGE OK: the published tarball is self-contained (${SPEC})`);
