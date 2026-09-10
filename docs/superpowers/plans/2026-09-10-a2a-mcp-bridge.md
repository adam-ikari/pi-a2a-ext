# Implementation Plan: pi-a2a-ext — omp 作为 MCP 服务器

日期：2026-09-10
上游：`docs/superpowers/specs/2026-09-10-a2a-mcp-bridge-design.md`（已批准）
执行方式：本计划可在独立会话执行，任务间无共享状态依赖（除 T6→T7 的编译/接线）。

## Header

- **Goal**：让装了插件的 omp 进程变成 Streamable HTTP MCP 服务器；远程 omp 通过 `type: http` 连入，直接调用宿主 `Main` 会话的工具；宿主不调用任何 LLM API；写/exec 类工具审批复用宿主内建门（默认 yolo 直通，策略 prompt 时宿主 TUI 弹窗）。
- **Architecture**：单进程。扩展入口 `extensions/a2a-bridge.ts`（`session_start` 时起服务器）；`src/server.ts` 手写 JSON-RPC on Bun.serve（零第三方依赖，MCP SDK 未安装且纯 JSON 响应已满足宿主客户端）；`src/bridge.ts` 经 `AgentRegistry.global().get("Main").session.getToolByName(name).execute(...)` 执行；审批由 `ExtensionToolWrapper` 内建门接管（注册表工具即 wrapper）；`src/config.ts`/`src/auth.ts` 管 token。
- **Tech Stack**：Bun（宿主即 Bun 运行时）、TypeScript（extension 源码直载，无构建步骤）、node:crypto（token/常数时间比较）、零 npm 依赖。

## 已验证的宿主事实（实现时直接引用，勿重查）

| 事实 | 出处 |
|---|---|
| 扩展自动发现：`~/.omp/agent/extensions/*.ts` 直接加载（herdr 即此机制） | 实测目录 |
| `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`；根导出 `AgentRegistry`/`MAIN_AGENT_ID`/`ToolInfo`/`ExtensionContext` | `src/index.ts:23-25,40`、`src/sdk.ts:712` |
| `AgentRegistry.global().get("Main")` → `{session: AgentSession \| null}`；所有模式（TUI/rpc/print）的顶层会话都以 `Main` 注册 | `src/registry/agent-registry.ts:72-87`、`src/sdk.ts:1745,3321` |
| `AgentSession` 公开 `settings`/`sessionManager`/`modelRegistry`/`model`；`getToolByName(name)` 返回注册表工具（即 `ExtensionToolWrapper`，内建审批门） | `agent-session.ts:532-534,1981,4977,5218`、`sdk.ts:2922` |
| `AgentToolContext` 必备 `{sessionManager, modelRegistry, model, isIdle(), hasQueuedMessages(), abort()}` + 可选 `{settings, autoApprove, fetch, localProtocolOptions, ui?, hasUI?, toolCall?}`；全部可从 `session.*` + 扩展 `ctx` 拼装 | `custom-tools/types.ts:85-106`、`tools/context.ts:5-19` |
| wrapper 审批读 `context.settings`/`context.autoApprove`；prompt 时经 `this.runner.getUIContext().select`（宿主 TUI）；无 UI fail-closed 抛错 | `wrapper.ts:196-347` |
| 宿主 MCP 客户端：协议 `2025-11-25`，`Accept: application/json, text/event-stream`，纯 JSON 响应 OK；GET SSE 405 容忍；notification 200/202 OK；tools/list do-while 分页遇无 `nextCursor` 即止 | `mcp/types.ts:168`、`mcp/transports/http.ts`、`mcp/client.ts:233-244` |
| schema：`pi-ai` 的 `toolWireSchema(tool)` 把 ArkType/TypeBox/JSON Schema 统一转 JSON Schema 2020-12；ToolInfo.parameters 即 `TSchema` | `@oh-my-pi/pi-ai/src/utils/schema/wire.ts:585-609` |
| `crypto.randomUUID()` / `crypto.getRandomValues(32)` base64url / `timingSafeEqual` 均可用 | node:crypto |
| 配置基目录：`getAgentDir()`（`@oh-my-pi/pi-utils` 根导出）→ `~/.omp/agent/` | `src/index.ts:10` |

## 任务

### T1 — 脚手架：包清单 + 目录结构

- **Files**
  - `package.json`（新建）：`{"name":"pi-a2a-ext","type":"module","private":true,"pi":{"extensions":["./extensions/a2a-bridge.ts"]}}`
  - `tsconfig.json`（新建）：`{"compilerOptions":{"strict":true,"noEmit":true,"allowImportingTsExtensions":true,"module":"esnext","moduleResolution":"bundler","target":"esnext","types":["bun"]}}`
  - `extensions/`、`src/`、`test/` 目录
- **Change**
  1. 写 package.json、tsconfig.json，建空目录（各放一个占位 `.gitkeep`）。
  2. 不引入任何依赖；不装 MCP SDK。
- **Acceptance**
  - `bun tsc --noEmit`（或 `bun x tsc --noEmit`）无输出退出 0。
  - `git status` 可见新目录。

### T2 — `src/config.ts`：配置加载 + token 生成

- **Files**：`src/config.ts`
- **Change**
  1. `export interface BridgeConfig { port: number; token: string; host: string; deny: string[]; denyMCPTools: boolean }`
  2. `export const DEFAULT_PORT = 0`（0=随机）。
  3. `export function configPath(env = process.env): string` — `env.A2A_BRIDGE_CONFIG || join(getAgentDir(), "a2a-bridge.json")`；`getAgentDir` 从 `@oh-my-pi/pi-coding-agent` 根导入。
  4. `export async function loadConfig(env = process.env): Promise<BridgeConfig>` — 文件存在→`JSON.parse`（畸形→抛错带路径）；不存在→生成默认（`token: generateToken()`，`host:"127.0.0.1"`，`deny:[]`，`denyMCPTools:false`），`mkdir -p dirname`，写 0600，返回。
  5. `export function generateToken(): string` — `base64url(randomBytes(32))`（`crypto.randomBytes` 或 `getRandomValues`；用 `node:crypto` 的 `randomBytes` + `base64url`）。
  6. `export async function saveConfig(cfg, env)` — 写回 JSON（`JSON.stringify(cfg,null,2)`），`chmod 0o600`。
  7. `export function isDenied(cfg, name): boolean` — `cfg.deny.includes(name)`；`denyMCPTools && name.startsWith("mcp__")`。
- **Acceptance**
  - 临时脚本：`TMP=$(mktemp -d); A2A_BRIDGE_CONFIG=$TMP/c.json bun -e '...loadConfig...'` → 文件生成、0600、token 44 字符 base64url、二次 load 幂等（token 不变）。
  - 畸形 JSON 文件 → 抛错信息含路径。

### T3 — `src/auth.ts`：Bearer 校验

- **Files**：`src/auth.ts`
- **Change**
  1. `export function extractBearer(authHeader: string | null): string | null` — 正则 `/^Bearer\s+(.+)$/`，无匹配→null。
  2. `export function tokenEqual(a: string, b: string): boolean` — `Buffer.byteLength` 不等→false；等→`timingSafeEqual(Buffer.from(a), Buffer.from(b))`。
  3. `export function authorize(cfg: BridgeConfig, headers: Headers): boolean` — `extractBearer(headers.get("authorization"))` → `tokenEqual`。
- **Acceptance**
  - 临时脚本断言：正确 token 过、错误 token 拒、无头拒、`Bearer ` 前缀缺失拒、长度不等拒且不抛。

### T4 — `src/server.ts`：JSON-RPC 服务器

- **Files**：`src/server.ts`
- **Change**
  1. `export interface BridgeDeps { getTools(): Promise<McpTool[]>; callTool(name: string, args: unknown): Promise<{content: McpContent[]; isError: boolean; errorText?: string}>; serverInfo(): {name:string; version:string} }`；`McpTool = {name:string; description:string; inputSchema:Record<string,unknown>}`；`McpContent = {type:"text"; text:string} | {type:"image"; data:string; mimeType:string}`（类型放 `src/types.ts` 或 server.ts 顶部，由 T4 定义、T5 消费——契约在此固定）。
  2. `export async function startServer(cfg: BridgeConfig, deps: BridgeDeps): Promise<{port:number; stop():void}>`：
     - `Bun.serve({hostname: cfg.host, port: cfg.port, fetch: handler, maxRequestBodySize: 1024*1024})`；`cfg.port===0` 时实际端口取 `server.port`。
     - `handler(req)`：
       - `GET` → `new Response(null,{status:405})`；`DELETE` → 会话 id 移除 + 204；非 POST → 405。
       - `authorize(cfg, req.headers)` 失败 → 401 `{jsonrpc:"2.0",id:null,error:{code:-32000,message:"unauthorized"}}`（HTTP 401 + JSON-RPC error body，content-type application/json）。
       - 读 body 上限 1 MiB（Bun.serve maxRequestBodySize 已拦，超出自然 413）；`JSON.parse` 失败 → 400 JSON-RPC error `{code:-32700,message:"parse error"}`。
       - 会话：`req.headers.get("mcp-session-id")`；不在 Map 且方法不是 initialize → 404（HTTP）+ error `{code:-32000,message:"unknown session"}`（客户端会重连）；initialize → 生成 `randomUUID()` 存 Map，响应头 `Mcp-Session-Id`。
       - 分派（按 `msg.method`，id 原样回）：
         - `initialize` → `{protocolVersion: msg.params?.protocolVersion ?? "2025-11-25", capabilities:{tools:{}}, serverInfo: deps.serverInfo()}`
         - `notifications/initialized` / 任意 method 以 `notifications/` 开头且无 id → 202 空体（不响应 result）
         - `ping` → `{}`
         - `tools/list` → `{tools: await deps.getTools()}`（无 nextCursor）
         - `tools/call` → `const r = await deps.callTool(name, params.arguments)`；`{content, isError}`；callTool 抛错 → result `{content:[{type:"text",text:msg}],isError:true}`
         - 其它 → `-32601 method not found`
       - 请求体为 JSON 数组（batch）→ `-32600 invalid request`。
     - 端口占用重试：`port!==0` 时 catch 一次 → 退回 0 重试（`startServer` 内部循环 ≤2 次）。
     - `stop()`：`server.stop(true)`。
  3. 响应统一 `Content-Type: application/json`；不实现 SSE。
- **Acceptance**
  - 临时脚本 `bun -e`：起 `startServer`（port 0，deps 用 stub），`fetch` 依次：无 token 401 → 无头 initialize 404 → 带 token initialize 200（断言 protocolVersion/serverInfo/会话头）→ `notifications/initialized` 202 → `ping` → `tools/list`（stub 内容原样）→ `tools/call`（stub）→ 未知 method -32601 → GET 405。全部断言过。

### T5 — `src/bridge.ts`：工具目录 + 执行

- **Files**：`src/bridge.ts`（消费 T4 的 `McpTool`/`McpContent` 契约）
- **Change**
  1. `import { AgentRegistry, type ExtensionContext } from "@oh-my-pi/pi-coding-agent"`；`import { toolWireSchema } from "@oh-my-pi/pi-ai"`（若该子路径导入在宿主 Bun 下解析失败，fallback：`ToolInfo.parameters` 直接作 inputSchema——`toolWireSchema` 只是把 ArkType schema 规范化，多数工具 parameters 已是 JSON Schema 形态；实现里 try/catch 包裹，失败走 fallback 并 `console.warn` 一次）。
  2. `export function buildToolCatalog(pi: ExtensionAPI, cfg: BridgeConfig): () => Promise<McpTool[]>`：
     - 闭包内 `Map<string, McpTool>` 缓存；每次调用：`pi.getAllTools()` → 过滤 `isDenied(cfg, t.name)` → 每项 `{name, description: t.description ?? "", inputSchema: toInputSchema(t.parameters)}`（缓存按 name；重扫时新名字才转换）→ 返回数组。
     - `toInputSchema(parameters)`：`try { return toolWireSchema({parameters}) as Record<string,unknown> } catch { return parameters as Record<string,unknown> ?? {type:"object"} }`。
  3. `export function buildCallTool(pi: ExtensionAPI): (name: string, args: unknown) => Promise<{content: McpContent[]; isError: boolean}>`：
     - 校验 `isDenied` → `{content:[{type:"text",text:\`tool '${name}' is not exposed by this bridge\`}],isError:true}`（T4 侧也过滤，双保险）。
     - `const ref = AgentRegistry.global().get("Main")`；`!ref?.session` → error "main session not available"。
     - `const tool = ref.session.getToolByName(name)`；`!tool` → error `unknown tool '${name}'`。
     - 组装 `ctx`（全公开面）：
       ```ts
       const ctx: any = {
         sessionManager: session.sessionManager,
         modelRegistry: session.modelRegistry,
         model: session.model,
         settings: session.settings,
         isIdle: extCtx.isIdle,
         hasQueuedMessages: extCtx.hasPendingMessages,
         abort: extCtx.abort,
         ui: extCtx.ui,
         hasUI: extCtx.hasUI,
         localProtocolOptions: extCtx.localProtocolOptions,
       };
       ```
       （`extCtx` 来自 `session_start` 事件回调的第二个参数；`ctx` 标注 `AgentToolContext` 类型，字段如不匹配用断言，因为宿主类型经声明合并。）
     - `const r = await tool.execute(crypto.randomUUID(), args as any, undefined, undefined, ctx)`。
     - 映射：`toMcpContent(r.content)`：text→`{type:"text",text}`；image→`{type:"image",data:块.data, mimeType:块.mimeType}`；其它→`{type:"text",text:JSON.stringify(块)}`。`isError: !!r.isError`。
     - `catch(e)` → `{content:[{type:"text",text:e.message}],isError:true}`（审批 deny、无 UI fail-closed、执行异常全覆盖）。
  4. 模块无副作用；`buildToolCatalog`/`buildCallTool` 在 T6 的 session_start 里实例化（拿 pi + extCtx）。
- **Acceptance**
  - 依赖 T6 接线后才能集成验证；本任务先保证类型通过 `bun x tsc --noEmit`。
  - 集成断言（T7 冒烟覆盖）：`tools/call read` 真实文件内容匹配；`tools/call` 未知名 isError；deny 列表项双端消失。

### T6 — `extensions/a2a-bridge.ts`：入口接线

- **Files**：`extensions/a2a-bridge.ts`
- **Change**
  1. `export default function a2aBridge(pi: ExtensionAPI) { ... }`；`import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent"`。
  2. 模块级 `let server: {port:number; stop():void} | null = null; let cfg: BridgeConfig;`。
  3. `pi.on("session_start", async (_ev, extCtx) => { if (server) return; cfg = await loadConfig(); const deps = {getTools: buildToolCatalog(pi, cfg), callTool: buildCallTool(pi, extCtx), serverInfo: () => ({name:"omp-a2a-bridge", version:"0.1.0"})}; server = await startServer(cfg, deps); extCtx.ui.notify(\`A2A bridge: http://${cfg.host}:${server.port} token=${cfg.token}\`, "info"); })`。
     - 注：`buildCallTool(pi, extCtx)` 持 extCtx 闭包即可（每次调用现查 Main session，不缓存 session 引用）。
  4. `pi.on("session_shutdown", async () => { server?.stop(); server = null; })`。
  5. `pi.registerCommand("a2a", { description: "A2A MCP bridge status/rotate", handler: async (args, ctx) => { const [sub] = args.trim().split(/\s+/); if (sub === "rotate") { cfg.token = generateToken(); await saveConfig(cfg); ctx.ui.notify("A2A token rotated; update remote mcp.json"); return; } ctx.ui.notify(server ? \`A2A bridge: http://${cfg.host}:${server.port} token=${cfg.token}\` : "A2A bridge not running"); } })`。
  6. 无其它注册；不触碰工具、不改系统提示。
- **Acceptance**
  - `bun x tsc --noEmit` 通过。
  - 真实宿主加载后：`~/.omp/agent/extensions/a2a-bridge.ts`（软链到本文件）→ 启动 `omp` → notify 显示 URL/token；`/a2a` 显示 status；`/a2a rotate` 换 token。

### T7 — `test/smoke.mts`：无头 E2E 冒烟

- **Files**：`test/smoke.mts`
- **Change**
  1. 脚本逻辑：
     - `const tmp = mkdtempSync(join(tmpdir(), "a2a-smoke-"))`；建 `tmp/.omp/agent/extensions/a2a-bridge.ts`（`symlinkSync` 指向仓库 `extensions/a2a-bridge.ts`）；env `A2A_BRIDGE_CONFIG=tmp/.omp/agent/a2a-bridge.json`、`HOME=tmp`（保留必要的 PATH）。
     - `spawn("omp", ["--mode","rpc"], {env})`；等待 `a2a-bridge.json` 出现（poll ≤15s）→ 读 cfg 拿 URL/token。
     - 裸 `fetch` MCP 客户端：`initialize`（带 Bearer）→ 断言 `result.protocolVersion`、`serverInfo.name`；`notifications/initialized` → 202；`tools/list` → 断言含 `read`、不含 deny 项（cfg.deny 预设 `["bash"]`）；`tools/call read <tmp 内文件>` → 断言 text 含文件内容；`tools/call no_such_tool` → `isError:true`；无 token 请求 → 401；`tools/call` 里调 `bash`（deny 项）→ isError。
     - kill 子进程；清理 tmp（`rmSync recursive force`）。
  2. 审批 fail-closed 用例：同一 smoke 里第二个场景——写临时 settings（`tmp/.omp/agent/config.yml` 或 env 指定 `tools.approvalMode`? 简化：宿主默认 yolo 即可测直通；prompt 路径属人工验证，不进自动化）。
     - 注：rpc 模式无 TUI → 默认 yolo 时 read 直通。若宿主默认非 yolo（用户配置），本测试用隔离 HOME 不受影响。
  3. 断言失败 `process.exit(1)`；成功打印 "SMOKE OK"。
- **Acceptance**
  - `bun test/smoke.mts` 在本机全绿（会真的起一个 omp 子进程，需网络无关：模型解析不要求在线——工具调用不经 LLM）。
  - 若宿主 `omp` 二进制不在 PATH：脚本内 `const OMP = process.env.OMP_BIN ?? "omp"` 并文档说明。

### T8 — README 与人工验证清单

- **Files**：`README.md`（新建）
- **Change**
  1. 安装：`ln -s <repo>/extensions/a2a-bridge.ts ~/.omp/agent/extensions/a2a-bridge.ts`（或 npm 包形式：`pi install pi-a2a-ext`，若将来发布）。
  2. 宿主侧：启动 omp → notify 里抄 URL/token；`/a2a` 查看；`/a2a rotate` 轮换。
  3. 远程侧 mcp.json 示例（HTTP + Bearer）。
  4. 跨机：`ssh -L <port>:127.0.0.1:<port> user@host` 一行；显式 `host:0.0.0.0` 需自行防火墙。
  5. 人工验证清单（TUI 审批）：宿主 TUI + `bash` 工具策略 prompt → 远程 tools/call bash → 宿主弹窗 Approve/Deny → 结果回传。
  6. 安全说明：token 即信任凭证；默认回环；风险声明（桥接环）。
- **Acceptance**：README 步骤可被照做；`bun test/smoke.mts` 仍绿。

### T9 — 收尾：git + brain + 回归

- **Change**
  1. `git add -A && git commit`（信息：`feat: omp-as-MCP-server a2a bridge (extensions + src + smoke)`）。
  2. brain：`brain append-timeline --id a2a-mcp-bridge --kind decision --summary "spec approved; implementation plan written; zero-dep hand-written JSON-RPC server on Bun.serve"`。
  3. 重跑 `bun test/smoke.mts` 确认。
- **Acceptance**：提交存在；brain 时间线有新条目；smoke 绿。

## 依赖图

```
T1 ─▶ T2 ─▶ T3 ─▶ T4 ──┐
      │            │    │
      └────────────┴─▶ T5 ─▶ T6 ─▶ T7
                              │
                              ├─▶ T8
                              └─▶ T9
```

- T4 定义 `McpTool`/`McpContent`/`BridgeDeps` 契约，T5 消费。
- T6 依赖 T2–T5 全部；T7 依赖 T6；T8/T9 依赖 T6 后。
- T1–T5 相互独立可并行（T4/T5 契约已在此固定）。

## 实施注意（避开已探明的坑）

- `AgentRegistry.global().get("Main")` 在 `session_start` 回调触发时已注册（SDK 注册先于会话事件），无需等待。
- `tool.execute` 的 `ctx` 必须含 `settings`（否则 wrapper 按默认 yolo 判定，用户 prompt 策略失效）；`autoApprove` 不设（undefined 即不强制）。
- `crypto.randomUUID` 用 `node:crypto` 导入（Bun 全局也有，但显式导入更稳）。
- 扩展文件被宿主 Bun 直接 import，`src/` 用相对路径 import（`../src/server.ts`），带 `.ts` 扩展名（allowImportingTsExtensions）。
- `toolWireSchema` 若 import 失败不要硬失败：fallback 直接传 parameters。冒烟会覆盖 read 的 schema 是否可用。
- 不要在扩展里 `console.log` 到 stdout（宿主 stdout 归协议/UI 用）；信息走 `ctx.ui.notify`。
- 宿主工具内容块类型：`TextContent`（`{type:"text",text}`）与 `ImageContent`（`{type:"image",data,mimeType}`）——映射按此两个判别分支。
