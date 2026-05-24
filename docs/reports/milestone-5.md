# 里程碑 5 阶段报告：依赖检测、安装与版本更新

## 目标

设置页完整 CLI 管理：查询最新版本、与当前版本对比、应用内一键安装/更新（命令预览 → 确认 → 执行 → 输出日志 → 重新检测）。

## 设计要点

- 最新版本：`ureq` 查 npm registry（claude=`@anthropic-ai/claude-code`、codex=`@openai/codex`、agy 无 registry → None），超时降级为"无法获取"，不阻塞当前版本展示。
- 安装/更新执行：结构化命令模型（program + args + source + preview），不在业务层拼接自由字符串；执行采用"捕获完整输出后返回"（非实时流式）。所有执行受 UI 显式点击 + 命令预览确认 gating。

## 完成内容

- `services/version_service.rs`：`fetch_latest`/`fetch_all_latest`，ureq + 连接/读取超时，解析 registry `latest` 的 `version`。
- `services/install_service.rs`：
  - `plan(tool, kind)`：官方来源命令（claude winget 安装 / `claude update`；codex `npm i -g @openai/codex@latest`；agy 官方 PowerShell installer，加 `-NonInteractive`），含可读 preview。
  - `run(plan)`：async `tokio::process`，10 分钟超时 + `kill_on_drop`；PowerShell 直接执行（其 `| iex` 由 PowerShell 解释），其余经 `cmd /C` 解析 PATH shim；捕获 stdout+stderr。
  - 4 项单测覆盖各工具命令结构。
- `commands/install.rs`：`fetch_latest_versions`、`get_install_plan`（仅预览不执行）、`run_install`（async）。
- `views/SettingsView.tsx`：版本对比（有更新标记）、安装/更新确认面板（来源 + 命令预览）、执行日志输出（成功/失败着色）、完成后重新检测（invalidate cli-status + latest-versions）。
- `lib/format.ts`：`extractSemver` + `hasUpdate`（数值化 semver 比较，仅当 latest 严格更新时报告）。
- 新增依赖 `ureq`。

## 代码审查与修复

经 code-reviewer 审查（重点安全），修复：

- **C-1**（修复）：`run` 无超时，安装卡在交互提示会永久挂起 → 改 async `tokio::process` + 10 分钟超时 + `kill_on_drop`。
- **C-2**（修复）：`cmd /C powershell -Command "... | iex"` 管道传递语义存疑 → PowerShell 作为真实 .exe 直接执行，不经 cmd /C；加 `-NonInteractive`。
- **I-3**（修复）：`hasUpdate` 字符串相等比较会把本地预发布版误判为"有更新"并触发降级 → 改数值化 semver 比较，仅 latest 严格更新才报告。
- **I-4**（修复）：`pending!` 非空断言在 race 下可能抛错 → mutate 时传入 action 快照。
- 命令注入面经确认为零（program/args 全硬编码常量，args 逐个传 `Command::args`）；scoped 包名 URL、ureq 超时经确认正确。

## 验证

- `cargo test`：23 项通过（含 4 项安装命令结构测试）。
- `cargo check`：无警告（ureq 2.12 编译通过）。
- `pnpm run build`：通过。
- **未执行真实安装**：无人值守下不运行任何安装/更新命令（会改动机器）。命令结构经单测验证；执行路径经编译验证。
- **待人工验证**：最新版本查询联网结果、版本对比展示、安装/更新确认面板与真实执行日志、完成后重新检测刷新。

## 已知限制 / 后续

- 安装日志为执行完成后一次性返回（非实时流式）；实时流式可作为后续增强（Tauri Channel）。
- `fetch_latest_versions` 串行查询，最差约 16 秒（仅 claude+codex 两次请求，agy 短路）。
- 桌面体验（托盘、窗口持久化、配置导入导出）与打包在 M6。
