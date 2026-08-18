# 产品需求

## 问题

开发者在多个本地仓库之间工作时，经常需要先打开 PowerShell、切换目录，再启动 Claude Code、Codex 或 Antigravity CLI。这个流程重复且容易出错。

CLI Launchpad 的目标是把这个动作变成可视化选择和一键打开。

## 目标用户

主要用户是需要频繁在多个本地项目中使用 AI CLI 工具的开发者。

## 工具范围

当前只聚焦三个 CLI：

- Claude Code CLI：`claude`
- Codex CLI：`codex`
- Antigravity CLI：官方主命令 `agy`

其他 CLI 不进入当前产品范围。

Antigravity 是 Google 新品牌下的目标 CLI。本项目不再关注 Gemini CLI，也不提供 Gemini CLI 的检测、安装或启动入口。

## MVP

- 持久化常用项目目录。
- 内置三个默认工具：Claude Code CLI、Codex CLI、Antigravity CLI。
- 终端启动偏好与工具参数分离。
- 全局工具参数与目录级工具参数分离。
- 展示即将执行的命令预览。
- 在选定目录中通过系统可用的终端或 Shell 打开对应 CLI；Windows 优先保留 Windows Terminal Profile，无法使用时按 `pwsh`、Windows PowerShell、CMD 分层回退。

## 界面形态

界面参考 cc-switch 的卡片式项目管理，采用多视图结构（项目主页、项目详情、参数编辑、设置），不使用弹窗承载主要操作。完整设计见 `docs/ui-design.md`。

核心特性：

- 卡片式项目管理：项目主页以卡片网格展示常用目录。
- 直接启动为常态：点击工具即在该目录启动，命令预览作为可折叠的辅助能力。
- 全局 CLI 状态：应用启动时检测三个 CLI，统一下发到所有视图，缺失的工具在任何位置都灰色禁用。
- 桌面常驻：默认关闭主窗口时最小化到系统托盘，托盘菜单可显示主界面或退出，双击托盘图标显示主界面；设置页可改为关闭即退出。

## 启动方式

- 默认使用自动推荐策略，优先选择 Windows Terminal 默认 Profile，并尽量保留该 Profile 的命令、参数、外观和初始化行为。
- Windows Terminal Profile 按能力分为完整追加、PowerShell 命令续接和仅保留外观三种保留级别，设置页允许显式选择检测到的 Profile。
- Windows Terminal 不可用或启动失败时，依次回退到 PowerShell 7、系统 Windows PowerShell 和 CMD；最终兜底允许牺牲 Profile 配置，但必须保证存在可用启动路径。
- 启动前的命令预览必须展示实际选中的终端、Profile 保留级别和失败回退链。
- 0.2.0 发布前必须在 macOS 完成同等启动能力的同步实现和实机验证；当前 Windows 实现不代表 macOS 已可发布。

## 会话历史

应用应能读取并展示已有的 CLI 会话历史，支持快速恢复之前的会话：

- 在项目详情中按 CLI 分 Tab 展示历史会话，不混在同一列表。
- Claude Code 优先读取 `sessions-index.json` 的摘要，Codex 优先调用 App Server `thread/list`，两者失败时回退到本地 JSONL。
- Antigravity 从本机 `conversation_summaries.db` 与 conversation metadata 只读匹配当前 workspace，并支持按 conversation id 恢复。
- 每个 CLI 首次只展示最新 10 条会话，用户点击“更多”时再加载 10 条；不同 CLI 的分页状态相互独立。
- 会话标题优先使用 CLI 保存的摘要或名称；用户可以按 `tool_key + session_id` 设置本地别名，也可以删除别名恢复原始标题。
- 会话历史实时读取事实来源，不将标题摘要或源文件路径持久写入应用缓存。
- 本地别名只在用户手动重命名时写入 SQLite，不把普通会话同步到应用数据库。

## 项目级参数编辑

提供项目参数编辑视图，按 CLI 分区配置该项目的工具参数：

- 项目级附加参数与全局参数分离，项目级只覆盖或追加；参数作为字面值传入 CLI，不被 Shell 求值执行。
- 三项 CLI 均提供模型选择和手动输入：Claude 使用官方稳定别名，Codex 与 Antigravity 从本机 CLI 动态查询模型目录。
- 未安装的 CLI 分区灰色禁用。
- 项目级参数保存到 SQLite。

## 版本检测与更新

设置页提供 CLI 版本管理能力：

- 检测三个 CLI 的可用路径和最新可用版本；被动检测不自动执行候选程序，用户主动刷新时才对解析后的完整路径执行有界 `--version` 探测。
- 对有新版的 CLI 提供应用内更新入口，执行对应官方更新命令。
- 更新与安装遵循同一原则：先预览命令、用户确认、输出日志、完成后重新检测。
- 更新来源必须来自官方：Claude、Codex、Antigravity 分别使用内置 `claude update`、`codex update`、`agy update`。

## 执行任务与历史日志

安装与更新不在确认浮层内等待完成。用户确认后创建后台执行任务，并通过左侧“执行任务”顶层导航查看：

- 每个任务展示准备中、执行中、正在终止、执行成功、执行失败、已取消、已超时或意外中断状态。
- 标准输出和错误输出实时追加到任务日志；应用重启后仍可查看历史任务和日志。
- 同一时间全局只允许一个安装或更新任务运行，避免多个包管理器或自更新进程互相干扰。
- 执行中的任务允许用户主动终止；Windows 必须终止完整进程树，并明确提示更新中断可能需要重新安装对应 CLI。
- 默认只保留最近 50 个任务，每个任务最多持久化 1 MiB 日志；超过上限时记录截断状态和提示。
- 支持清理单个历史任务或全部历史任务，清理前必须再次确认；执行中的任务不能清理。
- 仅持久化三个内置 CLI 已批准的结构化安装/更新计划，不接受自由命令，也不保存环境变量或密钥。

## 依赖检测

应用应提供启动前或设置页中的依赖检测能力：

- 检测 `claude`、`codex`、`agy` 是否可用。
- Antigravity 以 `agy` 为主；`antigravity` 只作为保守兼容探测，不作为推荐启动命令。
- 在 PATH 或可信已知安装目录解析到完整路径时判定为可用，否则判定为未安装。
- 展示实际解析路径；当前版本或最新版本查询失败时保留安装状态，并显示独立失败原因。

## 一键安装

一键安装是后续增强能力，不属于第一版必须完成项。

一键安装必须满足：

- 只覆盖 `claude`、`codex`、`agy` 三个 CLI。
- 安装前展示安装来源和完整命令。
- 安装来源必须来自官方文档或官方推荐包。
- 用户确认后才执行。
- 输出安装日志。
- 安装完成后自动重新检测。
- 安装失败时展示可操作的错误信息和手动安装建议。

## 非目标

- 不使用 Electron。
- 不提供远程后端。
- 第一版不做账号管理。
- 第一版不做代理、模型路由或密钥管理。
- 不做通用 CLI 工具管理器。
- 不检测或安装当前范围外的 CLI 工具。

## 数据归属

SQLite 是功能配置的事实来源：

- directories
- tools
- shell profiles
- per-directory tool arguments
- launch history
- application settings（包括关闭窗口行为）
- execution tasks 与执行日志
- 手动创建的稀疏会话别名
- CLI detection cache（存放在独立可删除的 `cache/cache.db`）

CLI 原始会话标题和源文件路径不属于应用持久缓存数据；展示时从各 CLI 的本地存储实时读取。只有用户显式设置的会话别名进入业务数据库。

本地 UI 偏好后续可使用 JSON 或 Tauri store：

- 窗口尺寸和位置
- 主题
- 上次选择的目录和工具
