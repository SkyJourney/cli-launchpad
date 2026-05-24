# 架构说明

CLI Launchpad 采用 Tauri + React + Rust 的分层结构。React 负责展示和交互，Rust 负责本地能力、命令组合、依赖检测和启动执行。

## 分层

```text
React UI
  调用 Tauri commands，维护全局 CLI 状态和视图状态

Commands
  处理 IPC 边界，转换请求和响应类型

Services
  负责目录管理、工具配置、依赖检测、命令预览、启动流程、会话索引、版本检测与更新

DB repositories
  负责 SQLite 查询和迁移

Platform helpers
  负责 Windows Terminal、PowerShell、命令转义和未来 macOS/Linux 启动行为
```

## 全局 CLI 状态

应用启动时检测三个 CLI，结果作为全局状态贯穿所有视图，可手动刷新。前端引入轻量全局状态库（如 Zustand）持有该状态。

```text
cli_status
  claude:  { installed, path, version, latest_version, path_visible }
  codex:   { installed, path, version, latest_version, path_visible }
  agy:     { installed, path, version, latest_version, path_visible }
```

状态映射到 UI：available（绿色，可启动可编辑）、path_not_visible（黄色，默认启动禁用）、missing（灰色，启动和编辑禁用）。详见 `docs/ui-design.md`。

## Tauri commands 清单

```text
目录与参数
  list_directories / add_directory / update_directory / remove_directory / set_directory_pinned
  get_directory_tool_args / save_directory_tool_args

启动
  preview_launch / launch_tool / resume_session

CLI 状态与版本
  detect_cli_status            检测三个 CLI 的安装、路径、当前版本
  fetch_latest_versions        查询最新可用版本
  update_cli / install_cli     执行更新或安装（结构化参数，输出日志）

会话历史
  list_sessions                按目录和工具列出会话索引
  refresh_session_index        重建会话索引缓存

Shell 配置
  get_shell_profiles / save_shell_profile
```

commands 保持小而清晰，业务组合放在 services。

## 目标 CLI 范围

当前只支持三个核心 CLI：

| 工具            | 默认命令 | 兼容命令      | 说明                                               |
| --------------- | -------- | ------------- | -------------------------------------------------- |
| Claude Code CLI | `claude` | 无            | 打开 Claude Code 工作会话                          |
| Codex CLI       | `codex`  | 无            | 打开 Codex CLI 工作会话                            |
| Antigravity CLI | `agy`    | `antigravity` | `agy` 是官方主命令，`antigravity` 仅作保守兼容探测 |

其他 CLI 工具不进入当前检测、安装或启动设计。

## 启动组合

启动输入按以下顺序组合：

```text
shell profile
+ shell init script
+ selected directory
+ tool executable
+ tool global args
+ directory-specific tool args
```

Windows 首版优先使用 Windows Terminal + PowerShell：

```powershell
wt.exe new-tab -d "<directory>" powershell.exe -NoLogo -NoExit -Command "<script>"
```

PowerShell 脚本应包含 UTF-8 初始化、目录切换和结构化参数调用：

```powershell
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$OutputEncoding=[System.Text.UTF8Encoding]::new()
Set-Location -LiteralPath '<directory>'
& <tool> <args>
```

## CLI 检测与安装

CLI 检测应区分三种状态：

- 已安装且当前 PATH 可见。
- 已安装但当前 PATH 不可见，例如 `~/.cargo/bin` 或 IDE/开发者命令行专属路径。
- 未安装或无法确认。

安装能力不做自动静默执行。UI 必须先展示将要执行的安装命令、来源、权限影响和预计结果，由用户确认后再执行。

Windows 默认安装后端优先级：

1. 官方安装方式或官方包管理建议。
2. `winget`。
3. 仅当某个目标 CLI 的官方安装方式明确要求时，才使用对应的补充安装通道。

当前官方安装来源：

- Claude Code：`winget install --id Anthropic.ClaudeCode --exact` 或官方 PowerShell 安装脚本。
- Codex：`npm i -g @openai/codex`。
- Antigravity：`irm https://antigravity.google/cli/install.ps1 | iex`。

安装命令必须用结构化参数建模，例如：

```text
program: winget
args: ["install", "--id", "...", "--exact", "--accept-package-agreements", "--accept-source-agreements"]
```

避免在业务层拼接自由字符串。

安装通道只是服务 `claude`、`codex`、`agy` 三个目标 CLI，不扩展为通用包管理或通用 CLI 安装器。

## 版本检测与更新

设置页需要展示每个 CLI 的当前版本和最新版本，并提供应用内更新入口。

```text
当前版本
  claude --version / codex --version / agy --version

最新版本
  Claude：官方包或 npm registry @anthropic-ai/claude-code
  Codex：npm registry @openai/codex
  Antigravity：官方渠道（如官方 installer 或发布信息）

更新命令（结构化参数，先预览后确认）
  Claude：claude update 或官方包更新
  Codex：npm i -g @openai/codex@latest
  Antigravity：重跑官方 installer
```

更新与安装走同一流程：预览命令、用户确认、输出日志、完成后重新检测并刷新全局 CLI 状态。最新版本查询涉及网络，失败时降级为"无法获取最新版本"，不阻塞当前版本展示。

## 会话历史读取

会话历史从各 CLI 的本地存储读取，路径已按公开资料核验：

```text
Claude Code  ~/.claude/projects/<slug>/<uuid>.jsonl   可列出，首条 user 消息作标题
Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl   可列出
Antigravity  官方未公开本地路径   不可列出，仅支持按 conversation id 恢复
```

读取逻辑放在 service，解析出标题、时间、session id。结果可缓存到 SQLite 的 sessions 缓存表，缓存可随时删除重建，事实来源始终是各 CLI 的本地文件。Antigravity 不读历史，只提供直接启动。

恢复会话通过 `resume_session` command，按工具拼装恢复参数：Claude 用 `--resume <id>`，Codex 用 `resume`/`resume --last`。恢复参数与普通启动共用命令组合与转义逻辑。

## 安全边界

- 目录路径来自用户输入，启动前必须验证。
- Windows 路径切换使用 `Set-Location -LiteralPath`。
- 工具可执行文件和参数分开建模。
- PowerShell 转义集中放在 `platform/powershell.rs`。
- 启动和安装前都要在 UI 中提供命令预览。
- 不在 SQLite 中保存密钥。如果未来需要凭据，使用操作系统凭据存储。
