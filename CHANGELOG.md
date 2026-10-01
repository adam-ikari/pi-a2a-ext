# Changelog

本项目暂无 git 标签/发布版本，按日期倒序分节（组内按依赖顺序）；面向使用者与开发者的变更，纯内部记忆提交（`brain:`）不收录。括号内为 commit 短 sha。

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
