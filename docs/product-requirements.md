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
- Shell 启动配置与工具参数分离。
- 全局工具参数与目录级工具参数分离。
- 展示即将执行的命令预览。
- 在选定目录中打开对应 CLI 的 PowerShell 窗口。

## 界面形态

界面参考 cc-switch 的卡片式项目管理，采用多视图结构（项目主页、项目详情、参数编辑、设置），不使用弹窗承载主要操作。完整设计见 `docs/ui-design.md`。

核心特性：

- 卡片式项目管理：项目主页以卡片网格展示常用目录。
- 直接启动为常态：点击工具即在该目录启动，命令预览作为可折叠的辅助能力。
- 全局 CLI 状态：应用启动时检测三个 CLI，统一下发到所有视图，缺失的工具在任何位置都灰色禁用。
- 桌面常驻：默认关闭主窗口时最小化到系统托盘，托盘菜单可显示主界面或退出，双击托盘图标显示主界面；设置页可改为关闭即退出。

## 会话历史

应用应能读取并展示已有的 CLI 会话历史，支持快速恢复之前的会话：

- 在项目详情中按 CLI 分 Tab 展示历史会话，不混在同一列表。
- Claude Code 从 `~/.claude/projects/` 读取，Codex 从 `~/.codex/sessions/` 读取，均可列出历史并恢复指定会话。
- Antigravity 官方未公开本地会话文件路径，只支持按 conversation id 恢复，因此不展示历史列表，只提供直接启动。
- 会话历史实时读取事实来源，不将标题摘要或源文件路径持久写入应用缓存。

## 项目级参数编辑

提供项目参数编辑视图，按 CLI 分区配置该项目的工具参数：

- 项目级附加参数与全局参数分离，项目级只覆盖或追加；参数作为字面值传入 CLI，不被 Shell 求值执行。
- Claude 区提供模型快捷选择（如指定 `--model`）。
- 未安装的 CLI 分区灰色禁用。
- 项目级参数保存到 SQLite。

## 版本检测与更新

设置页提供 CLI 版本管理能力：

- 检测三个 CLI 的可用路径和最新可用版本；被动检测不自动执行候选程序获取当前版本。
- 对有新版的 CLI 提供应用内更新入口，执行对应官方更新命令。
- 更新与安装遵循同一原则：先预览命令、用户确认、输出日志、完成后重新检测。
- 更新来源必须来自官方：Claude 使用 `claude update` 或官方包，Codex 使用 `npm i -g @openai/codex@latest`，Antigravity 重跑官方 installer。

## 依赖检测

应用应提供启动前或设置页中的依赖检测能力：

- 检测 `claude`、`codex`、`agy` 是否可用。
- Antigravity 以 `agy` 为主；`antigravity` 只作为保守兼容探测，不作为推荐启动命令。
- 在 PATH 或可信已知安装目录解析到完整路径时判定为可用，否则判定为未安装。
- 展示实际解析路径；被动检测不执行候选程序获取版本。

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
- CLI detection cache（存放在独立可删除的 `cache/cache.db`）

会话标题和源文件路径不属于应用持久缓存数据；展示时从各 CLI 的本地存储实时读取。

本地 UI 偏好后续可使用 JSON 或 Tauri store：

- 窗口尺寸和位置
- 主题
- 上次选择的目录和工具
