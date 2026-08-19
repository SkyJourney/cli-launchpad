# 架构说明

CLI Launchpad 采用 Tauri + React + Rust 的分层结构。React 负责展示和交互，Rust 负责本地能力、命令组合、依赖检测和启动执行。

## 分层

```text
React UI
  调用 Tauri commands，维护全局 CLI 状态和视图状态

Commands
  处理 IPC 边界，转换请求和响应类型

Services
  负责目录管理、工具配置、依赖检测、命令预览、启动流程、会话读取、版本检测与更新

DB repositories
  负责 SQLite 查询和迁移

Platform helpers
  按 Windows/macOS 分支负责 CLI 路径解析、终端探测、结构化启动计划、参数边界和进程树管理
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
  get_directory_tool_args / save_directory_tool_args_batch

启动
  preview_launch / launch_tool / resume_session

工具与全局参数
  list_tools / save_tool_global_args_batch

CLI 状态与版本
  detect_cli_status            被动检测安装与全路径；显式刷新时才执行 --version
  fetch_latest_versions        从三个 CLI 的官方发布元数据查询最新版本
  get_install_plan             返回结构化安装/更新命令（仅预览，不执行）
  start_execution_task         创建后台安装/更新任务
  list/get/cancel/clear_execution_task(s)  查询、终止与清理任务

会话历史
  list_sessions                按目录和工具实时读取会话
  set/delete_session_alias     设置或删除匹配会话 ID 的本地别名
  resume_session               按工具恢复指定会话

模型目录
  get_model_catalog            获取三项 CLI 的模型选项，支持强制刷新

终端启动配置
  detect_terminal_environment / get_launch_target / set_launch_target

桌面行为配置
  get_close_behavior / set_close_behavior

配置备份
  export_config_to_path / import_config_from_path   读写 JSON 文件（配合文件对话框）
```

commands 保持小而清晰，业务组合放在 services。

## 桌面集成

- 系统托盘：核心 `tray-icon` 能力，菜单提供"显示主界面/退出"，左键双击托盘显示并聚焦窗口。
- 关闭窗口行为：设置页可选"最小化到托盘"或"退出应用"，默认关闭到托盘；策略持久化到 SQLite，Rust 窗口事件直接执行该策略。
- 窗口状态持久化：`tauri-plugin-window-state` 在 Rust 层自动保存/恢复窗口尺寸与位置，并排除可见性状态，避免关闭到托盘导致下次启动隐藏。
- 文件对话框：`tauri-plugin-dialog` 用于添加目录的文件夹选择器、配置导入导出的文件选择（capability 放行 `dialog:allow-open` / `dialog:allow-save`）。
- 单实例：`tauri-plugin-single-instance` 阻止多个 GUI 进程并行写入同一业务数据库，二次启动改为聚焦现有主窗口。
- macOS 生命周期：用户点击 Dock 图标重新激活应用时处理 `RunEvent::Reopen`，显示、取消最小化并聚焦主窗口；菜单栏状态项沿用“显示主界面/退出”入口，不依赖 Windows 双击语义。

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
`data/` 目录；旧文件不自动删除。数据库迁移通过 SQLite 一致性备份 API
读取旧库，而非复制活动数据库文件。数据库连接启用外键、忙等待与 WAL，
并在打开既有数据库时运行 `quick_check`，拒绝高于当前应用支持版本的
schema，避免在损坏或未来版本数据库上继续写入。

窗口状态由官方插件保存在 Tauri 配置目录。由于插件不公开自定义根目录
能力，应用更换稳定 `identifier` 时仅迁移其 `.window-state.json`，不将
该运行时文件混入业务数据库目录。

关闭窗口策略属于应用行为配置，保存在业务库 `application_settings` 中，
并包含在版本化 JSON 配置导入导出中。配置导入或数据库恢复完成后，Rust
运行时同步刷新当前策略，保证本次进程内的关闭行为与持久化数据一致。

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
migrations。恢复期间所选源恢复点不参与剪枝，后处理失败会回写恢复前
保护点。manifest 仅接受应用生成的文件名。自动备份保留最近 10 个，手动恢复点保留最近 5 个。

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
为避免导入文件改变执行链，不再导入或导出 Shell 程序与初始化脚本。仍兼容 v1 文件。导入目录必须是绝对路径，存在的目录会规范化为稳定身份。配置导出不
包含日志、缓存、备份、窗口位置或外部 CLI 会话正文。

`launch_history` 仅记录目录、工具、启动或恢复动作、成功状态与错误
类别，不持久化最终命令或参数文本。添加目录和实际发起启动时，Rust
服务层均验证项目路径存在且为目录，失效路径会保留配置并返回修正提示。

## 可删除缓存

缓存数据库固定为 `~/.cli-launchpad/cache/cache.db`，与业务数据库隔离。
缓存内容只包括 CLI 状态短期快照、官方最新版本查询结果和动态模型目录；CLI 原始会话标题及
来源路径不会写入持久缓存。用户手动设置的稀疏会话别名属于业务配置，单独保存在
`session_aliases`，不属于会话缓存。CLI 状态使用 30 秒 TTL，最新版本使用 30 分钟
TTL；过期后重新检测路径时，仅在可执行路径未变化的情况下保留上次主动
探测到的当前版本；目录删除、配置导入和数据库恢复会清除旧版本遗留的
会话缓存；手动刷新强制绕过缓存并执行有界 `--version` 探测。网络查询失败时可回退到已
存在的最新版本缓存。删除或损坏缓存库后应用自动重建；持久缓存不可用时
退化为当前进程的内存缓存，不阻断业务数据库和恢复功能启动。实际启动仍
实时解析工具路径，不以缓存决定执行目标。

## 打包与运行依赖

- 公共配置位于 `src-tauri/tauri.conf.json`，平台 target 通过 Tauri 标准平台配置自动合并。
- Windows 配置位于 `src-tauri/tauri.windows.conf.json`，只生成 NSIS，避免 WiX 依赖；构建同时产出 NSIS 安装包与裸 exe。
- **VC++ 运行库**：`src-tauri/.cargo/config.toml` 用 `+crt-static` 静态链接 MSVC CRT，目标机无需安装 Visual C++ Redistributable。
- **WebView2 两种策略**：
  - 在线版（默认 `downloadBootstrapper`）：安装包小，安装时按需联网下载。
  - 离线版（`src-tauri/tauri.offline.conf.json` 覆盖 `webviewInstallMode=offlineInstaller`）：内嵌完整 WebView2，离线可装。
- 多版本命名：`scripts/build-installers.ps1` 依次构建在线/离线两版，复用 Tauri 产物名的 `{productName}_{version}_{arch}` 前缀并追加 `online`/`offline`（架构自动继承），归档到 `dist-installers/`。标准维度（版本/架构/格式）由 Tauri 自动命名，非标准维度（WebView2 模式）由脚本补名。
- macOS 配置位于 `src-tauri/tauri.macos.conf.json`，只生成 DMG。Apple Silicon 与 Intel 分别使用 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` target 独立编译与测试，不生成 Universal 包。
- `.github/workflows/release.yml` 以 `v*.*.*` Tag 作为正式发布入口，先校验 `package.json`、Tauri 配置和 Cargo 包版本，再并行构建 Windows 在线/离线 NSIS、macOS ARM64 DMG 和 macOS Intel DMG。只有全部 target 成功后才汇总产物、生成 `SHA256SUMS.txt` 并自动创建 GitHub Release；手动触发仅产生短期 Actions Artifacts。
- macOS 线上构建当前使用 ad hoc 签名，不依赖仓库 Secret，也不执行 Apple 公证。后续购买 Developer ID 后，可在保持矩阵与产物汇总结构不变的前提下补充证书导入、公证和 stapling 步骤。
- UI 内置 Noto Sans SC 的 100–900 可变 TTF，并采用 400、500、600、700 四个主要字重；命令、路径、参数和日志内置 Maple Mono NL NF-CN v7.9 的相同四个静态字重。两套字体通过 Vite 前端产物进入各平台安装包，不依赖系统字体安装，并在关于页内置各自的 SIL OFL 1.1 文本。

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
launch target（auto / platform terminal host / Windows Terminal Profile / direct shell）
+ selected directory
+ resolved full path of shell / terminal
+ resolved full path of tool（候选命令解析，agy 优先于 antigravity）
+ tool global args ⊕ directory-specific tool args（项目级覆盖同名 flag）
```

其中 launch target 使用跨平台稳定 ID：Windows 保留现有 `wt:*` 与
`direct:*`；macOS 使用 `macos:terminal`、`macos:iterm2`、
`macos:ghostty`、`macos:wezterm` 与 `macos:kitty`。终端环境响应包含
`platform`、平台中立的 host 列表、Windows 专属 Profile 信息、Shell 信息、
推荐目标和告警。旧数据库中的其他
平台显式目标不会被执行，而是作为当前平台不可用目标进入自动回退。

**执行边界**：工具在启动或版本探测前解析为完整路径；安装计划在用户确认前解析实际目标，并按该目标执行。终端与 Shell 由平台探测结果生成结构化候选，用户参数始终作为字面值传递，只在最终 Shell 边界编码。

**Windows 启动策略**：

```text
自动推荐
  → Windows Terminal 默认 Profile
      A. Profile 原生命令追加（支持 appendCommandLine）
      B. PowerShell Profile 命令续接
      C. 保留 Profile 外观，替换为受控 Shell 命令
  → PowerShell 7 独立窗口
  → Windows PowerShell 独立窗口
  → CMD 独立窗口
```

Windows Terminal Stable、Preview、Canary 和非打包版本分别探测；读取其 `settings.json` 后解析默认 Profile、Profile 名称、命令行和来源。用户也可在设置中指定某个 Profile 或直接 Shell。显式目标启动失败时仍按安全候选继续回退，保证至少存在一种可用方式。

PowerShell 命令使用 UTF-16LE Base64 传递受控脚本，避免参数被 Windows Terminal 或 PowerShell 再次拆分。CMD 兜底不直接拼接不可信字符串，而是通过固定系统 PowerShell 解码同一受控载荷。PowerShell 脚本包含目录切换和结构化调用：

```powershell
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=...
Set-Location -LiteralPath '<directory>'
& '<tool-full-path>' <args>
```

**macOS 启动策略**：

```text
自动推荐
  → Terminal.app（系统内置，默认）
显式选择
  → Terminal.app / iTerm2（一次性、自删除的 .command 文档）
  → Ghostty（AppleScript 原生窗口 + 安全命令输入）
  → WezTerm / kitty（应用包内原生 CLI 参数）
显式目标不可用或启动失败
  → Terminal.app
  → 返回可操作错误，不在 GUI 进程中静默运行 CLI
```

macOS 不使用 Terminal.app 或 iTerm2 的 AppleScript `do script`，避免触发
跨应用自动化权限。Ghostty 使用其官方 AppleScript 字典创建原生窗口，并将
经过 POSIX 引用的完整命令作为 `osascript` argv 传入后，通过 `input text` 与
`send key` 输入目标终端。自动模式固定选择系统 Terminal.app，不因安装第三方
终端而改变；第三方终端仅在用户显式选择时使用。

启动服务先在 `~/.cli-launchpad/cache/launch/` 原子创建权限为 `0700` 的临时
`.command` 文件，供 Terminal.app 与 iTerm2 通过 LaunchServices 按已验证的
Bundle ID 打开。载荷只包含应用生成的固定控制流程和经过 POSIX 单引号规则
编码的目录、完整工具路径与参数，执行开始即删除自身，CLI 退出后回到用户
登录 Shell。WezTerm 与 kitty 直接使用包内 CLI 的结构化参数，其中 kitty 使用
`--hold` 保留命令退出后的窗口。应用启动时清理超过限定时长的残留载荷，启动
失败也主动清理本次文件。所有平台的终端启动子进程都会移除调用方继承的
`NO_COLOR`、`TERM`、`COLORTERM`、`CI` 与强制配色变量，让目标终端建立自己的
交互环境；这也避免 Windows 开发版或从非交互终端启动的安装版把无颜色环境
继续传给 Windows Terminal、PowerShell 和目标 CLI。Windows 启动边界还会从
注册环境读取 Machine PATH 与 User PATH，将当前进程缺失的条目补入子终端 PATH，
避免开发沙箱或隔离父进程隐藏用户级工具入口；该过程不修改注册表或系统环境。

终端探测先检查 `/Applications` 与 `~/Applications` 中的标准应用路径，再使用
`/usr/bin/mdfind` 按 Bundle ID 查找被用户移动的应用。所有候选必须读取
`Info.plist` 复核 Bundle ID；需要直接启动的终端还要验证应用包内可执行文件，
探测过程不执行候选应用。

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
- Codex：Windows 官方 PowerShell 独立安装器，npm 作为备选安装方式。
- Antigravity：`irm https://antigravity.google/cli/install.ps1 | iex`。

macOS 使用官方原生安装脚本：

- Claude Code：`curl -fsSL https://claude.ai/install.sh | bash`。
- Codex：`curl -fsSL https://chatgpt.com/codex/install.sh | sh`。
- Antigravity：`curl -fsSL https://antigravity.google/cli/install.sh | bash`。

这些管道字符串是内置清单中的固定常量，只允许由对应工具的安装计划生成，
不拼接用户输入；执行程序固定解析为系统 `/bin/bash` 或 `/bin/sh`，参数数组
固定使用 `-c` 和对应常量。UI 必须展示完整脚本来源和网络脚本风险。更新仍
执行已解析完整路径上的 `claude update`、`codex update` 或 `agy update`。

安装命令必须用结构化参数建模，例如：

```text
program: winget
args: ["install", "--id", "...", "--exact", "--accept-package-agreements", "--accept-source-agreements"]
```

避免在业务层拼接自由字符串。

安装通道只是服务 `claude`、`codex`、`agy` 三个目标 CLI，不扩展为通用包管理或通用 CLI 安装器。

## 版本检测与更新

设置页提供最新版本查询与应用内更新入口。为避免应用启动时执行 PATH
中的第三方程序，被动检测不自动调用 CLI 的 `--version`；只有用户显式
点击重新检测或安装/更新完成后的刷新才会对已解析的完整路径执行有界版本
探测。版本命令固定为 `--version`，并以超时、无窗口方式捕获输出。

```text
最新版本
  Claude：downloads.claude.ai 原生发布 latest 端点
  Codex：releases.openai.com Codex latest channel
  Antigravity：官方安装器使用的平台 manifest

更新命令（结构化参数，先预览后确认）
  Claude：claude update
  Codex：codex update
  Antigravity：agy update
```

更新与安装走同一流程：预览命令、用户确认、输出日志、完成后主动探测当前
版本并刷新全局 CLI 状态。当前版本和最新版本查询分别返回失败原因；网络
查询失败时可使用已有缓存，不阻塞安装状态与路径展示。

## 执行任务与日志

安装和更新由 Rust 执行任务管理器统一调度，不在前端确认浮层或 React 组件中直接管理子进程：

```text
Settings / Execution View
  -> Tauri command（创建、查询、终止、清理）
  -> ExecutionTaskManager（单任务并发、状态机、进程句柄）
  -> platform process runner（Windows Job Object / Unix process group）
  -> SQLite execution_tasks / execution_task_logs
  -> Tauri events（状态与 stdout/stderr 日志增量）
```

任务状态机为 `preparing -> running -> succeeded | failed`。用户终止时进入
`cancelling -> cancelled`；超时进入 `timed_out`。应用启动时将数据库中遗留的
`preparing`、`running`、`cancelling` 任务统一标记为 `interrupted`，避免把已不存在的
进程继续显示为运行中。

Windows 执行器将任务子进程加入独立 Job Object；终止时关闭整个作业进程树，
防止 PowerShell、包管理器或自更新器留下子进程。该行为是强制终止而不是向
终端发送字面 `Ctrl+C`，UI 统一使用“终止任务”并提示更新中断风险。

macOS 执行器在 spawn 前把任务命令放入新的 Unix process group。终止或超时
时先向整个进程组发送 `SIGTERM`，经过有界宽限期仍未退出时发送 `SIGKILL`，
随后回收根子进程与输出管道。非 Windows 平台不得继续使用空实现，否则取消
任务会在 `child.wait()` 上无限等待。

任务创建时只接受内置三工具清单生成的 `InstallPlan`，持久化工具、类型、来源、
程序、参数数组和预览，不保存环境变量或自由命令。全局同时最多运行一个安装/
更新任务。日志按序号分别记录 `stdout`、`stderr`、`system`，通过 Tauri event 实时
增量下发，同时写入 SQLite。每个任务日志上限 1 MiB，达到上限后写入截断标记；
默认保留最近 50 个任务，裁剪时级联删除日志。执行中任务不可被历史清理。

## 会话历史读取

会话历史按需读取各 CLI 的本地事实来源：

```text
Claude Code  ~/.claude/projects/<slug>/sessions-index.json + <uuid>.jsonl
Codex        App Server thread/list，失败时回退 ~/.codex/sessions/**/rollout-*.jsonl
Antigravity  ~/.gemini/antigravity-cli/conversation_summaries.db + conversation metadata
```

读取逻辑放在 service，解析出原始标题、时间、session id，并严格匹配当前项目目录或
workspace URI。Claude 标题优先级为 `summary`、`firstPrompt`、首条用户消息；Codex 为
`name`、`preview`、首条用户消息；Antigravity 为数据库 `title`、metadata `summary`、
数据库 `preview`。读取故障会明确返回错误而不是伪装为空列表；恢复或修改别名前会再次
验证 session 仍归属于当前目录。

路径身份比较遵守平台语义：Windows 规范化分隔符并忽略大小写；macOS 对存在
路径优先使用 `canonicalize` 后比较，不将路径统一转为小写，对暂时不存在的路径
只做 POSIX 分隔符与尾部分隔符的词法规范化。CLI 状态缓存中的可执行路径比较
使用同一规则，避免大小写敏感卷上的错误复用。

列表默认每页 10 条，Claude 与 Antigravity 使用有界 offset cursor，Codex 透传并封装
App Server cursor。前端为每个 CLI 保留独立无限查询，点击“更多”按 10 条追加。
CLI 原始标题和源文件路径不进入应用持久缓存。

用户手动重命名时才向 `session_aliases` 写入 `tool_key + session_id + alias`；普通会话不会
批量入库。列表读取到真实会话后才合并匹配别名，因此孤立记录不会生成虚假会话。删除别名
即恢复 CLI 原始标题。

恢复会话通过 `resume_session` command，按工具拼装恢复参数：Claude 用 `--resume <id>`，Codex 用 `resume <id>`，Antigravity 用 `--conversation=<id>`。恢复参数与普通启动共用命令组合与转义逻辑。

## 安全边界

- 目录路径来自用户输入，启动前必须验证。
- Windows 路径切换使用 `Set-Location -LiteralPath`。
- macOS 路径和参数使用 POSIX 单引号字面值编码，单引号按关闭、转义、重新打开的规则处理，不允许未编码内容进入启动载荷。
- 工具可执行文件和参数分开建模。
- 终端探测与启动计划分别集中在 `platform/terminal.rs` 和 `platform/terminal_launch.rs`，内部通过平台模块隔离 Windows 与 macOS 逻辑。
- 启动和安装前都要在 UI 中提供命令预览。
- 不在 SQLite 中保存密钥。如果未来需要凭据，使用操作系统凭据存储。

## 跨平台发布约束

- Windows 启动策略已经实现并完成本机受控探针与界面验收。
- macOS 必须提供 CLI 路径检测、五款目标终端探测、一次性结构化启动载荷、Unix 进程组终止和平台路径语义，不允许简单复用 Windows 命令字符串。
- macOS 分别发布 Apple Silicon 与 Intel DMG，不发布 Universal DMG；两个架构均需独立完成构建和运行验证。
- macOS DMG 的 target 配置与功能实现分离；内部未签名测试包可以用于本机验证，正式跨设备分发仍需有效 Developer ID Application 身份、公证凭据和 stapling 验证。
- 0.2.0 发布前必须在真实 macOS 设备完成 CLI 检测与版本、直接启动、项目目录、特殊字符参数、模型目录、会话恢复、安装更新任务、主动终止、Dock/菜单栏恢复和终端失败回退实测；完成前保持发布状态为 Unreleased。
