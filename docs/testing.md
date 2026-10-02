# 测试与核验

## 总览

| 命令 | 类型 | 需要本机 omp | 预期输出 |
| --- | --- | --- | --- |
| `bun test` | 单测（自动发现 `test/*.test.ts`） | 否 | 54 pass / 0 fail（5 文件） |
| `bun run test:smoke` | 真实宿主 E2E | 是 | `SMOKE OK` |
| `bun run test:hardening` | 真实宿主加固核验，29 项 | 是 | `HARDEN OK` |
| `cd website && bun run check` | 站点渲染与 SEO 核验，34 项 | 否 | `render-check: all pages OK` |
| `bun run test:approval` | 审批边界判别核验，约 95 秒 | 是 | `VERDICT: B`（预期），exit 0 |
| `bun run test:install` | 发布包自包含 + 端到端，28 项 | 是 | `PACKAGE OK` |

统一前置（四个起宿主的核验）：PATH 上有 `omp`。`test:smoke` / `test:hardening` / `test:approval` 另外认 `OMP_BIN`；`test:install` 不认——它要跑的 `omp install` 与被它装的东西必须是同一个，所以固定用 PATH 上那份。**不需要模型凭据**——`test/harness.ts` 写入一个故意不可达的 provider，宿主只要「有模型配置」就能启动，而桥只跑工具不推理（设 `A2A_PROBE_REAL_MODELS=1` 可改用真实配置）。`test:install` 的端到端那半程是例外：它走 `omp install .` 装进**真实**插件目录，因为宿主解析 `~/.omp/plugins` 不受 `HOME` 影响、也没有环境变量能改道（详见下一节）。`test:smoke` / `test:hardening` / `test:approval` 的宿主都跑在**隔离临时 HOME** 里：软链本仓库扩展、独立配置与审计路径、跑完即删（失败时保留现场并在 stderr 打印路径）。提交前基线：`bun run lint` + `bun run typecheck` + `bun test` 三绿。

四个宿主核验与文档站构建都在 CI 里跑（`ci.yml` 的 `host-probes` 与 `site` 两个 job），宿主版本从 `package.json` 的 pin 读出再装。

## `test:install` — 发布包自包含核验 + 端到端（28 项）

**核验发布的 tarball 装得上去、装完就能加载、起宿主能通。** 四组：

| 组 | 项数 | 断言 |
| --- | --- | --- |
| manifest | 6 | 有 `name`；有 `version`（否则 omp 显示 `@undefined`）；声明 `pi.extensions`（加载开关）；**无 runtime 依赖**（`@oh-my-pi/*` 由宿主 shim 提供）；`files[]` 同时含 `extensions/` 与 `src/` |
| 打包 | 3 | `npm pack` 出 tarball；体积 < 500KB（不含 `node_modules`）；解开是 `package/` 根 |
| 内容 | 8 | 入口 `extensions/a2a-bridge.ts` 与 5 个 `src/*.ts` 都在 tarball 里；从入口出发走**相对 import 图**，每个模块都能在包内解析到；确实走起来了（≥6 模块） |
| 端到端 | 11 | 每次先卸载再 `omp install .`——装的是链接，所以宿主加载的就是工作区；断言该路径不是实体拷贝；桥被发现并广播监听地址；首次启动只写 `host`/`port`/`token`；`initialize` 返回协议版本；`tools/list` 21 项且无 `a2a_*`；设备名不作为工具名暴露；远程 `tools/call` 在本机执行并回结果；`tools/call` 设备名被拒；无 token 得 401 |

第三组是关键：入口 import 的是 `../src/*.ts`，`files[]` 漏掉任何一个都会**装得上、加载时才炸**。逐个断言文件名会被新增的模块绕过，走 import 图才抓得到。

端到端这组**每次都先卸载再装**。原先是「已装就跳过」，那是个洞：git URL 装出来的是**实体拷贝**，冻结在装的那一刻，于是改坏工作区的 `src/bridge.ts` 之后端到端那 11 项全绿——它验的是那份旧拷贝。实测过：破坏工作区、旧版核验报 `PACKAGE OK`。现在每次重装，且断言插件目录**解析到工作区而非拷贝**，破坏工作区会如实变红并点名那个文件。

装法用 `omp install .`（链接）而不是 README 那个 git URL（拷贝）：链接指向工作区，宿主加载的就是当前代码。**本地安装在这里是测试夹具，不是受支持的安装方式**——受支持的只有 git URL 一条，见 README。

## 插件发现与 HOME：实测结论

早先这个核验断言「宿主解析插件目录不受 `HOME` 影响」，并据此放弃了端到端。**那条结论是错的，来源是一次坏探针。** 实测：

| 目录 | 是否跟随 `HOME` | 证据 |
| --- | --- | --- |
| `~/.omp/agent/extensions/` | **跟随** | 往临时 HOME 放一个只打印标记的扩展，标记出现了 |
| `~/.omp/plugins/` | **不跟随** | 桥仍从真实插件目录加载；`OMP_PLUGIN_DIR`、`OMP_PLUGINS_DIR`、`XDG_DATA_HOME` 都不能改道 |

坏探针错在哪：它只往临时 HOME 的 agent 目录放标记，没往 plugins 目录放；而且**没给临时 HOME 写 `models.yml`**。

第二点是关键，也单独吃过一次亏：**宿主没有模型配置就不创建 session，扩展在 `session_start` 加载，于是桥永远不广播**。这个症状与「插件发现忽略了我的 HOME」完全一样。写「桥没起来」的失败信息时，先看有没有这句 `No models available`。所有起宿主的核验都走 `test/harness.ts` 播种 `models.yml`（不可达 provider，够启动即可，桥不推理）。

所以端到端这组**不假装自己验证了干净机器**——插件发现确实无法用环境变量改道。

它每次先卸载再 `omp install .`，所以插件目录里那份永远是链接、永远指向工作区。原先
写的是「已装就跳过」，那是个洞：git URL 装出来的是实体拷贝，冻结在装的那一刻，于是
改坏工作区的 `src/bridge.ts` 之后端到端全绿报 `PACKAGE OK`——它根本没看工作区。实测
复现过。现在破坏工作区会如实变红并点名那个文件。

需要说清的是这组**测什么、不测什么**：测的是桥在宿主里能不能起来、MCP 面通不通；装到
插件目录这一步是**前置条件**，用的是本地链接，因为被测对象是当前工作区。发布路径能否
安装由 omp 保证，不在这个核验的范围内。

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
- 环境变量：`OMP_BIN`（宿主二进制）、`REPO`（仓库根，脚本默认自推导）、`A2A_BRIDGE_AUDIT`（审计日志路径，默认 `<agentDir>/a2a-bridge.log`）。
- 判定性结论（如审批挂起语义）必须由核验复核，不以源码阅读或推理代替——这是本仓库评审沉淀的规矩。
