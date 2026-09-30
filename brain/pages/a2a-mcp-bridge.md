---
id: a2a-mcp-bridge
title: A2A MCP bridge architecture
category: decision
status: active
tags: [omp, extension, mcp]
created: "2026-09-10T09:16:34"
updated: "2026-09-30T04:26:43"
---

<!-- compiled_truth -->
# A2A MCP Bridge — Key Decisions

Goal: an omp extension (pi-a2a-ext) turns the running omp into a Streamable HTTP MCP server so a remote omp can call the host's live tools without the host invoking any LLM API.

## Q1 Execution target (decided)
Remote tools/call executes IN the host's live session via AgentRegistry.global().get("Main").session.getToolByName(name).execute(...). No headless subprocess for v1.

## Q2 Transport (decided — supersedes early "stdio" note)
Streamable HTTP on 127.0.0.1 via Bun.serve, single process inside the host omp. stdio was rejected: a stdio MCP server needs exclusive stdin/stdout which collides with the running TUI, and TUI approval forwarding requires same-process. Verified against host client: protocol 2025-11-25, Accept: application/json, text/event-stream; plain JSON responses suffice; GET SSE optional (405 tolerated); notifications accept 200/202 (src/mcp/transports/http.ts).

## Q3 Approval (decided; protocol behavior reversed 2026-09-24)
Reuse the host's built-in approval gate. Registry tools ARE ExtensionToolWrapper instances (sdk.ts:2922) which run resolveApproval internally: yolo passes, deny throws -> isError, per-tool prompt raises ui.select. The bridge must inject the REAL session.settings and the ExtensionContext ui into the AgentToolContext it builds; it implements no approval logic itself.
REVERSED (approval probes on omp 18.2.10, --mode rpc): prompt tier with NO interactive UI does NOT return isError — the tools/call request hangs indefinitely (>=90s observed; src/ contains no setTimeout/AbortSignal/timeout anywhere). Execution is still blocked (side-effect probe never fired), so fail-closed holds only in the security sense, not the protocol sense: the README section 「审批 / Approval」 (was line 105; corrected 2026-09-24 to document the hang, the caller-timeout requirement, and the start-without-done audit trace; the discriminating probe is committed as test/approval-probe.ts (expected verdict B). Host mechanism: hasUI=false in plain rpc (host sets hasUI=f||r==="rpc-ui"), so ui.select has no answerer; the host's 600000ms input timeout belongs to login, not approval. The TUI prompt path is unaffected.

## Q4 Exposure (decided; tightened 2026-09-23)
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



## Q8 修订 — 文件面代码评审修复（2026-09-30）

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
