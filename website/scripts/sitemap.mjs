/**
 * Generate dist/sitemap.xml from the built HTML (the npm mirror this CI uses
 * has no vitepress-plugin-sitemap). Run after `vitepress build`.
 *
 * The site is a single-locale static build, so every page except 404 is a
 * crawlable URL. The origin is derived exactly the way .vitepress/config.ts
 * derives it (owner.github.io + repo base) so the two cannot drift; SITE_URL
 * stays as an override for local previews.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(SITE, ".vitepress", "dist");
const REPO = dirname(SITE);

const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
const isUserSite = repo === `${owner}.github.io`;
const base = isUserSite ? "/" : `/${repo}/`;
const SITE_URL = (
	process.env.SITE_URL ?? (owner && repo ? `https://${owner}.github.io${base}` : "http://localhost:5173/")
).replace(/\/?$/, "/");

/** Last commit date (YYYY-MM-DD) touching a repo file, or null if git can't say. */
function lastCommitDate(relPath) {
	if (!relPath) return null;
	try {
		// -1 on a pathspec gives the most recent commit for that file.
		const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", relPath], {
			cwd: REPO,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim() || null;
	} catch {
		return null;
	}
}

// content/ is generated from these repo files by sync.mjs; lastmod must reflect
// when the SOURCE last changed, not when CI ran.
const SOURCE_OF = {
	index: "README_ZN.md",
	intro: "README_ZN.md",
	changelog: "CHANGELOG.md",
	protocol: "docs/protocol.md",
	testing: "docs/testing.md",
};

// sync.mjs copies docs/** verbatim, so every other page maps back by path
// (superpowers/plans/X -> docs/superpowers/plans/X) instead of needing an entry.
function sourceOf(page) {
	return SOURCE_OF[page] ?? (page ? `docs/${page}.md` : undefined);
}

/** Collect every built .html as a clean (extensionless, base-prefixed) URL. */
function collect(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...collect(abs));
		else if (entry.name.endsWith(".html") && entry.name !== "404.html") {
			const rel = abs
				.slice(DIST.length)
				.replace(/\.html$/, "")
				.replace(/index$/, "");
			const page = rel.replace(/^\//, "");
			out.push({ url: `${SITE_URL}${page}`, page });
		}
	}
	return out;
}

// One git call for the whole tree rather than one per page.
let head = "";
try {
	head = execFileSync("git", ["log", "-1", "--format=%cs"], {
		cwd: REPO,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	head = "";
}

const pages = collect(DIST)
	// Only claim a lastmod we can actually substantiate: the source file's last
	// commit, falling back to the newest commit in the repo. Previously this was
	// the built file's mtime, which is the CI run time — every page claimed to
	// change on every deploy, and search engines are told to ignore that.
	.map((p) => ({ ...p, lastmod: lastCommitDate(sourceOf(p.page)) ?? head }))
	.filter((p) => p.lastmod) // no git -> omit lastmod rather than invent one
	.sort((a, b) => a.url.localeCompare(b.url));

const xml = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	...pages.map((p) => `  <url>\n    <loc>${p.url}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`),
	"</urlset>",
	"",
].join("\n");
writeFileSync(join(DIST, "sitemap.xml"), xml);
console.log(`sitemap: ${pages.length} urls -> ${SITE_URL}sitemap.xml`);
if (!head) console.warn("sitemap: no git history, lastmod omitted");

// robots.txt points at the sitemap by ABSOLUTE url, so it has to carry the same
// origin. Written here rather than committed as a static file precisely because
// a hardcoded copy is a second thing to forget when the repo moves.
writeFileSync(join(DIST, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);
