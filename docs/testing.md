# 测试与核验

## 总览

| 命令 | 类型 | 需要本机 omp | 预期输出 |
| --- | --- | --- | --- |
| `bun test` | 单测（自动发现 `test/*.test.ts`） | 否 | 54 pass / 0 fail（5 文件） |
| `bun run test:smoke` | 真实宿主 E2E | 是 | `SMOKE OK` |
| `bun run test:hardening` | 真实宿主加固核验，29 项 | 是 | `HARDEN OK` |
| `bun run test:approval` | 审批边界判别核验，约 2 分钟 | 是 | `VERDICT: B`（预期），exit 0 |
| `bun run test:install` | 发布包自包含核验，17 项 | 否 | `PACKAGE OK` |

统一前置（E2E 三件套）：PATH 上有 `omp`（或设 `OMP_BIN`）；真实 `~/.omp/agent/models.yml` 存在（拷进临时 HOME，仅此一项与真实 HOME 共享）。三者都在**隔离临时 HOME** 里启动宿主：软链本仓库扩展、独立配置与审计路径、跑完即删（核验失败时保留现场目录并在 stderr 打印路径）。提交前基线：`bun run lint` + `bun run typecheck` + `bun test` 三绿。

## `test:install` — 发布包自包含核验（17 项）

**核验发布的 tarball 装得上去、且装完就能加载。** 三组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| manifest | 6 | 有 `name`；有 `version`（否则 omp 显示 `@undefined`）；声明 `pi.extensions`（加载开关）；**无 runtime 依赖**（`@oh-my-pi/*` 由宿主 shim 提供）；`files[]` 同时含 `extensions/` 与 `src/` |
| 打包 | 3 | `npm pack` 出 tarball；体积 < 500KB（不含 `node_modules`）；解开是 `package/` 根 |
| 内容 | 8 | 入口 `extensions/a2a-bridge.ts` 与 5 个 `src/*.ts` 都在 tarball 里；从入口出发走**相对 import 图**，每个模块都能在包内解析到；确实走起来了（≥6 模块） |

第三组是关键：入口 import 的是 `../src/*.ts`，`files[]` 漏掉任何一个都会**装得上、加载时才炸**。逐个断言文件名会被新增的模块绕过，走 import 图才抓得到。

**这一版不启动宿主、不碰 MCP 端点。** 上一版两样都做，但**验的是错的对象**：宿主解析插件目录不受 `HOME` 影响，临时 HOME 并未隔离插件发现——宿主继续加载真实 `~/.omp/plugins` 里那份，于是每一条「新机器」断言其实都在重测那份陈旧副本。`XDG_DATA_HOME`、`OMP_PLUGIN_DIR`、改 `cwd` 都试过，没有一个能改变插件发现。实测证据：往假 HOME 装一个只会打印标记的扩展，标记没出现，真实那份的桥却起来了。

因此 **`omp install <git-url>` 的端到端（真机装 → 起宿主 → MCP 握手 → 文件往返）目前没有自动化覆盖**。恢复它要先搞清楚宿主的插件发现机制，那是独立任务；在这个核验里自己搭一层目录隔离，等于对别人的目录布局另立一套权威。

全过 → `PACKAGE OK`；任何一项不过 → `FAIL: <label>` + exit 1。

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
