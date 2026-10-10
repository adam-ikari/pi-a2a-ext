# Changelog

首个发布版：`v0.1.0`（git tag 与 GitHub Release）。**不发布到 npm** —— 安装方式只有 `omp install <git-url>` 一条，见 README。

本文按日期倒序分节（组内按依赖顺序）；面向使用者与开发者的变更，纯内部记忆提交（`brain:`）不收录。括号内为 commit 短 sha。

## v0.1.0 — 首次发布

这个扩展在宿主 `session_start` 时起一个 MCP 服务器（`2025-11-25`，Streamable HTTP，默认只绑 `127.0.0.1`），把宿主会话里的工具暴露给远程 MCP 客户端。执行落在宿主真实的文件与 shell 上，宿主不做模型推理。

- **安装**：`omp install https://github.com/adam-ikari/pi-a2a-ext.git`。只这一条路，不发 npm
- **`tools/list`** 返回宿主注册表，原样透传，不过滤
- **`tools/call`** 走宿主 `Main` 会话的 `getToolByName(name).execute()`，注入真实的 `session.settings` 与 `ExtensionContext ui`，所以宿主审批门照常生效
- **`POST /blob`** 收原始字节（上传专用）。100 MB 镜像一次请求传完，实测字节一致。不经宿主审批门、桥自己解释路径——这两条代价写在 README「安全与边界」与协议页里
- **审计**：每次远程调用写两条 JSONL（`start`/`done` 配对），`/blob` 写入记 `blob:write`
- 核验：54 单测 / 19 blob / 29 hardening / 28 install / smoke / approval，另有站点的 34 项渲染与 SEO 核验

下面各节按日期倒序，含 v0.1.0 之后的演进。

## 2026-10-10 — 审计先于尺寸落盘，`/blob` 的 `sid` 只认自己签发过的

- fix: **`POST /blob` 的审计记录挪到读回尺寸之前**。旧顺序是写完、`stat` 读回大小、再 `auditBlob`——那一次 `stat` 落在 `close()` 之后的窗口里，文件可以被 unlink、父目录可以失去可寻性，于是一个已经落盘的写入可能换来「500 + 日志无痕」，而这个端点的唯一痕迹就是那行日志。现在记录先落盘，读尺寸失败只让响应少一个 `size` 字段，状态照常 200；不能反过来报 500——分块客户端见 5xx 就重试，而 `/blob` 只会追加，重试等于同一段字节写两遍。这条没有先红后绿：窗口在写完与读回之间，摆不出来，`docs/testing.md` 按「第三条没有」明说
- fix: **`/blob` 的 `sid` 过去照抄请求头**。审计里 `sid` 是共享 token 下唯一的归因字段，照抄等于由调用方自报——任何持 token 的人都能把自己的写入登记到别人的会话名下，或者编一个。现在只认本桥签发过、还在空闲窗口内的 id，其余一律记 `null`；不拒请求，拒了就是桥自己在决定谁可以上传，协议没给过这个位置。签发过的 id 经 `/blob` 刷新空闲计时，与 MCP 路径同语义。顺带把 MCP 与 `/blob` 两条路径上「同一个字段不是一个意思」的分歧消掉：那边逐条验这个头，这边以前根本不碰会话表
- fix: **审计写失败从「吞」改成「吞但不哑」**。`appendLine` 的失败照旧不影响调用（这条不变式原有测试钉着，rejection 冒进宿主进程与卡死队列都在这条的红名单里），新增：每个日志路径第一次写失败往宿主 stderr 打一行 `[a2a-bridge] audit record not written to <路径>（<原因>）`，此后每满一百次再打一行，计数经 `auditWriteFailures()` 可读。理由是外观问题——写不成的日志与从没被调用过的桥看起来一模一样，而整个安全论证建立在这份文件是 `/blob` 唯一痕迹上。「按路径记首次」而非按进程：`$A2A_BRIDGE_AUDIT` 让一个进程可以对着多个路径，全局只报第一次会让第二个路径哑掉
- fix: **401 有了信号，且刻意不进审计文件**。未鉴权尝试原先在日志里零痕迹，运维分不清「没人来」与「来的人全敲错门」；现在进程级计数，第一次与其后每五十次打一行宿主 stderr。不落审计是一条攻击面算术：那份日志 512 KB 轮转、只保留一代，而轮转不认鉴权状态——给鉴权前的流量写记录，等于把冲掉真实记录的唯一杠杆交给每一个正在猜 token 的人，他们不需要猜中，只需要灌量
- fix: **配置的 token 有了下限，且自愈的范围收窄**。字段里存在但短于 32 字符、或含空白的 token，与 `port`/`host` 同罪：拒绝启动并报字段名。旧代码把一切「非法 token」当缺失处理、重写并写回——对三字符的占位符那不是宽容，是给一个能写宿主可写一切的端点留了扇没人知道开着的门；而继续自愈等于桥悄悄换掉谁手写的 token，远程 `mcp.json` 对不上号且没有任何地方说明原因。自愈只剩字段缺失或根本不是字符串一种。`MIN_TOKEN_CHARS = 32` 压在 `generateToken` 自己产出（43 字符）之下，拦的是占位符，不是从别处抄来的密钥
- test: 单测 105 → 107（config 两条：太短与含空白的 token 各自拒绝启动、不落写回）；`test:blob` 32 → 35（伪造头照样写得成且不被归属、伪造头审计记 `null` 不记那个自称的 id、桥签发过的头原样进审计）；`test/audit.test.ts` 的「路径写不成」一项从「不出 rejection」扩到断言告警行点名路径且计数器前进
- test: 排查记录一条：新告警断言在全套件里红、单文件跑绿——`test/host-call.test.ts` 的 afterAll 直接删审计目录，把别的文件此刻还在途的记录一并抹掉。改成先向队列投一条哨兵记录、等它落盘（上限 3 秒）再拆。进程级共享资源做完断言前必须排空再销毁
- 变异核验三项：去掉 token 下限校验，只红新增那两条 config；把审计的 `.catch` 换回空函数，只红那条失败路径断言；`/blob` 的 sid 换回照抄，宿主 blob 核验里只红归属那一条，还原后重跑 35 项全绿——那一轮同时成为内存序列的第二十二轮。审计顺序那条无变异可做，原因见第一条
- docs: 协议页——`200` 响应里 `size` 改为可选并写明读失败只缺字段；处理顺序把 `/blob` 路由列为第 3 步（鉴权之后、JSON 解析之前）；鉴权节补 token 下限与「鉴权前的流量碰不到审计文件」；「它放弃了什么」加第三条：桥自己的 `a2a-bridge.json` 与 `a2a-bridge.log` 就落在它解释路径所用的根里，改写不了（一律追加、`offset` 必须等于当前大小），但往配置追加垃圾会让下一次 `loadConfig` 抛错、桥起不来，往日志灌量会驱动轮转冲掉证据——冲的是启动与证据，不是新增可达范围，能这么干的人本来就握着 token
- docs: README 中英两版同步——配置表与 fail-closed 段补 token 下限与自愈边界，`/blob` 条补上面那条代价，审计条补三处新语义，故障排查加两条（短 token 拒启动、审计路径写不成的外观）。顺手按同一惯例清了「移动文件」一节没人复核的死数：「空闲 368 MB、一次 100 MB 上传后 624 MB、两次并发 846 MB」与「0.4 秒」换成指向协议页每轮刷新的表——那些数是 18.6.1 时代量的，空闲基线这半年就从 368 走到 468–497
- 计数同步：单测 107、blob 35（README 中英、站点摘要、`docs/testing.md` 总览与覆盖率段——后者两处「剩余未覆盖」的行号按当前码位重标）。协议页内存表按第二十二轮重落（空闲 488 MB，单个 8 MB 安顿 +22 MB，两个并发安顿 +40 MB，峰值 +22 / +41——单个那一项峰值与安顿相等，并发那一项峰值高 1 MB；近六轮基线 480、497、483、485、468、488 MB，跨度 29 MB）；100 MB 单请求本轮 2.2 秒，同一天里 0.3 秒也出现过，耗时数跟着机器负载走，文档把这句写明
- 回归：`lint` / `tsc` / `bun test` 107/107；六个宿主核验在变异全部还原之后重跑全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 35 项、`SCENARIOS 54 steps, 0 failed`、审批探针 `VERDICT: B` 挂起 90002ms、`PACKAGE OK`）

## 2026-10-09 — 测试页的序列停在第十六轮，首页卡片把 install 当纯打包

- docs: `docs/testing.md` 那段 RSS 结论抄了协议页的逐轮序列，抄完停在第十六轮——协议页已记到第二十轮，它还少了四个并发数与后来的基线。改成只留区间（单个 −157 到 +171 MB，并发 −141 到 +168 MB）与负值的来处，逐轮序列与近六轮基线归协议页那张表维护，不抄第二份
- docs: 首页「测试与核验」卡片把 `test:install` 当成不起宿主的纯打包检查——它有端到端那半程之后，六个核验全都起宿主（`docs/testing.md` 的统一前置段一直写着六个）。卡片改为六个，点名发布包那一个装回去跑通

## 2026-10-09 — 宿主又超前两天，pin 同步至 18.8.6

- chore: pi-* pin 与 lockfile 同步至 **18.8.6**（第七次复发）。宿主 omp 有 `startup.checkUpdate`（默认开），会自己升级，节奏不由本仓库定；10-07 同步到 18.6.3 推完，10-09 宿主与 node_modules 都到了 18.8.6，版本守卫两条红（实装 ≠ pin、宿主 ≠ pin）。谁在改本仓库的 node_modules 仍是未知机制，不假装知道。代码与文档引的宿主源码位置逐条对 18.8.6 复核过，全部原位未动：三个 `getAllTools` 接线点（`runtime-init.ts:126`、`extension-ui-controller.ts:199/427`、`acp-agent.ts:2581`）、`session_start` 的两个发点（`runtime-init.ts:212`、`extension-ui-controller.ts:320-329`）、`AgentRef.session` 的哨兵注释（`agent-registry.ts:69`，`Null exactly when parked/aborted`）——文档与测试注释里的行号不用改
- 18.8.6 全量回归：`lint` / `tsc` / `bun test` 105/105 三绿；六个宿主核验全绿（`SMOKE OK` 21 工具、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、审批探针 `VERDICT: B`、`PACKAGE OK`）。轮转那组仍是数量守恒：8 条前置 + 212 次调用写出的 424 条，430 条进 `.1`、2 条留在当前文件；审批探针 bash 挂起 90001ms、副作用文件未出现、审计 `start=1 done=0`；`xd://` 挂载设备 5 个。跨版本未变的行为：21 个工具、挂起语义、两阶段审计、审批门仍 fail-closed
- docs: 协议页内存表按 `test:blob` 第二十轮重落（空闲 485 MB，单个 8 MB 上传安顿 +21 MB，两个并发安顿 +51 MB，在途峰值 +22 / +51 MB——这一轮峰值与安顿几乎相等，「高于、低于、相等」三种关系这些轮次里都出现过，这两个数不构成排序；近六轮基线 461、490、480、497、483、485 MB，跨度 36 MB）；100 MB 单请求本轮 0.6 秒
- chore: `test/rss-18.8.6.json` 入库，替换 18.6.3 那份——归档按宿主版本一文件一份，文档那张表的出处跟着当前宿主走

## 2026-10-09 — 两条并发写日志，第二次轮转吃掉第一次

- fix: **审计落盘的「查大小 → 轮转 → 写行」三步不是一个整体**。`src/audit.ts` 的 `appendLine` 原先每来一行就自己起一个 async 闭包，两个同时在飞的写可以都读到越过 512 KB 的尺寸、都去 `rename`，而第二次 `rename` 覆盖掉的正是第一次刚放好上一代的那个 `.1`。被吃掉的是轮转那一刻还留在当前文件里的记录，几毫秒前由另一个调用写下的，外加被换出去的一整代。配上 `/blob` 更糟：那个端点在宿主审批门之外，审计行是它唯一的痕迹。现在按进程一条 promise 链串行，`appendLine` 把行交给链就返回（调用照旧不等磁盘），链上每个环节自带 `.catch`，于是一次写失败既冒不到宿主进程，也不会把链卡住让后面所有审计落不了盘。接受的代价说清楚：磁盘慢的时候，后面的行在内存里排队
- test: `test/audit.test.ts` +1（4 → 5，单测 104 → 105）。舞台摆成只需要一次轮转：日志灌到离 512 KB 差 200 字节以内，同时打 60 条（每条约 1.15 KB），断言按两个文件的记录数守恒、逐条 id 都要在。未修版本重跑六轮先红，落点两种：四次缺 59 条（本轮 60 条只剩 1 条），两次缺 570 条（两个文件各剩 1 条）
- 变异核验三项：换回不串行的写法，只红这一条；去掉链尾的 `.catch`，红两条——「路径写不成」那项（rejection 冒出来）与这条新的（前一个环节失败卡住了链，此后所有审计都落不了盘）；把轮转整句删掉，红的是原有那条保留测试。轮转本身、轮转的串行、串行的自愈，三样各自有人看着
- 顺带两处过期：那条保留测试每 20 对让一次路，注释给的理由是「有链子会冲过上限把尺寸读数弄浑」，串行之后这件事不成立了，注释按新行为改写、让路去掉；`docs/testing.md` 里 `auditBlob` 的未覆盖行号从 `116-136` 跟到 `132-152`
- docs: 协议页审计那条补上串行的理由与实测落点，README 中英两版的审计条各补一句
- 计数同步：单测计数落到 105（README 中英、站点摘要、`docs/testing.md` 总览）；协议页内存表按 `test:blob` 第十九轮重落（空闲 483 MB，单个 8 MB 上传安顿 +20 MB，两个并发安顿 +168 MB，在途峰值 +29 / +258 MB——这一轮峰值高于安顿，上一轮反过来，这两个数不能互相排序；近六轮基线 474、461、490、480、497、483 MB，跨度 36 MB）
- 回归：`lint` / `tsc` / `bun test` 105/105（新那条连跑三轮全绿，串行之后一次多余的轮转都没有）；六个宿主核验在最后一次改动之后重跑全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`）。轮转那组报的是数量守恒：8 条前置 + 212 次调用写出的 424 条，430 条进 `.1`、2 条留在当前文件

## 2026-10-09 — 目录、暴露门与执行，原先读三份注册表

- fix: **`tools/list` 与暴露门读的是入口 pin 住那份 `pi`，而执行读 `Main` 的活会话**。宿主把 `pi.getAllTools()` 接到那套 runner **自己的**会话（`runtime-init.ts:126`、`acp-agent.ts:2581` 都是 `() => session.getAllToolInfos()`），入口却只认第一个 `session_start`——task 子代理或 ACP 会话先走到，桥就在报出另一个会话的工具清单，同时把 `Main` 自己的名字按「not exposed」拒掉；反方向也成立，`Main` 有而那份 runner 没有的名字列不出来却其实能调。现在这一处只有一个权威（`src/bridge.ts` 的 `servedTools()`）：读 `Main` 会话的 `getAllToolInfos()`，目录与门都改读它，常规宿主里它与原先那份 `pi` 逐字相同；`AgentRef.session` 为 `null`（parked/aborted 到端口释放之间）时退回那份 `pi`，因为报出一份宿主其实并没有的空注册表不是诚实而是添乱
- test: `test/host-call.test.ts` +2（17 → 19，单测 102 → 104）。harness 多一个 `pinnedPiNames` 把「入口那套 runner 不是 Main」摆出来，假 `Main` 会话补上 `getAllToolInfos` 与 `getToolByName` 同源。新增的第一项三个方向都断，先红在目录那半；第二项断 parked 的兜底
- 变异核验三项：两处都换回 `pi.getAllTools()`（红那一项）、只改目录而门仍读 `pi`（红同一项的另半条断言，两处分别被断着）、去掉 parked 的兜底（红五项——新增的兜底项，加 `test/bridge.test.ts` 里三条依赖「没有 Main 就读入口那份」的目录测试与「registered tool with no Main session」那条）
- 顺带修一处过期的计数：`docs/testing.md` 那节标题写着 14 项，实际早就不是了
- docs: 协议页 `tools/list` 那条改口到真正的权威并写清兜底的适用窗口，README 中英两版的目录、安全与边界、模块表三处加 mermaid 标签同步
- 计数同步：单测计数落到 104（README 中英、站点摘要、`docs/testing.md` 总览）；协议页的内存表按 `test:blob` 第十八轮重落（空闲 497 MB，单个 8 MB 上传安顿 +17 MB，两个并发安顿 +45 MB，在途峰值 +0 / +58 MB——这一轮的峰值低于安顿，正说明这两个数不能互相排序；近六轮基线 484、474、461、490、480、497 MB，跨度 36 MB）
- 回归：`lint` / `tsc` / `bun test` 104/104；六个宿主核验在最后一次改动之后重跑全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`），其中 `tools/list` 非空与远程调用走的就是这份新读数

## 2026-10-09 — 释放端口那一刻，在途的那一次要落审计

- fix: **释放端口把正在处理的那一次一刀切断**。`src/server.ts` 的 `stop()` 是 `server.stop(true)`，而端口会在三个时刻释放：`session_shutdown` 看见注册表里没有活的 `Main`、绑定中途那次放弃、启动失败的 catch。任一个时刻都可能正有一个请求在处理。代价分两种：`tools/call` 那一边客户端拿到 `ECONNRESET`、审计只剩 `start` 那一行；`POST /blob` 是整个消失，body 还没收完就断，`Buffer.from(await req.arrayBuffer())` 抛在写之前，于是文件没动、`auditBlob` 也没跑到——而那个端点走的正是宿主审批门之外的路，审计是它唯一的痕迹。改成非强制的 `server.stop()`：监听立刻关，后来的人一律被拒，已经进来的那一次处理完、返回、落审计
- 同一批实测里有一条属于 Bun，不掩盖也不装成已修：非强制 `stop()` 在 1.3.14 **不关**释放时已经空闲的 keep-alive 套接字，`closeIdleConnections()` 只有函数名（返回 `undefined`，socket 照旧被服务），`bun-types` 1.4.2 描述的「空闲连接立刻关」是更新版本的行为。于是这条改动换来的是「新建连接一律进不来」，而释放前就连着、之后仍保持着连接那一方，在它自己的旧 socket 上还能被服务（`tools/call` 只会拿到 `main session not available`，`/blob` 仍写得进去）。核验一律用 `node:net` 裸连判释放，走 HTTP 客户端会复用那根老 socket，量到的是这一半而不是监听的状态
- test: `test/server.test.ts` +1（23 → 24，单测 101 → 102），新增一节「releasing the port」。起一个 `tools/call`，等 stub 的 `callTool` 确实在跑（一个 `entered` 标志），然后 `stop()`，断言那一次照样 200、结果文本完整，再断裸连被拒。同一条里先断裸连在释放前是 `true`，免得这个读数只会恒假
- 变异核验两项：把 `stop(true)` 换回去，只红这一条，18 ms 内以 `ECONNRESET` 红；把 `server.stop()` 整个删掉，红五条——这一条的裸连接断言，加入口那四条靠新建连接判释放的
- docs: 协议页「一个进程，一套端口」加两条（释放的动作为何是非强制、Bun 那条偏差对 `tools/call` 与 `/blob` 各意味着什么），`docs/testing.md` 新增同名一节，README 中英两版的生命周期那条各补一句，站点摘要与单测计数同步到 102（下一节又把它推到 104）
- 回归：`lint` / `tsc` / `bun test` 102/102；六个宿主核验全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`）

## 2026-10-09 — 每会话的事件，每进程的端口

- fix: **任何一次子代理结束都会拆掉还在服务的端口**。`extensions/a2a-bridge.ts` 把 `server?.stop()` 挂在 `session_shutdown` 上，而这个事件是**每会话**的：宿主为 task 子代理、ACP 会话、持久化 revive 各建一套 extension runner 并重跑扩展工厂（模块图不重新求值，`server`/`cfg` 因此共享），一个 task 子代理跑完，它的 `session_shutdown` 落到同一个 handler，端口释放，而主会话那边再没有第二个 `session_start` 把它重启。现在的判据是宿主注册表里还有没有 `Main` 会话（`src/bridge.ts` 的 `hasMainSession()`）：有就照常服务，没有才收。交互式宿主的 `/new` 不在此列——它复用同一个 runner，根本不重发 `session_start`
- fix: **两个 `session_start` 同时在途会各绑一套端口**。绑定这一步不是原子的，`loadConfig` 与 `startServer` 都要 await，于是后到的那一个能在 `if (server)` 检查上赶在前一个赋值之前通过，真的再绑一个。模块只记住后一个端口，前一个从此谁也停不掉，操作者还会收到两条指向不同端口的广播。现在后到的等前一个绑完再复用那套
- fix: **绑定还在进行时的 `session_shutdown` 手里没有端口可停**。那个事件的 handler 只看 `server`，而 `loadConfig` 与 `startServer` 都还没回来时它是 `null`，于是它谁也没停，绑定却在随后完成——留下的端口服务的是一个已经不存在的 `Main`，此后再没有 `session_start` 来纠正它。现在绑完那一刻按同一条判据（`hasMainSession()`）复查一次：已经没有 `Main` 就把刚绑的端口收掉，一句广播也不发
- fix: **parked 的 `Main` 被 `hasMainSession()` 当成还在**。宿主把 `AgentRef.session` 注释成「Null exactly when parked/aborted」，槽位留着、会话置 `null`，而这条判断原先比的是 `undefined`，于是那种状态下它说「有 Main，照常服务」，同一份注册表在 `src/bridge.ts` 的调用路径里却回 `main session not available`——两处读同一个字段，读出两个结论。现在按宿主的哨兵判（`!= null`），端口跟着调用路径能服务的那个状态走。顺手把那条假想断言换掉：原先注册的是一句 `session: undefined as never`，宿主根本发不出这个值，它绿得没有依据
- fix: **`/a2a rotate` 先改内存再写文件**，写失败就是运行中的桥换了 token、配置文件留着旧 token、操作者收到一句「失败」。改成先落盘再生效
- 顺带记下启动失败那条注释（「不留半初始化状态」）现在有据可查：catch 里的 `stop()` 与清状态两半各有断言，只清 `cfg` 而留着 `server` 那种改法红不了——挡住 `rotate` 的是两个条件里任一个，这条保护本来就写在注释里，现在写在测试里
- test: 新增 `test/entry.test.ts`（19 项，单测 79 → 98）。入口此前没有任何单测能引到它。不 mock 任何模块：`$A2A_BRIDGE_CONFIG` 指临时文件、端口写 `0`、`Main` 是真注册进 `AgentRegistry.global()` 的假货，每条断言都是「从广播里解析出端口，然后去连它」——200 就是在服务，连不上就是没在服务。`mock.module` 试过，也不行：Bun 的模块 mock 是进程级的，同一进程里 `test/config.test.ts` 的 `loadConfig` 会被换掉，`bun test` 整个绿不回来
- test: `test/host-call.test.ts` +3（14 → 17，单测 98 → 101），其中「没有会话的 Main 槽位」那一项原先注册的是宿主发不出来的 `session: undefined as never`，现在换成宿主真用的 `session: null` 加 `status: "parked"`，`hasMainSession()` 对着真注册表测三种情形：空表、`Main` 在册、`Main` 在册但背后没有会话。入口那条判断就靠这个读数，所以它不能被 stub
- 变异核验十项：去掉 `hasMainSession()` 那道闸（红 1 项）、`rotate` 的赋值挪回写盘之前（1）、catch 里不再 `stop()`（1）、catch 里什么都不清（1）、`hasMainSession()` 恒真（红的正是真注册表那 3 项）与恒假（1）、去掉在途那道闸（1，红的正是并发那条）、去掉绑完之后那次复查（1，红的正是绑定中途结束那条）、把 `hasMainSession()` 的比较换回 `!== undefined`（2，红的正是 parked 那两条：真注册表那一项与入口的端口释放）。第十项是广播里改用配置的端口，红 7 项——端口报错了，所有「去连它」的断言一起塌，这条恰恰证明断言是连着真端口写的
- docs: 协议页新增「一个进程，一套端口」，把后来的 `session_start` 静默复用、并发到达时后到的等前一个绑完、审批归属第一份 `ctx`（子代理那份没有可用 UI，让它占住引用会一路挂住）、`Main` 没了才释放、绑定落地后按同一判据复查、以及「没有 `Main`」按宿主那个 `session = null` 的哨兵判（parked/aborted 的槽位不算在册）这七条写清；README 中英两版各加一条
- 计数同步：README 中英两版的 `bun test` 说明加 101 项与两组新覆盖面，站点 testing 摘要同步；内存表按第十六轮实测重落（空闲 490 MB，单个 8 MB 安顿 +23 MB，两个并发 +160 MB，在途峰值 +24 / +264 MB），基线近六轮依次是 490、567、484、474、461、490 MB
- 回归：`lint` / `tsc` / `bun test` 101/101；宿主核验五连与发布包核验在最后一次改动之后全部重跑，全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`、`PACKAGE OK`）。冷启动那一步也复查过：宿主在构造会话时把 `Main` 预注册进注册表，槽位后面的会话随后附上，而三个模式都是在会话建好之后才发 `session_start`（`runtime-init.ts:212`、`extension-ui-controller.ts:320-329`），所以那条复查挡不到正常启动。探针只跑 `--mode rpc`，tui 与 print 的这一步是按宿主源码核对的。场景核验的「宿主结束 → 端口不再接受连接」正是第一条改动的反例位

## 2026-10-09 — 渲染事件不该决定一次调用的结果

- fix: **宿主拒绝渲染事件时，一次已经执行完的写会被报成失败**。`src/bridge.ts` 里那两次 `emitExternalEvent` 坐在判定结果的 `try` 中。三种后果：start 被拒则工具根本不执行；end 被拒则 `edit` 照常落盘而调用方拿到 `isError`，照着它重试就重复执行一次带副作用的写；工具本身抛错时交出去的错误文本被换成渲染自己的那一条。注释写的是「只驱动渲染」，代码没做到。现在事件的构造与发送失败都吞掉，成功与失败两条路合到同一处结果映射，`toInputSchema` 那类降级照旧
- test: 新增 `test/host-call.test.ts`（14 项）。`buildCallTool` 交给 Main 会话的那半条路径此前一行 deterministic 测试都没有，只在 `test:smoke` 里跑过，而探针能调的工具只返回文本块。`AgentRegistry.register` 接受任何对象作 `session`，`resetGlobalForTests` 就是为此而设，于是不必起宿主也能断：text/image 原样转出（`detail` 不透传）、其他块折成 JSON 文本、`isError` 到调用方与审计、参数按引用交出、工具上下文里 `hasPendingMessages` → `hasQueuedMessages` 那次改名、一调一对事件且 `toolCallId` 是新 UUID、目录有而会话无的名字回 `unknown tool`
- test: `test/server.test.ts` +3。500 那句「细节只进服务端日志」两半都断上了（响应体查不到假宿主路径，`console.error` 拿到了错误对象）；端口退避分支原先不可能覆盖到，因为其余测试都以 `port: 0` 起服务，现在用真实占用的端口断 `fellBack`，反向一条用特权端口的 EACCES 断它不该退避（环境允许绑低端口时跳过）
- test: `test/audit.test.ts` +3、`test/bridge.test.ts` +2。参数含 `JSON.stringify` 拒绝的值时记录仍落盘（`args` 退化成 `[object Object]`）；日志写不成时不同步抛错也不以 unhandled rejection 冒到宿主进程，`appendLine` 末尾那个 `.catch(() => {})` 至此才有断言撑着；注册表里缺 `parameters` 的条目降级成 `{type: "object"}` 而不是把整份目录带走；参数在 1024 字符截断（去掉截断，原先所有测试全绿，所以补了一项 40 × 110 字符的用例）
- 变异验证：12 处逐项破坏实现（image 分支、`hasQueuedMessages`、`structuredClone` 参数、end 换 id、`if (!tool)`、未知块原样发出、吃掉 `isError`、不发 start、500 泄露细节、任何绑定失败都退避、`fellBack` 不置位、去掉参数上限与去掉两处 catch），每项只让自己那条断言变红。fix 本身另以 `git stash push src/bridge.ts` 回到改前状态验证：恰好渲染事件那三项变红，其余十一项绿
- docs: 协议页写清结果内容的三种情形与渲染事件不参与判定这件事；`tools/list` 那条补上「宿主转换器对非对象 `parameters` 会抛，桥接住并降级」。内存表按第十一轮实测重落（空闲 490 MB，单个 8 MB 安顿 +9 MB，两个并发 +16 MB，在途峰值 +32 / +33 MB）
- 计数同步：README 中英两版的加固项数 33 → 35（上一批把核验加到 35 项时漏改），单测 57 → 79（7 文件）
- 回归：`lint` / `tsc` / `bun test` 79/79；宿主核验五连全绿（`SMOKE OK`、`HARDEN OK` 35 项、`BLOB OK` 32 项、`SCENARIOS 54 steps, 0 failed`、`VERDICT: B`）

## 2026-10-08 — 参数脱敏只走两层，而宿主 `edit` 的正文在第三层

- fix: **审计日志会写下文件正文**。`src/audit.ts` 的 `redact()` 走到第二层就停，注释写着「工具参数不会嵌得更深」，而宿主自己的 `edit` 是 `{path, edits: [{oldText, newText}]}`，正文落在第三层。远程调用一次 `edit`，日志里就多出最多 1 KB 的文件内容（只有 `MAX_ARGS_CHARS` 的截断挡着）。现在逐层走到叶子；嵌套超过 32 层的子树整个换成 `<max-depth>`，不再往下走
- test: 原有的那条脱敏单测（`test/bridge.test.ts`）断言 `args` 字段不含完整的 5000 字符 payload，而那个字段本来就截在 1024 字符，整段永远不可能出现，于是漏洞开着它也是绿的。改成在整行日志里查 payload 的 60 字符窗口，另加一条 40 层嵌套的用例（单测 55 → 57）
- test: `test:hardening` 33 项 → 35 项，同样的事从宿主这一侧再验一次：真发一次带三层正文的 `tools/call`，然后在日志里确认 `<len:4000,sha256:` 查得到、那 60 字符的窗口查不到
- 变异验证：把 `redact()` 的层数停止条件还原，两条单测如实变红。宿主核验那两项的红走的是 `until` 超时抛出，所以那一轮后面的项没跑（27 项 ok 之后中止）。这是宿主核验的既有风格：等不到本该出现的证据就中止，后面的结论没有意义
- docs: README 中英两版与协议页把脱敏的范围写清：**逐层到叶子**，且这是桥自己那份日志的承诺；宿主会话照常收到原参数，宿主的 transcript 里有什么不归本桥管
- 顺带记一条观察：宿主 stdout 会把收到的参数原样打出来，核验失败时探针打印的日志尾部因此带着那个 4 KB 的 payload。保留现场这件事，在有 payload 的用例上要多加一分小心
- 回归：`lint` / `tsc` / `bun test` 57/57 三绿；`HARDEN OK`（35 项）

## 2026-10-08 — `/blob` 两处「报了成功却没写成」，与审计日志的保质期

- fix: **两个调用方同时写一个新文件会丢字节，两条请求都回 200**。旧实现在 body 读进来之前取文件大小、据此选打开方式，两边都看到 0、都选 `w`，而 `w` 在 open 时截断，第二次 open 抹掉第一次已经落盘的内容。改成一律 `"a"` 打开；给了显式 `offset` 的调用方在拿到句柄之后复查一次大小，位置变了就 409，字节不放，也不回报你那个 offset
- fix: **`write` 短写（磁盘满、配额到顶）回 200，且不留任何审计**。现在短写与抛错都是 500，审计记 `bytes: 0` 加错误文本。被 413 挡在 handler 之外的那种不写文件也不写审计，这一条也断言了
- test: `test:blob` 21 项 → 32 项，新增「失败与边界」组。`/dev/full` 是 open 成功、写时 ENOSPC，无 root 下唯一干净地触发写失败的路子（填满 `/dev/shm` 也能达到目的，但那是全机范围的破坏，不做）。其余：只有 token 没有会话头、413 不碰已存在的文件、目录目标、`~` 与相对路径的落点、同一文件两路并发追加，外加四条审计断言
- test: `test:hardening` 29 项 → 33 项，补上审计轮转那组（此前一项都没有）。写它的时候撞见自己一条假断言：拿本轮发出的 JSON-RPC id 去日志里找记录，而日志里的 `id` 是本桥为配对生成的 UUID，JSON-RPC id 从不落盘，那条无论实现怎么写都不会有结果。换成数量守恒：一次调用写两条，N 次调用就要在两个文件里多出 2N 条。让记录变胖同样不能靠一个 1000 字符的路径，`redact()` 把超过 120 字符的字符串折成 `<len:N,sha256:...>`，每条只剩 210 字节，越过 512 KB 要 1241 次调用；换成 10 个 110 字符的参数之后每条约 1.1 KB，213 次调用就够
- test: 新增 `test/audit.test.ts`（单测 54 → 55）。轮转只保留一代，下一次轮转覆盖 `.1`，所以「只有 `start` 没有 `done`」那个挂起信号有保质期。这条直接灌审计模块，一秒跑完四轮流量；用宿主驱动要两千次真实调用，还会把并发落盘的顺序噪声卷进来。变异验证：把 `MAX_LOG_BYTES` 放大到不轮转，那项如实变红
- fix: 三处探针（blob / smoke / hardening）失败时保留现场并把路径打到 stderr。文档早写了「失败时保留现场」，代码里是无条件 `rmSync`，那句话一直是空的
- docs: 内存表按第十轮实测重落（空闲 495 MB，单个 8 MB 安顿 +18 MB，两个并发 +32 MB，在途峰值 +26 / +32 MB），并交代负值的来处：`空闲`基线在探针末尾取样，那一刻前一步那次 100 MB 上传仍有内存没归还，基线自己在往下衰减，于是每个增量量到的是衰减的进度。同一个探针连着三轮给出 −157、+91、+18 MB，「本表是最近一次实测，不是稳定值」那句话就是这么来的。探针打印负增量曾显示成 `+-141`，改成带符号
- docs: `/blob` 的拒绝总表补上 `500` 那一类（打不开、写不进、目标是目录）与 `413` 不碰文件不写审计；README 中英两版与协议页写明审计 `id` 是 UUID、日志只留一代
- 计数同步：README ×2、`docs/testing.md`、`website/scripts/sync.mjs` 里 blob 21 → 32、加固 29 → 33、单测 54 → 55
- 回归：`lint` / `tsc` / `bun test` 55/55 三绿；`SMOKE OK`、`HARDEN OK`（33 项）、`BLOB OK`（32 项，最后一轮 0 项失败）、`SCENARIOS: 54 steps, 0 failed`、审批 `VERDICT: B`、`PACKAGE OK`、站点 `render-check: all pages OK`

## 2026-10-08 — 内存实测重新落表：文档里的数会自己烂掉

- test: **`test:blob` 加宿主 RSS 实测段**（19 项 → 21 项）。`docs/protocol.md` 那张内存表只在宿主 18.6.1 上量过一次，宿主已到 18.6.3，文档里一句没人复核的内存断言会烂在原地。探针每轮起隔离宿主、测空闲/单个 8 MB/两个并发 8 MB 的安顿值与在途峰值，覆盖写进 `test/rss-<宿主版本>.json`，文档表从它刷新
- **不断言阈值**，理由写在探针文件头：这条原本要卡在「两个并发 body 的开销小于两者之和」上，实测杀死了这个想法。单个 8 MB 请求的安顿增量七轮分别是 +11、+26、+171、+165、+10、+18、−6 MB，最后那一轮上传完宿主 RSS 比上传前还低；两个并发的那一项安顿 +44、+147、+148 MB，峰值 +44、+245、+248 MB——并发也不可复现，最大最小差三倍多。主导这些数的是 Bun 分配器（arena 增长，加上前一步 100 MB 上传延迟归还的内存），与本桥有没有把 body 留在内存里无关。断言这种数等于测分配器，且会在忙碌的 CI runner 上因与桥无关的原因变红。改成断言确定的一半：测量期间的并发上传与 100 MB 单请求都必须被接受
- 反证做了两版变异体（延迟写、延迟读）：**峰值不可分辨**，都落在真实路径的噪声带里。所以峰值采样留着当仪器，不当判决。先前一版探针只采安顿值，那读不到在途 body（落盘的和驻留的此刻都被 Bun 放掉了），改成 5 ms 间隔同步读 `/proc` 才看得见；最新归档那一轮峰值与安顿值相等，小 body 传得快时本来就没有可分辨的差
- docs: 内存表换成归档那一轮的实测（空闲 370 MB，单个 8 MB 安顿 +18 MB，两个并发 +44 MB，峰值与安顿值相等）；删掉没人复核的「100 MB 实测 2–5 秒」，改为探针每轮打印耗时（本轮 0.4 秒）；并发的告诫改写为从 128 MB 请求体上限制推（上限是每个在途请求各自的），不再挂在 RSS 上
- fix: **四处文档与实际不符**。README 与 README_ZN 各两处仍写「`omp --version` ≠ pin 只告警」——10-07 已改成失败；README 开发块缺 `test:scenario` 与 `test:install` 两行；`docs/testing.md` 说「五个起宿主的核验」，场景核验接进来之后是六个，前置说明里也没列它；探针文件头仍写「单请求上限 1 MB」，那是 128 MB 之前的话
- fix: 探针注释声称「断言的是文档承诺的规模（100 MB 一次请求）」，代码里那个状态码只被打进日志、没有断言。补上断言。说与做不同，这次是做的少
- chore: `test/rss-18.6.3.json` 入库，作为文档那张表的出处；无 `/proc` 时这组打印 SKIP 并保留旧文件，不把上一台机器的数当本轮的
- 回归：lint / tsc / `bun test` 54/54 三绿；六个起宿主的核验全过——`BLOB OK`（21 项，含 100 MB 字节一致）、`SMOKE OK`、`HARDEN OK`（29 项）、`SCENARIOS: 54 steps, 0 failed`、`PACKAGE OK`（28 项）、审批核验 `VERDICT: B`；站点 34 项渲染与 SEO 核验 `render-check: all pages OK`

## 2026-10-08 — 端到端场景核验：从产生它的通道之外去验

- test: **新增 `bun run test:scenario`**（10 个叙事 / 54 步，约 45 秒，已接进 CI 的 `host-probes`）。其余五个探针都是平铺断言，每项一个观察；这个每个场景是一条叙事，且**结尾状态从产生它的那条通道之外去验**——远程 `bash` 看文件系统与审计日志，`/blob` 的写入用宿主自己的 `read` 读回来，会话终止后去连端口。理由在代码里：留在单通道内的推理正是那 675 行文件传输面带着两个 P1 上线、100 个单测全绿的原因
- 覆盖的空白（此前零覆盖）：端口被占回落 + 告警、配置损坏 fail-closed、`--approval-mode=write` 档、宿主结束释放端口、外部改配置的生效时机、两客户端并存与 sid 归因、并发上传互不串扰、`xd://` 挂载设备、blob→宿主工具的数据一致性
- **每个场景都反证过会红**（改坏实现再跑）：`/blob` 一律覆盖写、非法 port 不 fail-closed、审计不记 sid、`DELETE` 清空整表、端口占用不回落——各自变红，且都点名是哪一步。暴露面校验删除时场景套件**不红**，那条归 `test:hardening`（实测它红两项），并写进探针文件头
- fix: **`test:install` 那项「设备名被拒」会因错误理由变绿**。它只断言 `isError`，而暴露门一去掉，调用会打到宿主、被设备自己以 `Unsupported debug action: undefined` 拒掉——仍是 isError。改为断言**是哪一种拒绝**（必须是桥的 `is not exposed by this bridge`）。与 10-07 那条「通过了却打印『没有广播』」是同一类错误的镜像：断言 A，绿的却是 B
- 途中修正探针自身三处：场景对「一律覆盖写」原本是绿的（对不存在的文件，追加与截断是同一个操作，补了显式 offset 的追加才咬得住）；`rpc()` 没有默认超时，桥没起来时会挂在占用端口上（现在恒有 20s 上限）；断言了宿主 `read` 的输出是裸内容，实际带 `[path#hash]` 头与行号（像 `cat -n`，先还原呈现再比数据）
- docs: `docs/testing.md` 新增该探针一节，含场景/通道对照表与六个注入缺陷的反证结果

## 2026-10-07 — 版本守卫从 warn 改成 fail

- fix: **「pin == 宿主版本」这条守卫此前只 warn，而它是这条不变量唯一的信号**。复发六次，`bun test` 每次红一项，但没人必须处理。宿主自己会升级（omp 有 `startup.checkUpdate`，默认开），CI 两个 job 都看不见真实宿主升过——`check` 用 frozen-lockfile 装，pin 与 lock 自洽；`host-probes` 装的就是 pin 本身，比的也是 pin。**没人必须处理的 warn 不是守卫**，所以宿主比较改成 fail，失败信息同时给出两个版本与修法
- 无宿主时仍然跳过（CI 的 `check` job 就是这种形态，无可比对象）；确实要对着别的宿主版本跑时用 `A2A_SKIP_HOST_VERSION_CHECK=1`，会打一行大声的 SKIPPED，不静默
- 三条路径都反证过：伪造一个报 `18.9.9` 的 `omp` → 如实红；`OMP_BIN` 指向不存在的路径 → 跳过；跳过开关打开 → 大声跳过
- 途中自己写错过一次断言（无条件拼了不匹配那句，于是永远不等），由「pin 已同步却仍红」暴露出来
- chore: pi-* pin 与 lockfile 同步至 **18.6.3**。18.6.3 全量回归：tsc 0 错误、单测 54/54、biome 干净、SMOKE OK（21 工具）、HARDEN OK（29 项）、BLOB OK（19 项）、PACKAGE OK（28 项）、审批探针 VERDICT B（挂起 90s，无副作用，审计 start=1 done=0）
- docs: `docs/testing.md` 此前完全没写这个守卫，补一节：四项断言各是什么、CI 无宿主时哪几项生效、跳过开关

## 2026-10-02 — 端到端每次重装：原先验的是冻结的拷贝

- fix: **`test:install` 端到端那组一直在验一份陈旧拷贝**。上一提交写的 `if (!existsSync(installedPlugin))` 表示「已装就跳过」，但 git URL 装出来的是**实体拷贝**（实测 `ls -ld` 确认非链接），冻结在装的那一刻。后果：改坏工作区的 `src/bridge.ts` 之后端到端全绿报 `PACKAGE OK`——它根本没看工作区。实测复现过
- 改为每次先 `omp plugin uninstall` 再 `omp install .`。装法用 `.`（链接，指向工作区）而不是 README 那个 git URL（拷贝）：链接保证宿主加载的就是当前代码。README 仍只写 git URL 一条安装路径——**本地安装在这里是测试夹具，不是受支持的安装方式**
- 新增一条断言：插件目录 `realpath` 必须等于仓库根，否则下面 11 项测的是拷贝不是工作区
- test:install 27 → 28 项

## 2026-10-02 — 加 `POST /blob`：原始字节上传，桥不再路径中立

- feat: **新增 `POST /blob?path=&offset=`，收原始字节**。`tools/call` 传不了二进制——宿主 `write` 吃字符串、`bash` 吃命令，调用方得先 base64。烧固件这类需求（远程把镜像推到宿主上烧写）实测要走 21 次请求（16 MB，单块用满 1 MB 上限）。`/blob` 省掉编码：每块少传 33%，两端不编解码
- **代价明确写进文档，不是疏漏**：
  - **不经宿主审批门。** `ExtensionAPI` 只有 `on("tool_approval_requested", …)`——宿主问、扩展答的方向，扩展无法主动发起审批。唯一能过审批门的写入方式是发一次 `tools/call`，而那正是这个端点要避免的编码
  - **桥自己解释路径。** 宿主有 `resolvePath()`/`expandPath()`，但那是宿主包内部模块，`BridgeDeps` 没有入口，依赖它们会在宿主移动文件时断。所以 `src/blob.ts` 自己实现 `~` 展开与相对/绝对判断——**代价是桥能写宿主能写的任何路径，无根目录、无白名单**
  - 这两条推翻了 AGENTS.md 的「不要替 omp 实现沙盒」与「桥不解释路径」，按决定记录而非默认
- 保住的一样：**审计照旧**。每次写入留一条 `tool: "blob:write"`，args 只有 `path`/`offset`/`bytes`，文件内容不进日志
- **请求体上限 1 MB → 128 MB**（`maxRequestBodySize`）。100 MB 的镜像一次请求传完，实测字节一致、0.4 秒；129 MB 是干净的 413。先单独验过 Bun 接受多大的值（16 / 128 / 256 MB 各发一个略低于上限的 body，都完整落盘），再定这个数
- **内存代价写进协议页**：`maxRequestBodySize` 是 Bun 在 handler 之前缓冲的上限，所以代价是每个在途请求的内存。实测宿主 RSS：空闲 368 MB → 一次 100 MB 上传 624 MB → 两次并发 846 MB。并发不是线性叠加（两次只比一次多 222 MB，body 流式落盘而非全量驻留），但每个在途大请求仍吃 200 MB 以上。文档明写别开十个并发
- `src/blob.ts` 里原先那道 1 MB 的 `MAX_CHUNK` 检查删掉——body 上限已在 HTTP 层挡住，留着两层限制只会让「边界在哪」有两个答案
- test: 新增 `bun run test:blob`（11 项，已接进 CI 的 `host-probes`）。字节比对是重点：HTTP 200 不证明字节到了，`size` 对也不证明内容对——第一版只断言大小，内容错了照样绿，现在每处写入都用 `Buffer.equals` 比对
- 反证：把写入改成少写一个字节，字节比对的两个断言都变红；复原后全绿。核验抓得住
- docs: 协议页新增「原始字节上传」（含「它放弃了什么」一节）；README（中英）「传文件」改为推荐 `/blob`，「安全与边界」新增 `/blob` 例外条目

## 2026-10-02 — 删掉 install.sh：安装只有 git URL 一条路

- **删除 `scripts/install.sh`（约 130 行）**。上一提交刚修好它「每次实装都失败」的 bug（手写的 `src/*.ts` 必检清单在删 `filetools.ts`/`fileguard.ts` 时没跟着删），但修一个不该存在的东西比删掉它更费：它是 `omp install` 之外的第二条安装路径，自己维护了一份模块图校验。按「不重复造轮子」，安装由 omp 保证，桥不该再给第二条路
- **安装方式收敛为一条**：README（中英）删掉「仓库根执行 `omp install .` 链本地这份」与整段 install.sh 说明，改写为「**只有这一条安装路径**」。手工软链的警告保留但独立成段——那个坑还在（`ln -s "$PWD/..."` 换个目录就链到不存在的路径，桥静默不启动而宿主不报错），只是不再依附于被删的脚本
- test:install 32 → 27 项，删掉测 install.sh 的整组（含那条「移走传递依赖必须拒绝」的反证）。随之清掉 `mkdirSync` / `realpathSync` / `renameSync` 三个未使用 import——biome 的 warning 不影响退出码，只看退出码会漏
- docs/testing.md 与 ci.yml 的 step 名同步。顺带改准两处：矩阵表原说四个核验共用 `OMP_BIN`，实际 `test:install` 不认（它要跑的 `omp install` 与被装的东西必须是同一个）；「三个宿主核验」现在是四个
- 项数实测 27（6 manifest + 3 打包 + 8 内容 + 10 端到端），不是沿用上一轮的 32

> CHANGELOG 与 brain 里的 `install.sh` 记录保留原文——那个 bug 是真的，只是修它的选择错了。

## 2026-10-02 — 端到端核验恢复；上一条「插件发现不受 HOME 影响」的结论被推翻

- fix: **`test:install` 恢复端到端**（17 → 32 项）。上一条把端到端判为「无法自动化」并写进了 README 与 docs，那个判断来自一次坏探针。实测两个目录的行为不同：`~/.omp/agent/extensions/` **跟随** `HOME`（往临时 HOME 放一个只打印标记的扩展，标记出现），`~/.omp/plugins/` **不跟随**（桥仍从真实插件目录加载，`OMP_PLUGIN_DIR` / `OMP_PLUGINS_DIR` / `XDG_DATA_HOME` 都改不动）。坏探针只试了前者，且没给临时 HOME 写 `models.yml`
- **宿主没有模型配置就不创建 session，扩展在 `session_start` 加载，于是桥永不广播**。这个症状与「插件发现忽略了我的 HOME」一模一样，单独吃过一次亏：临时 HOME 起宿主、桥没起来，一度又归因到隔离。所有起宿主的核验统一走 `test/harness.ts` 播种 `models.yml`（不可达 provider，够启动即可——桥只跑工具不推理）
- 新增第五组端到端：宿主广播监听地址 → `initialize` → `tools/list`（21 项、无 `a2a_*`、设备名不作为工具名暴露）→ 远程 `tools/call` 在本机执行并回结果 → `tools/call` 设备名被拒 → 无 token 得 401。**已验过会失败**：把插件目录移走后，那一组如实变红。反证跑了两轮才收敛——第一轮的失败详情打印了整个 `available_commands_update` 帧，一行几千字符
- fix: **`scripts/install.sh` 在完整 checkout 上必然失败**。第 94 行硬编码 7 个 `src/*.ts` 的必检清单，删 `filetools.ts`/`fileguard.ts` 时没跟着删，于是实装报 `incomplete checkout?`。手写清单是模块图的第二份真相，删模块时必然过期。改为脚本自己走**传递** import 图（裸标识符跳过——那是包名的事，不是「checkout 不完整」；路径归一交给 `realpath -m`）
- test: 第四组跑 `install.sh` 本身：临时 `OMP_AGENT_DIR` 上实装、`--status`、`--uninstall`，外加**反证**——移走 `src/bridge.ts` 传递引入的 `audit.ts`，脚本必须以 `unresolvable relative import` 拒绝。反证特意用传递依赖而非入口直连项，否则只证明了脚本读了入口那一行。移走的文件在 `finally` 里复原，核验不留脏工作区
- docs: 两版 README 与 `docs/testing.md` 里「端到端无自动化覆盖」的说法改掉，`docs/testing.md` 增一节把两个目录的实测行为与那条错误结论的来源写明
- docs: 修四处删文件传输面时漏掉的失效描述——「首次启动生成配置、token 与文件沙箱」（实测生成的 `a2a-bridge.json` 只有 `host`/`port`/`token`）、`/a2a` 「显示沙箱根与大小上限」（它只输出地址、端口、token 前缀）、`A2A_BRIDGE_AUDIT` 注为「审计路径沙箱」（实为审计日志路径）

> 上一条（2026-10-01）写的「宿主解析插件目录不受 `HOME` 影响，模拟新机器的探针一直在验真实环境里那份旧安装」——**方向对，机制错**。真实插件目录那份确实会被加载，但原因是探针没播种 `models.yml`，宿主压根没起 session，与目录隔离无关。原记录保留以说明这次误判是怎么发生的。

## 2026-10-01 — 首页与指南改写痛点：远程够不到本地设备

- fix: **CI 的 `site` job 红了**（上一提交引入）。headless 浏览器在 runner 上静默返回空 DOM（`dom=0B`），三个页面全被判 FAIL——而真因是浏览器没跑起来，不是图坏了。核验新增**控制项**：先请求一个不存在的页面（此时服务 404.html），控制项也空就以退出码 2 报「harness 坏了，下面的结果不作数」；顺带让 404 走真实的 `404.html`（此前是纯文本 `not found`）。CI 侧改为装 playwright 的 chromium 并用 `CHROME` 指过去，不再赌镜像自带哪个浏览器


- docs: hero 与 feature 卡片此前全在讲「我是什么」（协议版本、端口、token），没有一句讲「你为什么来」。改为先说痛点：Agent 跑在服务器上、设备插在本机，中间的 USB 没人能跨；hero 改为「让远程的 agent 操作你本地的设备」，tagline 落到 adb / idf / 串口工具与宿主挂载的调试设备
- docs: README（中英）新增「设备 / Devices」一节，并成为 feature 卡片「远程能碰到什么」的落点。两种形态都写清：**工具链走 `bash`**（adb、idf.py、烧录器不是 omp 的工具，是本机命令，PATH 上有什么就有什么）；**挂载设备走 `read` / `write` 的 `path`**（`read {"path":"xd://"}` 列清单，`write {"path":"xd://debug"}` 执行）
- 全部结论实测，不是推断：
  - 远程 `tools/call {"name":"bash","arguments":{"command":"adb version"}}` → 拿到本机 SDK 路径与 `Android Debug Bridge version 1.0.41`。通道通（该机当时未插设备，故 `adb devices` 为空）
  - 远程 `read {"path":"xd://"}` → `isError=false`，返回 5 个挂载设备：`xd://debug`（DAP 调试器）、`xd://lsp`、`xd://ast_edit`、`xd://omniroute_status`、`xd://omniroute_sync`
  - **`tools/call {"name":"xd://"}` 被拒**（`not exposed`）——设备不是独立工具名，只有 `read` / `write` 的 path 能到达。这是宿主的形态，桥不改写
  - `tools/list` 里一个 `xd://` 都没有（21 个工具），所以「远程能碰设备」这件事在目录上完全看不出来，只在正文里讲
- docs: feature 卡片顺手改掉三处已过期的描述（上一轮删掉的「6 个文件传输工具」「五个核验脚本」「跨机器安装」）
- docs: OG 卡片同步为痛点表述

## 2026-10-01 — 三个真实宿主核验接入 CI

- test: **核验不再需要模型凭据**。四个探针原先都拷 `~/.omp/agent/models.yml`（真实 provider + 真实 API key），这是它们只能在开发机上跑的原因。桥只跑工具、不推理，宿主启动只需要「有模型配置」——实测一个故意不可达的 provider 就能让宿主起来并把桥带起来。新增 `test/harness.ts` 提供该占位配置（`A2A_PROBE_REAL_MODELS=1` 可切回真实配置）
- ci: `ci.yml` 拆成三个 job。`check`（typecheck + lint + 单测）不变；新增 `host-probes` 装**与 devDependencies 同一版本**的宿主 omp 并跑四个核验；新增 `site` 构建文档站并跑渲染核验（`render-check` 会断言 SVG 内的标签文本与每页 SEO 头）
  - 宿主版本从 `package.json` 的 pin 读出再装，不写死：探针跑在被 pin 的版本上正是版本漂移那三次事故的教训
  - `test:approval` 在 CI 里仍占约 95s——它**故意**把 bash 调用挂到调用方超时，那个挂起就是被测行为
- 本机复跑：SMOKE OK、HARDEN OK 29/29、VERDICT B（exit 0），三者均用占位 provider

## 2026-10-01 — `test:install` 停止验证错的对象，改为核验发布包自包含

- fix: **`test:install` 一直在验真实环境里那份旧安装**。探针只设 `HOME`=临时目录，但宿主解析插件目录不受 `HOME` 影响——实测往假 HOME 装一个只会打印标记的扩展，标记没出现，真实 `~/.omp/plugins` 里那份桥却起来了。于是每一条「新机器」断言都在重测陈旧副本。`XDG_DATA_HOME`、`OMP_PLUGIN_DIR`、改 `cwd` 都试过，没有一个能改变插件发现
- refactor: 该核验改为只测它真能观测的边界——**发布的 tarball 装得上去、装完能加载**（17 项）。三组：manifest（有 `name`/`version`/`pi.extensions`、无 runtime 依赖、`files[]` 含两半）、打包（`npm pack` 出 tarball、体积 < 500KB 不含 `node_modules`、解出 `package/` 根）、内容（入口与 5 个 `src/*.ts` 都在、**从入口走相对 import 图每个模块都能在包内解析**）。第三组是关键：`files[]` 漏一个模块会**装得上、加载时才炸**，逐个断言文件名会被新增模块绕过，走 import 图才抓得到
- test: 核验自身验过会失败：`files[]` 去掉 `src/` → 5 项 FAIL；`files[]` 精确列文件但漏掉入口 import 的模块 → 精确报出 `src/scratch-mod.ts` 缺失
- docs: `docs/testing.md` 与 README（中英）如实写明 **`omp install <git-url>` 的端到端目前没有自动化覆盖**，并给出原因。恢复它要先搞清楚宿主的插件发现机制，那是独立任务——在这个核验里自己搭目录隔离，等于对别人的布局另立一套权威
- fix: 删掉核验里遗留的未使用 `OMP_BIN`（biome warning，2.x 下 warning 不影响退出码，故前一轮 lint「全绿」时没看见）

## 2026-10-01 — 把本质需求与原则写进仓库

- docs: `AGENTS.md` 新增「What this is」与「Principles」两节。本质需求一句话：**复用本机已经跑着的那个 omp**；桥只负责把调用送到，不在途中加意思。四条原则（不重复造轮子 / 不替 omp 实现沙盒 / 不按权限过滤 / 不长出第二个系统）都从这一句推出，不是并列的偏好
- docs: README（中英）「v1 边界」后加「设计取舍」段。原先这些约束只存在于对话里，仓库里没有任何地方写下，读遍代码的人会重新发明 `deny`、重新长出 675 行沙盒——本轮就是这么发生的
- 原则写完后不加解释。写长了就成了新的可解释空间，而原则的价值恰恰在于它不留余地

## 2026-10-01 — 极简：删掉文件传输与第二套权限

按「极简 / 不重复造轮子 / 不替 omp 实现沙盒 / 不替 omp 管权限」四条，桥缩回成接口转换器。**源码 1460 → 655 行，减 55%。**

- **删除桥自带的 6 个 `a2a_file_*` 工具**（`src/filetools.ts` 460 行 + `src/fileguard.ts` 215 行）。这些能力宿主工具已经给了：远程能调 `mcp__omp-host__bash`，`cat` / `base64 -d >` / `ls` / `dd` 分别覆盖 get / put / list / 分块。为此付出的代价是 675 行实现 + 1216 行测试（测试是实现的两倍），以及**一个已经证明会自己生产 P1 的状态机**：分块 seq 的 TOCTOU 写坏文件、串行化修复自身引入的活性竞态、`.tmp` 暂存目录可寻址被枚举/改写他人上传
- **删除 `deny` / `denyMCPTools`**：这是第二套权限名单，与宿主自己的工具配置可以互相矛盾，而代码里没有定义冲突时谁优先。`tools/list` 现在是 `pi.getAllTools()` **原样透传不过滤**——含 `hidden` 工具、含宿主当前对自己模型禁用的工具。**omp 是什么权限，桥就是什么权限**；要收紧就配宿主，桥不参与
- **删除 `fileRoot` 沙盒**：桥不解释路径。执行走宿主 `Main` 会话的 `getToolByName().execute()`，注入真实 `session.settings` 与 `ExtensionContext ui`，所以宿主审批门（`ExtensionToolWrapper`）照常生效，桥自己一套审批逻辑都没有——删掉 `a2a_file_*` 之后，「绕过审批门所以要自带沙盒」这个因果链也一并消失
- 配置只剩 `port` / `host` / `token` 三个字段。`config.test.ts` 与 `hardening.ts` 里随功能消失的用例一并删除；`bridge.test.ts` 改为断言**注册表原样透传**与**目录外名字一律拒绝**
- 代价（如实记）：100MB 文件不再走 MCP 通道，走 SSH/`scp`（README 早已这么建议）；`a2a_file_put` 的原子落盘（`.tmp` + `rename` + 0600）没有了，远程写文件用宿主的 `edit`/`bash`；远程会看到 `hidden` 工具——这是「不过滤」的必然结果
- 核验：`tsc` 0 errors；`bun test` 114 → **54**；`SMOKE OK`（21 工具全透传、`tools/call` 真实执行）；`HARDEN OK` 29/29；approval 核验 **VERDICT B**（bash 挂起 90s、无副作用、审计 start=1 done=0，exit 0）——审批挂起语义跨这次大改未变。`test:install` 装的是远端代码，推送后才可验

## 2026-10-01 — lint 恢复为有效守卫

- fix: **`bun run lint` 从 `5107bad` 起一直是红的**，持续到本次才修。CI 真实失败原因（`gh run view --log-failed` 查得）共 4 errors + 1 warning：`.agents/skills/.../plugin.json` 与 `skills-lock.json` 的 format（上游用空格缩进，本仓库 `indentStyle: "tab"`）、`website/.vitepress/config.ts` 与 `website/scripts/sitemap.mjs` 的 format、config.ts 的 `noUnusedFunctionParameters`
- fix: 前两个是**范围错误**而非缺陷——它们是外部 skill 安装器的产物，与 `node_modules/` 同类，只是恰好被提交进了版本库。gitignore 管「不该进版本库」，biome 管「该由本仓库负责」，这是两个维度；提交进 git 只改变它被追踪的状态，不改变它的来源。按 biome 2.2.0 的 `useBiomeIgnoreFolder` 规则（忽略目录**不写** `/**`）在 `files.includes` 加 `!.agents` 与 `!skills-lock.json`，覆盖将来安装的任何 skill
- **教训：发现守卫失效时先问「它为什么失效」，而不是逐个修它报出的错。** 逐个修是治标，下次重装 skill 即复发。与 brain 里「守卫失效的两种形态」同源——一个必然失败的检查等于没有检查，它只提供噪音，人看久了就学会无视红灯
- 遗留（未修，需另行决策）：biome 2.x 下 **warning 不影响退出码**（实测 `--diagnostic-level=warn` 仍 exit 0），所以 `noUnusedFunctionParameters` 从设计上就拦不住任何人，它被报出来只是噪音

## 2026-10-01 — 用词统一与站点核验加固

- docs: 活文档中的「探针」统一改为「核验」——`docs/testing.md`（含标题）、README（中英）、站点 nav / 侧边栏 / 首页 feature 卡片。同一个表格里原本「加固核验」与「判别探针」混用，现已一致；`test/approval-probe.ts` 是文件名，不动。CHANGELOG 与 brain timeline 内的历史条目按 append-only 保留原词
- fix: `render-check.mjs` 硬编码 `chromium-browser`——本机是这个名字，GitHub 的 ubuntu runner 是 `chromium` 或 `google-chrome`，会在 deploy 阶段因「找不到可执行文件」而非真实缺陷失败。改为按候选列表探测并支持 `CHROME` 覆盖
- fix: `CHROME` 指向不存在的路径时 spawn 抛未捕获 `error` 事件，打的是 Node 堆栈、看不到原因。补 `proc.on("error")` 给出可读信息
- docs: 首页 hero 与 feature 卡片按 adam 文风校订（见下条）

## 2026-10-01 — 新增「与 computer use 的区别」

- docs: 新增 [docs/computer-use.md](docs/computer-use.md)——按名字调工具与看屏幕猜坐标点按的差别。站点接为 `/computer-use`，进 nav 与侧边栏，首页加一张 feature 卡片
- fix: 站点文案主体此前写成「远程 omp 调用宿主 omp」——**主体搞错了**。桥实现的是 MCP `2025-11-25`，任何 MCP 客户端都能接，调用方与宿主是否同机、是否同为 omp 都不影响。hero 改为「让任意 agent 调用本机这个 omp 的工具」，tagline 补 `url` + Bearer token 与三个具体调用方（另一个 omp / Claude Code / 一段 curl）；`config.ts` 的 `description`、OG 卡、`computer-use.md` 里 6 处「远程」一并改掉。原写法把 README 的一个 `mcp.json` 示例当成了主体
- fix: **`CHANGELOG` 从未做过链接重写**——条目里的仓库相对路径（`docs/xxx.md`）在站点上是死链，VitePress 会因此构建失败。此前没暴露是因为 CHANGELOG 里一直只有站点同名的 `docs/protocol.md` / `docs/testing.md`，这次写了新的 `docs/computer-use.md` 才触发
- docs: 首页 feature 卡片由提纲腔改为句子（「单测矩阵、真实宿主 E2E 四件套、审批判别探针」这类并列名词换成「五个探针起真实的宿主 omp 跑完整流程——含跨机器安装」）；404 的 quote 原本在猜原因（「可能是链接过期」）改为陈述事实（本地址下没有 .md 文件）；footer copyright 补年份与作者
- fix: `config.ts` 里 `description` 与 `transformHead` 的兜底值曾是两份独立字符串，会各自漂移——提取为 `SITE_DESC` 单点引用
- docs: 站点文案按 adam 文风校订——首页 feature 卡片由提纲腔（「单测矩阵、真实宿主 E2E 四件套、审批判别探针」这类并列名词）改为句子；404 的 quote 原本在猜原因（「可能是链接过期」）改为陈述事实；footer copyright 补年份与作者
- 论证落在两处：执行的是宿主原生工具实现（不需要窗口摆着、不需要程序支持无头），目录是 `tools/list` 显式给出的（名字写错得 `not exposed`，坐标点错就是点到别的东西）。另附代价对照（上下文开销、宿主 token、稳定性、前提）
- 明确一处易误解：「不经过模型」指的是**宿主**这一侧，远程那台机器上的模型照旧要推理，只是把推理用来决定调哪个工具而非算坐标——两边 token 账要分开算。`a2a_file_get` 的 base64 仍进远程上下文
- docs: README（中英）「安全与边界」后各加一行指向该页；`sync.mjs` 补 `](docs/computer-use.md)` → `](./computer-use.md)` 重写（漏了会在站点构建时报断链）

## 2026-10-01 — 网站修复（4 项，含 1 项此前从未生效）

- fix: **JSON-LD 从未真正生效**——`transformHead` 写成 `["script", { type, innerHTML }]`，而 VitePress 渲染的是 `["script", attrs, innerHTML]` 三元组，`innerHTML` 被当成 HTML **属性**序列化，`<script>` 体内是空的。标签在 review 里看着齐全，爬虫读到的是零结构化数据。改为第三个元素
- fix: **`og:image` 指向 SVG**——Twitter/X、Facebook、Slack 都不渲染 SVG 社交卡片，等于没有卡片。新增 1200×630 PNG（`public/img/og.png`，可编辑源 `og.svg`），补 `og:image:width/height/alt`，`twitter:card` 由 `summary` 改 `summary_large_image`（630px 高的卡片按 summary 会被压成方形）
- perf: **每页预载 1.58 MB JS**——`withMermaid` 的 Vite 插件把 Mermaid 组件**静态**注册进 app entry，mermaid 及其约 40 个 diagram 类型因此进入 entry 的 import graph，而 VitePress 会预载 entry 的 dynamic imports，于是**每个页面**都在首屏前拉取全部 mermaid 代码，包括四页根本没有图的页面。弃用 `withMermaid`，保留其 markdown fence 渲染、组件改由 `.vitepress/theme/index.ts` 里 `defineAsyncComponent` 按需加载：阻塞预载降到 1–2 KB，空闲预取 169 KB，app entry 从 684 KB 降到 1 KB
- fix: **sitemap `lastmod` 每次部署都是当天**——原实现取构建产物的 mtime，即 CI 运行时间，等于宣称「所有页面每次都变了」，搜索引擎会直接忽略。改为取各源文件（`README_ZN.md` / `CHANGELOG.md` / `docs/**`）的最后提交日期；`deploy.yml` 的 `actions/checkout` 相应加 `fetch-depth: 0`（浅克隆无历史，git 会对所有页面返回同一个 commit，正是要避免的信号）
- fix: sitemap 的站点地址原是 `sitemap.mjs` 里硬编码的兜底常量，而 build 并不传 `SITE_URL`——与 `config.ts` 推导出的地址可能不一致。改为同一套推导逻辑（`GITHUB_REPOSITORY` → `owner.github.io` + base），`SITE_URL` 保留为本地预览的覆盖入口
- fix: `robots.txt` 原是静态文件里的**第二处**硬编码 origin（仓库改名即失效）——改由 `sitemap.mjs` 一并生成，与 sitemap 同一个地址
- fix: sitemap 的源文件映射此前漏了 superpowers 两页，会退回全仓最新提交日；补 `docs/<page>.md` 兜底。实测七页日期各不相同（superpowers 09-10、testing 09-30、其余 10-01）
- docs: 站点 UI 中文化——默认主题的界面文案是英文，zh-CN 站点上是「半成品」外观。补 `search` 弹窗与按钮、目录、回到顶部、跳到正文、外观、上一页/下一页、本页目录，以及 404 页（此前是英文的 "PAGE NOT FOUND" + 一句英文引言）
- test: 新增 `bun run check`（`website/scripts/render-check.mjs`，28 项）——**Mermaid 图是客户端渲染的，构建通过不等于图能画出来**。探针用 headless chromium 载入构建产物，断言 SVG 内的中文标签文本（mermaid 把非 ASCII 转成实体，需先解码），并检查 canonical / og:image 为位图 / twitter:card / 每页 JSON-LD 类型。已接入 `deploy.yml`
  - 写探针时踩了三个 harness 假阴性（都不是站点缺陷）：`cleanUrls` 下请求 `/protocol` 拿不到 `protocol.html`；Pages 的 base 前缀（`/pi-a2a-ext/`）没处理时 entry JS 404、页面不 hydrate，症状与「图坏了」完全一样；「parse error」正则命中的是 `protocol.md` 正文里作为 JSON-RPC 错误码讲解的 `parse error`。前两个已修，第三个改为只扫 SVG 段
  - 探针本身也验过会失败：把组件改成提前 `return` → 两页 FAIL；把 `og:image` 改回 SVG、JSON-LD 改回属性写法 → 对应两项 FAIL

## 2026-09-30 — 定位文案改写

- docs: README（中英）首段改写——去掉术语堆砌的 tagline 式表述，改为讲清实际作用：装上后运行中的 omp 多一个 MCP 接口，远程 omp 配好地址即可调用本机会话里的工具、执行本机真实文件与 shell，宿主不做模型推理故不消耗 token
- docs: 首页 hero 主副标题改为作用导向（主：「让另一台机器直接调用本机会话的工具」），副标题说明装上即多一个 MCP 接口、调用本机真实工具、宿主不做模型推理；替换原协议版本术语堆砌

## 2026-09-30 — 网站 SEO

- feat: VitePress `transformHead` 补齐 VitePress 默认不产出的 SEO 信号——每页 **canonical**、**Open Graph**（title/description/url/image/locale/site_name）、**Twitter Card**、`WebSite` **JSON-LD**（schema.org）
- feat: build 末尾生成 `sitemap.xml`（`scripts/sitemap.mjs`，扫 dist 全部 HTML 排除 404，输出绝对 URL + lastmod；CI 镜像源无 `vitepress-plugin-sitemap`，故自写），新增 `public/robots.txt` 指向该 sitemap

## 2026-09-30 — 架构图改为 Mermaid

- docs: README（中英）「工作原理」的 **ASCII 字符图换成 Mermaid 图**（`graph TB` + 高对比 classDef + Unicode 语义符号），GitHub 原生渲染为矢量图，跨平台一致
- docs: `docs/protocol.md` 的 `tools/call` 节新增 **Mermaid 时序图**（`sequenceDiagram`），画一次完整往返：远程 `tools/call` → 鉴权/查会话 → `getToolByName().execute()` → 宿主工具执行 → 受控端 TUI 的 `emitExternalEvent` 卡片显示 → 审计 start/done，三种出口（成功/未暴露/审批挂起）用 `alt` 分支标明
- build: 网站接入 `vitepress-plugin-mermaid`（`withMermaid`），使用指南页的架构图在站点内渲染为 SVG，不再是代码块

## 2026-09-30 — 受控端显示远程操作

- feat: 受控端（宿主 omp）现在会显示远程 `tools/call`——远程调用宿主工具时，宿主 TUI 按和本地操作**完全一样**的方式渲染出工具卡片（同样的卡片、同样的执行生命周期）。此前远程调用直接 `tool.execute()` 执行、受控端界面毫无痕迹，用户无从得知机器正被远程操作
- 实现：`runHost` 用同一个 `toolCallId` 包住 `tool.execute()`，前后调 `session.agent.emitExternalEvent()` 发 `tool_execution_start` / `tool_execution_end`（本就是 TUI 渲染工具卡片所依赖的事件）。这些事件只驱动渲染、**不进消息流**，故远程调用不会进入 LLM 上下文、不会扰动会话——MCP 执行链路保持天然不变，扩展只补「显示」这一环。范围仅宿主工具，`a2a_file_*` 文件传输按约定不显示

## 2026-09-30 — `/a2a token` 子命令

- feat: 新增 `/a2a token` 子命令——打印完整 token（`/a2a` 状态行与启动通知只显示前 6 位前缀，远程接入需复制完整 token 时用此命令）。`/a2a rotate` 轮换行为不变
- docs: README（中英）Commands 节同步补充该子命令

## 2026-09-30 — 安装方式修正

- feat: **`omp install https://github.com/adam-ikari/pi-a2a-ext.git` 为跨机器安装方式**——装到 `~/.omp/plugins/node_modules/pi-a2a-ext`，`omp plugin uninstall pi-a2a-ext` 卸载。已提交并推送，在全新 HOME（无 config/token/沙箱）上实测：安装 → `pi-a2a-ext@0.1.0` → 宿主起桥并自建独立 token 与沙箱
- feat: 补 `version`（此前缺失致 `omp plugins list` 显示 `@undefined`，且 `npm pack` 直接失败 `Invalid package, must have name and version`）、`description`/`keywords`/`repository`/`homepage`/`bugs`；`files: ["extensions/", "src/"]`——入口 import 的是 `../src/*.ts`，两者缺一则装上也起不来。tarball 实测 12 文件 25.8kB，不含 `node_modules`（`@oh-my-pi/*` 由宿主 shim 运行时重定向）
- docs: 记录 `omp install` 的 spec 限制——接受**目录或 git URL，不接受 `.tgz`**（报 `ENOTDIR`），GitHub `owner/repo` 简写被当作非法包名，须用完整 URL
- test: 新增 `bun run test:install`（26 项）——用独立 `HOME` 模拟另一台机器，走 `omp install <git-url>` 装到全新插件目录，再以远程 MCP 客户端身份走完整流程：manifest/打包文件、首次启动自建 config/token/沙箱、initialize 握手、文件往返、沙箱边界、鉴权、审计。这是**唯一**验证「任意机器可装」的探针——`test:files` 自己软链扩展到沙箱 agentDir，证明桥可用但完全没碰安装链路
  - 写这个探针时踩了两个 harness 坑（都由探针自身暴露，非产品缺陷）：`--print` 带 prompt 跑完一轮即退出，桥随之消失，远程调用得到 `ConnectionRefused`（须用 `--mode rpc` 且不传 prompt、stdin 保持打开）；以及以 `proc.exitCode === null` 作为轮询条件会在最后一个 stdout 分片到达前提前退出，把「桥正常」误报为「桥没起来」——最终改为**直接 HTTP 探测**（真实客户端做法），不再刮 stdout
- feat: **`omp install .` 为本地开发的首选方式**（软链仓库到 `~/.omp/plugins/node_modules/pi-a2a-ext` 并注册，卸载用 `omp plugin uninstall pi-a2a-ext`）。此前 README 只给了手写软链，从未提到 omp 自带的插件安装

- fix: **安装说明的 `ln -s "$PWD/..."` 是错的**——该写法只在 `$PWD` 恰为仓库根目录时成立；换个目录执行会链到不存在的路径（实测 `cd /tmp` 后链成 `/tmp/extensions/a2a-bridge.ts`），桥静默不启动、无任何报错。改为 `scripts/install.sh`：从 `BASH_SOURCE` 推导仓库根目录，装完**校验**软链可解析且入口 import 的模块齐备，装坏了当场报错
- feat: `scripts/install.sh` 另提供 `--status`（只报告状态，坏了非零退出）与 `--uninstall`（删软链，保留 token 配置与审计日志）；`OMP_AGENT_DIR` 可改安装位置
- fix: `--status` 用 `readlink -f` 判活时，**悬空软链会打印空串且退出 0**（`readlink -f` 对断链非零退出且无输出）——已改为比对 `readlink` 原始目标并用 `[ -e ]` 判存在
- fix: 安装目标若已是**真实文件**（用户自己的扩展），脚本拒绝覆盖并退出 1，不再静默替换
- fix: 删除 `package.json` 里无效的 `"pi": { "extensions": [...] }` 声明——`omp plugins list` 只列出已安装的 npm 插件，**不读取本地 package.json 的该字段**，故此前的「或把本仓库作为插件」从来不可用
- **revert（同一提交内更正）**：上一条是**错的**，该删除已回滚。`omp install .` 正是靠 `pi.extensions` 才能工作——`omp install --json` 显示删除后 `manifest` 为 `{}`，实测宿主不加载任何扩展；恢复后 `manifest.extensions` 有值、扩展正常加载。**判据不是「`omp plugins list` 里有没有它」（那是已安装插件列表，与 manifest 解析无关），而是 `omp install --json` 的 `manifest` 字段加上宿主是否真的加载。**

## 2026-09-30 — 双语 README（英文默认 + 中文 `_ZN`）

- docs: `README.md` 改写为**英文**（GitHub 默认展示），中文内容移入 `README_ZN.md`，两版顶部互相链接
- docs: 两版补齐此前遗漏的 `src/fileguard.ts` / `src/filetools.ts` 文件布局行与 `bun run test:files` 命令
- fix: 文档站 `scripts/sync.mjs` 改读 `README_ZN.md`——原先读 `README.md`，若不改会在中文导航「指南」下渲染英文，且语言切换行指向站外不存在的路径；同时剥掉该行（站点单语言）
- docs: brain 中 2 处硬编码 README 行号（`README:103`/`README:105`）改为章节引用，避免下次改文档再次失效；timeline 内 3 处按 append-only 保留原样（历史证据不改写）

## 2026-09-30 — 代码评审修复（文件面 4 项 + 版本漂移）

- fix: **串行化后排队中的步骤会往「已改名的死路径」写入**（P1，由修复自身引入、对抗探针抓出）——`requireTransfer` 在同步阶段取记录、变更本体稍后才在队列上跑；其间若一次 `put_end` 成功提交并已 `rename` 走暂存文件，排队中的 `put_chunk` 会让 `appendFile` **重新创建**该文件，返回 `{"ok":true,"receivedBytes":12}` 而已提交文件仍只有前 8 字节：**字节静默丢失**，且在 `.tmp` 留下一份永远无人回收的孤儿 `.part`。串行步骤内改为先 `requireLive(tr)` 重验记录仍在册
- fix: **`put_chunk` 的 seq 校验有 TOCTOU，并发重试静默损坏文件**（P1）——校验读 `expectedSeq`、自增却在 `await appendPart` 之后，同一 seq 的两个并发请求都能通过校验并都写入；未声明 `totalBytes` 时 `put_end` 报**成功**而文件已是双倍内容，声明时则整个传输报废。这不是假想场景：README 要求调用方自设超时（无 UI 时 `prompt` 审批挂起 ≥90s），超时重试正好并发打出两个相同 seq。同一 transfer 的变更步骤（`put_chunk`/`put_end`）改为串行执行，且**同 seq 同字节的重传按已收处理**（返回 `duplicate: true`）而非双写——重传是超时后的常规动作，不该损坏上传；同 seq 换内容仍报 `bad_chunk_order`。队列吞掉拒绝，单步失败不会卡死后续分块
- fix: **未翻译的宿主 fs 错误泄露绝对路径并破坏错误码契约**（P2）——`ENOTDIR`（父级是文件）、`put_end` 撞目录等原先以裸 errno + 宿主绝对路径直达调用方，既与「500 body 不得泄露宿主内部」的既定立场矛盾，也让按 `a2a_file_error <code>` 解析的客户端失效。兜底为新枚举 `io_error` + 固定文案，细节只进宿主 stderr；`put_end` 补 `is_a_directory` 预检
- fix: **暂存目录 `.tmp` 可寻址，会话绑定形同虚设**（P2）——`.tmp` 只在 `list(".")` 被过滤，直接以路径访问不受限：可枚举他人 `transferId`、读取其在途暂存字节、`put` 改写其暂存文件导致对方 `put_end` 把攻击者字节落成最终文件。首段为 `.tmp` 一律 `invalid_path`（嵌套 `sub/.tmp/x` 仍合法）
- fix: **`a2a_file_list` 跟随符号链接目录**（P3）——只过滤了子项，目标本身用 `stat` 检查，根外目录的**文件名/大小/mtime** 因此泄露；改用 `lstat` 并拒绝符号链接。文件内容始终由 `resolveInRoot` 的 realpath 包含性检查挡住，故此前仅为元数据泄露
- perf: **`a2a_file_get` 每页重算整文件 sha256**（P3）——100MB（默认 `maxFileBytes`）实测每页 76ms、整趟下载 30.4s 纯哈希，而每页只传出 256KB（400 倍读放大，且随文件平方增长）。改为**本次返回区间**的摘要：0.9s。`sha256` 语义随之明确为区间摘要，`totalBytes` 仍是整文件大小
- test: 单测 100 → **114**（新增并发同 seq 不双写、8 路同 seq 突发、乱序 seq 并发保序、200 块长传输字节精确、排队 vs 提交不写死路径、同 seq 异字节拒绝、重传幂等、失败步不卡死、`.tmp` 不可寻址、跨会话暂存不可改写、list 符号链接拒绝、错误码契约与路径不外泄、`get` 区间摘要）；真实宿主探针 `test:files` 54 → **71** 项，两条并发用例（同 seq 突发、排队 vs 提交）跑在真实 HTTP 上而非进程内
- chore: pi-* pin 与 lockfile 同步至 **18.4.4**（宿主已升级；node_modules 漂移同一机制再次复发，版本守卫如期捕获）
- ci: 新增 `.github/workflows/ci.yml`（`bun install` + typecheck + lint + test）——「pin == 宿主」不变量此前三次靠单测事后捕获，CI 的 frozen-lockfile 安装把「pin 与 lockfile 不一致」提前到提交时就失败

## 2026-09-29 — 双向文件传输（桥自带工具）

- feat: 6 个 `a2a_file_*` 工具（put / put_start / put_chunk / put_end / get / list），远程→宿主 push 与宿主→远程 pull 双向；线格式复用 A2A FilePart 的 `{name, mimeType, bytes(base64)}`，**不新增 JSON-RPC 方法**——挂进既有 `tools/list` / `tools/call`，因此鉴权、会话、`deny` 门禁与两阶段审计原样生效
- feat: 分块写入纳入首版（内联与单块 512KiB、单次读响应 256KiB，均留在 1MB 请求体上限内），单文件默认上限 **100MB**；传输状态绑定 `Mcp-Session-Id`，空闲 30 分钟惰性回收（无定时器），并发上限 16
- feat: 配置新增 `fileRoot`（默认 `~/.omp/a2a-bridge-files`）与 `maxFileBytes`，逐字段 fail-closed 校验照旧
- feat: 落盘沙箱 `src/fileguard.ts`——词法拒绝对外路径/`..`/NUL/控制字符/`.` 段，最深存在祖先 `realpath` 后必须仍在根内，根内符号链接既不顺着读也不顺着写；根创建为 0700 且拒符号链接，不得是配置文件或审计日志的祖先目录；写入经 `<root>/.tmp` 原子 `rename`，文件 0600
- feat: 审计脱敏——参数内超过 120 字符的字符串（文件 base64 正文）只记 `<len:N,sha256:前8位>`；`a2a_file_put_chunk` 整体不逐块记录，由 start/end 两条夹住
- feat: 名字冲突策略为**宿主优先**（桥工具绕过宿主审批门，故不允许反向遮蔽），首次遮蔽时宿主 stderr 一次性告警
- fix: `a2a_file_put_end` 未创建目标父目录，导致分块上传到尚不存在的子目录时 `rename` 直接 ENOENT——由真实宿主探针（`bun run test:files`）捕获，单测此前只用顶层路径而漏掉
- test: 单测 59 → **100**（新增 `fileguard` 16、`filetools` 18、`bridge` 桥工具与脱敏 4、`config` fail-closed 3）；新增真实宿主探针 `bun run test:files`（54 项，`FILES OK`）
- fix: 站点内容同步脚本用 `replace` 只改写**首个**链接，README 第二次引用同一页时留下仓库相对路径 → Docusaurus 断链、构建失败；改为 `replaceAll`
- test: 版本守卫的宿主比对用例改用 30s 显式超时——`omp --version` 冷启动实测 ~8s，恒超 bun 默认 5s 而偶发失败
- docs: `docs/protocol.md` 新增「桥自带工具：文件传输」（工具表、`a2a_file_error <code>` 稳定枚举、分块语义），`README.md` 新增「文件传输」节与威胁模型（**桥自带工具不经宿主审批门**：token 即 `fileRoot` 内读写权；pull 回的字节会进远程模型上下文，大二进制建议 SSH 旁路），`docs/testing.md` 补核验矩阵

## 2026-09-28 — 站点配色改为 GitHub Primer 中性主题

- docs: 配色/可读性改版（零新增依赖）——Infima 变量、代码块、首页、侧栏、页脚全面换为 GitHub Primer 色板，明暗双模式实拍验证
- fix: 亮色模式代码块此前恒为深色——根因是 theme-classic 按 `themeConfig.prism.theme` 运行时注入内联 CSS 变量，静态 CSS 覆盖无效；自定义主题挂载于 `themeConfig.prism`（非 preset `theme.prism`），且主题对象须为 v1 `{plain, styles}` 格式（`id`/`name`/`type` 会被 schema 拒绝）

## 2026-09-28 — 宿主 18.4.0 回归与基线修复

- docs: 站点视觉改版——品牌色板（青/紫，明暗双模式）、首页重做（渐变网格 hero + MCP 调用终端示意 + 数据条 + 特性卡图标 + 三步接入）、SVG logo/favicon、导航栏 GitHub 入口；零新增依赖（`navbar.logo` 为 3.10 中导航 logo 的正确挂载点）

- chore: `.gitignore` 收录 `.qoder/` 本地设置目录，恢复 `bun run lint` 干净基线（929b9aa）
- chore: 宿主 omp 升级至 **18.4.0**；node_modules 漂移（同一未知机制第三次复发）被版本守卫捕获，pi-* pin 与 lockfile 同步至 18.4.0（531f7a1）
- test: 18.4.0 全量回归——tsc 0 错误、单测 59/59、SMOKE OK（21 工具）、HARDEN OK 29/29、审批探针 VERDICT B（挂起语义与两阶段审计行为跨版本未变）

## 2026-09-24 — 文档补充与 P3 收尾

- docs: 站点发布至 GitHub Pages（<https://adam-ikari.github.io/pi-a2a-ext/>），push master 经 GitHub Actions 自动构建部署；`url`/`baseUrl` 按 `GITHUB_REPOSITORY` 环境感知（本地预览仍是 `/`）
- docs: Docusaurus 文档站（`website/`：构建时同步 README/CHANGELOG/docs 进生成目录 `website/content`，中文界面，首页 + 指南 + 协议 + 测试 + 变更日志 + 历史设计存档）
- docs: 新增 `docs/protocol.md`（wire 契约：传输、处理顺序、会话生命周期、方法示例、错误码总表）、`docs/testing.md`（单测矩阵、三 E2E 判读含审批探针 VERDICT A/B/C）、`CHANGELOG.md` 与 README 故障排查节
- chore: 新增 MIT `LICENSE`、`package.json` `license` 字段与 README 许可节（d4930b9）
- chore: 引入 Biome lint/format（tab 缩进、120 列、recommended 规则，2 空格 JSON 不受管），新增 `bun run lint`，存量风格归一（5b2342f）
- feat: 审计记录携带 `Mcp-Session-Id`——共享 token 下调用可归因到客户端会话（单测 + 加固探针双重断言）（c20dc4e）
- refactor: 移除全部 3 处 `as never`：`TSchema` 从 `ToolInfo` 原生流入 `toolWireSchema`，`execute()` 上下文对真实 `AgentToolContext` 逐字段校验（变异测试验证校验非空洞）（806ad85）
- fix: 500 响应体固定为 `internal error`，宿主内部细节只进服务端 stderr（e7393eb）

## 2026-09-24 — 元评审修正（第一轮收尾）

- docs: README 实话修正——无 UI 下 prompt 审批挂起 ≥90s（非 `isError`，调用方须自设超时）、默认 yolo 下 token 即工具执行全权、两阶段审计格式、宿主 omp 版本事实更正为 **18.2.10**（18.2.11 是 registry latest 的误读）（f332b4a）
- test: 真实宿主加固核验（29 项）与审批判别探针落仓为手动脚本 `test/hardening.ts`、`test/approval-probe.ts`，接入 `test:hardening` / `test:approval`（6e0414a）
- test: 版本守卫 `test/versions.test.ts`——pi-* pin 必须精确、实装 == pin 硬断言、`omp --version` ≠ pin 告警（4ffdbf7）
- feat: 审计改为**两阶段**——派发即写 `start`，未落定的调用（无 UI 审批挂起）在日志中可见（6162136）
- test: 单测审计路径 `A2A_BRIDGE_AUDIT` 沙箱化、断言与执行顺序解耦（9560729）

## 2026-09-23/24 — 评审加固第一轮

- docs: README 补充配置校验（fail-closed）、暴露语义、会话规则、审计日志与开发脚本（cf58cef）
- feat: fail-closed 配置校验（非法字段拒绝启动，仅 token 自愈并持久）、调用 ∩ 目录暴露交集门、JSONL 审计日志、端口占用回退告警（339a46b）
- fix: 协议加固——鉴权前置于一切状态变更、强制 `Mcp-Session-Id`（缺头 400 / 未知 404，通知同样受限）、版本协商固定 `2025-11-25` 不回显、会话表上限 64 淘汰最久未见（998f572）
- chore: `@oh-my-pi/pi-*` 以**精确版本**声明为 devDependencies，建立 pin == 宿主版本不变量（48d52ca）

## 2026-09-11 — 首版实现

- fix: 会话 TTL 改为命中刷新、过期条目惰性清理（d80237a）
- docs: README（安装、配置、远程 `mcp.json`、SSH 转发、审批语义）（a4ad053）
- test: 真实宿主 E2E 冒烟 `test/smoke.ts`（隔离 HOME 启动 omp、走完整 MCP 流程、`tools/call read` 落真实 Main 会话）（19a2259）
- feat: A2A bridge 核心——`Bun.serve` JSON-RPC 服务器（server/bridge/config/auth）、扩展入口 `session_start` 起服与 `/a2a` 命令（5a4bd02）

## 2026-09-10 — 设计与计划

- spec+plan: 按评审修正设计（pi-ai schema 导入路径、`buildCallTool` 签名、审批经 wrapper runner 而非 `ctx.ui`）（41ae4a2）
- plan: 实施计划 T1-T9（72bc255）
- spec: omp 即 MCP 服务器的 A2A bridge 设计（66517b1）
