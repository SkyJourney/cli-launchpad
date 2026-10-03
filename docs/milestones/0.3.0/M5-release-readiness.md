# M5：跨平台验收与 0.3.0 发布

**状态：** M5 跨平台对齐与整体验收已于 2026-10-03 由用户确认通过；后续平台问题按 bug+fix 单独处理。八目标 Release 预检于 2026-10-03 全部成功，现进入 `v0.3.0` 正式 tag 与 GitHub Release 流程。
**依赖：** M1–M4、G1–G4
**目标：** 为 0.3.0 建立可靠的跨平台发布候选。

M1–G4 分散文档中的 macOS/Linux 实机检查曾收敛到[跨平台对齐待办](cross-platform-alignment.md)。用户已确认 M5 整体验收通过；清单中未逐项勾选或未记录的项目保留为历史证据边界，不再阻塞 M5，也不代表这些项目已逐项实测通过。后续发现的平台问题按 bug+fix 闭环。

Windows 的 0.3.0 x64 NSIS 本地候选包已完成干净构建、升级本机 0.2.4 安装及启动核对。2026-10-03 推送 `ab34efc` 后，手动运行 [Release 预检 #37129066965](https://github.com/SkyJourney/cli-launchpad/actions/runs/37129066965)：版本校验及八个构建目标全部成功，八组 Actions artifacts 均已上传；正式发布步骤按手动预检设计跳过。Linux x64/ARM64 构建日志没有 Rust 编译告警，Windows ARM64 构建成功。

## 范围

- 在 Windows、macOS、Linux 覆盖 PTY 生命周期、项目切换、多个会话、分栏布局、 CLI 恢复和窗口/托盘行为。
- 检查高频终端输出、Unicode、中文输入法、主题、复制粘贴、快捷键和窗口尺寸变化。
- 按统一清单验收 M1 PTY、M2 工作区、G1/G2 CLI、M3 布局、G3 窗口标题栏和 G4 主题/生命周期/适配契约在 macOS/Linux 的行为；确认 G4 语义 token 矩阵和 CLI 能力在各平台一致。
- 通过 CI 或平台主机完成 macOS/Linux Tauri 配置、Rust 目标编译、前端生产打包和安装包构建；检查窗口能力、平台依赖及 SQLite schema/迁移兼容。
- 验证旧版本升级、异常退出、进程终止、数据库迁移和布局恢复。
- 构建 Windows x64/ARM64 在线/离线 NSIS、macOS ARM64/Intel DMG、Linux x64/arm64 deb/rpm/AppImage。Windows ARM64 使用原生 ARM64 Runner 和 `aarch64-pc-windows-msvc`。
- 更新 README、截图、安装说明、已知限制、发布说明和版本入口。

## 非目标

- 不以未完成的自更新、远程运行、移动端配套或 Agent 编排阻塞 0.3.0。

## 验收结论

- [x] 用户于 2026-10-03 确认 M5 跨平台对齐与整体验收通过。
- [x] 后续发现的平台问题按 bug+fix 单独处理，不重开 M5。

## 正式发布前检查

- [x] 推送发布前修复后，手动运行 Release workflow；八个构建目标和 Windows ARM64 在线/离线 NSIS 均成功生成，见 [预检 #37129066965](https://github.com/SkyJourney/cli-launchpad/actions/runs/37129066965)。
- [ ] 将文档验收记录推送至 `main` 后，推送 `v0.3.0` tag 并确认正式 GitHub Release 的构建、校验和及产物上传成功。

本页与[跨平台对齐待办](cross-platform-alignment.md)保留逐项历史记录。未勾选/未记录的单项不作为 M5 未通过结论，也不得反向表述为已逐项验证。

## 产物

- 三平台验收记录及发布构建产物；M1–G4 的 macOS/Linux 实机验证统一按跨平台对齐待办执行。
- 0.3.0 发布说明与更新后的用户文档。
