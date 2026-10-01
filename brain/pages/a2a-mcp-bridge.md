---
id: a2a-mcp-bridge
title: A2A MCP bridge architecture
category: decision
status: active
tags: [omp, extension, mcp]
created: "2026-09-10T09:16:34"
updated: "2026-10-01T11:56:34"
---

<!-- compiled_truth -->
# A2A MCP Bridge — Key Decisions

Goal: an omp extension (pi-a2a-ext) turns the running omp into a Streamable HTTP MCP server so a remote omp can call the host's live tools without the host invoking any LLM API.

（本页其余 Q1–Q8 与 timeline 未改动；本轮为网站侧修订，见下方「网站构建链」一节。）

## 网站构建链（2026-10-01 修订）

站点是 VitePress 1.6.4 单语言中文站，GitHub Pages 部署，构建链为 `website/scripts/sync.mjs`（从 `README_ZN.md` / `CHANGELOG.md` / `docs/**` 生成 `content/`）→ `vitepress build` → `scripts/sitemap.mjs`。

**Mermaid 不能用 `withMermaid`**。该插件的 Vite transform 把 Mermaid 组件**静态**注入 `vitepress/dist/client/app/index.js`（app entry），mermaid 及其约 40 个 diagram 类型因此进入 entry 的 import graph；而 VitePress 的 `resolvePageImports` 会把 `appChunk.imports + appChunk.dynamicImports + pageChunk.*` 全部输出为 `modulepreload`，于是**每个页面**首屏前都要拉 1.58 MB，包括四页根本没有图的页面。弃用 `withMermaid`，保留其 `MermaidMarkdown` fence 渲染（它只负责把 ```mermaid 转成 `<Mermaid>` 标签），组件改由 `.vitepress/theme/index.ts` 里 `defineAsyncComponent` 注册、`virtual:mermaid-config` 用一个 8 行自写 Vite 插件提供。实测阻塞预载 1.58 MB → 1–2 KB，空闲预取 169 KB，app entry 684 KB → 1 KB。

**`transformHead` 的 script 是三元组，不是带 `innerHTML` 键的对象**。`["script", { type, innerHTML }]` 会把 `innerHTML` 当 HTML 属性序列化，`<script>` 体为空——标签在 review 里看着齐全，爬虫读到零结构化数据。正确写法 `["script", attrs, innerHTML]`。此错已随站发布布过，修复于 2026-10-01。

**`og:image` 不能是 SVG**：Twitter/X、Facebook、Slack 都不渲染，社交卡片等于不存在。已改 1200×630 PNG（`public/img/og.png`，源 `og.svg`）。

**sitemap `lastmod` 必须取源文件的最后提交日期**，不能取构建产物 mtime（那是 CI 运行时间，等于宣称每页每次都变，搜索引擎直接忽略）。源文件映射在 `sitemap.mjs` 的 `SOURCE_OF`；`deploy.yml` 的 `actions/checkout` 必须 `fetch-depth: 0`，否则浅克隆下 git 对所有页面返回同一个 commit，正是要避免的信号。站点地址由 `GITHUB_REPOSITORY` 推导（与 `config.ts` 同一套逻辑），不再有第二处硬编码。

**`website/scripts/render-check.mjs`（`bun run check`，28 项）是网站侧唯一能证明「图能画出来」的东西**。Mermaid 是客户端渲染，构建通过与图能否显示无关。探针用 headless chromium 载入构建产物，断言 SVG 内的中文标签文本（mermaid 把非 ASCII 转成实体，须先解码），并检查 canonical / og:image 为位图 / twitter:card / 每页 JSON-LD 类型。已接入 `deploy.yml`。

**写这个探针时踩的三个 harness 假阴性——都不是站点缺陷，但症状与真缺陷无法区分**：(1) `cleanUrls` 下 VitePress 写的是 `protocol.html` 而服务路径是 `/protocol`，静态服务器不做 `.html` 兜底就 404；(2) Pages 的 base 前缀（`/pi-a2a-ext/`）必须从 index.html 里读出来并剥掉，否则 entry JS 404、页面不 hydrate，**症状与「Mermaid 组件坏了」完全一样**；(3) `parse error` 正则命中的是 `protocol.md` 正文里作为 JSON-RPC 错误码讲解的 `parse error`，须只扫 SVG 段。**教训与既有方法论一致：探针自己会骗人，必须先证明它在故障时 FAIL**（本轮已验：组件提前 return → 两页 FAIL；og 改回 SVG / JSON-LD 改回属性写法 → 对应两项 FAIL）。

**`vitepress-plugin-mermaid` 的 `Mermaid.vue` 直接在 `onMounted` 里 `await import("mermaid")`**——它本身就是懒的，问题全在 entry 那一侧的静态注册。

## 既有结论（未改动）

Q1 执行目标在宿主 Main 会话内；Q2 传输为 Streamable HTTP on 127.0.0.1 via Bun.serve，协议 2025-11-25；Q3 审批复用宿主门，无 UI + prompt 档会挂起（≥90s）而非返回 isError；Q4 暴露面为 `pi.getAllTools()` 减 deny，tools/call 与目录取交集；Q5 静态 Bearer token，首启生成、0600 持久化、轮换用 `/a2a rotate`；Q6 配置 fail-closed（仅 token 自愈）、两阶段 JSONL 审计带 `Mcp-Session-Id`；Q7 强制会话、64 上限、24h 空闲 TTL、端口占用回退；Q8 文件面沙箱与分块幂等，串行步骤内 `requireLive(tr)` 重验活性。README 语言分工：`README.md` 英文、`README_ZN.md` 中文，站点渲染中文。跨机器安装 `omp install <git-url>`，本地开发 `omp install .`。


## Timeline

- time: 2026-09-10T09:16:34
  kind: decision
  summary: "Created this page: A2A MCP bridge architecture"
  source: brainstorming session 2026-09-10
  affects: [a2a-mcp-bridge]

- time: 2026-09-10T09:16:34
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: spec docs/superpowers/specs/2026-09-10-a2a-mcp-bridge-design.md
  affects: [a2a-mcp-bridge]

- time: 2026-09-10T09:56:50
  kind: decision
  summary: "spec approved; implementation plan written to docs/superpowers/plans/2026-09-10-a2a-mcp-bridge.md (T1-T9, zero-dep Bun.serve JSON-RPC, execution via AgentRegistry Main session)"
  source: plan commit 72bc255
  affects: [a2a-mcp-bridge]

- time: 2026-09-10T16:42:33
  kind: evidence
  summary: "implementation complete: T1-T9 done; tsc 0 errors; server_stub 15 assertions; real-host smoke SMOKE OK (omp 18.1.16, 21 tools, tools/call read on real Main session)"
  source: implementation session
  affects: [a2a-mcp-bridge]

- time: 2026-09-23T04:31:03
  kind: decision
  summary: "P1/P2 review hardening folded into Q4/Q5 + new Q6 (config & audit) and Q7 (session & protocol); 3 runtime facts added"
  source: project review 2026-09-23
  affects: [a2a-mcp-bridge]

- time: 2026-09-23T04:31:41
  kind: evidence
  summary: "verification of hardening: tsc 0 errors; bun test 54/54 (protocol/auth/config/exposure/audit, incl. idle-TTL-refresh regression and session-cap eviction); real-host E2E smoke SMOKE OK (21 tools, tools/call read on live Main session)"
  source: test runs 2026-09-23
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: decision
  summary: "Q3 protocol behavior reversed (prompt+no-UI hangs, not isError); Q6 audit scoped to completed calls; approval-probe and version-drift facts added"
  source: meta-review 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: reversal
  summary: "Q3 reversed: prompt-tier tools/call in no-UI mode hangs >=90s instead of returning isError, writes no audit line, and src/ has no watchdog — fail-closed holds only in the no-execution sense; README:105 pending correction"
  source: approval probe verify-approval2.ts 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: evidence
  summary: "approval probes: default yolo executes remote bash in 0.03s; always-ask auto-approves read (17-30ms) and hangs bash >=90s with no side-effect, server alive; host 600000ms timeout belongs to login input not approval"
  source: verify-approval.ts / verify-approval2.ts 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T01:26:04
  kind: evidence
  summary: "version drift: host omp 18.2.11 vs pin/lock 18.2.10; node_modules was 18.2.11 desynced from its lock, healed via bun install; tsc + 54 tests green on both versions"
  source: bun install / tsc / bun test 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:02:53
  kind: decision
  summary: "Q3 README correction done; Q6 audit redesigned two-phase (start/done paired by id); host-version claim corrected (18.2.10, invariant holds); version guard + committed probes recorded"
  source: post-review fix session 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:03:04
  kind: reversal
  summary: "Meta-review's version finding corrected: host omp is 18.2.10 (omp --version + global pi-* agree), not 18.2.11 — 18.2.11 was registry-latest, not installed; pin==host invariant holds; only the node_modules/lock desync was real (already healed)"
  source: "version recheck 2026-09-24 (omp --version, global node_modules)"
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:03:04
  kind: decision
  summary: "Two-phase audit adopted (start at dispatch, done on completion, paired by id) superseding the completion-only amendment; version-guard test added (installed==pin hard-assert, omp --version mismatch warns; pins stay 18.2.10); approval + hardening probes committed under test/; README corrected (approval hang semantics, two-phase audit, yolo token=full tool-execution authority)"
  source: post-review fix session 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T02:03:04
  kind: evidence
  summary: "verification: tsc 0 errors; bun test 59/59 across 5 files (probes not auto-discovered); SMOKE OK; HARDEN OK 28/28 incl. start/pairing audit checks; approval probe VERDICT B — 90s hang, no side effect, server alive, audit start=1 done=0, exit 0"
  source: test runs 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T03:42:16
  kind: decision
  summary: "Second-round P3s implemented: audit records carry Mcp-Session-Id (Q6 attribution gap closed), 500 body genericized, three as never casts removed (ctx mutation-verified), MIT license, Biome lint/format; rate limiting explicitly declined for v1"
  source: P3 follow-up review 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T03:42:16
  kind: evidence
  summary: "verification: tsc 0, bun test 59/59, biome lint clean, SMOKE OK, HARDEN OK 29/29 (incl. sid attribution), approval probe VERDICT B exit 0; 5 commits e7393eb..5b2342f"
  source: verification runs 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T06:11:00
  kind: decision
  summary: "Documentation set completed: docs/protocol.md is the authoritative wire contract (processing order, session lifecycle, error-code table), docs/testing.md owns probe verdict semantics (VERDICT A/B/C) and the 29-check breakdown, CHANGELOG.md uses date sections without tags; README gained a troubleshooting section and doc links, all inserted below the approval section so its README:103/105 references stay valid"
  source: documentation round 2026-09-24
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T06:36:14
  kind: decision
  summary: "文档站架构（Docusaurus 3.10.2，website/）：内容不直读仓库 md——scripts/sync.mjs 在构建时把 README.md→content/intro.md（slug /，标题「使用指南」）、CHANGELOG.md→content/changelog.md、docs/** 原样拷入生成目录 website/content（gitignored，禁止手改），并按站点深度重写 6 处相对链接（README 4 + protocol 2，LICENSE 解链）、给 superpowers 子目录生成 _category_.json。关键决策：markdown.format:detect——仓库文档含字面 {}/<>，必须按纯 CommonMark 解析否则 MDX 求值/报错；站点 url 用 localhost（仓库无 git 远端）、首页常量硬编码不引 useDocusaurusContext（3.10 中该包在根 node_modules 不可解析）。源文件零改动，README L103/105 行号约束不受影响。"
  source: "commit: docs 站点轮"
  affects: [a2a-mcp-bridge]

- time: 2026-09-24T13:22:42
  kind: decision
  summary: "站点发布：GitHub Pages（https://adam-ikari.github.io/pi-a2a-ext/），仓库 adam-ikari/pi-a2a-ext（公开，gh 创建，本项目首个 git 远端）。部署链：push master → .github/workflows/deploy.yml（bun 1.3.14 + website build + actions/{configure,upload}-pages + deploy-pages）。docusaurus url/baseUrl 由 GITHUB_REPOSITORY 环境推导（Actions 内 /pi-a2a-ext/，本地 /），预演验证过。坑：用 API 开启 Pages 时仓库默认分支还是 main（空仓库初值），github-pages 环境被自动加了只放行 main 的分支白名单，master 首跑 deploy 被 environment protection 拒——已 PUT environments/github-pages 置 deployment_branch_policy=null 放行；分支保持 master 不改名。Pages build_type=workflow，Pages 源分支字段 main 无实际影响。"
  source: "GitHub Pages 部署轮"
  affects: [a2a-mcp-bridge]

- time: 2026-09-26T16:30:22
  kind: decision
  summary: "E2E 复跑（宿主 omp 18.3.2）：smoke/hardening(29)/approval(VERDICT B) 三件全绿，跨版本运行时兼容确认。node_modules 漂移以同一未知机制复发（实装 18.3.2，lock/package.json 仍 18.2.10）——版本守卫如期捕获，按既定流程同步 pin 到 18.3.2 并重写 lockfile；tsc 对 18.3.2 类型面零破坏，unit 恢复 59/59。pin==host 不变量当前值 = 18.3.2。"
  source: "E2E 复跑 + pin 同步"
  affects: [a2a-mcp-bridge]

- time: 2026-09-28T13:59:58
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "pin sync + E2E rerun on host 18.4.0"
  affects: [a2a-mcp-bridge]

- time: 2026-09-28T13:59:58
  kind: evidence
  summary: "E2E rerun on host 18.4.0: smoke/HARDEN(29)/approval(VERDICT B) all green; node_modules drift recurred (18.4.0 vs pin 18.3.2), guard caught it, pins+lock synced to 18.4.0; tsc 0, unit 59/59, lint clean"
  source: test runs 2026-09-28
  affects: [a2a-mcp-bridge]

- time: 2026-09-28T15:36:47
  kind: evidence
  summary: "docs 站点 GitHub Primer 主题化（2026-09-28）：Docusaurus 3.10 代码块配色的权威路径是根级 themeConfig.prism.theme/darkTheme（preset theme 选项只接受 customCss，根级 prism 被拒）；自定义主题对象必须是 v1 prism-react-renderer 格式 {plain, styles}（含 id/name/type 会被 schema 拒绝）。theme-classic 按该主题运行时注入内联 --prism-background-color/--prism-color，静态 CSS 覆盖必然失效——亮色代码块此前恒为深色的根因。零新增依赖（@primer/primitives 仅设计 token、无 Prism 主题，装后即删）。"
  source: website/prism-light.mjs / website/prism-dark.mjs / CHANGELOG 2026-09-28
  affects: [a2a-mcp-bridge]

- time: 2026-09-29T00:56:07
  kind: decision
  summary: "文件传输面（Q8，decided 2026-09-29）：双向（远程→宿主 push、宿主→远程 pull）走 tools/call，**不新增 JSON-RPC 方法**——桥自带 6 个 a2a_file_* 工具挂进既有管线，免费复用鉴权/会话/deny/两阶段审计。线格式复用 A2A FilePart {name,mimeType,bytes(base64)}，不发明新编码。落盘沙箱根 fileRoot 默认 ~/.omp/a2a-bridge-files（agentDir 的**兄弟目录**，刻意不与 token/审计同父，降低遍历 bug 的爆炸半径；ensureRoot 另拒「根是 config/审计祖先」）；maxFileBytes 默认 100MB。1MB 请求体上限不动：内联与单块 512KiB、单次 get 响应 256KiB，100MB≈200 次 put_chunk，分块写入纳入首版（用户明示「需要支持100M以下的文件」，推翻 Plan agent 砍分块的建议）。路径语义：绝对/~/NUL/控制字符/./.. 段一律词法 invalid_path（先拒），escapes_root 专门留给 realpath 检出的符号链接逃逸——两层职责分明。根内符号链接既不顺着读也不顺着写；写入经 <root>/.tmp 原子 rename、0600；分块状态绑 Mcp-Session-Id（跨 sid 与不存在同文案 unknown_transfer），30 分钟空闲**惰性**回收（每次文件调用入口 sweep，无定时器）、并发上限 16。名字冲突 host-wins + 一次性 stderr 告警（桥工具绕过宿主审批门，故不允许反向遮蔽）。威胁模型明示：token 即 fileRoot 内读写权、桥工具无审批门；pull 回的字节能进远程模型上下文，大件建议 SSH 旁路。审计：>120 字符字符串只记 <len:N,sha256:P8>，put_chunk 整体跳过审计（否则一次上传几百行冲爆轮转）。"
  source: "双向文件传输轮（plan eager-gulf-drum）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-29T00:56:21
  kind: evidence
  summary: "文件传输验证基线（宿主 omp 18.4.0）：单测 59→100/100 绿（fileguard 16、filetools 18、bridge 桥工具与脱敏 4、config fail-closed 3）；新增真实宿主探针 test/file-transfer.ts（bun run test:files，54 项 → FILES OK），smoke（现 27 工具，含 6 个 a2a_file_*）、HARDEN 29/29、approval VERDICT B（挂起语义与两阶段审计跨版本未变）全绿。方法论再次生效：put_end 不创建目标父目录（分块上传到不存在的子目录时 rename ENOENT）是**宿主探针**抓到的，单测当时只用顶层路径故全绿——文件面改动必须跑 test:files，不能只信 bun test。另两处非代码坑：(1) website/scripts/sync.mjs 的链接改写用的是 String.replace（只换首个），README 第二次引用同一文档即留下仓库相对路径 → Docusaurus 断链构建失败，已改 replaceAll；(2) 版本守卫比对宿主版本的用例外设 30s 超时——omp --version 冷启动实测约 8s，恒超 bun 默认 5s 会偶发失败。"
  source: "bun test + 四件宿主探针 2026-09-29"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T02:51:35
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "代码评审修复轮 2026-09-30（探针驱动，含修复自身引入的活性竞态）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T02:51:51
  kind: evidence
  summary: "第二轮对抗测试（18 项）抓到 1 个**修复自身引入**的 P1：串行化后排队中的 put_chunk 会在 put_end 已 rename 走暂存文件后往死路径 append，报 ok 但字节静默丢失并留下无人回收的孤儿 .part；修法为串行步骤内 requireLive(tr) 重验活性（Transfer 自带 id）。同时发现我自己的 3 处探针断言写错（okPayload 返回 null 非 undefined；传输已满是 size_mismatch 非 bad_chunk_order；串行化后乱序 seq 是被拒而非被吸收），均为断言错非代码错——再次印证探针会纠正评审者。基线：单测 110→114，宿主四件套全绿（FILES OK 62/62、SMOKE OK、HARDEN OK 29/29、approval VERDICT B）。"
  source: "对抗探针 + 四件宿主探针 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T04:26:25
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "README 语言分工轮 2026-09-30（英文默认 + 中文 _ZN，站点仍渲染中文）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T04:26:43
  kind: evidence
  summary: "README.md 改写为英文（新增 fileguard/filetools 两行文件布局、补 test:files 命令），README_ZN.md 承接中文并加语言切换；sync.mjs 改读 README_ZN.md 且剥掉切换行（曾因正则未跨行匹配而漏剥，已修 m 标志）。brain compiled_truth 内 2 处 README 硬编码行号改为章节引用，timeline 内 3 处按 append-only 保留。验证：website build SUCCESS 且站点 intro 仍为中文、链接全部 ./ 形式无断链。"
  source: "双语 README + 站点构建 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T04:46:48
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "安装方式更正轮 2026-09-30（install.sh + 两条无效旧说明作废）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:10:58
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "安装方式定稿：omp install . 为首选，pi.extensions 是其开关（回滚我此前的误删）"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:10:58
  kind: reversal
  summary: "更正上一条 decision：package.json 的 pi.extensions 并非无效，已回滚我的删除。该字段是 omp install . 的开关——删掉后 omp install --json 的 manifest 变 {}、宿主完全不加载扩展（正反两向均实测）。我误判的根因是拿 omp plugins list 的输出当判据（那只列已安装 npm 插件），而正确判据是 omp install --json 的 manifest + 宿主是否真加载。"
  source: "omp install --json + 宿主实测 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:46:01
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "跨机器安装定稿：omp install <git-url> + 包自包含三要素"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T05:46:01
  kind: evidence
  summary: "跨机器安装验证：独立 HOME（无 config/token/沙箱）+ models.yml 模拟另一台机器，omp install <git-url> 装到 pi-a2a-ext@0.1.0，宿主起桥并自建独立 token 与沙箱。过程中确认三点：(1) omp install 不接受 .tgz（ENOTDIR）、不接受 owner/repo 简写（Invalid package name）；(2) 装的是远端代码，本地未推送时装到旧版本（先得 @undefined，推送后重装才 0.1.0），9 个提交已推送；(3) omp 在无模型配置时先退出、根本不加载扩展，模拟机必须给 models.yml 才测得到扩展。"
  source: "独立 HOME 模拟机实测 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-09-30T06:25:32
  kind: evidence
  summary: "跨机器安装实验固化为 test/install-probe.ts（bun run test:install，26 项）：独立 HOME 模拟另一台机器 → omp install <git-url> → 以远程 MCP 客户端走完整流程（manifest/打包文件、首次启动自建 config+token+沙箱、initialize、文件往返、沙箱边界、鉴权、审计），全绿。这是唯一验证「任意机器可装」的探针——test:files 自己软链扩展，完全不碰安装链路。写探针时踩了两个 harness 假阴性（非产品缺陷）：omp --mode rpc --print 带 prompt 跑完即退、桥随之消失导致 ConnectionRefused（须不传 prompt 且 stdin 保持打开）；以 proc.exitCode===null 轮询会在最后一个 stdout 分片到达前提前退出，把「桥正常」误报为「没起来」——最终改为直接 HTTP 探测，test:files 一直这么做故未踩到。顺带修正 docs/testing.md 的过期数字（单测 100→114、fileguard 16→17、filetools 18→31）。"
  source: "test:install 26/26 2026-09-30"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T10:47:58
  kind: decision
  summary: "网站构建链定稿：弃用 withMermaid 改异步组件、JSON-LD 三元组写法、og:image 位图、sitemap lastmod 取源文件提交日、render-check 探针"
  source: "网站修复轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T10:48:06
  kind: evidence
  summary: "网站侧 4 项修复验证：阻塞预载 1.58MB→1-2KB（app entry 684KB→1KB，空闲预取 169KB）；JSON-LD 由「标签存在但 script 体为空」改为可解析（首页 WebSite+SearchAction，内页 TechArticle）；og:image 改 1200x630 PNG + summary_large_image；sitemap lastmod 改为各源文件最后提交日（testing=09-30、其余=10-01，不再全是当天），deploy.yml 加 fetch-depth: 0。新增 render-check 探针 28 项全绿，并验过它在故障时 FAIL。"
  source: "网站修复轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T10:59:22
  kind: decision
  summary: "网站侧收尾两条：robots.txt 由 sitemap.mjs 用同一套推导生成（此前是静态文件里第二处硬编码 origin，仓库改名即失效）；sitemap 源文件映射补上 superpowers 两页（docs/<page>.md 兜底，不再退回全仓最新提交日）。另确认 HEAD 上 lint 早已因 .agents/ 第三方 skill 文件（空格缩进 vs biome tab）失败，本轮 4 错 1 警 → 2 错 0 警，未去改他人文件。"
  source: "网站修复轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T11:48:28
  kind: decision
  summary: "新增 docs/computer-use.md（站点 /computer-use，进 nav + 侧边栏 + 首页 feature 卡片）：本桥 vs computer use 的定位对比。论点只写能证的——执行走宿主原生工具实现（五个真实宿主探针均在 --mode rpc 无 UI 下跑通，故不依赖窗口/无头能力）、目录由 tools/list 显式给出（写错得 not exposed）、宿主不推理。明确一处易误解：省的是宿主侧推理与 token，远程模型照旧推理，a2a_file_get 的 base64 仍进远程上下文。README（中英）加指向行，sync.mjs 补链接重写（漏则构建报断链）。"
  source: "与 computer use 的区别页 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T11:56:29
  kind: reversal
  summary: "更正站点文案的主体：此前写成「远程 omp 调用宿主 omp」，是把 README 的一个 mcp.json 示例当成了主体。桥实现的是 MCP 2025-11-25，任意 MCP 客户端均可接入——调用方与宿主同机/异机、是否同为 omp 都成立。hero 改为「让任意 agent 调用本机这个 omp 的工具」。**教训：文档里的单个示例不定义产品主体，主体要看协议层对谁开放。**"
  source: "站点文案校订 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T11:56:34
  kind: decision
  summary: "sync.mjs 补 CHANGELOG 的链接重写（此前完全没有）：条目里的 docs/*.md 仓库相对路径在站点上是死链，VitePress 会构建失败。一直没暴露是因为 CHANGELOG 只引用过站点同名的 protocol/testing，新增 computer-use.md 才触发。另将 config.ts 里重复的 description/兜底值提取为 SITE_DESC 单点引用。"
  source: "站点文案校订 2026-10-01"
  affects: [a2a-mcp-bridge]
