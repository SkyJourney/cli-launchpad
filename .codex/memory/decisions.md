---
name: 项目决策
description: 当前关键架构、产品范围和安装策略决策
type: project
last_updated: 2026-05-26
commit: cef5f60
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
**See Also：** [[project_overview.md#核心-CLI-范围]] [[feedback.md#不要扩展为通用-CLI-管理器]] [[project_progress.md#已完成功能]]

## Antigravity 使用 agy 作为官方主命令

**结论：** Antigravity CLI 以 `agy` 作为官方主命令；`antigravity` 只做保守兼容探测。
**Why：** 官方资料显示 Antigravity CLI 使用 AGY CLI；项目不再关注 Gemini CLI。
**How to apply：** UI 推荐启动命令和安装设计都应围绕 `agy`，不要把 `antigravity` 展示成推荐路径。
**See Also：** [[reference.md#官方-CLI-资料]] [[feedback.md#不再关注-Gemini-CLI]]

## 安装命令必须来自官方来源

**结论：** 一键安装命令必须来自官方文档或官方推荐包，并在执行前展示来源和完整命令。
**Why：** 安装 CLI 属于用户机器上的高影响操作，尤其是 PowerShell 网络脚本，需要明确来源和风险。
**How to apply：** Claude 优先使用官方 winget 包或官方 PowerShell 脚本；Codex 使用官方 npm 包；Antigravity 使用官方 PowerShell installer。业务层使用结构化参数模型，不拼接自由字符串。
**See Also：** [[reference.md#官方-CLI-资料]] [[feedback.md#修改前说明和确认]]

## 启动必须使用解析后的完整可执行路径

**结论：** CLI 在启动前解析为完整路径；Shell 固定使用系统 PowerShell；仅保留 Windows Terminal + PowerShell 与独立 PowerShell 两种模式，停用 CMD。
**Why：** 桌面进程继承的 PATH 可能落后于用户安装状态；用户可导入的 Shell 路径、CMD 拼接和可求值 PowerShell 参数均会扩大执行注入面。
**How to apply：** 被动检测不执行候选 CLI；安装计划确认前解析目标程序；启动参数按 PowerShell 字面值编码；配置导入不接受可执行 Shell 字段或初始化脚本。
**See Also：** [[project_overview.md#启动与检测边界]]

## 会话历史按需读取本地事实来源

**结论：** Claude Code 与 Codex 会话列表按查看时实时读取各自本地存储，不建立 SQLite 会话缓存；Antigravity 不展示历史列表。
**Why：** 两项可读取的 CLI 会话文件是事实来源，按需读取成本可控且避免缓存过期；Antigravity 没有公开可依赖的本地列表格式。
**How to apply：** SQLite 只保存应用配置；恢复会话沿用统一启动组合，Claude 使用 `--resume`，Codex 使用 `resume`，Antigravity 保留直接启动能力。
**See Also：** [[project_overview.md#会话与配置数据]]

## Windows 内部分发使用 NSIS 双安装包策略

**结论：** Windows 打包以 NSIS 为目标，提供在线 WebView2 引导版和内嵌 WebView2 离线版，并静态链接 MSVC CRT。
**Why：** 内部分发需要覆盖有网与无网环境，同时减少目标机器对 VC++ 运行库和 WiX 工具链的额外依赖。
**How to apply：** 默认 Tauri 配置构建在线版，离线覆盖配置构建离线版，归档脚本为产物添加 `online` / `offline` 标识。
**See Also：** [[project_overview.md#桌面体验与分发]] [[project_progress.md#已完成功能]]

## 业务数据使用稳定用户目录并提供一致性恢复点

**结论：** 业务数据固定存放在 `~/.cli-launchpad/`，分离 `data/`、`cache/`、`logs/` 与 `backups/`；旧开发标识目录仅在新库缺失时迁移且不自动删除。
**Why：** release 不应继续依赖 `dev.local` 身份目录；配置事实、可重建缓存、诊断记录和恢复点必须具备不同的保留与故障语义。
**How to apply：** 数据库迁移与备份使用 SQLite 一致性备份；恢复校验 manifest、完整性和 schema，并在覆盖前生成保护恢复点；缓存损坏可重建或降级内存，不阻断业务数据。
**See Also：** [[project_overview.md#存储与可靠性边界]] [[project_progress.md#可靠性治理完成]]

## 会话摘要不进入应用持久缓存

**结论：** Claude Code 与 Codex 的会话列表实时读取外部事实来源；标题摘要和源文件路径不持久写入应用缓存。
**Why：** 会话标题可能包含工作内容，且缓存身份失配会导致错误项目展示或恢复风险；性能收益不足以抵消隐私与正确性成本。
**How to apply：** 持久缓存只保存 CLI 状态和版本查询等可重建信息；恢复会话前重新验证 session 与当前目录的归属关系；升级时清理历史会话缓存条目。
**See Also：** [[project_overview.md#会话与配置数据]] [[project_progress.md#可靠性治理完成]]

## 关闭窗口策略由 Rust 执行并持久化为业务配置

**结论：** 主窗口默认关闭到系统托盘，可在设置中切换为退出应用；关闭策略保存在 SQLite 并由 Rust 窗口事件直接执行。
**Why：** 应用需要常驻托盘且在窗口关闭前即可可靠判断行为；仅保存在 React 状态或窗口状态文件中无法覆盖启动、配置导入和数据库恢复后的统一行为。
**How to apply：** 托盘菜单固定提供显示主界面和退出，左键双击显示主界面；配置导入或数据库恢复后同步刷新运行时策略。
**See Also：** [[project_overview.md#桌面体验与分发]] [[project_progress.md#已完成功能]]
