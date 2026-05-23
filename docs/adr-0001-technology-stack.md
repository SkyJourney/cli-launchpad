# ADR 0001：技术栈选择

## 状态

已接受。

## 背景

CLI Launchpad 是一个轻量桌面工具，用于在指定项目目录中快速打开公司内部常用的 AI CLI 工具。当前产品范围聚焦三个 CLI：

- Claude Code CLI：`claude`
- Codex CLI：`codex`
- Antigravity CLI：官方主命令 `agy`

Antigravity 是 Google 新品牌下的目标 CLI。本项目不再关注 Gemini CLI。`antigravity` 仅作为保守兼容探测命令，不作为推荐启动命令。

Electron 的包体积和运行时开销不符合轻量目标，因此不作为技术选型。

## 决策

使用以下技术栈：

- Tauri 2 作为桌面壳。
- React + TypeScript 构建前端界面。
- Rust 负责 Tauri 命令、CLI 启动编排、依赖检测、安装命令预览、SQLite 访问和平台相关逻辑。
- SQLite 持久化目录、工具、Shell 配置和启动历史。
- pnpm 作为 Node 包管理工具。

Windows 构建和打包依赖：

- Node.js + pnpm
- Rust stable MSVC 工具链、rustup、cargo
- Visual Studio 2022 Build Tools，包含 C++ x64/x86 构建工具
- Windows SDK
- WebView2 Runtime

## 影响

- 前端保持常规 Web 开发体验。
- CLI 启动、路径处理和命令转义集中在 Rust 层，避免把系统行为散落到 React 组件中。
- 应用包体和运行时成本显著低于 Electron 方案。
- 贡献者需要同时准备 Node/pnpm 与 Rust/Tauri 工具链。
- 一键安装功能优先服务 `claude`、`codex`、`agy` 三个目标 CLI，不扩展为通用 CLI 管理器。
