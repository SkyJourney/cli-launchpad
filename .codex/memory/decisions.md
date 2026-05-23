---
name: 项目决策
description: 当前关键架构、产品范围和安装策略决策
type: project
last_updated: 2026-05-23
commit: a2fbb54
---

# 项目决策

## 不使用 Electron

**结论：** 项目使用 Tauri 2，不引入 Electron 或服务端运行时。
**Why：** 产品目标是轻量桌面工具，Electron 的包体积和运行时开销不符合目标。
**How to apply：** 新功能应沿用 Tauri + React + Rust 架构，本地能力放在 Rust 层实现。
**See Also：** [[project_overview.md#技术栈]]

## 只聚焦三项核心 CLI

**结论：** 产品只支持 `claude`、`codex`、`agy` 三个 CLI。
**Why：** 核心功能是快速在项目目录中打开公司内部常用 AI CLI，不是通用 CLI 工具管理器。
**How to apply：** 检测、安装、启动、UI 状态和文档都只围绕这三个工具展开。
**See Also：** [[project_overview.md#核心-cli-范围]] [[feedback.md#不要扩展为通用-cli-管理器]] [[project_progress.md#当前状态]]

## Antigravity 使用 agy 作为官方主命令

**结论：** Antigravity CLI 以 `agy` 作为官方主命令；`antigravity` 只做保守兼容探测。
**Why：** 官方资料显示 Antigravity CLI 使用 AGY CLI；项目不再关注 Gemini CLI。
**How to apply：** UI 推荐启动命令和安装设计都应围绕 `agy`，不要把 `antigravity` 展示成推荐路径。
**See Also：** [[reference.md#官方-cli-资料]] [[feedback.md#不再关注-gemini-cli]]

## 安装命令必须来自官方来源

**结论：** 一键安装命令必须来自官方文档或官方推荐包，并在执行前展示来源和完整命令。
**Why：** 安装 CLI 属于用户机器上的高影响操作，尤其是 PowerShell 网络脚本，需要明确来源和风险。
**How to apply：** Claude 优先使用官方 winget 包或官方 PowerShell 脚本；Codex 使用官方 npm 包；Antigravity 使用官方 PowerShell installer。业务层使用结构化参数模型，不拼接自由字符串。
**See Also：** [[reference.md#官方-cli-资料]] [[feedback.md#修改前说明和确认]]
