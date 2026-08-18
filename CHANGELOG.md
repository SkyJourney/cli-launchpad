# 变更日志

本文档记录 CLI Launchpad 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

项目从 `0.2.0` 开始维护变更日志；此前的 `0.1.0` 未追溯补录。

## [0.2.0] - Unreleased

### 新增

- 新增“执行任务”顶层导航，集中展示 CLI 安装与更新任务。
- 新增准备中、执行中、正在终止、成功、失败、取消、超时和意外中断状态。
- 实时采集并分流展示任务的标准输出、错误输出和系统消息。
- 使用 SQLite 持久化最近 50 个任务及其日志；单个任务日志上限为 1 MiB。
- 支持查看历史日志、终止运行中任务，以及确认后清理单条或全部已结束任务。
- Windows 使用 Job Object 管理任务进程树，终止任务时一并结束后代进程。
- 应用启动时自动把遗留的未结束任务标记为意外中断。
- 新增 Windows Terminal Stable、Preview、Canary 和非打包版本探测，可读取默认 Profile 与可用 Profiles。
- 设置页新增自动推荐、Windows Terminal Profile 和独立 Shell 分组选择，并展示 Profile 保留级别。
- 项目卡片除独立操作按钮外均可点击进入详情。
- 三项 CLI 会话历史默认按最新 10 条加载，并支持独立“更多”分页。
- 新增 Antigravity 本地会话历史读取与恢复。
- 三项 CLI 均支持启动模型选择、动态刷新和手动模型/部署名。
- 新增按会话 ID 保存的稀疏本地别名，支持重命名和恢复原始标题。

### 变更

- CLI 当前版本仅在用户主动刷新或任务结束后，通过已解析的完整可执行路径执行有界 `--version` 探测。
- Claude Code、Codex 和 Antigravity 的最新版本改为读取各自官方发布元数据。
- 更新命令统一使用 CLI 内置命令：`claude update`、`codex update` 和 `agy update`。
- Codex Windows 安装首选官方 PowerShell 安装器，npm 保留为手动备选方式。
- 安装与更新确认改为按钮附近的浮层；确认后创建后台任务并转到执行任务页。
- 全局同时只允许一个安装或更新任务运行。
- Windows 启动改为结构化候选链：优先保留 Windows Terminal Profile，随后回退到 PowerShell 7、Windows PowerShell 和 CMD。
- 命令预览新增实际启动方式、Profile 保留级别、启动说明和失败回退链。
- 会话标题优先使用 Claude `summary`、Codex `name` 和 Antigravity `title` 等 CLI 原生简洁名称，再回退到预览或首条用户消息。
- Codex 模型目录改为调用 App Server `model/list`，Antigravity 模型目录改为调用 `agy models`；动态结果使用 10 分钟缓存并支持失败回退。

### 修复

- 修复设置页无法可靠显示三个 CLI 当前版本的问题。
- 修复 Antigravity 无法获取最新版本的问题。
- 补充 `%LOCALAPPDATA%\agy\bin` 和 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` 等 Windows 安装路径探测。
- 修复 CLI 安装或更新期间界面无输出、无法判断是否卡住的问题。
- 修复执行任务空页面板横向偏移的问题。
- 修复固定使用 PowerShell 启动导致 Windows Terminal Profile 参数、初始化和样式无法充分保留的问题。

### 已知限制与测试债务

- 本次未执行真实 CLI 安装或更新的端到端测试：本机三个 CLI 均已是最新版本，没有可安全复现的更新任务。已完成 Rust 单元测试、前端生产构建、Windows Job Object 终止实测和空任务页面视觉检查。下次出现可用更新时，需要验证实时日志、完整状态流转、任务终止、完成后版本刷新及重启后的历史持久化。
- macOS 启动能力尚未与新版 Windows 分层启动架构同步，也未进行真实设备验证。0.2.0 发布前必须完成 macOS 终端/Shell 探测与结构化启动实现，并实测项目目录、CLI 参数、会话恢复和失败回退。
