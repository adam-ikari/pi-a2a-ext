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
	.replaceAll("](CHANGELOG.md)", "](./changelog.md)")
	.replaceAll("[LICENSE](LICENSE)", "LICENSE 文件");
writeFileSync(join(CONTENT, "intro.md"), `---\ntitle: 使用指南\n---\n\n${intro}`);

// CHANGELOG -> changelog.md (strip H1, add frontmatter)
const changelog = readFileSync(join(REPO, "CHANGELOG.md"), "utf8").replace(/^# Changelog\n/, "");
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
  text: 让另一台机器直接调用本机会话的工具
  tagline: 装上扩展，运行中的 omp 就多了一个 MCP 接口；远程 omp 配上地址即可调用本机的真实工具与文件，宿主不做模型推理，不消耗 token。
  actions:
    - theme: brand
      text: 快速开始
      link: /intro
    - theme: alt
      text: 协议参考
      link: /protocol

features:
  - title: 使用指南
    details: 安装、配置、远程 mcp.json 接入、审批语义与安全边界（源：README）。
    link: /intro
  - title: 协议参考
    details: wire 契约：传输约定、处理顺序、会话生命周期、桥自带文件传输工具、错误码总表。
    link: /protocol
  - title: 测试与探针
    details: 单测矩阵、真实宿主 E2E 四件套、审批判别探针 VERDICT A/B/C。
    link: /testing
  - title: 变更日志
    details: 按日期分节的完整演进历史（源：CHANGELOG）。
    link: /changelog
---
`;
writeFileSync(join(CONTENT, "index.md"), home);

console.log("synced content ->", CONTENT);
