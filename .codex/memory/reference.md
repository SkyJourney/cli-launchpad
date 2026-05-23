---
name: 参考资料
description: 官方 CLI 文档调研摘要和外部依据
type: reference
last_updated: 2026-05-23
commit: a2fbb54
---

# 参考资料

## 官方 CLI 资料

- Claude Code CLI：官方命令为 `claude`。Windows 可使用 `winget install Anthropic.ClaudeCode`，也可使用官方 PowerShell 安装脚本。
- Codex CLI：官方命令为 `codex`。官方安装方式为 `npm i -g @openai/codex`，升级命令为 `npm i -g @openai/codex@latest`。
- Antigravity CLI：官方命令为 `agy`。Windows 官方安装方式为 PowerShell：`irm https://antigravity.google/cli/install.ps1 | iex`。

**See Also：** [[project_progress.md#当前状态]]

## 使用方式

这些资料用于维护 `docs/tooling-and-installation.md` 和未来三项 CLI 检测/安装清单。若官方文档变化，应先更新 docs，再改代码。

## See Also

- [[decisions.md#安装命令必须来自官方来源]]
- [[decisions.md#antigravity-使用-agy-作为官方主命令]]
