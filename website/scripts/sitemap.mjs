/**
 * Generate dist/sitemap.xml from the built HTML (the npm mirror this CI uses
 * has no vitepress-plugin-sitemap). Run after `vitepress build`.
 *
 * The site is a single-locale static build, so every page except 404 is a
 * crawlable URL. SITE_URL is injected by build to keep the absolute origin in
 * one place; it must match the `base` derived in .vitepress/config.ts.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(dirname(fileURLToPath(import.meta.url))), ".vitepress", "dist");
const SITE_URL = (process.env.SITE_URL || "https://adam-ikari.github.io/pi-a2a-ext/").replace(/\/?$/, "/");

/** Collect every built .html as a clean (extensionless, base-prefixed) URL. */
function collect(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...collect(abs));
		else if (entry.name.endsWith(".html") && entry.name !== "404.html") {
			const rel = abs.slice(DIST.length).replace(/\.html$/, "").replace(/index$/, "");
			const mtime = statSync(abs).mtime;
			out.push({ url: `${SITE_URL}${rel.replace(/^\//, "")}`, lastmod: mtime.toISOString().slice(0, 10) });
		}
	}
	return out;
}

const pages = collect(DIST).sort((a, b) => a.url.localeCompare(b.url));
const xml = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	...pages.map((p) => `  <url>\n    <loc>${p.url}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`),
	"</urlset>",
	"",
].join("\n");
writeFileSync(join(DIST, "sitemap.xml"), xml);
console.log(`sitemap: ${pages.length} urls -> ${SITE_URL}sitemap.xml`);
