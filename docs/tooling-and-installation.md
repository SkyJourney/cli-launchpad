# CLI 检测与安装设计

## 范围

G1 完成后当前有四个核心工具；G2 完成后，本设计覆盖 0.3.0 的五个目标 CLI：

- Claude Code CLI：`claude`
- Codex CLI：`codex`
- Antigravity CLI：官方主命令 `agy`
- Grok Build CLI：官方命令 `grok`（独立里程碑 G1）
- Hermes Agent CLI：官方命令 `hermes`（独立里程碑 G2；Windows 阶段先接入）

不检测、不安装、不管理其他 CLI。

Antigravity 是 Google 将 Gemini CLI 迁移到新品牌后的目标 CLI。本项目只关注 Antigravity CLI，不再把 Gemini CLI 作为检测、启动或安装目标。

## Windows 基线检查结果

当前环境检查结果：

| 项目                | 状态                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `claude`            | 可用，版本 `2.1.150 (Claude Code)`                                       |
| `codex`             | 可用，版本 `codex-cli 0.133.0`                                           |
| `agy`               | 未发现                                                                   |
| `antigravity`       | 未发现，仅作为保守兼容探测                                               |
| `pnpm`              | 可用，版本 `10.29.2`                                                     |
| `node`              | 可用，版本 `v24.12.0`                                                    |
| `winget`            | 可用，版本 `v1.28.240`                                                   |
| Rust 工具链         | 已安装，但当前普通 PowerShell PATH 未直接暴露 `rustup`、`rustc`、`cargo` |
| VS Build Tools 2022 | 已安装，MSVC `14.44.35207`                                               |

`pnpm`、`node`、`winget`、Rust 和 VS 工具链是开发与打包依赖，不属于应用内面向用户的一键安装范围。应用内检测、启动和管理只服务五个已确认目标 CLI；Grok Build 按 G1、Hermes Agent 按 G2 分阶段接入，当前状态见 [G1 里程碑](milestones/grok-build-cli.md)和 [G2 里程碑](milestones/hermes-agent-cli.md)。

## 官方依据

当前文档设计基于官方资料：

- Claude Code CLI 官方命令为 `claude`。Windows 可使用 `winget install Anthropic.ClaudeCode`；macOS 使用 `curl -fsSL https://claude.ai/install.sh | bash`。
- Codex CLI 官方命令为 `codex`。Windows 优先使用官方 PowerShell 独立安装器；macOS 使用 `curl -fsSL https://chatgpt.com/codex/install.sh | sh`；当前 CLI 提供 `codex update`。Windows 下由应用固定通过 Windows PowerShell 5.1 执行该更新命令，并将 `PSModulePath` 限定为 Windows PowerShell 5.1 的标准模块目录，避免应用从 PowerShell 7 启动时把不兼容的模块路径继承给更新器。
- Antigravity CLI 官方命令为 `agy`。Windows 使用官方 PowerShell installer；macOS 使用 `curl -fsSL https://antigravity.google/cli/install.sh | bash`。
- Grok Build CLI 官方命令为 `grok`。Windows 官方安装器为 `https://x.ai/cli/install.ps1`，Launchpad 固定 stable 通道；默认目录为当前用户目录下的 `.grok/bin`，支持 `GROK_BIN_DIR`。安装脚本会视情况替换 `grok.exe`/`agent.exe`、写入用户级 PATH 与 Grok CLI 配置，并生成 PowerShell 补全。若环境含 `GROK_DEPLOYMENT_KEY`，还会请求并写入托管部署配置。脚本从 x.ai 获取版本和二进制，必要时回退 Google Cloud Storage。CLI 支持 `grok update`、`grok update --check`，以及 `grok --resume <session-id>`。
- Grok Build 的 macOS/Linux 确认预览按官方 POSIX 脚本 `https://x.ai/cli/install.sh` 说明影响：默认把版本二进制放在 `~/.grok/downloads`、在 `~/.grok/bin` 发布 `grok`/`agent` 入口，写入 `~/.grok/config.toml` 与 Bash/Zsh/Fish 补全；脚本按可识别的 shell 修改启动文件以加入 PATH，首次编辑对应现有文件时创建时间戳备份。macOS Bash 还可能在已有 `~/.bash_profile` 中追加加载 `~/.bashrc` 的语句。如果 `~/.local/bin` 或 `/usr/local/bin` 已在 PATH 且可写，也可能在那里创建入口软链接。Launchpad 固定 stable；仅在环境存在 `GROK_DEPLOYMENT_KEY` 时请求和写入托管部署配置。见[官方脚本](https://x.ai/cli/install.sh)及[Grok Build 官方说明](https://docs.x.ai/build/overview)。
- Grok 官方会话位于 `~/.grok/sessions/`（可由 `GROK_HOME` 覆盖）；Launchpad 只读取官方文档描述的 `summary.json` metadata。官方 `grok sessions search` 可能混合本地与远端结果，因此工作台只实现本地 metadata 搜索。
- Hermes Agent CLI 官方命令为 `hermes`，支持 `hermes --version`。Windows 官方安装器为 `https://hermes-agent.nousresearch.com/install.ps1`；G2 使用官方 PowerShell 调用方式和 `-NonInteractive -Branch main -SkipBrowser -SkipComputerUse`，跳过 setup/gateway 交互及 Launchpad 不提供的可选浏览器、computer-use 工具。源码受管安装的入口默认位于 `%LOCALAPPDATA%\hermes\bin\`，源码与默认用户数据位于 `%LOCALAPPDATA%\hermes\`，`HERMES_HOME` 可覆盖数据目录。安装器仍会准备其受管 Python/Node 等运行时和基础依赖、launcher 与数据目录；确认预览说明这些影响和用户 PATH 变更。官方更新说明区分源码安装与包管理安装；`hermes update --check` 不应用代码、不安装依赖或重启 Gateway，但可能获取 Git metadata，不视为零文件写入；`hermes update --plan` 可查看安装归属及运行服务影响。Launchpad 的更新任务直接运行官方默认命令 `hermes update`，不指定分支或额外确认参数，也不重复读取更新计划；安装渠道、默认更新目标与交互由 Hermes CLI 自行处理。
- Hermes Agent macOS/Linux 安装确认预览按当前官方 POSIX 安装脚本及 Launchpad 参数说明：源码位于 `~/.hermes/hermes-agent`，命令入口发布到 `~/.local/bin/hermes`，默认数据目录为 `~/.hermes`（可由 `HERMES_HOME` 改写）；安装会下载校验过的 uv、准备受管 Python/依赖和工具缓存、写安装日志，并按检测到的 shell 更新启动文件 PATH。Launchpad 使用 `--non-interactive` 跳过首次 setup 向导，同时传入 `--skip-browser --skip-computer-use`；官方脚本会记住这两个可选组件的跳过状态，之后可通过 `hermes pm install` 单独安装。Linux 管理入口仅识别官方默认的 `~/.local/bin/hermes` 与 `~/.hermes/hermes-agent` Git checkout；其他路径或安装渠道仍交由其自身管理。官方细节见[安装文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)、[当前安装脚本](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh)；社区用户也报告安装后需要重新载入 shell 配置并留意 `~/.local/bin` PATH 项，见[安装后 PATH 案例](https://www.reddit.com/r/hermesagent/comments/1tsp31w/uninstall_hermes_completely_for_a_clean_install/)。
- Hermes 会话保存在当前有效 Hermes home 对应 Profile 的 SQLite `state.db`；官方 `sessions` 表含 `source`、`title`、`cwd`、`git_repo_root` 等元数据。G2 只读且有界地处理 `source=cli` 会话，按项目目录过滤；指定会话以 `hermes --resume <session-id> --no-restore-cwd` 恢复。官方稳定机器可读列表格式未明确前，不解析人类可读表格输出。
- Antigravity 官方 release manifest 的 macOS 平台名为 `darwin_arm64` 与 `darwin_amd64`。

后续实现时，如果官方安装命令变化，应先更新本文档，再调整安装清单。

## 检测模型

每个工具应定义：

```text
id: claude | codex | antigravity | grok | hermes
display_name: 用户可见名称
commands: 候选命令列表
version_args: 版本检测参数
install_hint: 手动安装说明或安装命令候选
```

检测结果：

```text
status: available | missing | unknown
resolved_command: 实际命中的候选命令（agy 优先于 antigravity）
path: 解析出的完整可执行文件路径
version: 当前版本输出
latest_version: 最新可用版本（可选，网络查询失败时为空）
```

启动一律走解析出的完整路径，不再区分 PATH 可见性。`unknown` 表示检测任务异常或无法判断，不会误报为未安装；该工具暂时禁用启动，其余工具照常工作。各 CLI 差异由 `src-tauri/src/services/cli_adapters/<cli>/` 与 `src/lib/cliAdapters/<cli>.ts` 实现，公共服务统一管理查询并发、缓存、任务执行、PTY 和搜索索引。检测结果作为全局 CLI 状态贯穿所有视图，详见 `docs/ui-design.md`。

Antigravity 的候选命令顺序：

```text
agy
antigravity
```

其中 `agy` 是官方主命令。`antigravity` 只作为保守兼容探测，不应在 UI 中作为推荐启动命令展示。

## Windows 检测策略

优先使用当前进程 PATH：

```powershell
Get-Command claude
Get-Command codex
Get-Command agy
Get-Command antigravity
Get-Command grok
```

如果 PATH 不可见，可以补充检查常见用户级目录，但补充检查只用于提示，不应绕过用户配置直接执行未知路径：

```text
%USERPROFILE%\.local\bin
%APPDATA%\npm
%LOCALAPPDATA%\Microsoft\WinGet\Links
%LOCALAPPDATA%\agy\bin
%LOCALAPPDATA%\Programs\OpenAI\Codex\bin
%USERPROFILE%\.grok\bin\grok.exe
%GROK_BIN_DIR%\grok.exe（仅在环境变量存在时）
```

被动检测只解析路径，不执行候选程序。用户点击重新检测或安装/更新完成后，
应用对已解析的完整路径执行有超时限制的 `--version`；版本探测失败不影响
`available` 状态，并单独展示失败原因。

## macOS 检测策略

GUI 应用从 Finder 或 Dock 启动时不能假设继承交互式 zsh 的完整 PATH。检测先
解析当前进程 PATH，再按固定顺序检查可信安装位置：

```text
~/.local/bin
/opt/homebrew/bin
/usr/local/bin
~/.volta/bin
~/.nvm/versions/node/*/bin
```

这些目录覆盖已有官方原生安装器与 Homebrew 的常见位置；Volta/NVM 只用于兼容
既有 Codex npm 安装。扫描 NVM 时只接受既有 `versions/node/<version>/bin`
目录中的目标文件，不执行 Shell 初始化脚本，也不通过 `zsh -lc` 加载用户配置。
候选必须是普通文件或指向普通文件的符号链接，并解析为完整路径。

本次 macOS 开发机只读审计确认三个官方命令均位于 `~/.local/bin`：Claude
`2.1.234`、Codex `0.147.0`、AGY `1.1.14`。该结果只是测试基线，不写入产品逻辑。

## macOS 终端探测与支持

macOS 自动模式固定使用系统 Terminal.app。第三方终端只有在检测到可信应用包且
用户显式选择后才参与启动，避免安装新终端后静默改变既有行为。

| 稳定 target ID   | 终端         | Bundle ID / 校验方式     | 启动接口                                |
| ---------------- | ------------ | ------------------------ | --------------------------------------- |
| `macos:terminal` | Terminal.app | `com.apple.Terminal`     | LaunchServices 打开 `.command`          |
| `macos:iterm2`   | iTerm2       | `com.googlecode.iterm2`  | LaunchServices 打开 `.command`          |
| `macos:ghostty`  | Ghostty      | `com.mitchellh.ghostty`  | LaunchServices 打开 `.command`          |
| `macos:wezterm`  | WezTerm      | `com.github.wez.wezterm` | `wezterm start --cwd <dir> -- <helper>` |
| `macos:kitty`    | kitty        | 验证应用包与包内 `kitty` | `kitty --directory <dir> <helper>`      |

探测顺序为标准 `/Applications`、用户 `~/Applications`，最后按 Bundle ID 使用
Spotlight 查找非标准位置。每个结果都读取 `Info.plist` 复核；WezTerm 与 kitty
还要验证包内 CLI。被动探测不启动终端，也不使用 AppleScript。

Terminal.app、iTerm2、Ghostty 对 `.command` 文档的支持来自各自应用声明；
WezTerm 与 kitty 使用官方 CLI 提供的工作目录与待执行程序参数。相关实现依据见
[iTerm2 scripting](https://iterm2.com/documentation-scripting.html)、
[Ghostty documentation](https://ghostty.org/docs)、
[WezTerm CLI start](https://wezterm.org/cli/start.html)、
[kitty invocation](https://sw.kovidgoyal.net/kitty/invocation/)。

## 安装模型

一键安装流程必须显式确认：

1. 用户点击安装。
2. 应用展示安装来源、命令和权限提示。
3. 用户确认。
4. Rust 层用结构化参数启动安装命令。
5. 创建后台执行任务，在“执行任务”视图展示状态与实时日志。
6. 安装完成后重新检测。

安装命令结构示例：

```text
program: winget
args:
  - install
  - --id
  - <package-id>
  - --exact
  - --accept-package-agreements
  - --accept-source-agreements
```

五个目标 CLI 的 Windows 安装清单：

| 工具         | 首选安装方式              | 命令模型                                                                                                                                              |
| ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | `winget` 官方包           | `winget install --id Anthropic.ClaudeCode --exact --accept-package-agreements --accept-source-agreements`                                             |
| Codex        | 官方 PowerShell installer | `irm https://chatgpt.com/codex/install.ps1 \| iex`                                                                                                    |
| Antigravity  | 官方 PowerShell installer | `irm https://antigravity.google/cli/install.ps1 \| iex`                                                                                               |
| Grok Build   | 官方 PowerShell installer | `irm https://x.ai/cli/install.ps1 \| iex`                                                                                                             |
| Hermes Agent | 官方 PowerShell installer | `& ([scriptblock]::Create((irm https://hermes-agent.nousresearch.com/install.ps1))) -NonInteractive -Branch main -SkipBrowser -SkipComputerUse`（G2） |

如果某个 CLI 没有稳定的官方包或官方安装命令，不应伪造安装命令。此时只展示官方手动安装说明。

`irm ... | iex` 类型安装脚本必须在 UI 中高亮来源、网络执行风险和确认按钮。默认不要静默运行。

macOS/Linux（POSIX）安装清单：

| 工具         | 解释器      | 固定官方命令                                                                                                                     |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | `/bin/bash` | `curl -fsSL https://claude.ai/install.sh \| bash`                                                                                |
| Codex        | `/bin/sh`   | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`                                                                          |
| Antigravity  | `/bin/bash` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`                                                                   |
| Grok Build   | `/bin/bash` | `curl -fsSL https://x.ai/cli/install.sh \| bash`                                                                                 |
| Hermes Agent | `/bin/bash` | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash -s -- --non-interactive --skip-browser --skip-computer-use` |

macOS/Linux 的 Grok Build 与 Hermes Agent 均调用官方 POSIX 安装脚本；Hermes 使用非交互模式跳过工作台不提供的浏览器和 computer-use 可选工具。官方默认入口为 `~/.local/bin/hermes`，源码 checkout 位于 `~/.hermes/hermes-agent`；Launchpad 仅对这两个默认位置匹配且包含 Git checkout 的安装开放托管更新。Hermes Desktop、Nix 或其他自定义安装路径由其所属渠道更新。macOS/Linux 实机验收仍归 M5。

实现层把解释器作为 `program`，把 `-c` 和对应命令常量作为参数数组。网络脚本
字符串只能从内置 CLI 安装清单产生，不允许追加用户输入；预览必须原样展示 URL、
解释器和管道风险。这些安装计划以当前用户权限运行，不要求应用请求管理员权限。
Grok Windows 主程序通过 HTTPS 下载；安装脚本对其附带的 MinGit 压缩包单独校验 SHA-256。

安装来源必须绑定到五项目标 CLI 的内置清单，不允许用户把任意 CLI 或任意包名加入一键安装流程。

## 更新模型

对已安装的 CLI，设置页提供应用内更新。更新与安装共用同一确认流程：预览命令、用户确认、输出日志、完成后重新检测。

最新版本查询：

| 工具         | 最新版本来源                                                                                                                                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | `downloads.claude.ai/claude-code-releases/latest`                                                                                                                                                                                                                                                                                       |
| Codex        | `releases.openai.com/codex/channels/latest`                                                                                                                                                                                                                                                                                             |
| Antigravity  | 官方安装器使用的当前平台 release manifest                                                                                                                                                                                                                                                                                               |
| Grok Build   | 进入设置页或手动刷新时独立运行官方 `grok update --check --json` 并解析 `latestVersion`；无法解析则显示未知                                                                                                                                                                                                                              |
| Hermes Agent | 进入设置页或手动刷新时，对已识别的官方 Windows/macOS/Linux 默认源码安装独立运行 `hermes update --check`，使用 Hermes 官方默认更新目标；以分支落后提交数表达更新状态，不使用语义版本比较；浅克隆可能只能确认有更新而无法给出提交数。该检查不应用代码、不安装依赖或重启 Gateway，但会获取并更新 Git 比较 metadata；无法识别输出时显示未知 |

设置页按 CLI 分别发起安装、当前版本和更新状态查询，并独立显示进度与结果；单个 CLI 的慢查询或失败不会阻塞其他 CLI。进入设置页自动查询，手动刷新必须强制重新查询；任务完成后的版本回读只刷新对应 CLI。

## CLI 生命周期适配器

每个目标 CLI 注册一个适配器，集中定义该工具的安装检测、版本探测与解析、更新语义、安装/更新命令计划，以及 CLI 专属的启动/恢复参数、历史来源解析和展示元数据。适配器只包含 CLI 专属差异，不负责 React 状态、PTY/窗口状态机、持久任务、日志、取消、搜索索引或平台进程树。

```text
CLI 适配器：检测/版本/更新/计划 + 启动/恢复 + 历史 DTO 解析 + 展示元数据
公共协调器：并发查询、强制刷新、缓存与失败回退
公共工作台与历史服务：项目校验、PTY 生命周期、会话索引/搜索/分页/去重
公共任务管理器：CLI 槽位互斥、跨 CLI 并行、事件日志、取消与历史持久化
平台 primitives：进程、文件系统、路径、PTY 等操作系统能力
```

适配器按 CLI 拆分公共实现与平台实现。公共实现放稳定的命令语义、解析规则、参数构造和 DTO 转换；只有确有系统差异的逻辑才放在该 CLI 的 Windows、macOS 或 Linux 覆盖实现中。共用的路径解析、进程执行和文件读取能力留在公共平台 primitives，不为每个 CLI 重复实现。图标与本地化名称由前端展示注册表维护，并以相同的 `ToolKey` 对应 Rust 适配器。

Windows 下 Codex 的官方安装器和内置更新命令都必须通过 `SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`（Windows PowerShell 5.1）运行；不得回退到 PowerShell 7。该路径无法解析时，计划生成应明确失败。

统一查询状态由安装状态/完整路径、当前版本、更新可用状态、最新版本或提交差异、缓存来源与最后成功检查时间，以及最近一次错误组成。适配器负责把各 CLI 的原始输出和更新语义映射到这一状态；Hermes 的分支提交差异不与语义版本比较混用。

缓存与刷新规则：

- React Query 缓存只用于页面快速呈现；每个 CLI 使用独立查询键和刷新状态。查询可以同时启动，单项超时或失败不延迟其他 CLI 的结果。
- Rust 可重建缓存只保存成功的更新探测结果及其成功时间。手动刷新必须跳过新鲜度缓存，重新调用对应适配器；不能通过重新写入失败响应来更新缓存时间。
- 失败时若有成功缓存，响应保留缓存中的已知状态并附带本次失败；界面在刷新中显示查询中，结束后显示本次错误和缓存状态。无可用成功缓存时显示未知状态和错误，不显示猜测的更新结论。
- 新查询成功后替换旧状态、清除旧错误并更新成功时间。安装/更新任务结束后，仅回读任务所属 CLI 的状态。

适配器在管理功能中的职责如下：

| 适配器职责    | 定义                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| 安装检测      | 提供命令候选、CLI 专属已知安装目录、完整路径解析所需标识及安装来源识别规则。  |
| 当前版本      | 提供探测参数或官方查询方式，并解析 CLI 专属输出为规范化版本值。               |
| 更新状态      | 读取官方最新版本或 CLI 原生更新状态，解析并映射为统一的“有更新/已最新/未知”。 |
| 安装/更新计划 | 生成固定来源、完整程序路径、参数数组和用户确认预览；禁止自由命令。            |
| 执行前准备    | 只实施必要的 CLI 专属来源复核或临时进程环境处理，不另建执行生命周期。         |

运行时和历史职责也遵循同一边界：适配器构造普通启动/恢复参数，历史部分发现 CLI 官方或本地事实来源、解析受限 metadata、校验项目归属并输出规范会话 DTO。PTY 生命周期、项目隔离复核、历史分页与搜索、FTS 索引、别名合并及以 `ToolKey + session_id` 去重均属于公共层。历史适配器不得读取超出产品需要的完整对话内容或把项目路径写入搜索索引。

后续新增 CLI 时，工具管理逻辑按该接口新增适配器并保留产品层必要的工具身份、图标/文案、PTY 与会话登记；这不是任意 CLI 的自动发现或命令执行机制。

更新命令清单：

| 工具         | 更新命令                                | Windows 执行环境                                                                                         |
| ------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Claude Code  | `claude update`                         | 原生安装按目标二进制恢复所属 HOME；退出码为 0 后复探同一可执行路径并核对版本是否变化 |
| Codex        | `codex update`                          | 固定使用 Windows PowerShell 5.1，隔离模块路径并透传退出码                                                |
| Antigravity  | `agy update`                            | 沿用现有结构化计划                                                                                       |
| Grok Build   | `grok update`                           | 任务创建后在后台校验官方原生安装来源，再执行更新                                                         |
| Hermes Agent | `<已解析的 Hermes CLI 完整路径> update` | 使用官方默认更新语义；确认框仅展示来源和完整路径命令，更新目标、安装渠道处理及交互由 Hermes CLI 自行决定 |

Grok 也提供官方 npm 包 `@xai-official/grok`，但本应用 G1 只托管官方原生安装器。
官方 CLI 检查 JSON 明确报告 `installer=internal` 时，应用内更新可用；安装路径可以是
用户自定义目录或 PATH 中的入口，不要求固定在默认目录。计划生成只定位本机 CLI，不执行
网络检查；任务创建后再校验同一可执行文件报告的安装来源。npm、未知来源时任务会失败且
不会调用更新命令。运行
`grok update` 时会移除 pnpm 注入的 `npm_config_user_agent`，避免官方原生安装
被误判为 npm 安装。

Hermes 的更新可用状态按已识别的官方 Windows/macOS/Linux 默认源码安装进行查询：设置页或手动刷新时仅运行一次 `hermes update --check`，使用 CLI 默认更新目标。Windows 要求可执行文件位于 `%LOCALAPPDATA%\\hermes\\bin` 且 checkout 位于 `%LOCALAPPDATA%\\hermes\\hermes-agent`；macOS/Linux 要求入口位于 `~/.local/bin/hermes` 且 checkout 位于 `~/.hermes/hermes-agent`。不额外运行 `--install-id` 和 `--plan`。状态不与 `--version` 中的语义版本比较；官方对浅克隆可能只报告是否存在更新而不给提交数。`--check` 不应用代码、不安装依赖或重启 Gateway，但会获取 Git 更新 metadata，因此可能更新本地比较引用，不能承诺零文件写入。用户确认后，Launchpad 直接执行已解析的 Hermes CLI 完整路径和 `update` 参数，并在任务启动前再次校验该路径和默认源码 checkout；MSIX、Microsoft Store、Hermes Desktop、Nix、其他包管理器和来源不明安装的更新行为交由其所属渠道处理。确认浮窗只显示来源与该完整路径命令。查询失败时保留可用缓存并明确标出查询错误；没有可用结果时显示未知状态，不猜测为已同步。

更新命令同样用结构化参数建模，不在业务层拼接自由字符串。Codex 的 Windows
更新计划先解析 CLI 完整路径，再在最终 PowerShell 边界进行字面量转义；命令主体
和 `update` 参数均来自内置清单，不接受用户输入。

## 执行任务模型

安装和更新共用持久化执行任务。任务按 CLI 独立维护：同一 CLI 同时只运行一个
任务，不同 CLI 可并行。确认浮层只负责展示来源和命令，确认后设置页保留当前
视图并更新对应按钮；左侧“执行任务”视图持续展示全部任务的状态与实时输出。

- Rust 分别管道化读取 `stdout` 和 `stderr`，通过 Tauri event 增量通知前端并写入 SQLite。
- 每项活动任务拥有独立取消信号和平台进程树，完成或终止时只释放对应 CLI 的任务槽。
- Windows 使用 Job Object 持有完整进程树；用户选择“终止任务”时结束作业内所有进程。
- macOS 在 spawn 前创建独立 Unix process group；取消或超时时先发送 `SIGTERM`，有界等待后发送 `SIGKILL`，并回收输出管道。
- 应用异常退出后，重启时把未结束记录标记为“意外中断”。
- 每个任务最多保存 1 MiB 日志，默认保留最近 50 条任务，旧记录连同日志自动裁剪。
- 任务历史只记录内置安装清单生成的结构化命令计划，不开放任意命令执行入口。
- 前端按 CLI 独立维护计划、确认、创建和错误状态；某 CLI 有活动任务时暂停该 CLI 的最新版本探测，隐藏缓存的最新版本，手动全局刷新也跳过该 CLI；任务结束后只刷新对应 CLI，并在回读期间隐藏旧版本计算出的更新入口。
- Grok 安装/更新任务结束后额外刷新官方 update-check JSON，回读当前/最新版本和安装来源；更新来源校验、计划生成和任务执行均由 Rust 后端负责，不能依赖前端传入的来源标记。

## UI 建议

设置页可增加一个 **CLI 状态** 区块：

| 工具         | 状态   | 版本      | 路径  | 操作             |
| ------------ | ------ | --------- | ----- | ---------------- |
| Claude Code  | 已安装 | `2.1.150` | `...` | 重新检测         |
| Codex        | 已安装 | `0.133.0` | `...` | 重新检测         |
| Antigravity  | 未安装 | -         | -     | 查看官方安装命令 |
| Grok Build   | 未安装 | -         | -     | 查看官方安装命令 |
| Hermes Agent | 未安装 | -         | -     | 查看官方安装命令 |

启动按钮应根据状态调整：

- 可用：允许启动。
- 未安装：禁用启动，展示安装或手动修复入口。
- 只在交互式 Shell 可见但固定可信位置未找到：提示使用官方安装器，应用不主动执行用户 Shell 启动脚本。

## 安全要求

- 安装和启动都必须有命令预览。
- 安装命令只允许来自内置工具清单，不能让用户输入任意命令后以安装流程执行。
- 日志中避免输出 token、密钥或用户隐私路径以外的敏感信息。
- 失败时保留错误输出，方便用户判断是网络、权限、包不存在还是 PATH 问题。
