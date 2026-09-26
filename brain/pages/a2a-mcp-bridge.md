---
id: a2a-mcp-bridge
title: A2A MCP bridge architecture
category: decision
status: active
tags: [omp, extension, mcp]
created: "2026-09-10T09:16:34"
updated: "2026-09-26T16:30:22"
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
REVERSED (approval probes on omp 18.2.10, --mode rpc): prompt tier with NO interactive UI does NOT return isError — the tools/call request hangs indefinitely (>=90s observed; src/ contains no setTimeout/AbortSignal/timeout anywhere). Execution is still blocked (side-effect probe never fired), so fail-closed holds only in the security sense, not the protocol sense: README:105 has been corrected (2026-09-24) to document the hang, the caller-timeout requirement, and the start-without-done audit trace; the discriminating probe is committed as test/approval-probe.ts (expected verdict B). Host mechanism: hasUI=false in plain rpc (host sets hasUI=f||r==="rpc-ui"), so ui.select has no answerer; the host's 600000ms input timeout belongs to login, not approval. The TUI prompt path is unaffected.

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
- Approval probes (2026-09-24, omp 18.2.10, --mode rpc, default settings): default approvalMode yolo -> remote bash EXECUTED in 0.03s (README:103 confirmed). With --approval-mode=always-ask: read auto-approved (17-30ms), bash hung >=90s, side-effect file never appeared, server answered ping 200 afterwards. Probe committed as test/approval-probe.ts (exit 1 on fail-open/unexpected return/audit-invisible); hardening probe committed as test/hardening.ts (29 checks incl. two-phase pairing and sid-attribution assertions).
- Version state 2026-09-24 (corrected): host omp is 18.2.10 (omp --version + global pi-coding-agent/pi-ai all agree); devDep pin + bun.lock + node_modules are 18.2.10 — the "pin == host" invariant HOLDS. The earlier "host 18.2.11" claim was wrong: 18.2.11 is the registry latest, not the installed version. The real anomaly was repo node_modules at 18.2.11, desynced from its own lock, healed via bun install (tsc + tests green under both versions). Guard added: test/versions.test.ts hard-asserts exact pins and installed==pin, warns when omp --version != pin.
- Typing the execute() context against the host SDK depends on pi-coding-agent's AgentToolContext augmentation being loaded: the `import type {} from "@oh-my-pi/pi-coding-agent/tools/context"` in src/bridge.ts merges the CustomToolContext required fields (sessionManager/modelRegistry/model/isIdle/hasQueuedMessages/abort) plus ui/hasUI into the interface. Mutation-verified 2026-09-24 (deleting abort from the literal fails tsc); deleting that empty import silently degrades the check to vacuous (the pi-agent-core base interface is all-optional), so keep it. Related: pi-ai Static<TSchema> = unknown (execute args need no cast) and ToolInfo.parameters is TSchema (flows typed into toolWireSchema) — the three historical `as never` casts were removed 2026-09-24.


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
