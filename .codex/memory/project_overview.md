---
name: 项目概览
description: 项目技术栈、架构边界、工具链和核心 CLI 范围
type: project
last_updated: 2026-08-21
commit: ddca86f
---

# 项目概览

CLI Launchpad 是一个轻量桌面工具，用于管理常用项目目录，并在指定目录中快速打开公司内部常用 AI CLI 会话。项目不做通用 CLI 管理器，当前产品范围只覆盖 Claude Code CLI、Codex CLI 和 Antigravity CLI。

## 技术栈

- 桌面壳：Tauri 2。
- 前端：React 19 + TypeScript + React Query + Zustand + i18next + Sonner，承载项目、详情、参数编辑、执行任务、设置和关于视图，并统一管理中英文文案、主题状态和任务结果 Toast。
- 后端：Rust，负责 Tauri commands、启动编排、依赖检测、后台安装/更新任务、会话读取、SQLite 备份恢复、诊断导出和平台相关逻辑。
- 数据：SQLite 保存业务配置、安全启动历史以及安装/更新任务历史；可重建缓存使用独立 SQLite 库。
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

## 界面与本地素材

- 界面支持简体中文、英文，以及浅色、深色、跟随系统三种主题；这些属于设备本地 UI 状态，不进入业务 SQLite。
- 全局 UI 内置 Noto Sans SC 可变字体，命令、路径、参数和日志继续使用 Maple Mono NF CN，不依赖系统字体安装。
- Claude Code、Codex、Antigravity 与 GitHub 品牌图标使用仓库内本地 SVG 素材，避免运行时图标依赖与生产包资源解析差异；授权信息统一维护在第三方声明中。
- 通用交互控件以 36 px 为高度基线；确认浮层根据窗口可用空间上下翻转并限制内部滚动。

**See Also：** [[project_progress.md#0.2.1-发布完成]]

## 启动与检测边界

- CLI 检测仅输出 `available` / `missing`，从 PATH 或已知用户级安装目录找到完整路径即为可用。
- 启动逻辑位于 Rust services 与 platform helper；工具和安装程序在执行前解析为完整路径，终端与 Shell 由平台探测结果生成结构化候选。
- Windows 探测 Windows Terminal Stable、Preview、Canary 和非打包版本及其 Profiles，优先保留默认 Profile；失败时按 Profile 兼容模式、PowerShell 7、Windows PowerShell、CMD 分层回退。
- CMD 仅作为使用受控编码载荷的最终兜底，不直接拼接不可信参数。Windows Terminal 和 PowerShell 同样在最终边界编码命令，避免终端解析器再次拆分。
- 所有平台启动终端前移除调用方继承的非交互配色变量；Windows 还会将注册环境中缺失的 Machine/User PATH 项补入子终端，使开发沙箱与安装版获得一致的用户工具入口。
- 被动检测只解析可信路径，不执行候选 CLI 获取版本；用户参数始终以 PowerShell 字面值传递。
- 全局参数与项目级参数分离，项目级同名 flag 覆盖全局 flag。

**See Also：** [[decisions.md#启动使用完整-CLI-路径与平台分层候选]]

## 执行任务边界

- 安装与更新由 Rust 任务管理器后台执行，前端通过 Tauri 事件接收状态变化和 stdout、stderr、system 日志增量。
- 任务管理器按 CLI 独立维护活动任务：同一 CLI 内互斥，不同 CLI 可并行；每项任务拥有独立取消信号和平台进程树。
- 任务和日志持久化到业务 SQLite，默认保留最近 50 项，每项日志最多 1 MiB。
- Windows 任务进程加入 Job Object，用户终止或任务超时时结束完整进程树；应用重启后将遗留活动任务标记为意外中断。
- 任务入口只接受三个内置 CLI 生成的结构化安装或更新计划，不接受自由命令，也不持久化环境变量或密钥。
- Windows 下 Codex 更新仍使用 `codex update`，但固定由 Windows PowerShell 5.1 托管并透传退出码，避免 PowerShell 7 环境缺失官方更新脚本依赖。
- 前端按 CLI 独立维护计划、确认、创建、执行和版本回读状态；任务终态使用双主题 Toast 提示，版本回读期间压住旧版本推导出的更新入口。

**See Also：** [[decisions.md#安装与更新使用持久化后台任务]] [[project_progress.md#0.2.0-发布完成]]

## 会话与配置数据

- Claude Code 优先读取 sessions index、Codex 优先调用 App Server、Antigravity 只读本地摘要 SQLite 与 metadata；三项均按项目过滤并支持恢复。
- 每项 CLI 首次加载最新 10 条，点击“更多”再加载 10 条；三个分页查询相互独立。
- 标题优先使用 CLI 保存的摘要或名称，再回退到预览或第一条用户消息；只有用户手动设置的本地别名按 `tool_key + session_id` 稀疏写入业务库。
- 配置交换以 JSON 文件导入导出，导入在事务中按绝对目录身份合并，并忽略外部文件中的 Shell 执行字段。
- 关闭窗口策略保存在业务库中，并随版本化 JSON 配置交换；配置导入或数据恢复后同步更新当前进程策略。
- SQLite 是应用配置来源，不保存密钥；应用缓存不持久保存 CLI 原始会话标题或源路径。会话别名暂不进入配置 JSON，但随数据库备份恢复。

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
- `build:installers` 同时归档在线与离线 x64 安装包；在线版可用于本机静默覆盖安装，覆盖后业务数据保持不变。
- macOS 分别构建 Apple Silicon 与 Intel DMG，不生成 Universal 包；当前使用 ad hoc 签名且未公证。
- GitHub Actions 以相同矩阵构建四类正式产物。手动触发用于发版预检并保留 Actions Artifact；版本 Tag 在全部 target 成功后生成 `SHA256SUMS.txt` 和 GitHub Release。
- 图标资源已生成，Windows 打包使用 `src-tauri/icons/icon.ico`。

**See Also：** [[decisions.md#Windows-内部分发使用-NSIS-双安装包策略]] [[decisions.md#关闭窗口策略由-Rust-执行并持久化为业务配置]] [[decisions.md#Git-Tag-驱动四目标自动发布]] [[project_progress.md#0.2.1-发布完成]]

## See Also

- [[decisions.md#只聚焦三项核心-CLI]]
- [[feedback.md#不要扩展为通用-CLI-管理器]]
