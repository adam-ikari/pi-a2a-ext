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
  text: 让任意 agent 调用本机这个 omp 的工具
  tagline: 扩展在宿主 session_start 时起一个 MCP 服务器（MCP 2025-11-25，Streamable HTTP，默认只绑 127.0.0.1）。任何 MCP 客户端配上 url 和 Bearer token，就能调用宿主 Main 会话里的工具（read/bash/edit…）——另一个 omp 也行，Claude Code 也行，一段 curl 也行。执行落在宿主真实的文件与 shell 上，宿主不做模型推理。
  actions:
    - theme: brand
      text: 快速开始
      link: /intro
    - theme: alt
      text: 协议参考
      link: /protocol

features:
  - title: 使用指南
    details: 装上扩展、拿到 token、把客户端指过来。含审批语义与安全边界——默认 approvalMode yolo 下 token 即工具执行全权。
    link: /intro
  - title: 协议参考
    details: 客户端要实现的全部约定：处理顺序、会话生命周期、错误码总表。桥自带的 6 个文件传输工具也在此。
    link: /protocol
  - title: 与 computer use 的区别
    details: 本桥按名字调工具，computer use 看屏幕猜坐标。省的是宿主的推理，不是调用方的上下文。
    link: /computer-use
  - title: 测试与核验
    details: 单测之外，五个核验脚本起真实的宿主 omp 跑完整流程——含跨机器安装（独立 HOME 模拟另一台机器）。审批核验给出 VERDICT A/B/C。
    link: /testing
  - title: 变更日志
    details: 按日期分节的完整演进历史，含每次评审修复的来龙去脉。
    link: /changelog
---
`;
writeFileSync(join(CONTENT, "index.md"), home);

console.log("synced content ->", CONTENT);
