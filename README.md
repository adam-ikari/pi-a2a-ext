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

配置文件 `~/.omp/agent/a2a-bridge.json`，首次启动自动生成，权限 `0600`（创建时即 0600，无权限窗口）：

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

环境变量 `A2A_BRIDGE_CONFIG` 可覆盖配置文件路径；`A2A_BRIDGE_AUDIT` 可覆盖审计日志路径。

校验是 **fail-closed** 的：字段类型非法（`port` 非整数/越界、`deny` 非字符串数组、`denyMCPTools` 非布尔、`host` 非非空字符串）时扩展拒绝启动并报错，不会带着错误的暴露面继续跑。唯一的例外是 `token`：缺失或非法时自动生成并**写回配置**，保证跨重启稳定。

配置文件的其他改动（如 `deny`）在**下次重启宿主**后生效；运行中只想换 token 用 `/a2a rotate`（立即生效，旧 token 即刻作废）。

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

- 宿主默认 `approvalMode` 为 `yolo` → 直通，没有审批环节。
- 若宿主把某个工具在 `tools.approval` 配成 `prompt`，且宿主有交互 UI（TUI），远程调用会弹 Approve/Deny，用户确认后继续，结果原路返回。
- 宿主无交互 UI 时（rpc 模式实测；print 同为无 UI 路径，未实测），`prompt` 类审批**不会执行命令，但也不返回**：请求一直挂起（实测 ≥90s），宿主在等一个永远不会出现的 UI 应答。**调用方必须自设超时**；挂起的调用会在审计日志留下 `start` 记录而无配对的 `done`（见下），可据此发现。

## 安全与边界

- **token 即工具执行全权（默认配置下）**：宿主默认 `approvalMode: yolo`，拿到 token 就可在宿主会话里直接执行任意暴露的工具（含 `bash`），不经过任何审批；只有宿主把工具配成 `prompt` 才有审批门可拦（无 UI 时见审批节）。配置文件保持 `0600`，不要进版本库。
- 默认仅回环监听；真要对外暴露，防火墙自己负责。
- **暴露语义 = 会话工具注册表全集**：`tools/list` 直接来自 `pi.getAllTools()`（即 Main 会话注册表），因此包含 `hidden` 工具、也包含宿主模型当前被禁用的工具——这不是「宿主模型当前可见集合」的镜像。需要收紧就用 `deny` / `denyMCPTools`。
- **调用与列表同源**：`tools/call` 只接受出现在 `tools/list` 中的名字（deny 过滤之后），别名（如 `xd://bash`）和未列出的名字一律拒绝，且拒绝时不区分「被 deny」与「不存在」（不泄露名字是否存在）。deny 判定在 list 与 call 两侧各做一次。
- **会话强制**：除 `initialize` 外所有消息必须携带 `Mcp-Session-Id`（缺失 → 400，未知/空闲超 24h → 404）。会话上限 64 个，超出淘汰最久未用；每次命中刷新空闲计时。
- **审计日志**：每次远程 `tools/call` 写两条 JSONL——发起时 `{ts,id,phase:"start",tool,args}`，完成时 `{ts,id,phase:"done",tool,isError,args}`（同 `id` 配对，参数摘要截断 1KB）到 `~/.omp/agent/a2a-bridge.log`，权限 0600，超过 512KB 轮转为 `.1`。**只有 `start` 没有 `done` = 调用已发起但未完成**（典型：无 UI 下挂起的审批）；轮转恰逢中途时，配对的两条可能分处 `.1` 与当前文件。日志写失败不影响调用。
- 端口被占用时回退到随机端口并告警（远程 `mcp.json` 需同步改端口）。

v1 边界：

- 只暴露工具（`tools/list` + `tools/call`），无 resources、无 prompts。
- 无 SSE 推送，无调用取消。
- 固定路由到宿主 `Main` 会话。
- 静态 Bearer token，无 OAuth。
- 无并发/速率限制。

## 开发

```sh
bun install

bun run typecheck     # 类型检查
bun test              # 单测：test/*.test.ts（协议/鉴权/配置/暴露门/审计/版本守卫）
bun run test:smoke    # 真实 E2E（需本机 omp + ~/.omp/agent/models.yml，手动跑）
bun run test:hardening # 真实宿主加固核验，28 项（需本机 omp，手动跑）
bun run test:approval  # 审批边界判别探针，约 2 分钟（需本机 omp，手动跑）
```

依赖说明：`@oh-my-pi/pi-coding-agent` 与 `@oh-my-pi/pi-ai` 以**精确版本**固定在 `devDependencies`，与宿主 omp 版本保持一致，仅用于类型检查与单测。**运行时不要从 `node_modules` 加载它们**——宿主 omp 的 `omp:legacy-pi-shim` 会把这些 import 重定向到宿主内嵌的同一份模块，`AgentRegistry.global()` 这类模块级单例才能共享；升级 omp 时同步改这两个版本号；`bun test` 内置**版本守卫**：实装 devDep ≠ pin 直接失败，`omp --version` ≠ pin 时告警。

文件布局：

| 路径 | 职责 |
| --- | --- |
| `extensions/a2a-bridge.ts` | 扩展入口，`session_start` 起服务器，注册 `/a2a` |
| `src/server.ts` | `Bun.serve` + JSON-RPC（MCP 2025-11-25，纯 JSON 响应）、会话与版本协商 |
| `src/bridge.ts` | 工具目录与执行（`pi.getAllTools` / AgentRegistry Main 会话）、暴露交集判定 |
| `src/config.ts` | 配置加载/保存、字段校验、token 生成、deny 判定 |
| `src/auth.ts` | Bearer token 校验（timing-safe 比较） |
| `src/audit.ts` | 远程调用审计日志（JSONL 两阶段 `start`/`done`，轮转） |
