---
name: 参考资料
description: 官方 CLI 文档调研摘要和外部依据
type: reference
last_updated: 2026-10-02
commit: 8d4a751
---

# 参考资料

## 官方 CLI 资料

- Claude Code CLI：官方命令为 `claude`。Windows 可使用 `winget install Anthropic.ClaudeCode`，也可使用官方 PowerShell 安装脚本。
- Codex CLI：官方命令为 `codex`。官方安装方式为 `npm i -g @openai/codex`，升级命令为 `npm i -g @openai/codex@latest`。
- Antigravity CLI：官方命令为 `agy`。Windows 官方安装方式为 PowerShell：`irm https://antigravity.google/cli/install.ps1 | iex`。
- Grok Build CLI：官方命令为 `grok`，Windows 官方安装器为 `https://x.ai/cli/install.ps1`；版本检查、安装来源和本地会话 metadata 的边界见 [G1 调研与验收文档](../../docs/milestones/grok-build-cli.md)。
- Hermes Agent CLI：官方命令为 `hermes`，Windows 官方安装器为 `https://hermes-agent.nousresearch.com/install.ps1`。官方更新按源码安装或包管理渠道区分；`hermes update --check` 检查版本，`hermes update --plan` 预览影响。会话元数据位于当前有效 Hermes home 对应 Profile 的 SQLite `state.db`；G2 的过滤、恢复参数及不接入范围见 [G2 调研与验收文档](../../docs/milestones/hermes-agent-cli.md)。
- Hermes 官方资料：[安装](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)、[更新](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/updating.md)、[CLI](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/cli.md)、[会话管理](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)、[会话存储](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md)。

**See Also：** [[project_progress.md#已完成功能]] [[decisions.md#Antigravity-使用-agy-作为官方主命令]] [[decisions.md#安装命令必须来自官方来源]] [[project_overview.md#核心-CLI-范围]]

## 使用方式

这些资料用于维护 `docs/tooling-and-installation.md` 及五项目标 CLI 的检测、安装和更新清单；Hermes 的实装进度以 G2 阶段验收为准。若官方文档变化，应先更新 docs，再调整内置命令计划。

## 发布工具官方资料

- [Tauri Action](https://github.com/tauri-apps/tauri-action)：GitHub Actions 中调用 Tauri CLI 构建桌面安装包；`tauriScript` 必须指向实际的包管理器 Tauri 入口。
- [GitHub Actions 手动运行工作流](https://docs.github.com/actions/managing-workflow-runs/manually-running-a-workflow)：用于 Tag 前执行不发布 Release 的六目标构建预检。
- [GitHub CLI auth login](https://cli.github.com/manual/gh_auth_login)：SSH Key 负责 Git 传输，`gh` 的 OAuth Token 负责 Actions 与 Release API；已有 SSH 配置时使用 `--skip-ssh-key` 避免生成或上传新密钥。

**See Also：** [[decisions.md#Git-Tag-驱动跨平台自动发布]] [[project_progress.md#0.2.1-发布完成]] [[synthesis_release-tag-cross-platform.md#结论]]

## See Also

- [[decisions.md#安装命令必须来自官方来源]]
- [[decisions.md#Antigravity-使用-agy-作为官方主命令]]
