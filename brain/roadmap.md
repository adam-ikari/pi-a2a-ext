---
slug: roadmap
title: Roadmap
role: milestones
updated: "2026-10-07T09:20:31"
---

# Roadmap

## 已发布

**v0.1.0**（2026-10-03，git tag + GitHub Release）——桥缩到接口转换器：宿主 `session_start` 时起 MCP 端点（MCP `2025-11-25`，Streamable HTTP，默认只绑 `127.0.0.1`），`tools/list` 是 `pi.getAllTools()` 原样透传，`tools/call` 落宿主 `Main` 会话的真实文件与 shell。另加 `POST /blob` 收原始字节。安装只有 `omp install <git-url>` 一条，不发 npm。

四项交付的完整边界在 `docs/`，取舍记在决定页 `a2a-mcp-bridge`。核验不是 `bun test` 一条：`test/smoke`、`test/hardening`、`test/blob-probe`、`test/install-probe`、`test/approval-probe` 各自起真实宿主，`website/scripts/render-check.mjs` 管站点那一侧（34 项）。**全绿只在这五六个都跑过之后才算数。**

## 版本漂移：守卫已从 warn 改成 fail（10-07 定）

「pin == 宿主版本」复发六次：09-28 三次、09-30 四次、10-06 五次、10-07 六次。根因有两条，都已确认：

- **宿主会自己动。** omp 有 `startup.checkUpdate`（默认开），启动时查更新。宿主升级不需要这个仓库做任何事。
- **CI 结构上看不见。** `check` 用 frozen-lockfile 安装，pin 与 lock 自洽；`host-probes` 装的就是 pin 本身，比的也是 pin。「宿主已升级」这个事实只存在于有宿主的机器上。

所以守卫的宿主比较**改成 fail**：没人必须处理的 warn 不是守卫。配套两条边界——无宿主时跳过（CI `check` job 的形态，反证过不会误红），确实要对着别的宿主跑时用 `A2A_SKIP_HOST_VERSION_CHECK=1`，打印大声的 SKIPPED。

仍然未知的：**是谁在改这个仓库的 node_modules**。六次都记成「同一未知机制」，这里不假装知道。守卫抓的是结果，不是这个机制。

## 明确不做（记下来免得反复讨论）

- **`/blob` 的路径根目录 / 白名单** —— 评估过并决定不做。代价：无根目录、无白名单，桥能写宿主能写的任何路径。见 `docs/protocol.md`「它放弃了什么」。
- **`GET /blob`** —— 有意 405，不是「还没做」。加它意味着桥开始**读**宿主任意路径（SSH 私钥、`.env`），比写更敏感。宿主那侧三个限制（`read` 单行 150 KB、`bash` 输出 768 KB、`artifact://N` 约 150 KB）实测原样列在协议页，让客户端知道为什么。
- **审批挂起的协议层修复** —— `ExtensionAPI` 只有 `on("tool_approval_requested")`，是宿主问扩展答的方向，扩展无法主动发起审批，没有入口可修。改为文档承诺：调用方自设超时，审计里留下 start-without-done 让挂起可见。
- **v1 未实现面** —— resources、prompts、SSE 推送、调用取消、并发与速率限制、OAuth / TLS。

## 下一步

没有已排期的里程碑。要立新的，先说清楚要解决什么问题——这页不预设方向。
