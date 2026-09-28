# M1：内置 PTY 核心闭环

**状态：** 进行中（Windows 开发与验收）
**依赖：** M0
**目标：** 在现有 Tauri + React + Rust 架构内，让一个受控 CLI 能通过内置终端完整交互。

## 范围

- Rust service 管理 PTY 创建、输入输出、窗口尺寸、退出状态和终止。
- React 工作区集成终端模拟器，并完成键盘输入、滚动、复制粘贴和自适应尺寸。
- 支持在指定项目目录分别启动 Claude Code、Codex、Antigravity。
- 向终端准备当前用户 CLI 所需的安全环境与完整可执行路径。
- 设计 PTY 输出传输、缓冲和销毁机制，避免阻塞 UI 或留下失管子进程。
- 明确 Windows、macOS、Linux 的平台实现边界；当前先完成 Windows 实现，macOS/Linux 实机对齐安排在 Windows M1–M4 完成后，见[跨平台对齐待办](cross-platform-alignment.md)。

## 非目标

- 不实现多终端分栏、布局预设或完整项目导航。
- 不解析 CLI TUI 的内部 UI 或替代 CLI 自身会话存储。
- 不在应用退出后保持 PTY 进程运行或接管旧进程；生命周期语义按 M0 契约执行，平台进程隔离机制在本阶段设计和实现。

## Windows 阶段验收条件

- [ ] Windows 下三项 CLI 都能在应用内终端中启动并进行真实交互。
- [ ] 终端尺寸变化后，CLI 收到匹配的 PTY 尺寸。
- [ ] 单终端关闭、显式应用退出（确认/取消）、托盘隐藏、异常结束和启动失败均符合 M0 生命周期契约并到达明确状态。
- [ ] Unicode、中文输入、ANSI 色彩、全屏 TUI、复制粘贴和滚动通过人工检查。
- [ ] 正常退出与受控异常结束后不会遗留应用已失去管理的子进程；启动时旧运行记录被识别为已结束，不伪装成可接管进程。
- [ ] 高输出速率下 UI 保持响应，输出缓存有明确边界和策略。

## 产物

- PTY service、Tauri IPC 和终端 UI 的边界设计。
- Windows 下三项 CLI 的内置终端纵向切片；macOS/Linux 实机验收记录见[跨平台对齐待办](cross-platform-alignment.md)。

## 设计决策

- 技术选型与输出回压：见 [ADR-0002](../../adr-0002-embedded-pty.md)。
- Windows 为当前开发和阶段验收平台；macOS/Linux 实机对齐按[跨平台对齐待办](cross-platform-alignment.md)安排在 Windows M1–M4 完成后执行，不阻塞 Windows 阶段推进。
- M1 的终端只在现有项目详情页提供单会话纵向切片；完整大窗口工作台、多项目快速切换和多面板留给 M2/M3。

## 推进记录

- [x] 开发前置检查：M0 验收与代码基线已核对；发现并修正 M0 单项文档遗留的状态标记。
- [x] 技术可行性检查：选定 `portable-pty` 0.9、xterm.js/Fit addon、Tauri Channel 消费确认回压；进程树隔离仍由平台 helper 承担。
- [x] Rust PTY 生命周期、跨平台进程树清理和退出协调（Windows Job Object 与 Unix 进程组；退出确认、强制清理和重启状态修正已实现）。
- [x] SQLite 会话元数据与旧运行态启动修正。
- [x] 单终端 UI、输入输出、尺寸和有界输出回压（xterm 延迟分包；Rust 单测与前端生产构建通过）。
- [x] Windows 三项 CLI 启动、输入交互和退出：用户实机确认 Claude Code、Codex、Antigravity 均正常。
- [ ] Codex TUI 缩放后的换行表现：用户判断更像 Codex 自身 TUI 的显示逻辑，暂不继续追查，不作为当前待修复缺陷；PTY 尺寸同步不据此宣称已单独验收。
- [x] Windows Claude Code 实机冒烟：内置终端成功启动并显示 TUI，执行 `exit` 后正常退出（退出码 0；116 个输出块均已确认，待处理输出为 0）。
- macOS/Linux 实机验收已从 M1 阶段门禁移出，改由[跨平台对齐待办](cross-platform-alignment.md)在 Windows M1–M4 完成后集中执行，并纳入 M5 发布门禁。

## 审查与自动化门禁记录

- [x] 完成实现差异审查、问题修复和复审；补齐 PTY 读写端创建失败、会话注册失败及 Job Object 附加失败时的清理，并处理退出后的迟到输出确认。
- [x] 完成实现差异复审：未发现未处理的 M1 级问题。
- [x] 最终门禁复跑：`cargo test --manifest-path src-tauri/Cargo.toml` 130 项通过；包含 Windows PTY Job Object 正常终止与附加失败清理测试。
- [x] 最终门禁复跑：`pnpm run build` 的 TypeScript 检查与 Vite 生产构建通过；主包 450.15 KB，项目详情分包 308.62 KB。
- [x] 最终门禁复跑：`cargo fmt --manifest-path src-tauri/Cargo.toml --check` 与 `git diff --check` 通过。
- [ ] Windows 完整交互矩阵：Codex TUI 换行观察项暂不追查；托盘、退出确认、启动失败、删除项目等未逐项确认。
- [x] Windows Claude Code 基本启动/输入/正常退出：用户实机验证通过；具体 TUI 重排和完整交互矩阵另行记录。
- [x] Windows Codex 与 Antigravity 基本启动/输入/正常退出：用户实机确认通过；日志分别记录 Codex、Antigravity 输出及退出码 0。
- macOS/Linux 实机验收由[跨平台对齐待办](cross-platform-alignment.md)跟踪，并作为 M5 发布门禁。

## Windows 手工验收清单

- [ ] 分别从 Claude Code、Codex、Antigravity 标签启动内置终端，核对预览中的可执行文件、参数和项目目录。
- [ ] 逐项检查中文输入、粘贴、方向键/快捷键、ANSI 色彩、滚动及全屏 TUI；确认输出持续时界面仍可操作。
- [ ] 调整应用窗口尺寸，确认终端列行同步变化、TUI 正常重排。
- [ ] 取消单会话关闭后确认会话仍可输入；再次关闭并确认后核对进程树结束及会话状态更新。
- [ ] 活动 PTY 时尝试删除项目，确认被拒绝；结束 PTY 后确认可删除。
- [ ] 活动 PTY 时分别测试应用退出取消、确认；测试隐藏到托盘后会话继续运行，以及托盘“退出”仍先确认。
- [ ] 验证启动失败能显示错误且不静默打开外部终端；退出应用后重新启动，确认遗留运行记录显示为已结束。
