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

## 依赖检测

应用应提供启动前或设置页中的依赖检测能力：

- 检测 `claude`、`codex`、`agy` 是否可用。
- Antigravity 以 `agy` 为主；`antigravity` 只作为保守兼容探测，不作为推荐启动命令。
- 区分已安装、未安装、当前 PATH 不可见三类状态。
- 展示检测命令、实际路径和版本信息。
- 对 PATH 不可见的情况给出修复建议，而不是直接判定未安装。

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
- CLI detection cache

本地 UI 偏好后续可使用 JSON 或 Tauri store：

- 窗口尺寸和位置
- 主题
- 上次选择的目录和工具
