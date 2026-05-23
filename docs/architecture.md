# 架构说明

CLI Launchpad 采用 Tauri + React + Rust 的分层结构。React 负责展示和交互，Rust 负责本地能力、命令组合、依赖检测和启动执行。

## 分层

```text
React UI
  调用 Tauri commands

Commands
  处理 IPC 边界，转换请求和响应类型

Services
  负责目录管理、工具配置、依赖检测、命令预览和启动流程

DB repositories
  负责 SQLite 查询和迁移

Platform helpers
  负责 Windows Terminal、PowerShell、命令转义和未来 macOS/Linux 启动行为
```

## 目标 CLI 范围

当前只支持三个核心 CLI：

| 工具 | 默认命令 | 兼容命令 | 说明 |
| --- | --- | --- | --- |
| Claude Code CLI | `claude` | 无 | 打开 Claude Code 工作会话 |
| Codex CLI | `codex` | 无 | 打开 Codex CLI 工作会话 |
| Antigravity CLI | `agy` | `antigravity` | `agy` 是官方主命令，`antigravity` 仅作保守兼容探测 |

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

## 安全边界

- 目录路径来自用户输入，启动前必须验证。
- Windows 路径切换使用 `Set-Location -LiteralPath`。
- 工具可执行文件和参数分开建模。
- PowerShell 转义集中放在 `platform/powershell.rs`。
- 启动和安装前都要在 UI 中提供命令预览。
- 不在 SQLite 中保存密钥。如果未来需要凭据，使用操作系统凭据存储。
