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
  claude:  { status, path, version, latest_version, resolved_command }
  codex:   { status, path, version, latest_version, resolved_command }
  agy:     { status, path, version, latest_version, resolved_command }
```

状态只有两种：available（绿色，可启动可编辑）、missing（灰色，禁用）。由于启动一律走解析出的完整路径，"PATH 是否可见"不再单独建模——在 PATH 或已知目录找到全路径即为 available。详见 `docs/ui-design.md`。

## Tauri commands 清单

```text
目录与参数
  list_directories / add_directory / update_directory / remove_directory / set_directory_pinned
  get_directory_tool_args / save_directory_tool_args

启动
  preview_launch / launch_tool / resume_session

工具与全局参数
  list_tools / save_tool_global_args

CLI 状态与版本
  detect_cli_status            检测三个 CLI 的安装、全路径、当前版本
  fetch_latest_versions        查询最新可用版本（npm registry）
  get_install_plan             返回结构化安装/更新命令（仅预览，不执行）
  run_install                  执行安装/更新并捕获日志

会话历史
  list_sessions                按目录和工具读取会话（按需实时读取，无缓存表）
  resume_session               按工具恢复指定会话

Shell 配置
  get_shell_profiles / save_shell_profile / set_shell_kind

配置备份
  export_config_to_path / import_config_from_path   读写 JSON 文件（配合文件对话框）
```

commands 保持小而清晰，业务组合放在 services。

## 桌面集成

- 系统托盘：核心 `tray-icon` 能力，菜单提供"显示主窗口/退出"，左键点击托盘显示窗口。
- 窗口状态持久化：`tauri-plugin-window-state` 在 Rust 层自动保存/恢复窗口尺寸与位置。
- 文件对话框：`tauri-plugin-dialog` 用于添加目录的文件夹选择器、配置导入导出的文件选择（capability 放行 `dialog:allow-open` / `dialog:allow-save`）。
- 单实例：`tauri-plugin-single-instance` 阻止多个 GUI 进程并行写入同一业务数据库，二次启动改为聚焦现有主窗口。

## 本地存储根目录

业务数据使用稳定且与 Tauri 打包身份解耦的用户目录：

```text
~/.cli-launchpad/
├─ data/       cli-launchpad.db（事实数据）
├─ cache/      后续可重建缓存
├─ logs/       后续诊断日志
└─ backups/    后续一致性恢复点
```

应用启动时若新数据库不存在而旧
`%APPDATA%\dev.local.cli-launchpad\cli-launchpad.db` 存在，则复制到新
`data/` 目录；旧文件不自动删除。数据库连接启用外键、忙等待与 WAL，
并在打开既有数据库时运行 `quick_check`，避免在损坏数据库上继续写入。

窗口状态由官方插件保存在 Tauri 配置目录。由于插件不公开自定义根目录
能力，应用更换稳定 `identifier` 时仅迁移其 `.window-state.json`，不将
该运行时文件混入业务数据库目录。

## 打包与运行依赖

- NSIS 单一格式：`bundle.targets = ["nsis"]`，避免 WiX 依赖；`tauri build` 同时产出 NSIS 安装包与裸 exe。
- **VC++ 运行库**：`src-tauri/.cargo/config.toml` 用 `+crt-static` 静态链接 MSVC CRT，目标机无需安装 Visual C++ Redistributable。
- **WebView2 两种策略**：
  - 在线版（默认 `downloadBootstrapper`）：安装包小，安装时按需联网下载。
  - 离线版（`src-tauri/tauri.offline.conf.json` 覆盖 `webviewInstallMode=offlineInstaller`）：内嵌完整 WebView2，离线可装。
- 多版本命名：`scripts/build-installers.ps1` 依次构建在线/离线两版，复用 Tauri 产物名的 `{productName}_{version}_{arch}` 前缀并追加 `online`/`offline`（架构自动继承），归档到 `dist-installers/`。标准维度（版本/架构/格式）由 Tauri 自动命名，非标准维度（WebView2 模式）由脚本补名。

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
launch mode (kind)
+ selected directory
+ resolved full path of shell / terminal
+ resolved full path of tool（候选命令解析，agy 优先于 antigravity）
+ tool global args ⊕ directory-specific tool args（项目级覆盖同名 flag）
```

**全路径解析**：工具、shell、终端都用 `where` 同步解析为完整路径再执行（带 `CREATE_NO_WINDOW`），不依赖被启动进程的 PATH。`where` 命中多条时优先可执行扩展名（`.exe`/`.cmd`/`.bat`/`.com`/`.ps1`），跳过 npm 的无扩展名 POSIX shim。`pwsh.exe` 缺失时回退到 `powershell.exe`。

**三种启动方式（shell profile `kind`）**：

```text
wt-pwsh  Windows Terminal + PowerShell
         wt new-tab -d <dir> <pwsh-full-path> -NoExit -EncodedCommand <base64>
         脚本用 -EncodedCommand(UTF-16LE Base64) 传递，避免 ; 被 wt 当作多 tab 分隔符
pwsh     独立 PowerShell 窗口（CREATE_NEW_CONSOLE + current_dir，; 由 PowerShell 解析）
cmd      独立 CMD 窗口（cmd /K "chcp 65001 & <tool> <args>"）
```

PowerShell 脚本含 UTF-8 初始化、目录切换和结构化调用：

```powershell
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=...
Set-Location -LiteralPath '<directory>'
& '<tool-full-path>' <args>
```

恢复会话通过 `resume_session`，按工具拼装恢复参数后复用同一组合逻辑（Claude `--resume <id>`、Codex `resume <id>`、Antigravity `--conversation=<id>`）。

## CLI 检测与安装

CLI 检测区分两种状态（启动走全路径，不再区分 PATH 可见性）：

- available：在当前 PATH 或已知安装目录解析到完整路径（含 `agy` → `antigravity` 兼容探测）。
- missing：未找到。

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

读取逻辑放在 service，解析出标题、时间、session id。当前实现为**按需实时读取**（只读首条用户消息和文件 mtime，开销小且永远最新），未建缓存表；事实来源始终是各 CLI 的本地文件。Antigravity 不读历史，只提供直接启动。

恢复会话通过 `resume_session` command，按工具拼装恢复参数：Claude 用 `--resume <id>`，Codex 用 `resume`/`resume --last`。恢复参数与普通启动共用命令组合与转义逻辑。

## 安全边界

- 目录路径来自用户输入，启动前必须验证。
- Windows 路径切换使用 `Set-Location -LiteralPath`。
- 工具可执行文件和参数分开建模。
- PowerShell 转义集中放在 `platform/powershell.rs`。
- 启动和安装前都要在 UI 中提供命令预览。
- 不在 SQLite 中保存密钥。如果未来需要凭据，使用操作系统凭据存储。
