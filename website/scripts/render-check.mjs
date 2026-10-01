/**
 * Headless render check: does the mermaid diagram actually become an inline
 * <svg> in a browser?
 *
 * A green `vitepress build` does NOT prove this — the diagram is rendered
 * client-side, so a broken component ships a blank box that only a real
 * browser load can catch. This is the probe that says so.
 *
 * Run after `bun run build`:  node scripts/render-check.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(SITE, ".vitepress", "dist");
const MIME = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".json": "application/json",
	".txt": "text/plain",
};

// VitePress serves this site at a base path on GitHub Pages (e.g. /pi-a2a-ext/),
// where every asset URL is prefixed. The probe has to speak whatever base the
// build used, or the page loads its HTML but 404s on the entry JS and nothing
// hydrates — which looks exactly like a broken diagram.
const BASE = (() => {
	const html = readFileSync(join(DIST, "index.html"), "utf8");
	const m = html.match(/(?:src|href)="(\/[^"/]+\/)assets\//);
	return m ? m[1] : "/";
})();

// cleanUrls: VitePress writes intro.html but serves it at /intro, so an
// extensionless request has to try the .html file. Getting this wrong makes
// the probe serve "not found" and report a false failure.
const srv = createServer((req, res) => {
	let path = decodeURIComponent(req.url.split("?")[0]);
	if (BASE !== "/" && path.startsWith(BASE)) path = path.slice(BASE.length - 1);
	const direct = join(DIST, path);
	const file =
		existsSync(direct) && statSync(direct).isDirectory()
			? join(direct, "index.html")
			: existsSync(`${direct}.html`)
				? `${direct}.html`
				: direct;
	if (!existsSync(file) || !statSync(file).isFile()) {
		// Serve the real 404 page, as GitHub Pages does, so the control request
		// below distinguishes "browser works" from "browser returned nothing".
		const notFound = join(DIST, "404.html");
		res.writeHead(404, { "content-type": "text/html" });
		return res.end(existsSync(notFound) ? readFileSync(notFound) : "not found");
	}
	res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
	res.end(readFileSync(file));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

// The binary is named differently everywhere: `chromium-browser` on this
// machine, `chromium` on Debian-ish systems, and GitHub's runner images ship
// Google Chrome under /opt/hostedtoolcache — which is not on PATH-lookup's
// usual prefixes, so a hardcoded /usr/bin scan misses it entirely. Search the
// paths each of them actually lives in, and let PATH decide too.
const CANDIDATE_DIRS = [
	"/usr/bin",
	"/usr/local/bin",
	"/opt/google/chrome",
	"/opt/hostedtoolcache/stable/google-chrome",
	"/snap/bin",
];
const BROWSER =
	process.env.CHROME ||
	["google-chrome", "chromium-browser", "chromium", "chrome"].find((bin) =>
		[...CANDIDATE_DIRS.map((d) => `${d}/${bin}`), bin].some((p) => existsSync(p)),
	);
if (!BROWSER) {
	console.error(
		"render-check: no chrome/chromium binary found (tried chromium-browser, chromium, google-chrome).\n" +
			"  set CHROME=/path/to/binary, or skip this check.",
	);
	process.exit(1);
}

function dumpDom(path) {
	return new Promise((resolve) => {
		const proc = spawn(BROWSER, [
			"--headless",
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			`--user-data-dir=/tmp/vp-render-check-${process.pid}-${path.replace(/\W/g, "")}`,
			"--dump-dom",
			"--virtual-time-budget=15000",
			`http://127.0.0.1:${port}${BASE.slice(0, -1)}${path}`,
		]);
		let dom = "";
		proc.stdout.on("data", (d) => (dom += d));
		proc.on("close", () => resolve(dom));
		// A wrong CHROME (or a binary that cannot exec) throws ENOENT/EACCES as an
		// unhandled 'error' event, which prints a Node stack and hides the cause.
		proc.on("error", (err) => {
			console.error(`render-check: cannot run ${BROWSER}: ${err.message}`);
			process.exit(1);
		});
		setTimeout(() => {
			proc.kill();
			resolve(dom);
		}, 90000);
	});
}

// Pages carrying a ```mermaid fence, each with a label that must survive into
// the rendered SVG. mermaid entity-encodes non-ASCII, so decode before looking.
const PAGES = [
	{ path: "/intro", label: "远程 omp" },
	{ path: "/protocol", label: "受控端 TUI" },
];
// A page with no diagram: it must load clean and carry no stray diagram.
const PLAIN = "/testing";

/** Decode mermaid's numeric entities and pull out CJK label text from the SVG. */
function diagramText(dom) {
	const start = dom.indexOf('<div class="mermaid">');
	const end = dom.indexOf("</svg>", start);
	if (start < 0 || end < 0) return "";
	const svg = dom.slice(start, end).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
	return [...svg.matchAll(/>([^<>]{1,60})</g)].map((m) => m[1]).join(" ");
}

let failed = 0;
// Control: a page with no JavaScript at all. If this comes back empty, the
// browser or the static server is the problem and every diagram result below is
// meaningless — say that instead of reporting three phantom diagram failures.
{
	const control = await dumpDom("/__no_such_page__");
	const ok = control.length > 0 && control.includes("Not Found");
	if (!ok) {
		console.error(
			`render-check: harness is broken (control page returned ${control.length}B). ` +
				"The browser or the static server did not run, so the diagram results below prove nothing.",
		);
		process.exit(2);
	}
	console.log(`OK   control    browser + static server respond (${control.length}B)\n`);
}

for (const { path, label } of PAGES) {
	const dom = await dumpDom(path);
	const hasSvg = /<div class="mermaid">[\s\S]*?<svg[\s\S]*?<\/svg>/.test(dom);
	const text = diagramText(dom);
	// A diagram can render as an empty SVG shell (markers and a viewBox but no
	// nodes) if the component breaks, so assert on real label text, not on <svg>.
	const hasLabel = text.includes(label);
	// Scoped to the diagram on purpose: protocol.md documents the JSON-RPC error
	// code "parse error" in its own prose, so a whole-page scan false-positives
	// on a page whose diagram is fine.
	const err = /Syntax error|Parse error|mermaid version/i.test(text);
	const ok = dom.length > 5000 && hasSvg && hasLabel && !err;
	if (!ok) failed++;
	console.log(
		`${ok ? "OK  " : "FAIL"} ${path.padEnd(10)} dom=${String(dom.length).padStart(6)}B  ` +
			`svg=${hasSvg}  label(${label})=${hasLabel}  parseError=${err}`,
	);
	if (!ok && !hasSvg) {
		const m = dom.match(/<div class="mermaid">[\s\S]{0,160}/);
		if (m) console.log(`      got: ${m[0].slice(0, 160)}`);
		else console.log("      got: no .mermaid div at all — component never mounted");
	}
}

const plain = await dumpDom(PLAIN);
const plainOk = plain.length > 5000 && !/<div class="mermaid">/.test(plain);
if (!plainOk) failed++;
console.log(
	`${plainOk ? "OK  " : "FAIL"} ${PLAIN.padEnd(10)} dom=${plain.length}B  no stray diagram=${!/<div class="mermaid">/.test(plain)}`,
);

srv.close();

/*
 * Head-tag checks, read straight from the built HTML. These guard a failure
 * mode that no build error reports: a tag that is emitted but wrong. The
 * JSON-LD one is not hypothetical — it shipped for a whole release with
 * `innerHTML` passed as an attribute, so the <script> body was empty and every
 * crawler read zero structured data while the tag looked present in review.
 */
const headChecks = [];
for (const file of [
	"index.html",
	"intro.html",
	"protocol.html",
	"computer-use.html",
	"testing.html",
	"changelog.html",
]) {
	const html = readFileSync(join(DIST, file), "utf8");
	const page = file.replace(/\.html$/, "");

	const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
	const ogImage = html.match(/property="og:image" content="([^"]+)"/)?.[1];
	const ogType = html.match(/property="og:type" content="([^"]+)"/)?.[1];
	const card = html.match(/name="twitter:card" content="([^"]+)"/)?.[1];
	const ldRaw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
	let ldType = null;
	let ldValid = false;
	try {
		ldType = JSON.parse(ldRaw)["@type"];
		ldValid = true;
	} catch {
		/* reported below */
	}

	// og:image must be a raster format: Twitter/X, Facebook and Slack all drop
	// an SVG, so the card silently never appears.
	const raster = /\.(png|jpe?g|gif|webp)$/i.test(ogImage ?? "");
	const expectedType = page === "index" ? "WebSite" : "TechArticle";

	headChecks.push(
		[Boolean(canonical), `${page}: canonical`],
		[raster, `${page}: og:image is raster (${ogImage?.split("/").pop() ?? "missing"})`],
		[card === "summary_large_image", `${page}: twitter:card (${card})`],
		[Boolean(ogType), `${page}: og:type (${ogType})`],
		[ldValid && ldType === expectedType, `${page}: JSON-LD parses as ${expectedType} (got ${ldType ?? "unparseable"})`],
	);
}

for (const [ok, label] of headChecks) {
	if (!ok) failed++;
	console.log(`${ok ? "OK  " : "FAIL"} head  ${label}`);
}

if (failed) {
	console.error(`\nrender-check: ${failed} check(s) failed`);
	process.exit(1);
}
console.log("\nrender-check: all pages OK");
