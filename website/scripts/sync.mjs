/**
 * Sync the repo's source-of-truth markdown into website/content/ (generated,
 * gitignored). VitePress never reads README/CHANGELOG/docs/ directly:
 *
 *   docs/**            -> content/**            (verbatim copy)
 *   README_ZN.md       -> content/intro.md      (frontmatter + link rewrites)
 *   CHANGELOG.md       -> content/changelog.md  (frontmatter + H1 strip)
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
writeFileSync(join(CONTENT, "intro.md"), `---\ntitle: 使用指南\n---\n\n${intro}`);

// CHANGELOG -> changelog.md (strip H1, add frontmatter). The same link rewrites
// as intro: entries link to repo files by their repo-relative path, which does
// not resolve from content/changelog.md.
const changelog = readFileSync(join(REPO, "CHANGELOG.md"), "utf8")
	.replace(/^# Changelog\n/, "")
	.replaceAll("](docs/computer-use.md)", "](./computer-use.md)")
	.replaceAll("](docs/protocol.md)", "](./protocol.md)")
	.replaceAll("](docs/testing.md)", "](./testing.md)");
writeFileSync(join(CONTENT, "changelog.md"), `---\ntitle: 变更日志\n---\n\n${changelog}`);

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
  - title: 接上远程 agent
    details: 宿主首次启动时广播桥地址并生成 token，复制进远程客户端的 mcp.json 即连通。跨机走 SSH 端口转发。
    link: /intro
  - title: 远程能碰到什么
    details: 宿主注册表原样透传，bash 在其中——adb、idf.py、烧录器都是本机上的命令。宿主挂载的设备同样能用。
    link: /intro#设备
  - title: 协议参考
    details: 客户端要实现的全部约定：处理顺序、会话生命周期、错误码总表。
    link: /protocol
  - title: 与 computer use 的区别
    details: 本桥按名字调工具，computer use 看屏幕猜坐标。省的是宿主的推理，不是调用方的上下文。
    link: /computer-use
  - title: 测试与核验
    details: 单测之外，三个核验脚本起真实的宿主 omp 跑完整流程，另一个核验发布包自包含。
    link: /testing
---
`;
writeFileSync(join(CONTENT, "index.md"), home);

console.log("synced content ->", CONTENT);
