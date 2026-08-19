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
- 新增 Terminal.app、iTerm2、Ghostty、WezTerm 与 kitty 五款 macOS 终端探测和显式选择。
- 新增 MIT License、第三方字体许可证与响应式关于页，侧边栏提供 GitHub 项目入口。

### 变更

- CLI 当前版本仅在用户主动刷新或任务结束后，通过已解析的完整可执行路径执行有界 `--version` 探测。
- Claude Code、Codex 和 Antigravity 的最新版本改为读取各自官方发布元数据。
- 更新继续使用 CLI 内置命令：`claude update`、`codex update` 和 `agy update`；Windows 下的 Codex 更新固定由 Windows PowerShell 5.1 托管执行。
- Codex Windows 安装首选官方 PowerShell 安装器，npm 保留为手动备选方式。
- 安装与更新确认改为按钮附近的浮层；确认后创建后台任务并转到执行任务页。
- 全局同时只允许一个安装或更新任务运行。
- Windows 启动改为结构化候选链：优先保留 Windows Terminal Profile，随后回退到 PowerShell 7、Windows PowerShell 和 CMD。
- 命令预览新增实际启动方式、Profile 保留级别、启动说明和失败回退链。
- 会话标题优先使用 Claude `summary`、Codex `name` 和 Antigravity `title` 等 CLI 原生简洁名称，再回退到预览或首条用户消息。
- Codex 模型目录改为调用 App Server `model/list`，Antigravity 模型目录改为调用 `agy models`；动态结果使用 10 分钟缓存并支持失败回退。
- 全局 UI 字体改为 IBM Plex Sans SC；命令、路径、参数和日志继续使用 Maple Mono NF CN。
- macOS 的 Terminal.app/iTerm2 使用自删除 `.command`，Ghostty 使用 AppleScript 原生窗口，WezTerm/kitty 使用包内 CLI，kitty 在命令退出后保留窗口。
- 主导航页面分别记忆当前进程内的滚动位置；未保存的新增目录表单在切换导航后自动收起。

### 修复

- 修复 Windows 开发版或从隔离环境启动时 PATH 缺少用户注册条目，导致 Claude Code 无法解析 `ccstatusline` 等用户级命令的问题。
- 修复 Windows 终端继承开发环境中的 `NO_COLOR`、`TERM=dumb` 等变量后，CLI 交互界面失去配色的问题。
- 修复 Windows 下 Codex 更新继承 PowerShell 7 环境后，官方安装脚本可能无法调用 `Get-FileHash` 的问题。
- 修复设置页无法可靠显示三个 CLI 当前版本的问题。
- 修复 Antigravity 无法获取最新版本的问题。
- 补充 `%LOCALAPPDATA%\agy\bin` 和 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` 等 Windows 安装路径探测。
- 修复 CLI 安装或更新期间界面无输出、无法判断是否卡住的问题。
- 修复执行任务空页面板横向偏移的问题。
- 修复固定使用 PowerShell 启动导致 Windows Terminal Profile 参数、初始化和样式无法充分保留的问题。
- 修复 macOS 终端继承 `NO_COLOR`、`TERM=dumb` 等调用方环境后 CLI 配色异常的问题。
- 修复项目卡片删除确认操作可能冒泡进入项目详情的问题。
- 修复新增目录操作区拥挤、保存与取消按钮缺少图标的问题。

### 已知限制与测试债务

- 本机三个 CLI 均已是最新版本，Claude `update` 已完成“已是最新版”的任务启动、实时日志、退出码和历史记录验证，但未发生真实二进制替换。下次出现可用更新时，仍需验证版本变化、任务终止及重启后的历史持久化。
- macOS 已补齐终端探测与结构化启动、三项 CLI 官方安装计划、平台化 UI、Dock Reopen、CLI 可信路径检测、Unix 进程组终止、平台路径语义及 AGY 平台映射。
- Apple Silicon 实机已验证五款终端探测、Terminal.app、iTerm2、Ghostty、WezTerm、kitty 冷/热启动、特殊字符参数、自删除载荷、CLI 交互配色及 Dock Reopen。仍需验证真实版本替换、主动终止和完整桌面生命周期，并对 Intel target 完成独立构建检查。
- Apple Silicon Release DMG 已完成构建和只读挂载验证；当前仅为 ad hoc 签名，正式跨设备分发仍依赖 Developer ID 签名与公证凭据。
