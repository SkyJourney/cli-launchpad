---
name: 参考资料
description: 官方 CLI 文档调研摘要和外部依据
type: reference
last_updated: 2026-08-19
commit: b01a015
---

# 参考资料

## 官方 CLI 资料

- Claude Code CLI：官方命令为 `claude`。Windows 可使用 `winget install Anthropic.ClaudeCode`，也可使用官方 PowerShell 安装脚本。
- Codex CLI：官方命令为 `codex`。官方安装方式为 `npm i -g @openai/codex`，升级命令为 `npm i -g @openai/codex@latest`。
- Antigravity CLI：官方命令为 `agy`。Windows 官方安装方式为 PowerShell：`irm https://antigravity.google/cli/install.ps1 | iex`。

**See Also：** [[project_progress.md#已完成功能]]

## 使用方式

这些资料用于维护 `docs/tooling-and-installation.md` 及已实现的三项 CLI 检测、安装和更新清单。若官方文档变化，应先更新 docs，再调整内置命令计划。

## 发布工具官方资料

- [Tauri Action](https://github.com/tauri-apps/tauri-action)：GitHub Actions 中调用 Tauri CLI 构建桌面安装包；`tauriScript` 必须指向实际的包管理器 Tauri 入口。
- [GitHub Actions 手动运行工作流](https://docs.github.com/actions/managing-workflow-runs/manually-running-a-workflow)：用于 Tag 前执行不发布 Release 的四目标预检。
- [GitHub CLI auth login](https://cli.github.com/manual/gh_auth_login)：SSH Key 负责 Git 传输，`gh` 的 OAuth Token 负责 Actions 与 Release API；已有 SSH 配置时使用 `--skip-ssh-key` 避免生成或上传新密钥。

**See Also：** [[decisions.md#Git-Tag-驱动四目标自动发布]] [[project_progress.md#0.2.1-发布完成]]

## See Also

- [[decisions.md#安装命令必须来自官方来源]]
- [[decisions.md#Antigravity-使用-agy-作为官方主命令]]
