---
name: 项目概览
description: 项目技术栈、架构边界、工具链和核心 CLI 范围
type: project
last_updated: 2026-05-23
commit: b99a354
---

# 项目概览

CLI Launchpad 是一个轻量桌面工具，用于在指定项目目录中快速打开公司内部常用 AI CLI 的 PowerShell 窗口。项目不做通用 CLI 管理器，当前产品范围只覆盖 Claude Code CLI、Codex CLI 和 Antigravity CLI。

## 技术栈

- 桌面壳：Tauri 2。
- 前端：React + TypeScript。
- 后端：Rust，负责 Tauri commands、启动编排、依赖检测、安装命令预览、SQLite 访问和平台相关逻辑。
- 数据：SQLite 存储目录、工具、Shell 配置、目录级参数和启动历史。
- Node 包管理器：pnpm，仓库只维护 `pnpm-lock.yaml`。

**See Also：** [[decisions.md#不使用-electron]]

## Windows 工具链

开发和打包环境应具备 Node.js、pnpm、Rust stable MSVC、Cargo、WebView2 Runtime、Visual Studio Build Tools 2022、MSVC C++ x64/x86 编译工具和 Windows SDK。

Rust 和 VS Build Tools 已在本机安装。Rust 可执行文件存在于用户级 Cargo bin 目录，但当前普通 PowerShell PATH 可能不可见；VS Build Tools 自带 CMake 和 Ninja，不要求它们在普通 PATH 中可见。

## 核心 CLI 范围

- Claude Code CLI：官方命令 `claude`。
- Codex CLI：官方命令 `codex`。
- Antigravity CLI：官方主命令 `agy`。

`antigravity` 仅作为保守兼容探测命令，不作为推荐启动命令。Gemini CLI 不进入检测、安装或启动范围。

## 资源状态

图标资源已完成并生成 ICO。主要文件是 `src-tauri/icons/icon.ico` 和 `assets/icon/final/icon.ico`，原始图保留在 `assets/icon/icon.png`。

## See Also

- [[decisions.md#只聚焦三项核心-cli]]
- [[feedback.md#不要扩展为通用-cli-管理器]]
