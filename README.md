# CLI Launchpad

CLI Launchpad 是一个轻量级桌面启动器，用于快速打开常用项目目录，并通过 Antigravity CLI、Codex CLI 或 Claude Code CLI 启动对应的命令行工作流。

项目采用 Tauri 风格架构，参考 CC-Switch 的组织方式：

- React + TypeScript 负责桌面 UI。
- Rust/Tauri commands 负责文件系统访问、SQLite 读写和进程启动。
- SQLite 作为目录、工具、Shell 配置和目录级参数的单一数据源。
- 设备本地 UI 偏好后续可以放在 JSON 或 Tauri store 中。

## 目标

- 将常用目录缓存在 SQLite 中。
- 在选中目录中一键启动配置好的 CLI 工具。
- 将 Shell 参数、全局 CLI 参数和目录专属 CLI 参数解耦。
- 保持桌面应用体积轻量，不引入 Electron 或服务端运行时。
- 在真正启动前，让用户可以预览最终命令。

## 技术栈

- Tauri 2
- React
- TypeScript
- Vite
- Rust
- rusqlite
- Windows Terminal / PowerShell 集成

## 本地依赖

需要提前安装：

- Node.js
- pnpm
- Rust stable 工具链，推荐通过 rustup 安装
- Visual Studio Build Tools 2022
- MSVC C++ x64/x86 编译工具
- Windows SDK
- WebView2 Runtime

当前项目使用 pnpm 作为 Node 包管理器。不要混用 npm、yarn 或其他锁文件。

## 首次运行

安装 Node 依赖：

```powershell
pnpm install
```

启动 Tauri 开发环境：

```powershell
pnpm tauri dev
```

如果需要单独检查 Rust 依赖：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

## 打包说明

项目设计目标包括编译为公司内部使用的 Windows 安装包。正式打包前需要补齐 Tauri 图标资源，例如 `src-tauri/icons/icon.ico`。

当前 `src-tauri/tauri.conf.json` 中启用了 bundle，后续可根据内部分发策略选择 MSI 或 EXE 安装器，并按 Tauri Windows 打包要求补齐 WiX、NSIS 或相关工具链。

## 项目结构

```text
docs/                         产品和架构说明
src/                          React UI
src-tauri/                    Tauri/Rust 后端
src-tauri/migrations/         SQLite 迁移脚本
src-tauri/src/commands/       暴露给 UI 的 IPC commands
src-tauri/src/services/       业务逻辑
src-tauri/src/db/             数据库连接和仓储
src-tauri/src/platform/       平台相关启动逻辑
```

## MVP 范围

- 目录增删改查。
- Antigravity、Codex 和 Claude Code 的工具配置。
- Shell profile 配置。
- 命令预览。
- 一键启动终端会话。
