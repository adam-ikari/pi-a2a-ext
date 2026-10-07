---
slug: roadmap
title: Roadmap
role: milestones
updated: "2026-10-07T08:36:01"
---

# Roadmap

## 已发布

**v0.1.0**（2026-10-03，git tag + GitHub Release）——桥缩到接口转换器：宿主 `session_start` 时起 MCP 端点（MCP `2025-11-25`，Streamable HTTP，默认只绑 `127.0.0.1`），`tools/list` 是 `pi.getAllTools()` 原样透传，`tools/call` 落宿主 `Main` 会话的真实文件与 shell。另加 `POST /blob` 收原始字节。安装只有 `omp install <git-url>` 一条，不发 npm。

四项交付的完整边界在 `docs/`，取舍记在决定页 `a2a-mcp-bridge`。核验不是 `bun test` 一条：`test/smoke`、`test/hardening`、`test/blob-probe`、`test/install-probe`、`test/approval-probe` 各自起真实宿主，`website/scripts/render-check.mjs` 管站点那一侧（34 项）。**全绿只在这五六个都跑过之后才算数。**

## 唯一开着的线程：版本漂移守卫的盲区

「pin == 宿主版本」这个不变量已经复发五次（09-28 三次、09-30 四次、10-06 五次，宿主已到 18.6.1）。CI 补不了这个洞：`check` 用 frozen-lockfile 安装，pin 与 lock 自洽；`host-probes` 装的就是 pin 本身，比的也是 pin。两个 job 都没法知道真实宿主已经升级——**只有跑在有宿主的机器上的 `test/versions.test.ts` 看得见，而它目前对 `omp --version` 只 warn。**

后果：宿主升级后本地 `bun test` 会红，CI 会绿。这是设计上的取舍还是待办，尚未决定。三个选项（都得实测过才知道哪个成立）：

| 选项 | 代价 |
| --- | --- |
| 保持现状 | 漂移只在有宿主的机器上显形，靠人记得跑 |
| 有宿主且 ≠ pin 时让守卫 fail，无宿主时仍 warn | `check` job 没有宿主，得确认它不会误红 |
| 升宿主后跑一个固定脚本，同步 pin + lockfile + 全量回归 | 多一个入口，且拦不住「忘了跑」 |

这页不替它决定。

## 明确不做（记下来免得反复讨论）

- **`/blob` 的路径根目录 / 白名单** —— 评估过并决定不做。代价：无根目录、无白名单，桥能写宿主能写的任何路径。见 `docs/protocol.md`「它放弃了什么」。
- **`GET /blob`** —— 有意 405，不是「还没做」。加它意味着桥开始**读**宿主任意路径（SSH 私钥、`.env`），比写更敏感。宿主那侧三个限制（`read` 单行 150 KB、`bash` 输出 768 KB、`artifact://N` 约 150 KB）实测原样列在协议页，让客户端知道为什么。
- **审批挂起的协议层修复** —— `ExtensionAPI` 只有 `on("tool_approval_requested")`，是宿主问扩展答的方向，扩展无法主动发起审批，没有入口可修。改为文档承诺：调用方自设超时，审计里留下 start-without-done 让挂起可见。
- **v1 未实现面** —— resources、prompts、SSE 推送、调用取消、并发与速率限制、OAuth / TLS。

## 下一步

没有已排期的里程碑。要立新的，先说清楚要解决什么问题——这页不预设方向。
