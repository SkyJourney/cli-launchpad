---
name: 项目决策
description: 当前关键架构、产品范围和安装策略决策
type: project
last_updated: 2026-08-21
commit: ddca86f
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
**How to apply：** Claude 优先使用官方 winget 包或官方 PowerShell 脚本；Codex 在 Windows 优先使用官方 PowerShell 安装器，npm 只作为手动备选；Antigravity 使用官方 PowerShell installer。业务层使用结构化参数模型，不拼接自由字符串。
**See Also：** [[reference.md#官方-CLI-资料]] [[feedback.md#修改前说明和确认]]

## 安装与更新使用持久化后台任务

**结论：** 三项 CLI 的安装与更新统一创建 Rust 后台任务，通过 Tauri 事件推送实时日志，并将任务状态和受限日志持久化到业务 SQLite；同一 CLI 内互斥，不同 CLI 可并行，每项任务拥有独立取消信号和平台进程树。
**Why：** 缓冲式静默执行无法判断任务是否卡住，也无法可靠终止子进程或在重启后查看历史；同一 CLI 的安装和自更新会争用同一工具状态，但三个不同 CLI 已具备独立命令、日志和进程树边界，无需互相阻塞。
**How to apply：** 任务管理器按 `ToolKey` 维护活动任务，每个 CLI 同时最多一个任务；只接受内置工具清单生成的结构化计划，不开放自由命令或保存环境变量；默认保留最近 50 个任务，每项日志上限 1 MiB；启动时将遗留活动任务标记为意外中断；UI 按 CLI 独立维护执行与版本回读状态，并使用“终止任务”表达强制结束进程树。
**See Also：** [[project_overview.md#执行任务边界]] [[project_progress.md#0.2.0-发布完成]] [[project_progress.md#Unreleased-累积更新]]

## 启动使用完整 CLI 路径与平台分层候选

**结论：** CLI 启动前解析为完整路径；Windows 优先保留 Windows Terminal Profile，并按 Profile 原生追加、PowerShell 命令续接、保留外观替换命令、PowerShell 7、Windows PowerShell、CMD 建立分层候选。
**Why：** 桌面进程继承的 PATH 可能落后于用户安装状态，开发沙箱还可能传入残缺 PATH、`NO_COLOR` 或 `TERM=dumb`；固定替换 Shell 会丢失用户 Profile 的参数、初始化和样式，而只依赖单一终端又无法覆盖未安装 Windows Terminal 或 Profile 命令不兼容的机器。
**How to apply：** 终端探测与启动计划放在 Rust platform/services；设置页持久化 `auto`、指定 Profile 或直接 Shell 目标；启动参数先结构化建模，只在最终 Shell 边界编码；进程创建失败时继续尝试安全候选。启动终端前移除非交互配色变量，Windows 子终端补入注册环境中当前进程缺失的 Machine/User PATH 项。CMD 只作为最终受控兜底，不直接拼接不可信字符串。配置导入不接受外部可执行 Shell 字段或初始化脚本。
**See Also：** [[project_overview.md#启动与检测边界]]

## 会话历史按需读取本地事实来源

**结论：** 三项 CLI 会话列表均按查看时读取各自本地事实来源，不建立原始会话缓存；每项 CLI 独立按 10 条分页。Claude 优先使用 sessions index，Codex 优先使用 App Server，Antigravity 只读本机摘要 SQLite 与 metadata。
**Why：** CLI 自有索引和会话存储是标题、时间及项目归属的权威来源，按需读取可避免缓存陈旧；Antigravity 新版本已在本机暴露可按 workspace 匹配的摘要库。
**How to apply：** 列表读取后仍要按项目目录或 workspace URI 过滤，恢复前重新验证归属；Claude 使用 `--resume`，Codex 使用 `resume`，Antigravity 使用 `--conversation`。原始标题与路径不进入应用缓存。
**See Also：** [[project_overview.md#会话与配置数据]]

## 会话本地别名使用稀疏关联

**结论：** 用户手动重命名会话时，才以 `tool_key + session_id` 向业务 SQLite 写入别名；普通会话不入表，删除别名即恢复 CLI 原始标题。
**Why：** 会话 ID 足以稳定关联用户命名，同时避免复制 CLI 会话索引、正文或源路径，也不会因为项目目录移动丢失别名。
**How to apply：** 别名必须在写入或删除前验证 session 属于当前项目；列表先读取真实会话，再合并匹配别名，孤立记录不得生成虚假会话。配置 JSON 暂不交换别名，但数据库备份与恢复自然包含该表。
**See Also：** [[decisions.md#会话摘要不进入应用持久缓存]] [[project_overview.md#会话与配置数据]]

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

**结论：** 三项 CLI 的原始会话列表实时读取外部事实来源；原始标题摘要和源文件路径不持久写入应用缓存。只有用户显式设置的稀疏别名属于业务配置。
**Why：** 会话标题可能包含工作内容，且缓存身份失配会导致错误项目展示或恢复风险；性能收益不足以抵消隐私与正确性成本。
**How to apply：** 持久缓存只保存 CLI 状态、版本和模型目录等可重建信息；恢复会话或修改别名前重新验证 session 与当前目录的归属关系；升级时清理历史会话缓存条目。
**See Also：** [[decisions.md#会话本地别名使用稀疏关联]] [[project_overview.md#会话与配置数据]] [[project_progress.md#可靠性治理完成]]

## 关闭窗口策略由 Rust 执行并持久化为业务配置

**结论：** 主窗口默认关闭到系统托盘，可在设置中切换为退出应用；关闭策略保存在 SQLite 并由 Rust 窗口事件直接执行。
**Why：** 应用需要常驻托盘且在窗口关闭前即可可靠判断行为；仅保存在 React 状态或窗口状态文件中无法覆盖启动、配置导入和数据库恢复后的统一行为。
**How to apply：** 托盘菜单固定提供显示主界面和退出，左键双击显示主界面；配置导入或数据库恢复后同步刷新运行时策略。
**See Also：** [[project_overview.md#桌面体验与分发]] [[project_progress.md#已完成功能]]

## Git Tag 驱动四目标自动发布

**结论：** 正式版本使用与应用版本一致的 `v*.*.*` Git Tag 触发 GitHub Actions，同时构建 Windows x64 在线/离线 NSIS 与 macOS ARM64/Intel DMG；全部目标成功后才生成校验和并发布 GitHub Release。手动触发只生成限时 Artifact，不创建 Release。
**Why：** 本地只能完整实测当前主机架构，直接打 Tag 会把跨平台配置错误带入正式发布；先以同一矩阵手动预检，可以在不产生 Release 的前提下验证所有 target，并让正式发布具备一致、可审计的产物来源。
**How to apply：** 发版前先完成本地调试和版本一致性检查，再手动运行 release workflow；四目标全部通过后创建 Tag。macOS 暂用 ad hoc 签名且不公证，待项目规模需要时再引入 Developer ID 与 notarization secrets。
**See Also：** [[project_overview.md#桌面体验与分发]] [[project_progress.md#0.2.1-发布完成]] [[reference.md#发布工具官方资料]]
