---
name: 项目进度
description: 当前完成状态和近期待办
type: project
last_updated: 2026-08-21
commit: ddca86f
---

# 项目进度

## 已完成功能

- 默认分支已改为 `main`。
- 可启动 MVP 已完成：SQLite migrations、目录/工具/启动偏好/项目参数读写、命令预览与 Windows 终端分层启动均已落地。
- 卡片式多视图 UI 已完成：项目主页、详情、参数编辑、设置、关于，以及全局 CLI 状态驱动的禁用/启动交互。
- 会话能力已完成：三项 CLI 均可读取、分页和恢复历史会话；标题优先使用 CLI 原生摘要/名称，并支持稀疏本地别名。
- CLI 管理能力已完成：安全路径检测、当前/最新版本查询、安装/更新计划预览、后台执行、实时日志、历史记录和任务终止。
- 桌面能力已完成：系统托盘、默认关闭到托盘与可配置退出行为、双击托盘唤起、窗口状态持久化、文件/目录选择对话框和 JSON 配置导入导出。
- Windows 分发配置已完成：NSIS、静态 CRT、在线/离线 WebView2 两种安装包及归档脚本。
- 相关架构、产品、UI、安装与里程碑文档均已补齐；后续事实应以当前实现和最新文档为准。

**See Also：** [[decisions.md#Windows-内部分发使用-NSIS-双安装包策略]] [[decisions.md#关闭窗口策略由-Rust-执行并持久化为业务配置]] [[project_overview.md#桌面体验与分发]]

## 可靠性治理完成

- 稳定数据根目录、单实例、防黑框启动与无闪窗探测已落地。
- 启动执行边界已收紧：参数字面化、配置导入不接受 Shell 执行字段、被动检测不执行候选程序；CMD 仅作为使用受控编码载荷的最终兜底。
- 一致性备份、恢复回滚、manifest 路径校验、未来 schema 拒绝和缓存损坏降级已落地。
- 日志与诊断导出、事务化参数保存、原子文件导出及会话隐私缓存治理已落地。
- 五阶段修复已完成并通过 Rust 测试、编译检查、前端生产构建与 Windows NSIS release 构建。

**See Also：** [[decisions.md#业务数据使用稳定用户目录并提供一致性恢复点]] [[decisions.md#会话摘要不进入应用持久缓存]]

## 0.2.0 发布完成

- 项目从 `0.2.0` 开始维护 `CHANGELOG.md`，Windows 与 macOS 生态功能对齐后已正式发布 `v0.2.0`。
- 三项 CLI 的当前版本主动探测、官方最新版本查询、Windows 已知安装路径和官方更新命令已更新。
- 执行任务页、SQLite 任务历史、实时分流日志、50 项留存、1 MiB 日志上限、启动中断修正和 Windows Job Object 进程树终止已落地。
- Windows Terminal Profile 探测、自动推荐、显式选择和分层启动候选已落地；设置页展示 Profile 保留级别，命令预览展示实际启动方式与失败回退链。
- 项目卡片主区域进入详情、三项会话标题源、每 CLI 独立 10 条懒加载、Antigravity 历史与恢复均已落地。
- 三项 CLI 均支持启动模型选择和手动模型/部署名；Claude 使用稳定别名，Codex 与 Antigravity 动态读取本机模型目录并有 10 分钟缓存。
- 会话本地别名使用稀疏 `session_aliases` 关联，只在手动重命名时入表，并支持恢复 CLI 原始标题。
- 已通过前端生产构建、102 项 Rust 测试、版本一致性检查、Windows Job Object 终止实测、Windows Terminal Profile 受控启动探针及关键页面实机检查。
- Windows NSIS 在线版和内嵌 WebView2 离线版均已构建；在线版已在本机静默覆盖安装，注册表/进程确认版本 `0.2.0`，项目数据、会话分页/重命名和三项目录选择验证正常。
- macOS 已完成五款终端探测、结构化启动、可信路径检测、Unix 进程组终止和平台路径语义对齐；Apple Silicon 已完成真实终端、特殊字符参数、CLI 配色、Dock Reopen 与 ad hoc DMG 实机验证。
- Windows 已修复隔离父进程传入无颜色环境和残缺 PATH 导致的 CLI 配色、用户级命令解析问题；Codex 更新固定在 Windows PowerShell 5.1 环境中执行内置 `codex update`。
- **测试债务：** 本机三个 CLI 均已是最新版本，本次没有执行真实安装或更新的端到端测试。下次出现可用更新时，必须验证实时日志、完整状态流转、主动终止、完成后版本刷新和重启后的历史持久化。

**See Also：** [[decisions.md#安装与更新使用持久化后台任务]] [[decisions.md#启动使用完整-CLI-路径与平台分层候选]] [[project_overview.md#执行任务边界]]

## 0.2.1 发布完成

- React 与 React DOM 已升级至 19.2，并完成前端生产构建与桌面端回归。
- 简体中文/英文切换和浅色/深色/跟随系统主题已落地；全局控件统一为紧凑高度，安装更新浮层可根据窗口空间翻转和内部滚动。
- UI 字体切换为 Noto Sans SC，终端内容保留 Maple Mono NF CN；品牌图标迁移为本地 SVG 并修复正式包中的遮罩渲染问题。
- 项目卡片点击、导航滚动隔离、未保存表单收起、GitHub 外链和暗色主题配色等真实交互问题已修复。
- `v0.2.1` 已通过 GitHub Actions 四目标手动预检，并由 Tag 流水线自动发布 Windows 在线/离线 NSIS、macOS ARM64/Intel DMG 与 SHA-256 校验文件。
- 本地 GitHub CLI 已使用现有 SSH Git 协议和独立 OAuth API 认证完成验证，可读取、触发和监控 release workflow 及 Release。

**See Also：** [[decisions.md#Git-Tag-驱动四目标自动发布]] [[project_overview.md#界面与本地素材]] [[project_overview.md#桌面体验与分发]]

## 0.2.2 发布完成

- 修复 macOS DMG 等生产构建中安装与更新确认浮层首次定位失败、界面看似无响应的问题。
- 三项 CLI 使用稳定且独立的确认浮层锚点，并完成生产诊断包与 Release App 人工验证。
- `v0.2.2` 已发布；后续小更新暂存于 CHANGELOG 的 `Unreleased`，正式发布前再统一确定版本号和 Tag。

## Unreleased 累积更新

- 安装与更新任务改为同一 CLI 内互斥、不同 CLI 并行；任务 ID、取消信号、平台进程树、日志和设置页状态均按 CLI 独立闭环。
- 设置页移除命令计划读取期间的按钮灰显和尺寸抖动；创建任务后保留当前视图，其他 CLI 可继续操作。
- 引入 Sonner 任务结果 Toast，适配浅色、深色和跟随系统主题，并按任务 ID 去重。
- 任务终态后按 CLI 显示“刷新版本中”过渡状态，只回读本机版本并压住旧更新入口，修复更新成功后的短暂状态回跳。
- macOS 开发版已完成真实 Antigravity 更新、成功 Toast 与双主题人工验证；前端生产构建和 118 项 Rust 测试通过。

**See Also：** [[decisions.md#安装与更新使用持久化后台任务]] [[project_overview.md#执行任务边界]]

## 近期待办

- 继续对 Claude Code、Codex 的真实版本替换，以及跨 CLI 并行、主动终止和重启后历史持久化进行人工端到端验证。
- 正式跨设备分发达到规模后，评估 Apple Developer Program，并补齐 Developer ID 签名与公证。
- 对安装包、托盘交互、窗口状态恢复、真实 CLI 启动/恢复及配置文件导入导出进行人工端到端验证。
- 设计主业务数据库在启动前已损坏时的维护启动模式或恢复专用界面。
- 后续评估 Linux 启动辅助；不扩大三项 CLI 产品范围。

## See Also

- [[decisions.md#只聚焦三项核心-CLI]]
- [[decisions.md#启动使用完整-CLI-路径与平台分层候选]]
- [[reference.md#官方-CLI-资料]]
