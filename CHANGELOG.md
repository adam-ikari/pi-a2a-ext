# Changelog

本项目暂无 git 标签/发布版本，按日期倒序分节（组内按依赖顺序）；面向使用者与开发者的变更，纯内部记忆提交（`brain:`）不收录。括号内为 commit 短 sha。

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
