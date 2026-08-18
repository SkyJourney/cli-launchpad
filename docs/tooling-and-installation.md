# CLI 检测与安装设计

## 范围

本设计只覆盖 CLI Launchpad 的三个核心工具：

- Claude Code CLI：`claude`
- Codex CLI：`codex`
- Antigravity CLI：官方主命令 `agy`

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

`pnpm`、`node`、`winget`、Rust 和 VS 工具链是开发与打包依赖，不属于应用内面向用户的一键安装范围。应用内检测和安装只面向 `claude`、`codex`、`agy`。

## 官方依据

当前文档设计基于官方资料：

- Claude Code CLI 官方命令为 `claude`。Windows 可使用 `winget install Anthropic.ClaudeCode`；macOS 使用 `curl -fsSL https://claude.ai/install.sh | bash`。
- Codex CLI 官方命令为 `codex`。Windows 优先使用官方 PowerShell 独立安装器；macOS 使用 `curl -fsSL https://chatgpt.com/codex/install.sh | sh`；当前 CLI 提供 `codex update`。
- Antigravity CLI 官方命令为 `agy`。Windows 使用官方 PowerShell installer；macOS 使用 `curl -fsSL https://antigravity.google/cli/install.sh | bash`。
- Antigravity 官方 release manifest 的 macOS 平台名为 `darwin_arm64` 与 `darwin_amd64`。

后续实现时，如果官方安装命令变化，应先更新本文档，再调整安装清单。

## 检测模型

每个工具应定义：

```text
id: claude | codex | antigravity
display_name: 用户可见名称
commands: 候选命令列表
version_args: 版本检测参数
install_hint: 手动安装说明或安装命令候选
```

检测结果：

```text
status: available | missing
resolved_command: 实际命中的候选命令（agy 优先于 antigravity）
path: 解析出的完整可执行文件路径
version: 当前版本输出
latest_version: 最新可用版本（可选，网络查询失败时为空）
```

启动一律走解析出的完整路径，不再区分 PATH 可见性，因此只有 available / missing 两态。检测结果作为全局 CLI 状态贯穿所有视图，详见 `docs/ui-design.md`。

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
```

如果 PATH 不可见，可以补充检查常见用户级目录，但补充检查只用于提示，不应绕过用户配置直接执行未知路径：

```text
%USERPROFILE%\.local\bin
%APPDATA%\npm
%LOCALAPPDATA%\Microsoft\WinGet\Links
%LOCALAPPDATA%\agy\bin
%LOCALAPPDATA%\Programs\OpenAI\Codex\bin
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

前三项覆盖三个 CLI 当前官方原生安装器与 Homebrew；Volta/NVM 只用于兼容
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

三个目标 CLI 的 Windows 安装清单：

| 工具        | 首选安装方式              | 命令模型                                                                                                  |
| ----------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| Claude Code | `winget` 官方包           | `winget install --id Anthropic.ClaudeCode --exact --accept-package-agreements --accept-source-agreements` |
| Codex       | 官方 PowerShell installer | `irm https://chatgpt.com/codex/install.ps1 \| iex`                                                        |
| Antigravity | 官方 PowerShell installer | `irm https://antigravity.google/cli/install.ps1 \| iex`                                                   |

如果某个 CLI 没有稳定的官方包或官方安装命令，不应伪造安装命令。此时只展示官方手动安装说明。

`irm ... | iex` 类型安装脚本必须在 UI 中高亮来源、网络执行风险和确认按钮。默认不要静默运行。

macOS 安装清单：

| 工具        | 解释器      | 固定官方命令                                                   |
| ----------- | ----------- | -------------------------------------------------------------- |
| Claude Code | `/bin/bash` | `curl -fsSL https://claude.ai/install.sh \| bash`              |
| Codex       | `/bin/sh`   | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`        |
| Antigravity | `/bin/bash` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

实现层把解释器作为 `program`，把 `-c` 和对应命令常量作为参数数组。网络脚本
字符串只能从内置三工具清单产生，不允许追加用户输入；预览必须原样展示 URL、
解释器和管道风险。三个官方安装器均校验下载产物摘要并安装到用户级目录，不要求
应用请求管理员权限。

安装来源必须绑定到内置三工具清单，不允许用户把任意 CLI 或任意包名加入一键安装流程。

## 更新模型

对已安装的 CLI，设置页提供应用内更新。更新与安装共用同一确认流程：预览命令、用户确认、输出日志、完成后重新检测。

最新版本查询：

| 工具        | 最新版本来源                                      |
| ----------- | ------------------------------------------------- |
| Claude Code | `downloads.claude.ai/claude-code-releases/latest` |
| Codex       | `releases.openai.com/codex/channels/latest`       |
| Antigravity | 官方安装器使用的当前平台 release manifest         |

最新版本查询涉及网络，失败时降级为"无法获取最新版本"，仍展示当前版本，不阻塞界面。

更新命令清单：

| 工具        | 更新命令        |
| ----------- | --------------- |
| Claude Code | `claude update` |
| Codex       | `codex update`  |
| Antigravity | `agy update`    |

更新命令同样用结构化参数建模，不在业务层拼接自由字符串。

## 执行任务模型

安装和更新共用持久化执行任务。全局同时只运行一个任务；确认浮层只负责展示
来源和命令，确认后立即返回，由左侧“执行任务”视图持续展示状态与实时输出。

- Rust 分别管道化读取 `stdout` 和 `stderr`，通过 Tauri event 增量通知前端并写入 SQLite。
- Windows 使用 Job Object 持有完整进程树；用户选择“终止任务”时结束作业内所有进程。
- macOS 在 spawn 前创建独立 Unix process group；取消或超时时先发送 `SIGTERM`，有界等待后发送 `SIGKILL`，并回收输出管道。
- 应用异常退出后，重启时把未结束记录标记为“意外中断”。
- 每个任务最多保存 1 MiB 日志，默认保留最近 50 条任务，旧记录连同日志自动裁剪。
- 任务历史只记录内置安装清单生成的结构化命令计划，不开放任意命令执行入口。

## UI 建议

设置页可增加一个 **CLI 状态** 区块：

| 工具        | 状态   | 版本      | 路径  | 操作             |
| ----------- | ------ | --------- | ----- | ---------------- |
| Claude Code | 已安装 | `2.1.150` | `...` | 重新检测         |
| Codex       | 已安装 | `0.133.0` | `...` | 重新检测         |
| Antigravity | 未安装 | -         | -     | 查看官方安装命令 |

启动按钮应根据状态调整：

- 可用：允许启动。
- 未安装：禁用启动，展示安装或手动修复入口。
- 只在交互式 Shell 可见但固定可信位置未找到：提示使用官方安装器，应用不主动执行用户 Shell 启动脚本。

## 安全要求

- 安装和启动都必须有命令预览。
- 安装命令只允许来自内置工具清单，不能让用户输入任意命令后以安装流程执行。
- 日志中避免输出 token、密钥或用户隐私路径以外的敏感信息。
- 失败时保留错误输出，方便用户判断是网络、权限、包不存在还是 PATH 问题。
