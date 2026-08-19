# 变更日志

本文档记录 CLI Launchpad 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

项目从 `0.2.0` 开始维护变更日志；此前的 `0.1.0` 未追溯补录。

## [0.2.1] - 2026-08-19

### 新增

- 新增浅色、深色与跟随系统三种主题模式，并同步原生窗口主题。
- 新增简体中文与英文界面切换，使用 i18next 统一管理界面文案、时间格式与状态文本。
- 侧边栏底部新增语言、主题和 GitHub 仓库入口，均提供悬浮提示与键盘可访问语义。
- 新增可视区域自适应的通用锚点浮层，安装与更新确认在窗口空间不足时自动向上展开并限制内部滚动。
- 关于页新增 Lobe Icons 第三方许可说明，并继续内置项目、UI 字体与终端字体的完整许可证。
- 新增 GitHub Actions 多目标发布流水线：Tag 自动构建 Windows 在线/离线 NSIS、macOS ARM64/Intel DMG，生成 SHA-256 校验并发布 GitHub Release。

### 变更

- React 与 React DOM 升级至 19.2，相关类型定义、状态管理和国际化依赖同步升级并完成回归。
- 全局 UI 字体由 IBM Plex Sans SC 更换为 Noto Sans SC 可变字体；Maple Mono NF CN 继续用于命令、路径、参数与日志。
- Claude Code、Codex、Antigravity 与 GitHub 图标改为本地 SVG 素材，移除运行时图标组件依赖并统一素材维护与授权信息。
- 全局交互控件统一为 36 px 高度基线，输入框、选择框和按钮保持一致；紧凑操作使用 32 px 高度。
- 安装与更新操作移动到 CLI 标题后方，减少状态卡片纵向占用。
- 浅色与深色主题分别采用独立的主按钮、文字、边框、状态和日志配色，降低暗色界面中高亮文字的视觉刺激。
- 新增目录表单保持两行布局，操作按钮统一图标、尺寸与白色表面背景。
- README、架构文档和第三方声明同步更新 Noto Sans SC、React 19、双语与主题能力。

### 修复

- 修复压缩控件高度后首页搜索框文字与图标越出边框的问题。
- 修复多处刷新按钮和清理历史按钮尺寸、背景与相邻控件不一致的问题。
- 修复 CLI 安装或更新浮层在窗口高度不足时底部内容不可见的问题。
- 修复项目卡片部分留白区域无法进入详情页，同时保持卡片内独立操作按钮不触发导航。
- 修复侧边栏 GitHub 图标无法通过系统默认浏览器打开项目仓库的问题。
- 修复 GitHub SVG 在生产构建中内联后遮罩 URL 失效，正式安装包将图标渲染为实心方块的问题。
- 修复切换导航页后复用上一页面滚动位置，以及未保存的新增目录表单未自动收起的问题。

### 发布说明

- macOS 继续分别提供 Apple Silicon 与 Intel DMG，不生成 Universal 包。
- 当前 DMG 使用 ad hoc 临时签名，未进行 Developer ID 签名与 Apple 公证；首次跨设备打开时可能需要用户在系统安全设置中确认。
- CLI Launchpad 仍不包含自身的自动更新功能，后续可基于 GitHub Releases 增加显式更新检查。

## [0.2.0] - 2026-08-19

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
