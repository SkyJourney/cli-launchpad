---
name: 项目概览
description: 项目技术栈、架构边界、工具链和核心 CLI 范围
type: project
last_updated: 2026-05-26
commit: cef5f60
---

# 项目概览

CLI Launchpad 是一个轻量桌面工具，用于管理常用项目目录，并在指定目录中快速打开公司内部常用 AI CLI 会话。项目不做通用 CLI 管理器，当前产品范围只覆盖 Claude Code CLI、Codex CLI 和 Antigravity CLI。

## 技术栈

- 桌面壳：Tauri 2。
- 前端：React + TypeScript + React Query + Zustand，承载项目、详情、参数编辑、设置和关于视图。
- 后端：Rust，负责 Tauri commands、启动编排、依赖检测、安装/更新执行、会话读取、SQLite 备份恢复、诊断导出和平台相关逻辑。
- 数据：SQLite 保存业务配置与安全启动历史；可重建缓存使用独立 SQLite 库。
- Node 包管理器：pnpm，仓库只维护 `pnpm-lock.yaml`。

**See Also：** [[decisions.md#不使用-Electron]]

## Windows 工具链

开发和打包环境应具备 Node.js、pnpm、Rust stable MSVC、Cargo、WebView2 Runtime、Visual Studio Build Tools 2022、MSVC C++ x64/x86 编译工具和 Windows SDK。

Rust 和 VS Build Tools 已在本机安装。Rust 可执行文件存在于用户级 Cargo bin 目录，但当前普通 PowerShell PATH 可能不可见；VS Build Tools 自带 CMake 和 Ninja，不要求它们在普通 PATH 中可见。

## 核心 CLI 范围

- Claude Code CLI：官方命令 `claude`。
- Codex CLI：官方命令 `codex`。
- Antigravity CLI：官方主命令 `agy`。

`antigravity` 仅作为保守兼容探测命令，不作为推荐启动命令。Gemini CLI 不进入检测、安装或启动范围。

## 启动与检测边界

- CLI 检测仅输出 `available` / `missing`，从 PATH 或已知用户级安装目录找到完整路径即为可用。
- 启动逻辑位于 Rust services 与 Windows platform helper；工具和安装程序在执行前解析为完整路径，Shell 固定为系统 PowerShell。
- 支持 Windows Terminal + PowerShell 和独立 PowerShell；CMD 已因执行注入风险停用。Windows Terminal 使用编码后的 PowerShell 命令避免参数被终端解析器拆分。
- 被动检测只解析可信路径，不执行候选 CLI 获取版本；用户参数始终以 PowerShell 字面值传递。
- 全局参数与项目级参数分离，项目级同名 flag 覆盖全局 flag。

**See Also：** [[decisions.md#启动必须使用解析后的完整可执行路径]]

## 会话与配置数据

- Claude Code 与 Codex 的历史会话按需读取本地文件并支持恢复；Antigravity 未公开可列出历史的数据源，只提供直接启动。
- 配置交换以 JSON 文件导入导出，导入在事务中按绝对目录身份合并，并忽略外部文件中的 Shell 执行字段。
- 关闭窗口策略保存在业务库中，并随版本化 JSON 配置交换；配置导入或数据恢复后同步更新当前进程策略。
- SQLite 是应用配置来源，不保存密钥；应用缓存不持久保存 CLI 会话标题或源路径。

**See Also：** [[decisions.md#会话历史按需读取本地事实来源]]

## 存储与可靠性边界

- 业务根目录为 `~/.cli-launchpad/`，其中 `data/` 保存业务库，`cache/` 可删除重建，`logs/` 保存受限诊断日志，`backups/` 保存一致性恢复点。
- 旧 `%APPDATA%\dev.local.cli-launchpad` 数据仅在稳定业务库不存在时迁移，旧数据不自动删除。
- 备份与旧库迁移使用 SQLite 一致性快照；恢复前创建保护备份并校验清单、完整性和 schema。
- 主业务库损坏或来自未来 schema 时会拒绝继续写入；当前尚无在主库无法打开时可进入的恢复专用界面。

**See Also：** [[decisions.md#业务数据使用稳定用户目录并提供一致性恢复点]] [[project_progress.md#可靠性治理完成]]

## 桌面体验与分发

- 桌面集成包括系统托盘、窗口尺寸/位置持久化和原生文件/目录选择对话框；默认关闭主窗口时隐藏到托盘，用户可切换为退出应用；窗口状态持久化不保存可见性，避免托盘隐藏影响下次启动。
- 托盘右键菜单提供显示主界面和退出，左键双击托盘图标显示并聚焦主界面。
- Windows 分发使用 NSIS；支持在线/离线 WebView2 两类安装包，并静态链接 MSVC CRT。
- 图标资源已生成，Windows 打包使用 `src-tauri/icons/icon.ico`。

**See Also：** [[decisions.md#Windows-内部分发使用-NSIS-双安装包策略]] [[decisions.md#关闭窗口策略由-Rust-执行并持久化为业务配置]]

## See Also

- [[decisions.md#只聚焦三项核心-CLI]]
- [[feedback.md#不要扩展为通用-CLI-管理器]]
