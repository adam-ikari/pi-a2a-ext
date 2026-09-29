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
- 除宿主工具外，桥自己也贡献 6 个 `a2a_file_*` 工具（双向文件传输，见「文件传输」）：目录追加在宿主工具之后，与宿主同名时宿主优先，同样受 `deny` 约束。
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
{ "port": 0, "token": "<base64url 32B>", "host": "127.0.0.1", "deny": [], "denyMCPTools": false, "maxFileBytes": 104857600 }
```

| 字段 | 含义 |
| --- | --- |
| `port` | `0` = 随机端口；写具体数字则固定 |
| `token` | Bearer token，首次启动自动生成 |
| `host` | 监听地址，默认 `127.0.0.1`（改成 `0.0.0.0` 会额外告警） |
| `deny` | 不暴露的工具名列表 |
| `denyMCPTools` | `true` 时排除所有 `mcp__` 前缀工具 |
| `fileRoot` | 文件传输的沙箱根，缺省 `~/.omp/a2a-bridge-files`（与配置/审计同 `~/.omp` 但**不同目录**）。要改写就写**绝对路径**，配置里不展开 `~` |
| `maxFileBytes` | 单文件大小上限，默认 `104857600`（100MB），允许范围 1KB–1GB |

环境变量 `A2A_BRIDGE_CONFIG` 可覆盖配置文件路径；`A2A_BRIDGE_AUDIT` 可覆盖审计日志路径。

校验是 **fail-closed** 的：字段类型非法（`port` 非整数/越界、`deny` 非字符串数组、`denyMCPTools` 非布尔、`host` 非非空字符串、`fileRoot` 非绝对路径、`maxFileBytes` 非整数或越界）时扩展拒绝启动并报错，不会带着错误的暴露面继续跑。唯一的例外是 `token`：缺失或非法时自动生成并**写回配置**，保证跨重启稳定。

配置文件的其他改动（如 `deny`）在**下次重启宿主**后生效；运行中只想换 token 用 `/a2a rotate`（立即生效，旧 token 即刻作废）。

### 命令

宿主会话内：

- `/a2a` — 显示当前监听地址、端口、token 前缀、文件沙箱根与大小上限（沙箱不可用时显示 `files disabled`）
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

## 文件传输

桥自带 6 个 `a2a_file_*` 工具，双向搬运文件：远程 → 宿主（push）与宿主 → 远程（pull）。它们和宿主工具走同一条 `tools/list` / `tools/call` 管线，因此复用同一套鉴权、会话、`deny` 门禁与审计；**没有新增 JSON-RPC 方法**。线格式采用 A2A FilePart 的 `{name, mimeType, bytes(base64)}`。

- 远程侧工具名形如 `mcp__omp-host__a2a_file_put`（前缀取决于 `mcp.json` 里的服务名）。
- 所有 `path` 相对 `fileRoot`（沙箱根，启动时创建为 `0700`），**不是**宿主文件系统路径。写入一律原子落盘（先写 `fileRoot/.tmp/<uuid>.part` 再 `rename`），文件权限 `0600`。
- 单文件上限 `maxFileBytes`（默认 100MB）。内联/单块 base64 解码后 ≤ 512KiB，单次读取响应 ≤ 256KiB：

```text
# 小文件（≤512KB）一次写完
a2a_file_put { "path": "inbox/note.md", "file": { "mimeType": "text/markdown", "bytes": "<base64>" } }

# 大文件分块（100MB ≈ 200 块），seq 从 0 起必须连续
a2a_file_put_start { "path": "bulk/data.tar", "totalBytes": 1048576 }   -> { "transferId": "..." }
a2a_file_put_chunk { "transferId": "...", "seq": 0, "bytes": "<base64>" }
a2a_file_put_end   { "transferId": "..." }                              -> { "path", "bytes", "sha256" }

# 读取（翻页直到 eof）
a2a_file_get { "path": "bulk/data.tar", "offset": 0, "limit": 262144 }  -> { "bytes", "totalBytes", "eof" }
a2a_file_list { "path": "inbox" }                                       -> { "entries": [...] }
```

- 失败一律是 `isError: true` + 文本 `a2a_file_error <code>: <message>`，`<code>` 是稳定枚举（`invalid_path` `escapes_root` `symlink_refused` `not_found` `is_a_directory` `already_exists` `too_large` `bad_base64` `bad_chunk_order` `unknown_transfer` `size_mismatch`）。协议细节（分块状态绑定会话、30 分钟空闲回收、上限）见 [docs/protocol.md](docs/protocol.md)「桥自带工具」。
- `deny` 对这些工具同样生效：`"deny": ["a2a_file_put", "a2a_file_put_start", "a2a_file_put_chunk", "a2a_file_put_end"]` 即可只留读、不留写。想整体关掉文件传输，把 6 个名字全 deny 掉。

## 安全与边界

- **token 即工具执行全权（默认配置下）**：宿主默认 `approvalMode: yolo`，拿到 token 就可在宿主会话里直接执行任意暴露的工具（含 `bash`），不经过任何审批；只有宿主把工具配成 `prompt` 才有审批门可拦（无 UI 时见审批节）。配置文件保持 `0600`，不要进版本库。
- **桥自带工具（文件传输）不经宿主审批门**：`a2a_file_*` 不是宿主工具，`tools.approval` 对它们无效——拿到 token 就等于拿到 `fileRoot` **内部**的读写权（这是设计取舍：换取复用同一条管线）。边界由沙箱兜住：路径拒绝绝对路径、`..`、NUL、控制字符、`.` 段；最深存在祖先做 `realpath` 后必须仍在 `fileRoot` 内；目录内符号链接既不顺着读也不顺着写（`symlink_refused`）；`fileRoot` 本身不得是符号链接，且不得是配置文件或审计日志的祖先目录（否则启动即失败）。
- **pull 回来的字节会进远程上下文**：`a2a_file_get` 的 base64 是工具结果，会进入远程模型的会话历史。协议支持 100MB，但大二进制建议走 SSH/`scp` 旁路，别用这条通道。
- 默认仅回环监听；真要对外暴露，防火墙自己负责。
- **暴露语义 = 会话工具注册表全集**：`tools/list` 直接来自 `pi.getAllTools()`（即 Main 会话注册表），因此包含 `hidden` 工具、也包含宿主模型当前被禁用的工具——这不是「宿主模型当前可见集合」的镜像。需要收紧就用 `deny` / `denyMCPTools`。
- **调用与列表同源**：`tools/call` 只接受出现在 `tools/list` 中的名字（deny 过滤之后），别名（如 `xd://bash`）和未列出的名字一律拒绝，且拒绝时不区分「被 deny」与「不存在」（不泄露名字是否存在）。deny 判定在 list 与 call 两侧各做一次。
- **会话强制**：除 `initialize` 外所有消息必须携带 `Mcp-Session-Id`（缺失 → 400，未知/空闲超 24h → 404）。会话上限 64 个，超出淘汰最久未用；每次命中刷新空闲计时。
- **审计日志**：每次远程 `tools/call` 写两条 JSONL——发起时 `{ts,id,sid,phase:"start",tool,args}`，完成时 `{ts,id,sid,phase:"done",tool,isError,args}`（同 `id` 配对；`sid` 为该调用的 `Mcp-Session-Id`，共享 token 下可把调用归因到客户端会话；参数摘要截断 1KB）到 `~/.omp/agent/a2a-bridge.log`，权限 0600，超过 512KB 轮转为 `.1`。**只有 `start` 没有 `done` = 调用已发起但未完成**（典型：无 UI 下挂起的审批）；轮转恰逢中途时，配对的两条可能分处 `.1` 与当前文件。日志写失败不影响调用。参数里超过 120 字符的字符串（文件 base64 正文）只记 `<len:N,sha256:前8位>`，日志不落载荷；`a2a_file_put_chunk` 完全不记（否则一次上传就是几百行），由 start/end 两条记录夹住整个传输。
- 端口被占用时回退到随机端口并告警（远程 `mcp.json` 需同步改端口）。

请求/响应格式、处理顺序、会话生命周期与错误码总表的完整 wire 契约见 [docs/protocol.md](docs/protocol.md)。

在线文档站（GitHub Pages，push 自动发布）：<https://adam-ikari.github.io/pi-a2a-ext/>

v1 边界：

- 只暴露工具（`tools/list` + `tools/call`），无 resources、无 prompts。
- 无 SSE 推送，无调用取消。
- 固定路由到宿主 `Main` 会话。
- 静态 Bearer token，无 OAuth。
- 无并发/速率限制。

## 故障排查

- **401 `unauthorized`**：token 不匹配。远程 `mcp.json` 的 `Authorization` 头必须与配置 `token` 一致；`/a2a rotate` 之后要同步改远程侧。
- **400 `missing mcp-session-id` / 404 `unknown session`**：除 `initialize` 外都要带会话头。会话是宿主进程内存态——宿主重启即全部失效、空闲超 24h 也回收；重新 `initialize` 拿新会话即可（正规 MCP 客户端库会自动处理）。
- **连不上 / 端口对不上**：宿主启动时配置端口被占用会回退到随机端口并在通知栏告警——以通知栏或 `/a2a` 显示的实际端口更新 `mcp.json`。
- **调用一直没有返回**：宿主无交互 UI 且该工具审批为 `prompt`（见「审批」）——命令不会执行但也不返回；调用方必须自设超时，审计日志里该调用只有 `start` 没有 `done`（见「安全与边界」的审计日志条目）。
- **500 `internal error`**：服务端内部故障；响应体固定不含细节（防泄露），真实原因在宿主 stderr，形如 `[a2a-bridge] internal error: …`。
- **改了配置不生效**：外部编辑 `a2a-bridge.json`（如 `deny`、`port`）需重启宿主；运行中只有 `/a2a rotate` 即时生效。
- **`bun test` 版本守卫失败**（开发）：`@oh-my-pi/pi-*` 实装与 pin/lock 失同步——`bun install` 恢复；`omp --version` 与 pin 不一致只告警，升级宿主时同步改 `package.json` 里的两个精确版本号。

## 开发

```sh
bun install

bun run typecheck     # 类型检查
bun run lint          # lint + 格式检查（Biome；修复用 bunx biome check --write .）
bun test              # 单测：test/*.test.ts（协议/鉴权/配置/暴露门/审计/版本守卫）
bun run test:smoke    # 真实 E2E（需本机 omp + ~/.omp/agent/models.yml，手动跑）
bun run test:hardening # 真实宿主加固核验，29 项（需本机 omp，手动跑）
bun run test:approval  # 审批边界判别探针，约 2 分钟（需本机 omp，手动跑）
bun run website        # 文档站（Docusaurus）本地预览 http://localhost:3000；首次先 cd website && bun install
```

各测试的覆盖面、真实宿主探针的前置条件与判读标准（含审批探针 VERDICT A/B/C 语义）见 [docs/testing.md](docs/testing.md)。

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

变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
