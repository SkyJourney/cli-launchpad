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
  detect_cli_status            被动检测三个 CLI 的安装与全路径，不执行候选程序
  fetch_latest_versions        查询最新可用版本（npm registry）
  get_install_plan             返回结构化安装/更新命令（仅预览，不执行）
  run_install                  执行安装/更新并捕获日志

会话历史
  list_sessions                按目录和工具读取会话（可使用可删除短期缓存）
  resume_session               按工具恢复指定会话

Shell 配置
  get_shell_profiles / set_shell_kind

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

## 数据备份与恢复

`backups/` 保存 SQLite 一致性恢复点，不等同于面向迁移的 JSON 配置导出：

```text
~/.cli-launchpad/backups/
├─ database/    cli-launchpad-<timestamp>-<reason>.db
└─ manifests/   cli-launchpad-<timestamp>-<reason>.json
```

备份使用 SQLite Online Backup API 生成，支持手动创建，并在配置导入、
数据库 schema 迁移和恢复覆盖前自动创建保护恢复点。恢复时先校验备份
完整性，拒绝来自更新 schema 的文件；恢复较旧 schema 后重新执行当前
migrations。自动备份保留最近 10 个，手动恢复点保留最近 5 个。

## 日志与诊断

应用使用官方日志插件将脱敏后的运行事件写入
`~/.cli-launchpad/logs/cli-launchpad.log`，覆盖启动、数据库初始化、
备份恢复、CLI 检测、安装更新和配置导入导出。日志不写入工具参数、
命令正文、会话标题或安装原始输出。日志单文件限制为 2 MiB，并最多
保留 10 个应用日志文件。

设置页提供诊断导出，JSON 报告包含应用版本、平台、存储根目录、数据库
schema 版本与日志内容，用于本地排障。

## 配置交换与启动历史

可移植 JSON 配置 bundle 当前版本为 v2，覆盖目录及全局/项目级工具参数；
为避免导入文件改变执行链，不再导入或导出 Shell 程序与初始化脚本。仍兼容 v1 文件。配置导出不
包含日志、缓存、备份、窗口位置或外部 CLI 会话正文。

`launch_history` 仅记录目录、工具、启动或恢复动作、成功状态与错误
类别，不持久化最终命令或参数文本。添加目录和实际发起启动时，Rust
服务层均验证项目路径存在且为目录，失效路径会保留配置并返回修正提示。

## 可删除缓存

缓存数据库固定为 `~/.cli-launchpad/cache/cache.db`，与业务数据库隔离。
缓存内容包括 CLI 状态短期快照、npm 最新版本查询结果和 Claude/Codex
会话列表摘要。CLI 状态使用 30 秒 TTL，最新版本使用 30 分钟 TTL，会话
摘要使用 60 秒 TTL；手动刷新强制绕过缓存。网络查询失败时可回退到已
存在的最新版本缓存。删除或损坏缓存库后应用自动重建，实际启动仍实时
解析工具路径，不以缓存决定执行目标。

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

**执行边界**：工具在启动或版本探测前解析为完整路径；安装计划在用户确认前解析实际目标，并按该目标执行。Shell 固定使用系统 PowerShell，初始化脚本固定在程序内；用户参数始终以 PowerShell 字面值传递。

**启动方式（shell profile `kind`）**：

```text
wt-pwsh  Windows Terminal + PowerShell
         wt new-tab -d <dir> <pwsh-full-path> -NoExit -EncodedCommand <base64>
         脚本用 -EncodedCommand(UTF-16LE Base64) 传递，避免 ; 被 wt 当作多 tab 分隔符
pwsh     独立 PowerShell 窗口（CREATE_NEW_CONSOLE + current_dir，; 由 PowerShell 解析）
cmd      已停用；旧配置会提示切换到 PowerShell
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

设置页提供最新版本查询与应用内更新入口。为避免应用启动时执行 PATH
中的第三方程序，被动检测不再自动调用 CLI 的 `--version`。

```text
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

读取逻辑放在 service，解析出标题、时间、session id。结果可短期缓存到
`~/.cli-launchpad/cache/cache.db`，用户可在设置页随时清除；事实来源始终
是各 CLI 的本地文件。Antigravity 不读历史，只提供直接启动。

恢复会话通过 `resume_session` command，按工具拼装恢复参数：Claude 用 `--resume <id>`，Codex 用 `resume`/`resume --last`。恢复参数与普通启动共用命令组合与转义逻辑。

## 安全边界

- 目录路径来自用户输入，启动前必须验证。
- Windows 路径切换使用 `Set-Location -LiteralPath`。
- 工具可执行文件和参数分开建模。
- PowerShell 转义集中放在 `platform/powershell.rs`。
- 启动和安装前都要在 UI 中提供命令预览。
- 不在 SQLite 中保存密钥。如果未来需要凭据，使用操作系统凭据存储。
