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
  text: 让远程的 agent 操作你本地的设备
  tagline: Agent 跑在服务器上，设备插在你机器上——中间的 USB 没人能跨。扩展在宿主 session_start 时起一个 MCP 服务器（MCP 2025-11-25，Streamable HTTP，默认只绑 127.0.0.1）；远程 agent 配上 url 和 Bearer token，就能在这台机器上跑 adb、idf、串口工具，也能用宿主挂载的调试设备。执行全落在本地，宿主不做模型推理。
  actions:
    - theme: brand
      text: 接上远程 agent
      link: /intro
    - theme: alt
      text: 协议参考
      link: /protocol

features:
  - title: 接上远程 agent
    details: 装上扩展拿到 token，把远程客户端的 mcp.json 指过来。跨机走 SSH 端口转发，默认只绑回环。
    link: /intro
  - title: 远程能碰到什么
    details: 宿主注册表里的工具原样透传——read/bash/edit…，于是 adb、idf、串口、烧录都能在本地跑；宿主挂载的 xd:// 设备（如 DAP 调试器）也能用。
    link: /intro#设备
  - title: 协议参考
    details: 客户端要实现的全部约定：处理顺序、会话生命周期、错误码总表。设备走 read/write 的 xd:// path，不是独立工具名。
    link: /protocol
  - title: 与 computer use 的区别
    details: 本桥按名字调工具，computer use 看屏幕猜坐标。省的是宿主的推理，不是调用方的上下文。
    link: /computer-use
  - title: 测试与核验
    details: 单测之外，三个核验脚本起真实的宿主 omp 跑完整流程，另有一个核验发布包自包含。审批核验给出 VERDICT A/B/C。
    link: /testing
  - title: 变更日志
    details: 按日期分节的完整演进历史，含每次评审修复的来龙去脉。
    link: /changelog
---
`;
writeFileSync(join(CONTENT, "index.md"), home);

console.log("synced content ->", CONTENT);
