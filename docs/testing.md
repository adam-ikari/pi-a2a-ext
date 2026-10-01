# 测试与核验

## 总览

| 命令 | 类型 | 需要本机 omp | 预期输出 |
| --- | --- | --- | --- |
| `bun test` | 单测（自动发现 `test/*.test.ts`） | 否 | 54 pass / 0 fail（5 文件） |
| `bun run test:smoke` | 真实宿主 E2E | 是 | `SMOKE OK` |
| `bun run test:hardening` | 真实宿主加固核验，29 项 | 是 | `HARDEN OK` |
| `bun run test:approval` | 审批边界判别核验，约 2 分钟 | 是 | `VERDICT: B`（预期），exit 0 |
| `bun run test:install` | 跨机器安装核验，26 项 | 是 | `INSTALL OK` |

统一前置（E2E 四件套）：PATH 上有 `omp`（或设 `OMP_BIN`）；真实 `~/.omp/agent/models.yml` 存在（拷进临时 HOME，仅此一项与真实 HOME 共享）。四者都在**隔离临时 HOME** 里启动宿主：软链本仓库扩展、独立配置与审计路径、跑完即删（核验失败时保留现场目录并在 stderr 打印路径）。提交前基线：`bun run lint` + `bun run typecheck` + `bun test` 三绿。

## `test:install` — 跨机器安装核验（26 项）

**唯一验证「任意机器可装」的核验**。`test:smoke` 自己把扩展软链进沙箱 agentDir，证明桥可用，但完全不碰安装链路；本核验走 `omp install <git-url>` 的真实路径。

用独立 `HOME` 模拟另一台机器（除 `models.yml` 外一无所有），分组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| 安装 | 5 | 装进新机器的插件目录；manifest 带 `version`（否则 omp 显示 `@undefined`）；manifest 声明 `pi.extensions`（加载开关）；包内含 `src/` 与 `extensions/`（入口 import 的是 `../src/*.ts`，缺一则装上也起不来） |
| 启动 | 4 | 宿主广播桥地址；首次启动自建 config 与该机器专属 token |
| MCP 握手 | 4 | HTTP `initialize` 成功并签发会话；协商 2025-11-25；广播的 URL 正是远程客户端要连的那个；`tools/list` 只含宿主工具 |
| 沙箱边界 | 4 | `.tmp` 不可寻址；宿主 fs 错误带 code；不泄露宿主路径；并发同 seq 只写一份 |
| 鉴权 | 2 | 无 token → 401；无会话头 → 400 |
| 审计 | 4 | 该机器上生成审计日志；start/done 配对；记录带 `sid`；不含原始 base64 |

默认装 `https://github.com/adam-ikari/pi-a2a-ext.git`，可用 `A2A_INSTALL_SPEC` 换成本地路径或 `.` 以测开发态。全过 → `INSTALL OK`；任何一项不过 → `FAIL: <label>` + exit 1。

**写这些核验脚本时踩的两个坑（均为 harness 自身缺陷，非产品缺陷，但会让核验给出假阴性）**：

- `omp --mode rpc --print "<prompt>"` 跑完一轮即退出，**桥随之消失**，远程调用得到 `ConnectionRefused`。须用 `omp --mode rpc` 不传 prompt、stdin 保持打开。
- 以 `proc.exitCode === null` 作轮询条件，会在最后一个 stdout 分片送达前提前退出，把「桥正常」误报为「桥没起来」。**最终改为直接 HTTP 探测**（真实客户端的做法），不再刮 stdout——`test:smoke` 一直是这么做的，所以没踩到。

## 单测矩阵（54 用例）

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `server.test.ts` | 20 | 鉴权放置（无/错 token 401、未鉴权 DELETE 401）、initialize 固定版本与会话签发、不回显客户端版本、会话强制（缺头 400、通知缺头 400、未知 404、TTL 刷新与过期清理、上限淘汰、DELETE 204 后即失效）、tools/list 无游标、tools/call 往返与抛错仍 200、未知方法 -32601、GET 405、非法 JSON / 非法 jsonrpc / batch 均 400 |
| `auth.test.ts` | 11 | Bearer 解析、scheme 大小写、其他 scheme 拒绝、缺失/空凭据、等长同内容/异内容、**异长不抛异常**（timing-safe 的长度前置） |
| `config.test.ts` | 12 | 缺文件默认值、round-trip、保存 0600、未知字段忽略、坏 JSON/非对象带路径抛错、port/host 类型或区间非法均 fail-closed、token 缺失/非法自愈并持久、token 32B base64url 且唯一 |
| `bridge.test.ts` | 7 | 目录（**注册表原样透传不过滤**、每次调用重读以纳入动态工具）、暴露门（目录外的名字/别名一律 `not exposed`、无 Main 会话清晰报错）、审计（dispatch 写 start + 完成写 done 按 id 配对、被拒调用两相齐全、sid 归因、超长参数落盘为 `<len:N,sha256:…>` 且原始载荷不出现） |
| `versions.test.ts` | 4 | 版本守卫：pi-* devDep 必须精确版本（无 `^`/`~`）、实装 == pin（硬断言）、两 pin 一致、`omp --version` ≠ pin 仅告警（omp 缺失时跳过） |

审计断言通过 `A2A_BRIDGE_AUDIT` 沙箱化，单测不会写真实 `~/.omp`。

## `test:smoke` — 真实宿主 E2E

启动真实 `omp --mode rpc`（加载本扩展），用裸 `fetch` 走完整 MCP 流程：

1. `initialize` → `protocolVersion` + `mcp-session-id` 响应头；
2. `notifications/initialized` → 202；
3. `tools/list` 含 `read`（并打印全量数量）；
4. **`tools/call read` 落到真实 `Main` 会话**，结果必须含载荷文件首行内容；
5. 未知工具 → `isError: true`；无 token → 401；未知方法 → `-32601`。

任一步不符 → `FAIL: …`（附宿主 stdout/stderr 尾部）+ exit 1；全过 → `SMOKE OK`。

## `test:hardening` — 加固核验（29 项）

配置种子**故意不带 token**（验证自愈）。29 项分组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| token 自愈 | 2 | 生成 43 字符 base64url（32B）并持久化；配置 0600 |
| 版本协商 | 3 | initialize → `2025-11-25`；签发会话头；请求 `1999-01-01` 仍答服务器版本 |
| 会话强制 | 4 | 带会话通知 202；通知缺头 400；请求缺头 400；伪造会话 404 |
| 鉴权放置 | 4 | 无 token 401；错 token 401；**未鉴权 DELETE 401**；会话在未鉴权 DELETE 后仍存活 |
| JSON-RPC 校验 | 4 | GET 405；坏 JSON 400；`jsonrpc: "1.0"` 400；batch 400 |
| 暴露门 | 4 | 目录含 `read`；无桥自带工具（`a2a_file_*` 一个都没有）；未注册名调用 → `isError` + `not exposed`；别名 `xd://read` 同样拒绝 |
| 真实执行 | 1 | `tools/call read` 在 Main 会话读回文件内容 |
| 审计 | 5 | `read` 的 start/done 双相；被拒的调用也有 start；所有 done 能按 id 配对到 start；**记录携带 `sid`（归因）**；审计文件 0600 |
| 会话终止 | 2 | 已鉴权 DELETE → 204；随后请求该会话 → 404 |

全过 → `HARDEN OK`；任何一项不过 → `FAIL: <label>` + exit 1（并打印宿主日志尾部）。

## `test:approval` — 审批边界判别核验

**要回答的问题**：宿主无交互 UI（rpc 模式）时，`prompt` 档的 `tools/call`（bash）到底是什么行为？

做法：以 `--approval-mode=always-ask` 启动隔离宿主 → 自愈拿 token → initialize → 先用 `read`（always-ask 自动放行只读工具）确认服务器活着 → 再发决定性的 `bash` 调用（副作用为临时目录里的 `touch <file>`，客户端 90s 超时）→ 检查副作用文件 → ping 存活 → 审计日志配对检查。

### 判读（VERDICT）

| 判定 | 观察 | 含义 | 退出码 |
| --- | --- | --- | --- |
| **A** | 快速返回 `isError`，无副作用 | 行为已回归为 fail-closed —— **需要更新 README 审批节**（文档落后于实现） | 0 |
| **B（预期）** | 挂起 ≥90s 被客户端中止，无副作用，ping 仍 200，`read` 仍可用，审计 `start` 有 `done` 无 | 命令**没有执行**（安全意义上 fail-closed），但调用方收不到答复——调用方必须自设超时；即 README 审批节所记行为 | 0 |
| **C** | 副作用文件存在 | **FAIL-OPEN（最坏情况）**：prompt 策略在无 UI 模式下被绕过 | 1 |
| UNEXPECTED | 返回了但不是 `isError` | 非预期返回形态 | 1 |
| 审计不可见 | 无 start 记录；或判 B 却有 done | 派发期审计被破坏 | 1 |

setup 失败（token 自愈超时、服务器起不来等）→ exit 1，stderr 打印宿主日志尾部。**失败时临时目录保留**（`evidence kept at <path>`）供事后检查；成功才清理。

## 约定

- `test/*.test.ts` 被 `bun test` 自动发现；核验脚本（`smoke.ts` / `hardening.ts` / `approval-probe.ts`）故意不带 `.test` 后缀，只能手动跑，避免 CI/本地把真实宿主进程拉起来。
- 环境变量：`OMP_BIN`（宿主二进制）、`REPO`（仓库根，脚本默认自推导）、`A2A_BRIDGE_AUDIT`（审计路径沙箱）。
- 判定性结论（如审批挂起语义）必须由核验复核，不以源码阅读或推理代替——这是本仓库评审沉淀的规矩。
