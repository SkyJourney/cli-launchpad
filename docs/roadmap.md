# 路线图

界面采用 cc-switch 风格的多视图结构，详见 `docs/ui-design.md`。路线图按"先打通数据与启动，再叠加视图能力"推进。

## 阶段 1：可启动 MVP

- 启动时应用 SQLite migrations。
- 添加目录 CRUD。
- 添加工具、终端探测和启动偏好持久化。
- 内置 Claude Code、Codex、Antigravity 三个工具配置。
- 实现命令预览。
- 通过当前平台检测到的终端打开指定目录下的目标 CLI，并提供平台内分层回退。

## 阶段 2：全局 CLI 状态与卡片主页

- Rust 层实现 CLI 检测 service，得出 available / missing（启动走全路径，不区分 PATH 可见性）。
- 前端引入全局状态库，持有全局 CLI 状态和视图状态。
- View A 项目主页：卡片网格、状态徽章、添加目录、排序、搜索、置顶。
- 卡片徽章直接启动，缺失工具灰色禁用。

## 阶段 3：项目详情与会话历史

- View B 项目详情：三个 CLI 会话历史 Tab、一键直接启动、可折叠命令预览和复制。
- 读取 Claude Code、Codex App Server 和 Antigravity 本地摘要库的会话索引并展示。
- 每个 CLI 默认加载最新 10 条并支持独立懒加载。
- 支持按会话 ID 设置稀疏本地别名和恢复原始标题。
- 实现 `resume_session`，按工具恢复指定会话。
- 原始会话保持按需读取，不缓存标题或源路径。

## 阶段 4：项目参数编辑

- View C 参数编辑：按 CLI 分区配置项目级参数。
- 三项 CLI 均提供动态或稳定模型目录选择，并支持手动模型/部署名。
- 项目级参数与全局参数分离，保存到 SQLite。
- 未安装的 CLI 分区灰色禁用。

## 阶段 5：依赖检测、安装与版本更新

- View D 设置页：CLI 状态面板，展示版本、路径、PATH 可见性。
- 查询最新版本，对有新版的 CLI 提供应用内更新入口。
- 一键安装流程：命令预览、用户确认、日志输出、完成后重新检测。
- 更新流程复用安装流程的确认与日志机制。
- 对安装/更新后 PATH 未刷新的情况提供重启终端或刷新环境变量提示。

## 阶段 6：桌面体验和内部发布

- Windows 系统托盘与 macOS 菜单栏状态项快速启动。
- 关闭窗口行为配置：默认保持后台运行，支持改为退出应用；Windows 双击托盘、macOS 点击 Dock 图标均可恢复主界面。
- 窗口状态持久化。
- 配置导入和导出。
- Tauri Windows 打包，优先支持公司内部可分发安装包。
- 明确 MSI/NSIS 选择、签名、版本号和升级策略。
- macOS 分别准备 Apple Silicon 与 Intel DMG，不生成 Universal 包；正式跨设备分发补齐签名与公证。
- Linux 启动辅助留待后续评估，不进入 0.2.0 范围。

## 阶段 7：执行任务与历史日志

- 新增“执行任务”顶层导航与运行中数量徽章。
- 安装和更新改为后台任务，实时展示标准输出、错误输出与状态变化。
- SQLite 持久化最近 50 个任务及日志，每个任务日志上限 1 MiB。
- 支持查看历史、终止卡死任务和确认后清理历史。
- Windows 使用 Job Object 终止完整任务进程树，应用重启时修正意外中断状态。
- macOS 使用 Unix process group 终止完整任务进程树，避免取消或超时后遗留安装器子进程。

## 阶段 8：Windows Profile 启动与 macOS 对齐

- Windows 探测 Windows Terminal Stable、Preview、Canary 和非打包版本及其 Profiles。
- 按完整追加、PowerShell 命令续接、保留外观、独立 Shell 建立启动候选，并在进程创建失败时自动回退。
- 设置页展示自动推荐、Windows Terminal Profiles 和独立 Shell，命令预览展示保留级别及失败回退链。
- 将终端环境响应改为平台中立模型，保留现有 Windows target ID，并新增 Terminal.app、iTerm2、Ghostty、WezTerm 与 kitty 的稳定 macOS target ID。
- macOS 检测当前 PATH 与限定可信目录，不执行用户 Shell 启动脚本；补齐 AGY 的 `darwin_arm64`、`darwin_amd64` manifest。
- Terminal.app、iTerm2 与 Ghostty 使用 LaunchServices 打开权限受限、一次性自删除的 `.command` 载荷；WezTerm 与 kitty 使用官方 CLI 的结构化参数；所有路径均避免 AppleScript 自动化权限。
- 补齐 macOS 官方安装脚本、Unix 进程组终止、路径大小写语义、Dock Reopen 与平台化设置页。
- 0.2.0 发布前完成 CLI 检测与版本、启动、特殊字符参数、模型、会话恢复、安装更新、主动终止、桌面生命周期和失败回退实机验证。

## 后续：应用自身更新

- 0.2.0 不实现 CLI Launchpad 自身的自动更新，也不进行后台版本检查。
- 后续可基于 GitHub Releases 查询应用最新版本，并明确展示版本、来源和发布说明。
- 下载或安装更新前必须由用户显式确认；签名、公证和跨版本数据兼容验证完成后再开放自动安装。
