/**
 * Sync the repo's source-of-truth markdown into website/content/ (generated,
 * gitignored). VitePress never reads README/CHANGELOG/docs/ directly:
 *
 *   docs/**            -> content/**            (verbatim copy)
 *   README_ZN.md       -> content/intro.md      (frontmatter + link rewrites)
 *   CHANGELOG.md       -> content/changelog.md  (frontmatter, H1 re-emitted)
 *   protocol.md        -> link rewrites (repo-relative -> site-relative)
 *   index.md (home)    -> content/index.md      (VitePress home layout)
 *
 * Repo-relative links must be rewritten because content/ sits at a different
 * depth; links that only make sense in the git repo are unlinked instead.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(SITE);
const CONTENT = join(SITE, "content");

rmSync(CONTENT, { recursive: true, force: true });
mkdirSync(CONTENT, { recursive: true });

// DRAFT=1 publishes a single holding page instead of the site. The extension's
// shape is still being decided, so the docs describe something that may change —
// publishing them now would have readers build against a form that gets revised.
// The repo's markdown stays the source of truth and untouched; only the built
// site changes, and dropping the env var brings the whole site back.
if (process.env.DRAFT === "1") {
	cpSync(join(SITE, "public"), join(CONTENT, "public"), { recursive: true });
	writeFileSync(
		join(CONTENT, "index.md"),
		`---
layout: home
hero:
  name: omp A2A Bridge
  text: 文档站正在重写
  tagline: 扩展的形态还没定下来，现在发布出来的内容可能改掉。仓库里的 README 与 docs 是准绳，改完再上线。
  actions:
    - theme: alt
      text: 看仓库
      link: https://github.com/adam-ikari/pi-a2a-ext
features: []
---
`,
	);
	process.stdout.write("sync: DRAFT=1 — 只出占位页，未发布正文\n");
	process.exit(0);
}

cpSync(join(REPO, "docs"), CONTENT, { recursive: true });

// Per-page descriptions. `transformHead` already prefers `pageData.description`
// over the site-wide one, but nothing set it — so every page carried the same
// string, which is how a search engine sees near-duplicate pages. Each is taken
// from what that page actually says.
const PAGE_DESCRIPTIONS = {
	"protocol.md":
		"桥实现的 MCP 2025-11-25 Streamable HTTP 子集：处理顺序、会话生命周期、错误码总表、POST /blob 的原始字节上传与它放弃的东西。",
	"testing.md":
		"核验矩阵：105 单测（含不起宿主也能量到的宿主交接那半条路径与入口那一层的端口生死）、32 项原始字节上传（含宿主 RSS 实测与写失败路径）、35 项加固（含审计轮转与逐层脱敏）、28 项发布包与端到端、10 个端到端场景、审批边界判别。附插件发现与 HOME 的实测结论。",
	"computer-use.md":
		"computer use 让模型看屏幕猜坐标去点按，本桥让调用方按名字调工具。执行的是真工具而非模拟操作，目录是显式的而非猜的。",
};
for (const [file, description] of Object.entries(PAGE_DESCRIPTIONS)) {
	const target = join(CONTENT, file);
	const body = readFileSync(target, "utf8");
	if (body.startsWith("---")) continue; // already has frontmatter
	// Keep the H1 and re-emit it under the frontmatter. Dropping it left these
	// pages starting at h2 — the same defect /intro had. The page title in
	// frontmatter is what the nav and <title> use; the H1 is what the page shows.
	const h1 = body.match(/^# (.+)\n/);
	const rest = body.replace(/^# .*\n+/, "");
	const heading = h1 ? `\n# ${h1[1]}\n` : "";
	writeFileSync(target, `---\ndescription: ${description}\n---\n${heading}\n${rest}`);
}

// README_ZN.md -> intro.md. The site is the Chinese one: README.md is the
// English default and README_ZN.md the translation, so sync the translation
// and strip its language-switch line (the site has a single locale).
// replaceAll, not replace: the README links to the same page more than once,
// VitePress resolves its public dir to <srcDir>/public = content/public, so
// copy the tracked website/public assets there as part of generation.
cpSync(join(SITE, "public"), join(CONTENT, "public"), { recursive: true });
// and a half-rewritten link is a broken link in the site build.
const intro = readFileSync(join(REPO, "README_ZN.md"), "utf8")
	.replace(/^# omp A2A Bridge\n/, "")
	.replace(/^\[English\]\(README\.md\) \| 简体中文\n+/m, "")
	.replaceAll("](docs/protocol.md)", "](./protocol.md)")
	.replaceAll("](docs/testing.md)", "](./testing.md)")
	.replaceAll("](docs/computer-use.md)", "](./computer-use.md)")
	.replaceAll("](CHANGELOG.md)", "](./changelog.md)")
	.replaceAll("[LICENSE](LICENSE)", "LICENSE 文件");
// The README's own H1 is the repo name, which the site's `title` already
// carries, so it goes. That left the page with 15 h2 and no h1 at all — the one
// page where that matters most, since it is what the nav sends people to. Give
// it its own h1 rather than promoting a section.
writeFileSync(
	join(CONTENT, "intro.md"),
	`---\ntitle: 使用指南\n---\n\n# 装上它，远程 agent 就能用你本机的工具\n\n${intro}`,
);

// CHANGELOG -> changelog.md (H1 replaced, add frontmatter). The link rewrites
// are the same: entries link to repo files by repo-relative path, which does
// not resolve from content/changelog.md.
// Same treatment: keep an H1 and give the page its own description, so the six
// pages do not all ship one string.
const changelog = readFileSync(join(REPO, "CHANGELOG.md"), "utf8")
	.replace(/^# Changelog\n+/, "")
	.replaceAll("](docs/computer-use.md)", "](./computer-use.md)")
	.replaceAll("](docs/protocol.md)", "](./protocol.md)")
	.replaceAll("](docs/testing.md)", "](./testing.md)");
writeFileSync(
	join(CONTENT, "changelog.md"),
	`---\ntitle: 变更日志\ndescription: 从 v0.1.0 起的完整演进：POST /blob 的原始字节上传、端到端核验的恢复与推翻、安装方式的收敛，每条都写明实测数字与代价。\n---\n\n# 变更日志\n\n${changelog}`,
);

// protocol.md: repo-relative links -> site form
const protocolPath = join(CONTENT, "protocol.md");
writeFileSync(
	protocolPath,
	readFileSync(protocolPath, "utf8")
		.replace("[`src/server.ts`](../src/server.ts)", "`src/server.ts`")
		.replace("[README](../README.md)", "[README](./intro.md)"),
);

// VitePress home page: default hero + features. The site UI lives here, not
// in the repo docs, so the frontmatter is hard-coded in the sync script.
// Sidebar category labels for the design docs are configured in
// .vitepress/config.ts instead of per-folder _category_.json.
const home = `---
layout: home

hero:
  name: omp A2A Bridge
  text: 让远程的 agent 操作你本地的设备
  tagline: 扩展把本机跑着的这个 omp 开成一个 MCP 接口，远程 agent 指过来就能在这台机器上跑 adb、idf.py、串口工具。宿主不做模型推理——收请求、跑工具、回结果。
  actions:
    - theme: brand
      text: 接上远程 agent
      link: /intro
    - theme: alt
      text: 协议参考
      link: /protocol

features:
  - title: 远程能碰到什么
    details: 宿主注册表原样透传，bash 在其中——adb、idf.py、烧录器都是本机上的命令。宿主挂载的 xd:// 设备走 read/write 的 path。
    link: /intro#设备
  - title: 传固件
    details: POST /blob 收原始字节，不 base64。实测 100 MB 一次请求传完，字节一致。上传专用，GET 会 405——理由在协议页。
    link: /intro#传文件
  - title: 接上远程 agent
    details: 宿主首次启动时广播桥地址并生成 token，复制进远程客户端的 mcp.json 即连通。跨机走 SSH 端口转发。
    link: /intro
  - title: 与 computer use 的区别
    details: computer use 让模型看屏幕猜坐标去点按，本桥按名字调工具。前者操作像素，后者操作宿主已注册的工具——要推理的那一方也在不同地方。
    link: /computer-use
  - title: 协议参考
    details: 客户端要实现的全部约定：处理顺序、会话生命周期、错误码总表。
    link: /protocol
  - title: 测试与核验
    details: 单测之外，六个核验起真实的宿主 omp 跑完整流程，发布包那一个装回去跑通才算过。审批核验给出 VERDICT A/B/C。
    link: /testing
---
`;
writeFileSync(join(CONTENT, "index.md"), home);

console.log("synced content ->", CONTENT);
