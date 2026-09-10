# A2A 桥设计：omp 作为 MCP 服务器（pi-a2a-ext）

日期：2026-09-10
状态：待评审
上游决策：BRAIN.md Q1（omp 宿主）、Q2（MCP 传输）、Q3（stdio 默认——**本 spec 修订为 HTTP，见下**）、Q4（TypeScript 插件）、Q5（只暴露工具）

## 1. 目标与范围

让远程 agent（典型：另一台机器或另一个目录里的 omp 实例）通过标准 MCP 协议，直接调用**当前正在运行的 omp 会话**的工具。

- 宿主 omp 进程内加载本扩展，起一个 Streamable HTTP MCP 服务器。
- 远程 omp 通过 `mcp.json` 的 `type: http` 连入，`tools/list` 看到宿主全部工具，`tools/call` 由宿主会话执行。
- 写/exec 类工具按宿主 `tools.approval` 策略执行：策略为 `prompt` 时触发宿主 TUI 实时审批弹窗；用户 Approve/Deny，结果原路返回远程。宿主默认 `yolo` 即直通（与本地调用语义一致）。

v1 不做：resources/prompts 暴露、server-to-client 进度通知（SSE）、调用取消、多会话路由（固定 `Main`）、OAuth（仅静态 Bearer token）。

### 对 BRAIN.md Q3 的修订

Q3 原结论「stdio 优先」。实施研究推翻：stdio 服务器必须独占 stdin/stdout，与运行中的 omp TUI 冲突；而审批转发到宿主 TUI、执行落在当前会话，都要求服务器与宿主同进程。结论改为：**v1 仅 Streamable HTTP（127.0.0.1 起步）**。本 spec 落定后同步更新 brain 页面。

## 2. 环境事实（已验证）

| 事实 | 来源 |
|---|---|
| 宿主 omp 18.1.16；扩展面 `@oh-my-pi/pi-coding-agent`，兼容别名 `@earendil-works/*` / `@mariozechner/*` 由 loader shim 解析 | 全局安装源码 `extensibility/plugins/legacy-pi-compat.ts`；superpowers 插件即 `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` |
| 宿主 MCP 客户端协议版本 `2025-11-25`，`Accept: application/json, text/event-stream`，纯 JSON 响应即满足；GET 长连接可选（405/非 2xx → 客户端静默忽略）；notification 接受 200/202 | `src/mcp/types.ts:168`、`src/mcp/transports/http.ts` |
| `pi.getAllTools()` 返回 `ToolInfo[]`：`{name, description, parameters, promptGuidelines?, sourceInfo}`，含核心+扩展+MCP 工具 | `extensibility/extensions/types.ts:700-706` |
| `AgentRegistry.global().get("Main").session` → `AgentSession`（公开 `settings`/`sessionManager`/`modelRegistry`/`model`）；`getToolByName(name)` 返回注册表工具（`session-tools.ts:410`） | `src/registry/agent-registry.ts` |
| `AgentToolContext`（`pi-agent-core` 经声明合并）= `CustomToolContext` 必备 `{sessionManager, modelRegistry, model, isIdle(), hasQueuedMessages(), abort()}` + 可选 `{settings, autoApprove, fetch, localProtocolOptions, ui?, hasUI?, toolCall?}` | `extensibility/custom-tools/types.ts:85-106`、`tools/context.ts:5-19` |
| 扩展 `ExtensionContext` 公开 `isIdle()/hasPendingMessages()/abort()/ui/hasUI/localProtocolOptions/modelRegistry` → 与 `session.*` 拼接即可构造完整 ctx | `extensibility/extensions/runner.ts:1160-1207` |
| `pi-ai` 的 `toolWireSchema(tool)` / `arkToWireSchema(schema)` 把 ArkType/TypeBox/JSON Schema 统一转 JSON Schema 2020-12 | `@oh-my-pi/pi-ai/src/utils/schema/wire.ts:585-609` |
| MCP SDK **未安装**；裸 Bun.serve 手写 JSON-RPC 即可满足已验证的协议面 | 全盘 find 无果 |

## 3. 架构

```
远程 omp                                         宿主 omp（装本扩展）
mcp.json: {type:"http", url, headers:{Authorization}}
  │                                              ┌────────────────────────────────────────┐
  │ POST /  initialize / tools/list / tools/call │ extensions/a2a-bridge.ts               │
  ├─────────────────────────────────────────────▶│  session_start → startServer(ctx)      │
  │ ◀── JSON-RPC responses (application/json)    │  ┌──────────────────────────────────┐  │
  │                                              │  │ server.ts  Bun.serve 127.0.0.1   │  │
  │                                              │  │  auth.ts   Bearer token 校验      │  │
  └──────────────────────────────────────────────│──│  bridge.ts  tools/list + call     │  │
                                                 │  └───────────────┬──────────────────┘  │
                                                 │  AgentRegistry.global().get("Main")    │
                                                 │    .session.getToolByName(name)        │
                                                 │    .execute(id, args, signal,          │
                                                 │             onUpdate, ctx)             │
                                                 │       │ 内建审批门 (ExtensionToolWrapper)
                                                 │       ▼  prompt → ctx.ui.select        │
                                                 │    宿主 TUI 弹窗 Approve / Deny        │
                                                 └────────────────────────────────────────┘
```

单进程、单文件入口 + 几个小模块。无 IPC、无子进程、无第三方依赖。

## 4. 模块

```
pi_a2a_ext/
  package.json                 # {"name":"pi-a2a-ext","pi":{"extensions":["./extensions/a2a-bridge.ts"]}}
  extensions/a2a-bridge.ts     # 唯一入口：默认导出 (pi: ExtensionAPI) => void
  src/
    config.ts                  # 读写 ~/.omp/agent/a2a-bridge.json；token 生成/持久化
    auth.ts                    # token → 请求头校验（常数时间比较）
    server.ts                  # Bun.serve + JSON-RPC 路由（initialize/tools/list/tools/call/ping）
    bridge.ts                  # 工具目录（getAllTools+deny → MCP tool）与执行（Main session → tool.execute）
  test/smoke.mts               # 无头 E2E 冒烟（§8）
```

### 4.1 入口 `a2a-bridge.ts`

- `pi.on("session_start", ...)`：加载配置（无则创建含随机 token 的默认配置），`startServer()`，`ctx.ui.notify` 显示 URL + token 摘要。`pi.on("session_shutdown", ...)` → `server.stop()`。`session_tree` 不处理：ctx 每次 `tools/call` 现取 `Main.session`，树切换无需重启服务器。
- 注册命令 `/a2a`（`pi.registerCommand`）：`status`（打印 URL/token/端口/已服务调用数）与 `rotate`（重生成 token 写回配置）。
- 端口占用 → 回退随机端口（配置里 `port: 0` 即随机）。

### 4.2 工具目录（tools/list）

数据源 `pi.getAllTools()`（全部列出——`ToolInfo` 无 availability 字段，不可用 MCP 工具自然不在注册表里）：

```ts
{
  name: t.name,
  description: t.description ?? "",
  inputSchema: jsonSchemaOf(t.parameters),   // 统一转 JSON Schema 2020-12（§2 最后一行）
}
```

- 配置 `deny: string[]`：列出的工具从 `tools/list` 消失；`tools/call` 同名请求也返回 `isError`（防绕过，即使期间 `getAllTools` 变化）。
- schema 转换只发生一次/工具，按工具名缓存；`tools/list` 每次重扫名单（成本低），schema 缓存按 `(name)` 失效即可（工具重建罕见且无害）。

### 4.3 执行（tools/call）

```ts
async function callTool(name, args, extCtx) {
  if (denied(name)) return err(`tool '${name}' is not exposed by this bridge`);
  const ref = AgentRegistry.global().get("Main");
  if (!ref?.session) return err("main session not available");
  const session = ref.session;
  const tool = session.getToolByName(name);
  if (!tool) return err(`unknown tool '${name}'`);
  const ctx = {
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
  };   // 全公开面拼装（§2 表），类型与 AgentToolContext 对齐
  try {
    const r = await tool.execute(randomUUID(), args, undefined, undefined, ctx);
    return { content: toMcpContent(r), isError: !!r.isError };
  } catch (e) { return err(e.message); }  // 审批 deny / 执行错误统一走 isError
}
```

- **审批复用宿主门**：注册表工具即 `ExtensionToolWrapper`；ctx 携带真实 `settings`（`session.settings`，与宿主同源）+ 扩展 `ui`，则：
  - `approvalMode: yolo`（默认）→ 直通；
  - 策略 `prompt` → wrapper 内部 `ui.select` 弹宿主 TUI，用户按键后继续——**桥不写任何审批逻辑**；
  - 宿主无 TUI（print/rpc 模式）→ wrapper fail-closed 抛错，返回 `isError`。
- 取消：v1 `signal` 传 `undefined`（wrapper 对 `signal: undefined` 安全）。
- 结果映射：`content[]` 的 `text` → `{type:"text",text}`；`image` → `{type:"image",data,mimeType}`；未知块转 text。`isError` 透传为 MCP result 的 `isError`。
- 并发：多次 `tools/call` 并行时无共享状态；审批弹窗由宿主 UI 队列天然串行化。

### 4.4 server.ts（协议面，对齐 §2 已验证客户端行为）

- `POST /`：解析 JSON-RPC。鉴权失败 → HTTP 401（不泄露原因差异）。
  - `initialize` → `{protocolVersion: 客户端请求值（缺省 "2025-11-25"）, capabilities:{tools:{}}, serverInfo:{name:"omp-a2a-bridge", version}}`，响应头 `Mcp-Session-Id`（随机生成，内存记录，后续请求校验匹配）。
  - `notifications/initialized` → 202 空体。
  - `tools/list` → `{tools:[...]}`（不带 `nextCursor`：客户端 do-while 分页遇缺省即止，`mcp/client.ts:233-244`）。
  - `tools/call` → `{content, isError}`。
  - `ping` → `{}`。其余方法 → JSON-RPC `-32601`。
- `GET /` → 405（客户端静默跳过 SSE；§2 已验证）。`DELETE /` → 204（可选会话注销）。
- 响应一律 `application/json`。未知/过期 `Mcp-Session-Id` → 404（规范行为，触发客户端重建会话）。
- 绑定 `127.0.0.1` 默认；`host` 配置显式改 `0.0.0.0` 时启动 notify 打安全警告。
- 单请求体上限 1 MB（超出 → 413/400）。工具执行不设桥级超时（长任务如 build 由工具自身控制；阻断型审批由宿主 UI 超时兜底）。

### 4.5 config.ts

`~/.omp/agent/a2a-bridge.json`（0600）：

```json
{ "port": 0, "token": "<base64url 32B，首次启动生成>", "host": "127.0.0.1", "deny": [], "denyMCPTools": false }
```

- token 生成：`crypto.getRandomValues(32B)` → base64url；文件不存在则创建。
- 远程配置示例（写入 README 段与 notify 文本）：
  `{"omp-host":{"type":"http","url":"http://<host>:<port>/","headers":{"Authorization":"Bearer <token>"}}}`

## 5. 错误模型

| 层 | 情形 | 返回 |
|---|---|---|
| HTTP | token 缺失/错误 | 401 |
| HTTP | 方法不是 POST/GET/DELETE | 405 |
| HTTP | body 非 JSON-RPC / 超限 | 400 + JSON-RPC error |
| JSON-RPC | 未知 method | -32601 |
| MCP | 工具不存在 / 被 deny / 会话不可用 | result.isError=true + 文本 |
| MCP | 审批 deny（宿主拒绝）/ 执行抛错 | result.isError=true + 错误文本 |
桥自身不实现 approve/deny 路径（§4.3 宿主门接管），错误文本原样透传（含 wrapper 的 `"Tool call denied by user: ..."`）。

## 6. 安全边界

- 默认仅绑回环；远程机需 SSH 端口转发（README 给一行命令）或显式 `host:0.0.0.0`+防火墙自管。
- 静态 Bearer token，常数时间比较；`rotate` 即时生效。token 仅出现在启动 notify 与配置文件（0600）。
- v1 无 per-remote 身份区分：能拿到 token = 能触发该工具的宿主审批。审批门是最后防线，默认语义继承宿主 `tools.approvalMode`。
- MCP 工具（`mcp__server__tool`）也在 `getAllTools()` 内，存在桥接环风险（远程把本桥再注册、宿主再连回它）。默认**暴露**（全量原则），文档声明；`denyMCPTools: true` 可整体排除。

## 7. 失败模式与恢复

- `Main` parked/session null → §5 错误行（远程 agent 可读文本）。
- 宿主退出：进程死、连接断——远程 MCP 客户端自身处理重连；**不做**跨重启会话保持（设计如此，非缺陷）。
- 端口被占：启动期重试随机端口 ≤3 次，仍失败 → notify 报错，桥不启动，宿主会话不受影响。
- 工具数组热更新（`/model`、xdev 切换）：每次 `tools/list` 重扫；`tools/call` 按当下注册表解析（调用瞬间不存在 = 错误）。

## 8. 测试

`test/smoke.mts`（无头、确定性、不碰用户配置——env `A2A_BRIDGE_CONFIG` 指向临时文件）：

1. 真实 E2E：临时 `HOME`（`.omp/settings.json` 指向本扩展）+ env `A2A_BRIDGE_CONFIG` 指向临时配置文件；起宿主 `omp --mode rpc`（保持会话存活，stdin 喂最小 prompt）一次性进程加载本扩展；从临时配置文件读取 URL/token。桥在宿主进程内跑，`tools/call` 落在真实 `Main` 会话——无 fake stub。
2. 裸 `fetch` 当 MCP 客户端：`initialize`（断言 protocolVersion/会话头）→ `notifications/initialized`(202) → `tools/list`（断言含 `read`、不含 deny 项）→ `tools/call read <tmpfile>`（断言 text 匹配）→ `tools/call` 未知名（断言 isError）→ 401（无 token）→ `-32601`（未知 method）。
3. 审批策略：宿主 settings `tools.approval: {write: prompt}` + `--mode rpc`（无 TUI）→ 断言 `tools/call write` 返回 isError 含 fail-closed 文本；默认 `yolo` → `read` 直通。
4. TUI 弹窗路径为**人工验证**（README 步骤）：宿主 TUI + `bash: prompt` 策略 + 远程 `tools/call bash` → Approve 执行 / Deny 返回拒绝。

## 9. 实现顺序

1. `config.ts` + `auth.ts`（纯函数，先测）。
2. `server.ts` 骨架：`initialize`/`ping`/错误码/鉴权。
3. `bridge.ts`：`tools/list`（schema 转换接入 `toolWireSchema`）。
4. `bridge.ts`：`tools/call`（getAllTools→Main session→execute→内容映射）。
5. `extensions/a2a-bridge.ts` 接线（session 生命周期、`/a2a` 命令、通知打印）。
6. `test/smoke.mts` 全绿；README（安装、远程 mcp.json、SSH 转发示例）。
7. 完成后 `git commit`，更新 brain 页面（Q3 修订 + 架构页），回归冒烟。

## 10. 明确非目标（v1）

- 不是 A2A/Agent2Agent 协议实现——传输是 MCP，语义是工具级代理。
- 不把宿主 LLM/模型暴露给远程（「宿主不调用 LLM API」是目标，不是疏漏）。
- 不做多会话/子 agent 路由，固定 `Main`。
- 不做 OAuth/动态凭证、不做 TLS（回环默认）。
- 不做 SSE 推送、进度通知、调用取消（客户端超时兜底）。