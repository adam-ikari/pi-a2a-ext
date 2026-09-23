---
id: a2a-mcp-bridge
title: A2A MCP bridge architecture
category: decision
status: active
tags: [omp, extension, mcp]
created: "2026-09-10T09:16:34"
updated: "2026-09-23T04:31:41"
---

<!-- compiled_truth -->
# A2A MCP Bridge — Key Decisions

Goal: an omp extension (pi-a2a-ext) turns the running omp into a Streamable HTTP MCP server so a remote omp can call the host's live tools without the host invoking any LLM API.

## Q1 Execution target (decided)
Remote tools/call executes IN the host's live session via AgentRegistry.global().get("Main").session.getToolByName(name).execute(...). No headless subprocess for v1.

## Q2 Transport (decided — supersedes early "stdio" note)
Streamable HTTP on 127.0.0.1 via Bun.serve, single process inside the host omp. stdio was rejected: a stdio MCP server needs exclusive stdin/stdout which collides with the running TUI, and TUI approval forwarding requires same-process. Verified against host client: protocol 2025-11-25, Accept: application/json, text/event-stream; plain JSON responses suffice; GET SSE optional (405 tolerated); notifications accept 200/202 (src/mcp/transports/http.ts).

## Q3 Approval (decided)
Reuse the host's built-in approval gate. Registry tools ARE ExtensionToolWrapper instances (sdk.ts:2922) which run resolveApproval internally: yolo passes, per-tool prompt raises ui.select in the host TUI, no-UI modes fail closed. The bridge must inject the REAL session.settings and the ExtensionContext ui into the AgentToolContext it builds; it implements no approval logic itself.

## Q4 Exposure (decided; tightened 2026-09-23)
pi.getAllTools() -> full tool list (name/description/parameters via toolWireSchema -> JSON Schema 2020-12), config deny list removes tools from both tools/list and tools/call. No whitelist in v1.
Exposure semantics (2026-09-23 review): the catalog is the session tool REGISTRY as-is — getAllToolInfos() filters neither `hidden` tools nor tools the host currently disabled for its own model, so it is deliberately NOT a mirror of what the host model can see. tools/call intersects with the catalog (name survives deny AND appears in pi.getAllTools()), so aliases like xd://bash and guessed hidden names are rejected; denied and not-in-catalog share one message so a token holder cannot probe name existence.

## Q5 Auth (decided)
Static Bearer token, 32 random bytes base64url, generated on first start, persisted 0600 in ~/.omp/agent/a2a-bridge.json together with port/host/deny. Constant-time compare. /a2a rotate regenerates. No OAuth/TLS in v1 (loopback default; SSH forwarding documented).

## Q6 Config & audit (decided 2026-09-23)
Config validation is fail-closed: a present-but-malformed field (port/deny/host/denyMCPTools) aborts extension startup with a named error instead of running with a wrong exposure surface. Only `token` self-heals — regenerated AND persisted, so it stays stable across restarts. Config writes are 0600 at creation (writeFile mode), closing the pre-chmod window. External edits to a2a-bridge.json apply on next host restart; only `/a2a rotate` is live.
Every remote tools/call appends one JSONL audit record (ts/tool/args truncated to 1KB/isError) to <agentDir>/a2a-bridge.log — 0600, rotates to .1 past 512KB, $A2A_BRIDGE_AUDIT overrides the path, and audit failures never affect the call itself.

## Q7 Session & protocol (decided 2026-09-23)
Mandatory sessions: every non-initialize message must carry Mcp-Session-Id — missing returns 400, unknown or idle past 24h returns 404, and every hit refreshes the idle TTL (header omission is not a bypass). The map is bounded at 64 sessions with least-recently-seen eviction, because abandoned clients never return to be purged. Auth runs before every state-touching branch, so an unauthenticated DELETE cannot terminate sessions. initialize always answers protocolVersion 2025-11-25 instead of echoing whatever the client asked for, and jsonrpc must be exactly "2.0" (else 400). A configured port already in use falls back to an ephemeral port WITH a warning, since remote mcp.json pins the old port.

## Notable verified facts
- MCP SDK not installed anywhere: bridge hand-writes JSON-RPC on Bun.serve, zero deps.
- AgentToolContext required fields (sessionManager/modelRegistry/model/isIdle/hasQueuedMessages/abort) are all reachable from public surfaces: AgentSession.settings/.sessionManager/.modelRegistry/.model + ExtensionContext ui/hasUI/isIdle/hasPendingMessages/abort.
- Main is registered into AgentRegistry.global() by createAgentSession in ALL modes (sdk.ts:1745,3321), so tools/call works in TUI and headless alike (headless prompt tier fails closed when policy requires UI).
- Host MCP client pages tools/list with do-while on nextCursor (mcp/client.ts:233); omitting nextCursor is valid.
- @oh-my-pi/* specifiers in extensions are rewritten at runtime by omp's `omp:legacy-pi-shim` Bun onResolve plugin (regex ^@(oh-my-pi|mariozechner|earendil-works)/(pi-agent-core|pi-ai|pi-coding-agent|pi-natives|pi-tui|pi-utils)(/.*)?$) to the host's bundled modules. AgentRegistry.global() is a MODULE-level static, so a second copy loaded from node_modules would fork the registry and tools/call would see no Main session — hence those packages belong in devDependencies only, pinned to the host omp version, never relied on at runtime.
- omp's Streamable HTTP client throws Transport not connected from notify() unless a session id exists, and attaches Mcp-Session-Id to every post-initialize request: strict session enforcement cannot break omp's own client.


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
