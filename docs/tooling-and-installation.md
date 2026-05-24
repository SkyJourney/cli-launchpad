# CLI 检测与安装设计

## 范围

本设计只覆盖 CLI Launchpad 的三个核心工具：

- Claude Code CLI：`claude`
- Codex CLI：`codex`
- Antigravity CLI：官方主命令 `agy`

不检测、不安装、不管理其他 CLI。

Antigravity 是 Google 将 Gemini CLI 迁移到新品牌后的目标 CLI。本项目只关注 Antigravity CLI，不再把 Gemini CLI 作为检测、启动或安装目标。

## 本机检查结果

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

- Claude Code CLI 官方命令为 `claude`。Windows 可使用 `winget install Anthropic.ClaudeCode`，也可使用官方 PowerShell 安装脚本。
- Codex CLI 官方命令为 `codex`。官方安装方式为 `npm i -g @openai/codex`，升级命令为 `npm i -g @openai/codex@latest`。
- Antigravity CLI 官方命令为 `agy`。Windows 官方安装方式为 PowerShell：`irm https://antigravity.google/cli/install.ps1 | iex`。

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
```

## 安装模型

一键安装流程必须显式确认：

1. 用户点击安装。
2. 应用展示安装来源、命令和权限提示。
3. 用户确认。
4. Rust 层用结构化参数启动安装命令。
5. UI 展示实时日志。
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

三个目标 CLI 的初始安装清单：

| 工具        | 首选安装方式              | 命令模型                                                                                                  |
| ----------- | ------------------------- | --------------------------------------------------------------------------------------------------------- | ---- |
| Claude Code | `winget` 官方包           | `winget install --id Anthropic.ClaudeCode --exact --accept-package-agreements --accept-source-agreements` |
| Codex       | npm 官方包                | `npm i -g @openai/codex`                                                                                  |
| Antigravity | 官方 PowerShell installer | `irm https://antigravity.google/cli/install.ps1                                                           | iex` |

如果某个 CLI 没有稳定的官方包或官方安装命令，不应伪造安装命令。此时只展示官方手动安装说明。

`irm ... | iex` 类型安装脚本必须在 UI 中高亮来源、网络执行风险和确认按钮。默认不要静默运行。

安装来源必须绑定到内置三工具清单，不允许用户把任意 CLI 或任意包名加入一键安装流程。

## 更新模型

对已安装的 CLI，设置页提供应用内更新。更新与安装共用同一确认流程：预览命令、用户确认、输出日志、完成后重新检测。

最新版本查询：

| 工具        | 最新版本来源                                      |
| ----------- | ------------------------------------------------- |
| Claude Code | 官方包或 npm registry `@anthropic-ai/claude-code` |
| Codex       | npm registry `@openai/codex`                      |
| Antigravity | 官方渠道（官方 installer 或发布信息）             |

最新版本查询涉及网络，失败时降级为"无法获取最新版本"，仍展示当前版本，不阻塞界面。

更新命令清单：

| 工具        | 更新命令                                                            |
| ----------- | ------------------------------------------------------------------- | ---- |
| Claude Code | `claude update` 或官方包更新                                        |
| Codex       | `npm i -g @openai/codex@latest`                                     |
| Antigravity | 重跑官方 installer：`irm https://antigravity.google/cli/install.ps1 | iex` |

更新命令同样用结构化参数建模，不在业务层拼接自由字符串。

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
- PATH 不可见：禁用默认启动，提示刷新环境变量或手动选择可执行文件。

## 安全要求

- 安装和启动都必须有命令预览。
- 安装命令只允许来自内置工具清单，不能让用户输入任意命令后以安装流程执行。
- 日志中避免输出 token、密钥或用户隐私路径以外的敏感信息。
- 失败时保留错误输出，方便用户判断是网络、权限、包不存在还是 PATH 问题。
