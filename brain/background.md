---
slug: background
title: Project background
role: project background
updated: "2026-10-07T08:43:36"
---

# Project background

## Why

这台机器上已经跑着一个 omp，它带着这个人的文件系统、PATH 上的工具链、插在本机的设备。想让别处的 agent 够到这些，现状是重开一个 agent：SSH 过去起一个，那边是**另一个** agent 自己推理、自己干活，用的不是你的凭据、不是你的 PATH、碰不到串口。

本项目只做一件事——**把已经在跑的这个 omp 的工具暴露成 MCP 端点**。桥把调用送过去，不在途中加意思。

动机最初更窄：设备插在本地，agent 跑在服务器上，中间的 USB 没人能跨。

## Goals

- 任意 MCP 客户端（另一个 omp、Claude Code、一个 curl 脚本）把 `mcp.json` 指向端点，即可调用宿主 `Main` 会话的工具
- 执行落在宿主真实的文件与 shell 上。宿主不做模型推理，不消耗 token
- 桥不加自己的意见：不替 omp 实现沙盒、不按权限过滤、不长出第二个系统
- 一次安装（`omp install <git-url>`），不发 npm，没有第二条安装路径
- 每次远程调用可审计到 token 持有者以外的具体客户端会话

## Non-goals

- **不做 agent。** 发过来的是工具名和参数，推理在调用方那边
- **不是 `omp acp` 的替代品。** 要一个替你干活的本地 agent，用 `omp acp`
- **不发布到 npm。** 安装只有 `omp install <git-url>` 一条
- **不替 omp 管权限。** `tools/list` 是 `pi.getAllTools()` 原样透传，含 hidden 工具与宿主当前对自己模型禁用的工具
- **v1 不做**：resources、prompts、SSE 推送、调用取消、并发与速率限制、OAuth / TLS
- **两条代价按决定承担**：`POST /blob` 不过宿主审批门；桥自己解析路径，无根目录无白名单

## Target user

- agent 跑在别处、设备和文件在这台机器上的人——烧固件、adb、串口、宿主持挂的调试设备
- 想让自己的模型驱动本机工具的编辑器用户（`omp acp` 不合适时）
- 需要脚本化调用的人（一个 curl 脚本就够）
