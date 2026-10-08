---
id: a2a-mcp-bridge
title: A2A MCP bridge architecture
category: decision
status: active
tags: [omp, extension, mcp]
created: "2026-09-10T09:16:34"
updated: "2026-10-08T03:37:10"
---

<!-- compiled_truth -->
## 网站构建链（2026-10-01 修订）

站点是 VitePress 1.6.4 单语言中文站，GitHub Pages 部署，构建链为 `website/scripts/sync.mjs`（从 `README_ZN.md` / `CHANGELOG.md` / `docs/**` 生成 `content/`）→ `vitepress build` → `scripts/sitemap.mjs`。

**Mermaid 不能用 `withMermaid`**。该插件的 Vite transform 把 Mermaid 组件**静态**注入 `vitepress/dist/client/app/index.js`（app entry），mermaid 及其约 40 个 diagram 类型因此进入 entry 的 import graph；而 VitePress 的 `resolvePageImports` 会把 `appChunk.imports + appChunk.dynamicImports + pageChunk.*` 全部输出为 `modulepreload`，于是**每个页面**首屏前都要拉 1.58 MB，包括四页根本没有图的页面。弃用 `withMermaid`，保留其 `MermaidMarkdown` fence 渲染（它只负责把 ```mermaid 转成 `<Mermaid>` 标签），组件改由 `.vitepress/theme/index.ts` 里 `defineAsyncComponent` 注册、`virtual:mermaid-config` 用一个 8 行自写 Vite 插件提供。实测阻塞预载 1.58 MB → 1–2 KB，空闲预取 169 KB，app entry 684 KB → 1 KB。

**`transformHead` 的 script 是三元组，不是带 `innerHTML` 键的对象**。`["script", { type, innerHTML }]` 会把 `innerHTML` 当 HTML 属性序列化，`<script>` 体为空——标签在 review 里看着齐全，爬虫读到零结构化数据。正确写法 `["script", attrs, innerHTML]`。此错已随站发布布过，修复于 2026-10-01。

**`og:image` 不能是 SVG**：Twitter/X、Facebook、Slack 都不渲染，社交卡片等于不存在。已改 1200×630 PNG（`public/img/og.png`，源 `og.svg`）。

**sitemap `lastmod` 必须取源文件的最后提交日期**，不能取构建产物 mtime（那是 CI 运行时间，等于宣称每页每次都变，搜索引擎直接忽略）。源文件映射在 `sitemap.mjs` 的 `SOURCE_OF`；`deploy.yml` 的 `actions/checkout` 必须 `fetch-depth: 0`，否则浅克隆下 git 对所有页面返回同一个 commit，正是要避免的信号。站点地址由 `GITHUB_REPOSITORY` 推导（与 `config.ts` 同一套逻辑），不再有第二处硬编码。

**`website/scripts/render-check.mjs`（`bun run check`，28 项）是网站侧唯一能证明「图能画出来」的东西**。Mermaid 是客户端渲染，构建通过与图能否显示无关。探针用 headless chromium 载入构建产物，断言 SVG 内的中文标签文本（mermaid 把非 ASCII 转成实体，须先解码），并检查 canonical / og:image 为位图 / twitter:card / 每页 JSON-LD 类型。已接入 `deploy.yml`。

**写这个探针时踩的三个 harness 假阴性——都不是站点缺陷，但症状与真缺陷无法区分**：(1) `cleanUrls` 下 VitePress 写的是 `protocol.html` 而服务路径是 `/protocol`，静态服务器不做 `.html` 兜底就 404；(2) Pages 的 base 前缀（`/pi-a2a-ext/`）必须从 index.html 里读出来并剥掉，否则 entry JS 404、页面不 hydrate，**症状与「Mermaid 组件坏了」完全一样**；(3) `parse error` 正则命中的是 `protocol.md` 正文里作为 JSON-RPC 错误码讲解的 `parse error`，须只扫 SVG 段。**教训与既有方法论一致：探针自己会骗人，必须先证明它在故障时 FAIL**（本轮已验：组件提前 return → 两页 FAIL；og 改回 SVG / JSON-LD 改回属性写法 → 对应两项 FAIL）。

**`vitepress-plugin-mermaid` 的 `Mermaid.vue` 直接在 `onMounted` 里 `await import("mermaid")`**——它本身就是懒的，问题全在 entry 那一侧的静态注册。
## Q1 Execution target (decided)
Remote tools/call executes IN the host's live session via AgentRegistry.global().get("Main").session.getToolByName(name).execute(...). No headless subprocess for v1.

## Q2 Transport (decided — supersedes early "stdio" note)
Streamable HTTP on 127.0.0.1 via Bun.serve, single process inside the host omp. stdio was rejected: a stdio MCP server needs exclusive stdin/stdout which collides with the running TUI, and TUI approval forwarding requires same-process. Verified against host client: protocol 2025-11-25, Accept: application/json, text/event-stream; plain JSON responses suffice; GET SSE optional (405 tolerated); notifications accept 200/202 (src/mcp/transports/http.ts).

## Q3 Approval (decided; protocol behavior reversed 2026-09-24)
Reuse the host's built-in approval gate. Registry tools ARE ExtensionToolWrapper instances (sdk.ts:2922) which run resolveApproval internally: yolo passes, deny throws -> isError, per-tool prompt raises ui.select. The bridge must inject the REAL session.settings and the ExtensionContext ui into the AgentToolContext it builds; it implements no approval logic itself.
REVERSED (approval probes on omp 18.2.10, --mode rpc): prompt tier with NO interactive UI does NOT return isError — the tools/call request hangs indefinitely (>=90s observed; src/ contains no setTimeout/AbortSignal/timeout anywhere). Execution is still blocked (side-effect probe never fired), so fail-closed holds only in the security sense, not the protocol sense: the README section 「审批 / Approval」 (was line 105; corrected 2026-09-24 to document the hang, the caller-timeout requirement, and the start-without-done audit trace; the discriminating probe is committed as test/approval-probe.ts (expected verdict B). Host mechanism: hasUI=false in plain rpc (host sets hasUI=f||r==="rpc-ui"), so ui.select has no answerer; the host's 600000ms input timeout belongs to login, not approval. The TUI prompt path is unaffected.

## Q4 Exposure ~~(decided; tightened 2026-09-23)~~ — **SUPERSEDED 2026-10-01**

> **已作废。** `deny` / `denyMCPTools` 全部删除，`tools/list` 改为 `pi.getAllTools()` 原样透传不过滤。理由见文末「极简化」一节。以下保留为历史记录。
pi.getAllTools() -> full tool list (name/description/parameters via toolWireSchema -> JSON Schema 2020-12), config deny list removes tools from both tools/list and tools/call. No whitelist in v1.
Exposure semantics (2026-09-23 review): the catalog is the session tool REGISTRY as-is — getAllToolInfos() filters neither `hidden` tools nor tools the host currently disabled for its own model, so it is deliberately NOT a mirror of what the host model can see. tools/call intersects with the catalog (name survives deny AND appears in pi.getAllTools()), so aliases like xd://bash and guessed hidden names are rejected; denied and not-in-catalog share one message so a token holder cannot probe name existence.

## Q5 Auth (decided)
Static Bearer token, 32 random bytes base64url, generated on first start, persisted 0600 in ~/.omp/agent/a2a-bridge.json together with port/host/deny. Constant-time compare. /a2a rotate regenerates. No OAuth/TLS in v1 (loopback default; SSH forwarding documented).

## Q6 Config & audit (decided 2026-09-23; audit redesigned two-phase 2026-09-24)
Config validation is fail-closed: a present-but-malformed field (port/deny/host/denyMCPTools) aborts extension startup with a named error instead of running with a wrong exposure surface. Only `token` self-heals — regenerated AND persisted, so it stays stable across restarts. Config writes are 0600 at creation (writeFile mode), closing the pre-chmod window. External edits to a2a-bridge.json apply on next host restart; only `/a2a rotate` is live.
Every remote tools/call writes TWO JSONL audit records paired by id — auditStart at dispatch ({ts,id,sid,phase:"start",tool,args truncated to 1KB}) and auditDone on completion ({ts,id,sid,phase:"done",tool,isError,args}) — to <agentDir>/a2a-bridge.log: 0600, rotates to .1 past 512KB, $A2A_BRIDGE_AUDIT overrides the path, audit failures never affect the call. Design reversal 2026-09-24 (supersedes the completion-only amendment): a call that never settles (prompt tier in no-UI mode) leaves start-without-done, so hangs are visible in the log. sid (the Mcp-Session-Id) was added to both records 2026-09-24, closing the attribution gap: under one shared token a call is attributable to its client session (asserted in unit tests and the hardening probe).

## Q7 Session & protocol (decided 2026-09-23)
Mandatory sessions: every non-initialize message must carry Mcp-Session-Id — missing returns 400, unknown or idle past 24h returns 404, and every hit refreshes the idle TTL (header omission is not a bypass). The map is bounded at 64 sessions with least-recently-seen eviction, because abandoned clients never return to be purged. Auth runs before every state-touching branch, so an unauthenticated DELETE cannot terminate sessions. initialize always answers protocolVersion 2025-11-25 instead of echoing whatever the client asked for, and jsonrpc must be exactly "2.0" (else 400). A configured port already in use falls back to an ephemeral port WITH a warning, since remote mcp.json pins the old port.

## Notable verified facts
- MCP SDK not installed anywhere: bridge hand-writes JSON-RPC on Bun.serve, zero deps.
- AgentToolContext required fields (sessionManager/modelRegistry/model/isIdle/hasQueuedMessages/abort) are all reachable from public surfaces: AgentSession.settings/.sessionManager/.modelRegistry/.model + ExtensionContext ui/hasUI/isIdle/hasPendingMessages/abort.
- Main is registered into AgentRegistry.global() by createAgentSession in ALL modes (sdk.ts:1745,3321), so tools/call works in TUI and headless alike (headless prompt tier fails closed when policy requires UI — see Q3 reversal for exact protocol behavior).
- Host MCP client pages tools/list with do-while on nextCursor (mcp/client.ts:233); omitting nextCursor is valid.
- @oh-my-pi/* specifiers in extensions are rewritten at runtime by omp's `omp:legacy-pi-shim` Bun onResolve plugin (regex ^@(oh-my-pi|mariozechner|earendil-works)/(pi-agent-core|pi-ai|pi-coding-agent|pi-natives|pi-tui|pi-utils)(/.*)?$) to the host's bundled modules. AgentRegistry.global() is a MODULE-level static, so a second copy loaded from node_modules would fork the registry and tools/call would see no Main session — hence those packages belong in devDependencies only, pinned to the host omp version, never relied on at runtime.
- omp's Streamable HTTP client throws Transport not connected from notify() unless a session id exists, and attaches Mcp-Session-Id to every post-initialize request: strict session enforcement cannot break omp's own client.
- Approval probes (2026-09-24, omp 18.2.10, --mode rpc, default settings): default approvalMode yolo -> remote bash EXECUTED in 0.03s (README 「审批 / Approval」 yolo bullet confirmed). With --approval-mode=always-ask: read auto-approved (17-30ms), bash hung >=90s, side-effect file never appeared, server answered ping 200 afterwards. Probe committed as test/approval-probe.ts (exit 1 on fail-open/unexpected return/audit-invisible); hardening probe committed as test/hardening.ts (29 checks incl. two-phase pairing and sid-attribution assertions).
- Version state 2026-09-24 (corrected): host omp is 18.2.10 (omp --version + global pi-coding-agent/pi-ai all agree); devDep pin + bun.lock + node_modules are 18.2.10 — the "pin == host" invariant HOLDS. The earlier "host 18.2.11" claim was wrong: 18.2.11 is the registry latest, not the installed version. The real anomaly was repo node_modules at 18.2.11, desynced from its own lock, healed via bun install (tsc + tests green under both versions). Guard added: test/versions.test.ts hard-asserts exact pins and installed==pin, warns when omp --version != pin.
- Typing the execute() context against the host SDK depends on pi-coding-agent's AgentToolContext augmentation being loaded: the `import type {} from "@oh-my-pi/pi-coding-agent/tools/context"` in src/bridge.ts merges the CustomToolContext required fields (sessionManager/modelRegistry/model/isIdle/hasQueuedMessages/abort) plus ui/hasUI into the interface. Mutation-verified 2026-09-24 (deleting abort from the literal fails tsc); deleting that empty import silently degrades the check to vacuous (the pi-agent-core base interface is all-optional), so keep it. Related: pi-ai Static<TSchema> = unknown (execute args need no cast) and ToolInfo.parameters is TSchema (flows typed into toolWireSchema) — the three historical `as never` casts were removed 2026-09-24.

- Version state 2026-09-28: host omp upgraded to 18.4.0; node_modules again drifted ahead of lock via the same unknown mechanism (installed 18.4.0 vs lock/pin 18.3.2). Guard caught it; pins synced to 18.4.0, lockfile rewritten. Regression on 18.4.0 all green: tsc 0 errors, unit 59/59, biome clean, SMOKE OK (21 tools), HARDEN OK 29/29, approval probe VERDICT B (bash hung 90s, no side effect, server alive, audit start=1 done=0). pin==host invariant current value = 18.4.0.

## Q8 修订 — 文件面代码评审修复（2026-09-30）~~ — **SUPERSEDED 2026-10-01**

> **已作废。** 整个文件传输面（`filetools.ts` / `fileguard.ts` / 6 个 `a2a_file_*`）已删除。以下保留为历史记录——那些 P1 缺陷本身是真实的，它们说明的是「这个状态机不该存在」，而不是「该修好它」。

评审发现 4 项文件面缺陷 + 1 项版本漂移，全部修复并加了回归测试。逐项的「为什么」比「改了什么」更重要，因为它们都是**评审读不出来、只有探针能抓**的：

- **分块写入必须串行 + 重传必须幂等**（P1，唯一的数据完整性问题）。旧实现读 `expectedSeq` 校验、却在 `await appendPart` 之后才自增——同一 seq 的两个并发请求都能过校验并都写入；未声明 `totalBytes` 时 `put_end` 报**成功**而文件已是双倍内容。**根因是需求自身矛盾**：README 要求调用方自设超时（无 UI 时 `prompt` 审批挂起 ≥90s），而超时重试正好并发打出两个相同 seq。修法不是「拒绝重试」，而是承认重试是常规动作：同一 transfer 的变更步骤（`put_chunk`/`put_end`）走一条 Promise 链串行化，同 seq 同字节按已收处理（返回 `duplicate: true`），同 seq 换内容才 `bad_chunk_order`。队列吞掉拒绝，单步失败不卡死后续分块。**教训：「调用方必须自设超时」这个文档承诺，同时规定了幂等性要求**——写下前一句就得写下后一句。
- **串行化自己又带进第二个竞态：排队中的步骤必须重验活性**（P1，评审修复之后才由对抗探针抓到）。`requireTransfer` 在**同步**阶段取出记录，而变更本体稍后才在队列上跑；两者之间若一次 `put_end` 成功提交并已 `rename` 走暂存文件，排队中的 `put_chunk` 就往一条**已被改名掉的死路径**上 append——`appendFile` 会重新创建该文件，返回 `{"ok":true,"receivedBytes":12}` 而已提交文件仍只有前 8 字节：**字节静默丢失**，且在 `.tmp` 留下一份永远无人回收的孤儿 `.part`。修法：`Transfer` 自带 `id`，串行步骤内先 `requireLive(tr)`（比对 map 里仍是同一条记录）再动手。**教训：把「检查」与「动作」拆到两个时序阶段（同步取记录 / 异步执行动作）时，前者的结论会过期——凡是这种形状，异步动作开头都要重验一次。修完 P1 要立刻重新对抗，因为修复本身会制造新的竞态。**
- **状态受会话约束 ≠ 字节受会话约束**（P2）。传输绑定 `Mcp-Session-Id`，但暂存字节就是 `<root>/.tmp/<uuid>.part` 普通文件；`.tmp` 只在 `list(".")` 被过滤，直接按路径访问不受限，于是任何客户端都能枚举他人 `transferId`、读取在途字节、`put` 改写其暂存文件让对方 `put_end` 落成攻击者字节。修法：首段为 `.tmp` 一律 `invalid_path`（嵌套 `sub/.tmp/x` 合法）。**凡是「按 id 授权」的状态，旁边一定还挂着一条按路径可达的数据路径**——两者都要封。
- **错误码契约必须覆盖兜底分支**（P2）。`guarded` 只翻译 `FileOpError`，其余原样抛出并被 `bridge.ts` 当工具结果文本返回，于是 `ENOTDIR`/`EISDIR` + 宿主绝对路径直达调用方：既违反本项目自己的「500 body 不得泄露宿主内部」立场，又让按 `a2a_file_error <code>` 解析的客户端失效。修法：兜底码 `io_error` + 固定无路径文案，细节只进宿主 stderr。**协议里承诺了「一律是 `<code>`」，就必须给「非预期异常」也留一个码。**
- **`get` 的 sha256 语义要选对层**（P3）。旧实现每页重算**整文件**哈希：100MB（默认 `maxFileBytes`）实测 30.4s 纯哈希 / 400 页，而每页只传 256KB——读放大 400 倍且随文件平方增长，正好卡在协议自己宣传的大文件场景上。改为**本次区间**摘要（0.9s）。`totalBytes` 仍表整文件大小，两者分工写进 protocol.md。
- **`list` 也要拒符号链接**（P3）。只过滤了子项，目标本身用 `stat`（跟随）检查，根外目录的文件名/大小/mtime 因此泄露；内容始终被 `resolveInRoot` 的 realpath 包含性挡住，故此前仅元数据泄露。

## 版本漂移的第四次复发与强制关口（2026-09-30）

node_modules 漂移同一未知机制再次复发（宿主已到 18.4.4，pin 仍 18.4.0），版本守卫如期捕获，pin+lock 同步至 18.4.4。三次复发后加了 `.github/workflows/ci.yml`（`bun install` + typecheck + lint + test）：CI 下 frozen-lockfile 安装把「pin 与 lockfile 不一致」提前到**提交时**失败，而不是等到某人下次跑 `bun test` 才发现。**靠单测事后捕获一个反复复发的不变量，是把守卫放在了太靠后的位置。**

## 方法论：这份代码要靠探针评审，不能靠读

100 个单测全绿时，上述缺陷**全部存在**。逐条静态阅读都能自圆其说——`.tmp` 只在 `list(".")` 过滤看起来是「已隐藏」，`stat` 看起来是「常规存在性检查」，每页算哈希看起来是「顺手给出完整性」。它们只在**跨进程/并发的实际调用**下暴露。这与既有记录一致（`put_end` 不建父目录也是真实宿主探针抓到的，单测当时全绿）。更要紧的是第二轮的教训：**P1 修完立刻又用对抗探针（8 路同 seq、200 块长传输、40 路并发 start、排队 vs 提交）打了一遍，才抓到修复自身引入的活性竞态**——第一轮的全绿并不代表修复没有副作用。评审这类文件面/并发代码：先写复现探针再下结论，修完再打一轮对抗，单测全绿不构成正确性证据。

## 文档语言分工（2026-09-30 决定）

`README.md` = **英文**（GitHub 默认展示、_ZN 惯例下的基础名即默认语言），`README_ZN.md` = 中文。顶部互相链接：英文版 `[简体中文](README_ZN.md)`，中文版 `[English](README.md) | 简体中文`。

**文档站仍然渲染中文**：`website/scripts/sync.mjs` 改为读 `README_ZN.md`（不是 README.md），并剥掉那行语言切换（站点单语言，站点内不需要切换入口）；标题仍是「使用指南」。若改成读 README.md，站点会在中文导航「指南」下显示英文，且 `[English](README.md)` 会指向站外不存在的路径。

**教训（与 brain 里那 3 处 README 行号引用同源）**：文档之间**不要用行号互引**——README 改一次行号就全断。Q3 段落里原有 `README:103` / `README:105` 两处硬编码行号，已在 compiled_truth 内改为章节引用（「审批 / Approval」）。但 timeline 里的 3 处（append-only，历史证据）**故意保留行号不改**：timeline 记录的是「当时的事实」，改它就是篡改证据；这 3 处的失效不影响任何人，因为它们描述的是 2026-09-24 那天的状态。

## 安装方式（2026-09-30 更正）

**跨机器安装用 `omp install https://github.com/adam-ikari/pi-a2a-ext.git`**（装到 `~/.omp/plugins/node_modules/pi-a2a-ext`，`omp plugin uninstall pi-a2a-ext` 卸载）；本地开发用 `omp install .`；`scripts/install.sh` 是绕开插件管理器的等效替代。

`omp install` 的 spec 限制（实测）：接受**本地目录或 git URL**，**不接受 `.tgz`**（报 `ENOTDIR: ... .tgz/package.json`）；GitHub `owner/repo` 简写被当作非法包名（`Invalid package name`），必须用完整 `https://….git` URL。装的是**远端代码**，所以本地提交未推送时，装到的是旧版本——2026-09-30 就因此先装到 `@undefined` 再重装才拿到 `0.1.0`。

**包必须自包含才能跨机器安装**：`package.json` 需要 `version`（缺了 `npm pack` 直接失败、`omp plugins list` 显示 `@undefined`）、`pi.extensions`（加载开关）、`files: ["extensions/", "src/"]`（入口 import 的是 `../src/*.ts`，两者缺一则装上也起不来）。不需要打包 `node_modules`：`@oh-my-pi/*` 由宿主 `omp:legacy-pi-shim` 在运行时重定向到宿主内嵌副本。tarball 实测 12 文件 25.8kB。

**验证方式**：用独立 `HOME`（无 config/token/沙箱）+ 复制一份 `models.yml` 模拟另一台机器，装完启动宿主确认起桥并自建独立 token 与沙箱。中途发现 omp 在无模型配置时会**先退出、根本不加载扩展**，故模拟机必须给 `models.yml` 才能测到扩展加载。（`--status` / `--uninstall`，`OMP_AGENT_DIR` 可改位置）。

**此前 README 的 `ln -s "$PWD/extensions/a2a-bridge.ts" ...` 是错的**：该写法依赖调用者的 `$PWD` 恰为仓库根目录，换个目录执行就会链到不存在的路径（实测 `cd /tmp` 后链成 `/tmp/extensions/a2a-bridge.ts`），宿主加载失败但**没有任何用户可见报错**——桥只是永远不出现。**教训：文档里给出的命令若隐含「你得先 cd 到某处」这个前提而不校验，用户会踩到静默失败；安装脚本应自己推导路径并在结束时校验。**

### 更正一：`omp install .` 才是首选，`pi.extensions` 是它的开关（我曾误删）

**`omp install .` 从仓库根执行即可**（等价于 `plugin install`/`plugin link`），把仓库软链到 `~/.omp/plugins/node_modules/pi-a2a-ext` 并注册；`omp plugin uninstall pi-a2a-ext` 卸载。**它依赖 `package.json` 的 `"pi": { "extensions": ["./extensions/a2a-bridge.ts"] }`**——删掉该字段后 `omp install --json` 的 `manifest` 变成 `{}`，宿主**完全不加载**任何扩展（实测）。

**我一度把该字段删掉并写进 CHANGELOG 说它「无效」，那是错的，已回滚。** 错因：我拿 `omp plugins list` 的输出当判据（它只列**已安装 npm 插件**，与 manifest 解析无关，我这个仓库不是 npm 插件所以查不到），而**真正的判据是 `omp install --json` 的 `manifest` 字段 + 宿主是否真的加载**。同款错误此前已在版本漂移那轮出现过一次（拿 `omp --version` 与 registry latest 混淆）——**同一个错误模式：拿「列表里没有」当「机制不支持」。**

对照证据：可用插件 `@better-compact/pi` 的 package.json 同时有 `pi.extensions` / `omp.extensions` / `main` / `exports` / `files` / `keywords:["pi-package",...]`。

### 更正二：单文件软链不构成障碍（曾误判）

扩展入口 import 的是 `../src/*.ts`，但 Bun 解析相对导入前先 `realpath` 软链，因此软链能正确落到仓库的 `src/`（实测宿主正常起桥）。曾误判此处会断链，**靠实际安装 + 启动宿主才确认可用**。`scripts/install.sh` 保留模块齐备检查只作纵深防御。

脚本自身的两个非显然细节：`--status` 判活必须用 `readlink` 原始目标 + `[ -e ]`，**不能用 `readlink -f`**——后者对悬空软链输出空串并非零退出，会让断链显示成「已安装」。安装目标若是真实文件（用户自己的扩展）一律拒绝覆盖。
## 守卫失效的两种形态（2026-10-01）

本仓库的 CI 从 `5107bad` 起就是红的，持续 9 天没人处理——`bun run lint` 报的是 `.agents/skills/design-doc-mermaid/.claude-plugin/plugin.json` 与 `skills-lock.json` 两个文件的 **format**（上游用空格缩进，`biome.json` 配的是 `indentStyle: "tab"`），**零逻辑缺陷**。已定位到引入提交：`5107bad` 之前 `biome check .` 是 25 文件 0 错误，之后 3 错误。

**这与版本漂移是同一个模式。** 那次的教训是「靠单测事后捕获一个反复复发的不变量，是把守卫放在了太靠后的位置」；这次更靠前一步——**守卫彻底失效，且因为它一直红，反而没人发现**。一个必然失败的检查等于没有检查：它不提供信息，只提供噪音，人看久了就学会无视红灯。**「CI 一直红」和「CI 一直是绿的但没检查该查的东西」是同一种失效，都表现为「没人发现问题」。**

修法不是格式化那两个文件（下次重装 skill 会被覆盖），而是**把它们移出 biome 管辖范围**：`biome.json` 的 `files.includes` 加 `!.agents` 与 `!skills-lock.json`。依据是 gitignore 与 biome 划的是**两个不同维度**——gitignore 管「不该进版本库」，biome 管「该由本仓库负责」。`.agents/` 与 `skills-lock.json` 是外部 skill 安装器的产物，和 `node_modules/` 同类，只是恰好被提交进了版本库；提交进 git 只改变它被追踪的状态，不改变它的来源。`!.agents` 按目录排除，覆盖将来安装的任何 skill（已实测：新建 `.agents/skills/fake-skill/plugin.json` 后 lint 仍绿）。注意 biome 2.2.0 起忽略目录**不写** `/**`，写成 `!.agents/**` 会触发 `lint/suspicious/useBiomeIgnoreFolder`。

**教训：发现守卫失效时，先问「它为什么失效」，而不是逐个修它报出的错。** 逐个修是治标，且下次重装即复发。

## 极简化（2026-10-01 决定，推翻 Q4 与 Q8）

四条原则：**极简 / 不重复造轮子 / 不替 omp 实现沙盒 / 不替 omp 管权限。** 桥缩回接口转换器，源码 1460 → 655 行。

**Q4 的 `deny` / `denyMCPTools` 取消。** `tools/list` 就是 `pi.getAllTools()`，**原样透传不过滤**——含 `hidden` 工具、也含宿主当前对自己模型禁用的工具。**omp 是什么权限，桥就是什么权限。** 理由不是「更简单」，而是 `deny` 是第二套权限名单：它与宿主自己的工具配置可以互相矛盾，而代码里没有定义冲突时谁优先（`src/bridge.ts` 只做 `isDenied` 短路，宿主侧管不到）。配置只剩 `port` / `host` / `token`。

**Q8 整个文件传输面删除**（`src/filetools.ts` 460 行 + `src/fileguard.ts` 215 行 + 6 个 `a2a_file_*` + 11 个错误码 + 37 处传输状态机）。三条理由：**(1) 重复造轮子**——远程本来就能调宿主 `bash`，`cat` / `base64 -d >` / `ls` / `dd` 分别覆盖 get / put / list / 分块。**(2) 沙盒是替 omp 做的**，而桥自带工具**绕过宿主审批门**（`src/bridge.ts` 原注释：bridge tools bypass the host's approval gate）——绕过审批就得自带隔离，两者同源，所以要一起删；只删沙盒会留下「谁都不管」的洞。**(3) 代价可量化**——675 行实现 + 1216 行测试（测试是实现两倍），且状态机自己生产了两个 P1：seq 校验 TOCTOU 致并发重试静默写坏文件、串行化修复自身引入的活性竞态。

保留的有价值判断（不随删除作废）：**执行必须走宿主原生 `getToolByName().execute()`，注入真实 `session.settings` 与 `ExtensionContext ui`**，这样宿主的 `ExtensionToolWrapper` 审批门照常生效——桥自己一套审批逻辑都不实现。**调用与列表同源**（`tools/call` 只接受出现在 `tools/list` 的名字，别名 `xd://bash` 与未注册名一律 `not exposed`，且不区分「被过滤」与「不存在」）这条不依赖 `deny`，仍然成立。

代价（如实）：100MB 文件不走 MCP 通道（走 SSH/`scp`，README 早已这么建议）；原子落盘（`.tmp` + `rename` + 0600）没有了，远程写文件用宿主的 `edit`/`bash`；远程会看到 `hidden` 工具——这是「不过滤」的必然结果。

**教训：桥自带工具绕过宿主审批门，所以不得不自带沙箱——这是一个决定的两个后果，要一起删。** 只删其中一个，会得到一个比原来更糟的中间态。
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

- time: 2026-10-01T13:18:55
  kind: decision
  summary: "恢复被上一次 update-truth 压掉的 Q1–Q8 与方法论全文，并新增「守卫失效的两种形态」一节"
  source: "lint 修复轮 2026-10-01（修正上轮 compiled_truth 的信息损失）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T13:49:26
  kind: reversal
  summary: "推翻 Q4 的 deny/暴露交集与 Q8 的整个文件传输面——按「极简/不重复造轮子/不替 omp 实现沙盒/不替 omp 管权限」四条，桥缩回接口转换器：源码 1460 → 655 行。删 src/filetools.ts + src/fileguard.ts（675 行）与 6 个 a2a_file_*，删 deny/denyMCPTools 与 fileRoot/maxFileBytes。tools/list 改为 pi.getAllTools() 原样透传不过滤（含 hidden 工具、含宿主对自己模型禁用的工具）——omp 是什么权限桥就是什么权限，删掉的是第二套与宿主可冲突且无优先级的权限名单。**教训一：桥自带工具绕过宿主审批门，所以不得不自带沙箱——这是同一个决定的两个后果，要一起删，只删一个会留下「谁都不管」的洞。教训二：为已有能力（bash 的 cat/base64/ls/dd）造轮子的代价可量化——675 行实现 + 1216 行测试，且状态机自己生产了两个 P1（seq TOCTOU 写坏文件、串行化修复自身引入的活性竞态）。**"
  source: "极简化轮 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T13:56:07
  kind: evidence
  summary: "发现 test:install 的隔离根本不成立（harness 缺陷，与代码无关）：探针只设 HOME=临时目录，但实测用一个全新空目录做 HOME，桥仍起来且仍广播「file transfer」——说明 omp 加载的是**真实 HOME** ~/.omp/plugins/node_modules/pi-a2a-ext 下 9-30 装的那份旧拷贝（grep a2a_file_ 有 1 处命中），而不是探针刚装进临时 HOME 的那份。设 OMP_PLUGIN_DIR 无效。后果：极简化提交后该核验报 FAIL，实际验的是旧插件。**教训：探针声称隔离某样东西时，要用「该物缺席」的反证测，不能只看它指向的目录。** 修复未做（独立议题）。"
  source: "极简化轮 2026-10-01 复跑 install 核验"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T14:44:25
  kind: decision
  summary: "把本质需求与四条原则写进 AGENTS.md 与 README（中英），此前它们只存在于对话里。**本质需求：复用本机已经跑着的那个 omp**——任意 MCP 客户端把 mcp.json 指向端点即可调用它的工具，调用落在宿主 Main 会话的真实文件与 shell 上。桥只负责把调用送到，不在途中加意思。四条原则由这一句推出：不重复造轮子 / 不替 omp 实现沙盒 / 不按权限过滤（tools/list 原样透传）/ 不长出第二个系统。**判断标准：改动是让桥更透明，还是给桥一个自己的意见？后者即第二个 omp。** 写的时候刻意不加解释——原则写长了就成了新的可解释空间。"
  source: "原则落仓 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T14:58:49
  kind: decision
  summary: "test:install 缩小为「发布包自包含」核验（17 项，不再起宿主）。根因实测确认：宿主解析插件目录不受 HOME 影响——往假 HOME 装一个只打印标记的扩展，标记未出现而真实 ~/.omp 那份桥起来了；XDG_DATA_HOME / OMP_PLUGIN_DIR / 改 cwd 三者都无效。新核验只测能观测的边界：manifest + npm pack 产物 + 从入口走相对 import 图（files[] 漏模块会「装得上、加载时才炸」，逐个断言文件名会被新增模块绕过，走图才抓得到），并已验过它会失败。docs 与 README（中英）如实写明 omp install <git-url> 端到端无自动化覆盖。**教训二则：(1) 探针声称隔离某样东西时用「该物缺席」的反证测——这里的反证是装一个只打印标记的扩展；(2) 绕不开宿主的机制时，缩小到能观测的边界并写明缺口，比自己重建一层隔离更诚实——后者正是不重复造轮子的反面。**"
  source: "install 核验修正 2026-10-01"
  affects: [a2a-mcp-bridge]

- time: 2026-10-01T23:58:33
  kind: reversal
  summary: "推翻本页 2026-10-01 两条 timeline 里的结论「宿主解析插件目录不受 HOME 影响，因此端到端无法自动化」。**方向对，机制错。** 实测：两个目录行为不同——~/.omp/agent/extensions/ 跟随 HOME（往临时 HOME 放只打印标记的扩展，标记出现），~/.omp/plugins/ 不跟随（桥仍从真实插件目录加载；OMP_PLUGIN_DIR / OMP_PLUGINS_DIR / XDG_DATA_HOME 都改不动）。坏探针只试了 agent 目录，且没给临时 HOME 写 models.yml。**真正的拦路虎是第二条：宿主没有模型配置就不创建 session，扩展在 session_start 加载，于是桥永不广播**——这个症状与「插件发现忽略了我的 HOME」完全一样，单独又误判过一次。test:install 已恢复端到端（17 → 32 项，第五组 9 项，已验过移走插件目录会红）。教训升级为三条：(1) 探针声称隔离某物时用「该物缺席」的反证测；(2) **同一个探针两次给出相反结论时，先查最平凡的前提**（这里是没有 models.yml），不要先怀疑被测系统；(3) 探针的失败详情要限长，否则一行几千字符的 frame 会把真正的错误行淹掉。"
  source: "test:install 恢复端到端；上一条 Q 关于插件发现隔离的结论被推翻"
  affects: [testing, tooling]

- time: 2026-10-06T13:07:30
  kind: reversal
  summary: "补记 ：它按决定推翻了「不替 omp 实现沙盒」与「桥不解释路径」两条原则，此前只写在 CHANGELOG 与代码里，本页 timeline 与 compiled_truth 均无记录（read-page grep blob = 0 命中）。取舍本身已在 2026-10-01 那条「桥自带工具绕过宿主审批门，所以不得不自带沙箱——这是一个决定的两个后果」里推出，只是这次选择承担两个后果而不是删掉能力：**(1) 不经宿主审批门**——ExtensionAPI 只有 on(\"tool_approval_requested\")，宿主问扩展答的方向，扩展无法主动发起审批；**(2) 桥自己解释路径**——宿主 resolvePath()/expandPath() 在宿主包内部，BridgeDeps 没有入口，依赖它们会在宿主移动文件时断，于是 src/blob.ts 自实现 ~ 展开与相对/绝对判断，代价是能写宿主能写的任何路径，无根目录无白名单。同时推翻极简化一节记录的代价「100MB 文件不走 MCP 通道（走 SSH/scp，README 早已这么建议）」：实测烧固件这类需求走 tools/call 要 21 次请求（16MB，单块用满 1MB 上限），/blob 省掉 base64 编码（每块少传 33%）。请求体上限 1MB → 128MB（maxRequestBodySize）；实测 100MB 镜像一次请求 0.4s 字节一致，129MB 干净 413，宿主 RSS 空闲 368MB → 一次上传 624MB → 两次并发 846MB（并发非线性叠加，但每个在途大请求仍吃 200MB+）。保住的一样是审计：每次写入留一条 tool=\"blob:write\"，args 只有 path/offset/bytes，内容不进日志。**教训：一次推翻若只落在 CHANGELOG 里，下一轮读到 brain 的人会以为原则从未被动过——推翻也是决定，决定就该进决定页。**"
  source: "补记 2026-10-02 /blob 一轮（本页此前漏记，2026-10-06 补）"
  affects: [a2a-mcp-bridge]

- time: 2026-10-06T13:07:36
  kind: evidence
  summary: "版本漂移第五次复发：宿主 omp 18.6.1、node_modules 18.6.1，pin 与 lockfile 仍 18.4.4，bun test 54 项红 1 项（installed != pin）。pin + lockfile 同步至 18.6.1。全量回归：tsc 0 错误、单测 54/54、biome 干净、SMOKE OK（21 工具）、HARDEN OK（24 项）、BLOB OK（19 项，100MB 一次请求字节一致 0.3s）、PACKAGE OK（28 项）、审批探针 VERDICT B（bash 挂起 90031ms 后由调用方超时抛出，副作用文件未出现，server 存活，审计 start=1 done=0）。pin == host 不变量当前值 = 18.6.1。**注意 CI 的盲区在这里又出现一次**：check job 的 frozen-lockfile 安装下 pin 与 lock 自洽，所以漂移只在本地显形（host-probes job 装的是 pin 本身，比的也是 pin），两个 job 都没法发现 pin 已落后于真实宿主——宿主升级这件事只有版本守卫在有宿主的机器上才看得见，而它 warn-only。**教训：守卫链条的最后一环是「有人在有宿主的机器上跑测试」，不是任何配置项。**"
  source: "宿主 18.6.1 回归 2026-10-06"
  affects: [a2a-mcp-bridge]

- time: 2026-10-07T08:47:53
  kind: evidence
  summary: "版本漂移第六次复发，且这次能说清一半机制：宿主 omp 有 startup.checkUpdate（默认开，启动时查更新），所以宿主升级不需要本仓库做任何事；10-06 同步到 18.6.1 并推完，10-07 宿主与 node_modules 已到 18.6.3，pin 18.6.1，bun test 又红——修复保质期不到一天，「保持现状」的成本从偶发变成跟节奏走。仍未知的是谁在改本仓库的 node_modules，前五次都记成「同一未知机制」，继续不假装知道。另外把 brain 六页 root page 的占位符全部换成实内容（background / architecture / flow / mindmap / stack，加 roadmap），内容只从源码与既有记录推，不补想象出来的里程碑；五张 mermaid 用站点自带的 mermaid 11.17.2 在 jsdom 下 parse 过，并先证明该探针对坏语法确实 FAIL（未闭合节点与双 root 各报一条），否则「全 ok」不算证据。**教训：占位符页比空页更糟——它看起来像个计划；而「探针全 ok」这句话本身也要先反证探针会红。**"
  source: "六页 root page 补实 + 漂移第六次复发 2026-10-07"
  affects: [a2a-mcp-bridge]

- time: 2026-10-07T09:20:09
  kind: decision
  summary: "关闭 roadmap 里那条未决线程，选定第二个选项：test/versions.test.ts 的宿主比较从 warn 改成 **fail**。理由三条，全部实测：(1) 宿主 omp 有 startup.checkUpdate（默认开），自己会升级，节奏不由本仓库定；(2) CI 两个 job 结构上都看不见真实宿主升过——check 用 frozen-lockfile 装（pin 与 lock 自洽），host-probes 装的就是 pin 本身（比的是 pin），所以「宿主已升级」这个事实只存在于有宿主的机器上；(3) 复发六次，最近两次隔了不到一天，warn 的保质期比修复的保质期还短。**没人必须处理的 warn 不是守卫**——这与本页「守卫失效的两种形态」是同一条：必然失败的检查等于没有检查，没人处理的 warn 也一样。配套两条边界：无宿主时跳过（CI check job 就是这种形态，反证过 OMP_BIN 指向不存在路径 → 跳过而非误红）；确实要对着别的宿主跑用 A2A_SKIP_HOST_VERSION_CHECK=1，打印大声的 SKIPPED，不静默。写第一版断言时自己写错——无条件拼了不匹配那句，于是期望值永远不等，表现为「pin 已同步却仍红」，由这个不合理现象自己暴露。教训：断言的失败信息不该由无条件构造决定；两支文案不同的时候，先写清楚「匹配那支长什么样」。pi-* pin 与 lockfile 同步至 18.6.3，全量回归绿（tsc 0 / 54 单测 / biome / SMOKE 21 工具 / HARDEN 29 / BLOB 19 / PACKAGE 28 / 审批 VERDICT B）。"
  source: "版本守卫 warn → fail 2026-10-07"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T01:28:48
  kind: evidence
  summary: "test:install 的 announce 断言通过时打印的是**失败形态**的 detail：「ok: the host announces the bridge …(no announcement and no short error line)」——标签说广播了，括号说没广播。根因是 check() 的 detail 参数两头都打印，而同一仓库有三种写法：hardening.ts 的 check 不带 detail；blob-probe.ts 用 `cond || !detail ? \"\" : detail` 只在失败时打印；只有 install-probe 两头都打印，且恰好有一处两态不成立的调用点。修法是让 detail 两态各自成立（通过时是广播本身，失败时才扫错误行），并在 check 上把契约写死。**教训一：探针的输出必须两态都读得通——断言成立但输出读起来像失败，比没有输出更坏，因为人会按输出下结论而不是按断言。教训二：同一概念在三处有三种写法时，第三种通常就是藏着缺陷的那处——差异本身是线索，不必逐个审。** 反证：改坏正则 → FAIL 且仍打诊断；复原 → ok 且 detail 是真实地址。项数仍 28，五探针与单测全绿。"
  source: "E2E 探针输出自相矛盾 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T01:56:23
  kind: decision
  summary: "新增第六个探针 test/scenario.ts（10 叙事 / 54 步 / 约 45s，接进 CI host-probes），形状与前五个不同：前五个是**平铺断言**（每项一个观察、彼此独立），这个每条是叙事，且**结尾状态从产生它的那条通道之外去验**——远程 bash 看文件系统与审计日志、/blob 写入用宿主 read 读回、会话终止后去连端口、外部改配置看运行中服务器认哪个 token、宿主结束看端口是否还接受。理由是既有的：留在单通道内的推理正是 675 行文件传输面带两个 P1 上线、100 单测全绿的原因，所以「多写测试」不等于「多一条通道」。补上的零覆盖空白：端口占用回落与告警、配置损坏 fail-closed、--approval-mode=write 档（读 25ms 答、bash 挂住、审计 start 无 done）、宿主结束释放端口、两客户端并存与 sid 归因、8 路并发上传互不串扰、xd:// 挂载设备、blob→宿主工具一致性。**每个场景都用注入缺陷反证过会红**，并把边界写进探针文件头：删掉暴露面校验场景套件**不红**（那条归 hardening，实测它红两项）。三条当场揪出的自身缺陷：(1) 场景对「/blob 一律覆盖写」原本是绿的——对不存在的文件追加与截断是同一操作，补显式 offset 追加才咬得住；(2) rpc() 无默认超时，桥没起来会挂在占用端口上（现恒 20s 上限）；(3) 误以为宿主 read 返回裸内容，实际带 [path#hash] 头与行号（像 cat -n）。顺手修 test:install 一项**因错误理由变绿**的断言：设备名被拒只断言 isError，暴露门一去掉就被设备自己以 Unsupported debug action 拒掉而照样绿；改为断言必须是桥的 not exposed。**教训一：一个断言要问「它绿的时候，凭的是什么」——凭另一个原因绿，等于没断言。教训二：探针自身的失败路径也要验，rpc 不设超时就足以让整轮挂死，而挂死不产出信息。**"
  source: "端到端场景核验 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T01:57:17
  kind: evidence
  summary: "架构页补一处不经代码即看出的耦合：/a2a rotate 之所以能立刻生效，是因为 startServer 捕获的是 cfg **对象**而非副本，rotate 改的就是同一对象（extensions/a2a-bridge.ts 的模块级 cfg → startServer(cfg, …) → handler 里 authorize({token: cfg.token})）。改成 startServer({...cfg}) 会让轮换静默退化成「下次重启才生效」，而这种退化没有任何断言会发现——现有测试全部在轮换之后手工重启。test:scenario 的「外部改配置到重启才生效」场景把两侧一起钉住：运行中的服务器只认启动时的 token（外部改写 → 旧 token 仍 200、新 token 401），重启后才读盘上那份。"
  source: "架构页补 cfg 对象耦合 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T02:41:26
  kind: reversal
  summary: "推翻本页 2026-10-06 补记里那组内存数字（空闲 368MB → 一次 100MB 上传 624MB → 两次并发 846MB，据此说「每个在途大请求仍吃 200MB+」）。那组数只在宿主 18.6.1 上量过一次，宿主已到 18.6.3，没人复核。新实测（test:blob 每轮跑，宿主 18.6.3，隔离临时 HOME）：空闲 487MB；单个 8MB 请求安顿增量 −6MB（在途峰值 +13MB）；两个并发 8MB 安顿 +148MB（在途峰值 +248MB）。五轮里单个请求的安顿增量分别是 +11、+26、+171、+165、−6MB——包括负的，即上传完宿主 RSS 比上传前还低。宽度来自 Bun 分配器（arena 增长 + 前一步 100MB 上传延迟归还），不是本桥有没有把 body 留在内存里。文档里的并发告诫因此改由 128MB 请求体上限制推（上限是每个在途请求各自的），不再挂在这组数上。"
  source: "宿主 RSS 实测重做 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T02:41:38
  kind: decision
  summary: "两条一起定下：**(1) 文档里的实测数字必须由某个探针每轮复核并归档**，否则它烂在原地而读者以为它还活着——protocol.md 那组 RSS 就是这么过期的。落法：test:blob 测完覆盖写 test/rss-<宿主版本>.json（表就是文件里那一份，最近一次实测而非稳定值），文档表从它刷新。**(2 分配器主导的指标只记录、不断言。** 原本这条要卡在「两个并发 body 的开销小于两者之和」，实测杀死了它；两版变异体（延迟写、延迟读）的峰值都落在真实路径的噪声带里，不可分辨。所以断言只留确定的一半（并发上传与 100MB 单请求必须被接受），RSS 阈值不设——建在它上面的断言测的是分配器当天的状态，会在忙碌的 CI runner 上因与桥无关的原因变红。峰值采样保留为仪器，但不当判决。附带一条通用形状：仪器诚实 ≠ 结论可信，采样方式改对（安顿值看不到在途 body，改 5ms 同步读 /proc 才看到）也不会让被噪声主导的量变成可断言的对象。"
  source: "内存实测规则定稿 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T02:46:08
  kind: evidence
  summary: "上一条 reversal 里那组 18.6.3 数字只看了两轮，第三轮把它推翻了一半：归档那轮空闲 370MB，单个 8MB 安顿 +18MB，两个并发安顿 +44MB，且峰值与安顿值相等。并发三项至此是 +44、+147、+148MB（峰值 +44、+245、+248MB），最大最小差三倍多——**并发也不可复现**，此前那句「并发那两个数看着比单个那一路稳」作废。单个请求的安顿增量七轮：+11、+26、+171、+165、+10、+18、−6MB。结论不变且更硬：这组数不能设阈值；文档内存表按归档那一轮刷新，protocol.md 与 testing.md 同步改掉「并发更稳」的说法。另一条附带教训：归档文件每轮覆盖，所以文档表必须在同一批改动里跟着刷新，否则表与文件说的是两次测量。"
  source: "RSS 第三轮实测，修正上一条的并发结论 2026-10-08"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:33:47
  kind: decision
  summary: "/blob 的写语义定死两条：一律以 \"a\" 打开（不按当前大小在 w/a 之间选择），显式 offset 在拿到句柄后再复查一次大小、不符则 409。理由是一次真实缺陷：两个调用方同时写一个新文件时都看到 size 0、都选 w，第二次 open 截断抹掉第一次已落盘的字节，两条请求却都回 200。另外 handle.write 短写（磁盘满、配额）必须回 500 并记一条 bytes:0 的审计，不能报成功。413 由 Bun 挡在 handler 之外，因此既不碰文件也不写审计，这是有意的一致。"
  source: "test/blob-probe.ts + src/blob.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:33:53
  kind: decision
  summary: "审计日志的保留语义定死：轮转只留一代（rename 到 <path>.1，下一次轮转覆盖它），所以「只有 start 没有 done」这个挂起信号有保质期，后续流量够多就把证据冲出日志。README 中英与 protocol.md 都要带这句告诫。另记两条读日志的人会踩的空处：日志里的 id 是本桥为配对生成的 UUID，调用方的 JSON-RPC id 从不落盘，按它查不到任何东西；轮转可能把一次调用的两条分处两个文件，配对要两个文件一起看。保留性这条在 test/audit.test.ts 里用直接灌审计模块的方式测（一秒），不在宿主核验里跑（要两千次真实调用）。"
  source: "test/audit.test.ts + src/audit.ts"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:34:01
  kind: note
  summary: "核验的取舍记两条：其一，宿主 RSS 那组只打印归档、不设阈值，本轮单个 8 MB 安顿增量 −157 MB、并发峰值 −141 MB，八个轮次从 −157 跨到 +171 MB。负值的成因是基线取样位置：空闲值在探针末尾读，那一刻前一步 100 MB 上传仍有内存未归还，基线自己在衰减，增量于是带着衰减的方向。这坐实了不断言阈值的决定，机理写进 docs/protocol.md 与内存表。其二，写断言时必须问「实现变坏它会不会红」：按 JSON-RPC id 查审计日志那项不会红也不会绿，因为那个 id 从没写进日志；让记录变胖靠 1000 字符的路径也不成立，redact() 会把超过 120 字符的字符串折成约 30 字节的摘要，越过 512 KB 因此要 1241 次调用而不是 213 次。两处都改成了能如实变红的形式。"
  source: "test/hardening.ts + docs/testing.md"
  affects: [a2a-mcp-bridge]

- time: 2026-10-08T03:37:10
  kind: evidence
  summary: "RSS 落表以最后那一轮为准：第十轮实测空闲 495 MB，单个 8 MB 安顿 +18 MB，两个并发安顿 +32 MB，在途峰值 +26 / +32 MB，100 MB 一次请求 0.3 秒。十轮的单个 8 MB 安顿增量为 +11、+26、+171、+165、+10、+18、−6、−157、+91、+18 MB（两轮为负），并发的安顿为 +147、+148、+44、−141、+99、+32 MB。连着三轮给出 −157、+91、+18 就是不断言阈值、文档只写「最近一次实测」的实证理由。"
  source: "test/rss-18.6.3.json + docs/protocol.md"
  affects: [a2a-mcp-bridge]
