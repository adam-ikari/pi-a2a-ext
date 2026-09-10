# omp A2A Bridge

把运行中的 omp 变成一个 Streamable HTTP MCP 服务器：远程 omp 通过标准 MCP 协议直接调用宿主当前会话的工具，宿主不调用任何 LLM API。

## 工作原理

```
远程 omp (MCP client)                宿主 omp (MCP server)
  mcp__omp-host__read  --HTTP/JSON-RPC-->  src/server.ts   鉴权 + 协议
                                             |            (tools/list, tools/call)
                                             v
                             src/bridge.ts  pi.getAllTools / Main 会话 getToolByName
                                             |
                                             v
                                   宿主真实工具（read/bash/edit/...）
```

- 扩展在 `session_start` 时启动 `Bun.serve`，实现 MCP `2025-11-25` 的 `initialize` / `tools/list` / `tools/call`，响应为纯 JSON（无 SSE）。
- 工具目录来自宿主当前会话（`pi.getAllTools()`），执行固定路由到宿主 `Main` 会话的 `getToolByName`，因此走的是宿主原生工具实现。
- 远程调用不经过任何模型推理：宿主只做「收请求 → 跑工具 → 回结果」。

## 安装

二选一。

1. 软链到 omp 扩展目录：

```sh
ln -s "$PWD/extensions/a2a-bridge.ts" ~/.omp/agent/extensions/a2a-bridge.ts
```

2. 或把本仓库作为插件：`package.json` 已声明 `"pi": { "extensions": ["./extensions/a2a-bridge.ts"] }`。

启动宿主 omp 后，通知栏显示：

```
A2A bridge listening on http://127.0.0.1:<port> (token <前6字符>…)
```

`<port>` 是实际监听端口（默认随机）。

## 配置

配置文件 `~/.omp/agent/a2a-bridge.json`，首次启动自动生成，权限 `0600`：

```json
{ "port": 0, "token": "<base64url 32B>", "host": "127.0.0.1", "deny": [], "denyMCPTools": false }
```

| 字段 | 含义 |
| --- | --- |
| `port` | `0` = 随机端口；写具体数字则固定 |
| `token` | Bearer token，首次启动自动生成 |
| `host` | 监听地址，默认 `127.0.0.1`（改成 `0.0.0.0` 会额外告警） |
| `deny` | 不暴露的工具名列表 |
| `denyMCPTools` | `true` 时排除所有 `mcp__` 前缀工具 |

环境变量 `A2A_BRIDGE_CONFIG` 可覆盖配置文件路径。

### 命令

宿主会话内：

- `/a2a` — 显示当前监听地址、端口、token 前缀
- `/a2a rotate` — 轮换 token（写完配置后需同步更新远程 `mcp.json`）

## 远程连接示例

远程 omp 的 `mcp.json`：

```json
{
  "mcpServers": {
    "omp-host": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

连上后远程侧会看到 `mcp__omp-host__read`、`mcp__omp-host__bash` 之类的工具，直接调用即可。

## 跨机转发

默认只绑回环，不对外网开放。远程机做 SSH 端口转发：

```sh
ssh -L <localport>:127.0.0.1:<port> user@host
```

`mcp.json` 的 `url` 写 `http://127.0.0.1:<localport>/`。

## 审批

远程调用完全复用宿主的审批门（`ExtensionToolWrapper`），不额外开权限：

- 宿主默认 `approvalMode` 为 `yolo` → 直通。
- 若宿主把某个工具在 `tools.approval` 配成 `prompt`，远程调用会在宿主 TUI 弹 Approve/Deny，用户确认后继续，结果原路返回。
- 宿主无交互 UI（print / rpc 模式）时，`prompt` 类审批 fail-closed，返回 `isError`。

## 安全与边界

- token 即信任凭证：拿到 token 就能触发该工具的宿主审批流程。配置文件保持 `0600`，不要进版本库。
- 默认仅回环监听；真要对外暴露，防火墙自己负责。
- 暴露的工具是宿主当前会话的全集（含 `mcp__` 嵌套工具），需要收紧就用 `deny` / `denyMCPTools`。

v1 边界：

- 只暴露工具（`tools/list` + `tools/call`），无 resources、无 prompts。
- 无 SSE 推送，无调用取消。
- 固定路由到宿主 `Main` 会话。
- 静态 Bearer token，无 OAuth。

## 开发

```sh
bun install

bun x tsc -p tsconfig.json   # 类型检查
bun test/server_stub.ts      # 协议冒烟（stub 化 BridgeDeps，验 JSON-RPC 行为）
bun test/smoke.ts            # 真实 E2E
```

文件布局：

| 路径 | 职责 |
| --- | --- |
| `extensions/a2a-bridge.ts` | 扩展入口，`session_start` 起服务器，注册 `/a2a` |
| `src/server.ts` | `Bun.serve` + JSON-RPC（MCP 2025-11-25，纯 JSON 响应） |
| `src/bridge.ts` | 工具目录与执行（`pi.getAllTools` / `AgentRegistry` Main 会话） |
| `src/config.ts` | 配置加载/保存、token 生成、deny 判定 |
| `src/auth.ts` | Bearer token 校验（timing-safe 比较） |
