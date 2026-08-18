# CLI Launchpad

CLI Launchpad 是一个轻量级桌面启动器，用于快速打开常用项目目录，并通过 Antigravity CLI、Codex CLI 或 Claude Code CLI 启动对应的命令行工作流。

版本变化与尚待验证的内容见 [CHANGELOG.md](CHANGELOG.md)。

项目采用 Tauri 风格架构，参考 CC-Switch 的组织方式：

- React + TypeScript 负责桌面 UI。
- Rust/Tauri commands 负责文件系统访问、SQLite 读写和进程启动。
- SQLite 作为目录、工具、启动偏好和目录级参数的单一数据源。
- 系统托盘提供常驻入口；默认关闭主窗口时隐藏到托盘，可在设置中切换为退出应用。

正式运行的数据根目录为 `~/.cli-launchpad/`，当前业务数据库位于
`~/.cli-launchpad/data/cli-launchpad.db`。从早期版本升级时，应用会从
旧的 `%APPDATA%\dev.local.cli-launchpad\` 复制已有数据库并保留旧文件。

## 目标

- 将常用目录缓存在 SQLite 中。
- 在选中目录中一键启动配置好的 CLI 工具。
- 将终端启动偏好、全局 CLI 参数和目录专属 CLI 参数解耦。
- 保持桌面应用体积轻量，不引入 Electron 或服务端运行时。
- 在真正启动前，让用户可以预览最终命令。
- 通过托盘快速重新显示主界面，或显式退出应用。

## 技术栈

- Tauri 2
- React
- TypeScript
- Vite
- Rust
- rusqlite
- Windows Terminal Profile / PowerShell / CMD 分层回退集成
- Maple Mono v7.9 内置 UI 与命令字体

## 本地依赖

需要提前安装：

- Node.js
- pnpm
- Rust stable 工具链，推荐通过 rustup 安装

Windows 开发与打包还需要：

- Visual Studio Build Tools 2022
- MSVC C++ x64/x86 编译工具
- Windows SDK
- WebView2 Runtime

macOS 开发与打包还需要：

- Xcode 与 Xcode Command Line Tools
- Apple Silicon target：`rustup target add aarch64-apple-darwin`
- Intel target：`rustup target add x86_64-apple-darwin`

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

Windows 内部分发使用 NSIS，平台配置位于
`src-tauri/tauri.windows.conf.json`。打包命令：

```powershell
pnpm tauri:build:windows    # 在线版安装包
pnpm tauri:build:offline    # 离线版安装包（内嵌 WebView2）
pnpm build:installers       # 一次构建在线 + 离线两版，归档到 dist-installers/
```

Windows 产物与运行依赖：

- NSIS 安装包：`src-tauri/target/release/bundle/nsis/`；裸 exe：`src-tauri/target/release/`。
- **VC++ 运行库**：通过静态链接 CRT（`src-tauri/.cargo/config.toml` 的 `+crt-static`）编入 exe，目标机无需安装 Visual C++ Redistributable。
- **WebView2**：
  - 在线版（默认 `downloadBootstrapper`）：安装包小，安装时检测缺失则联网下载。
  - 离线版（`offlineInstaller`，见 `src-tauri/tauri.offline.conf.json`）：内嵌完整 WebView2，无网也能装（包体更大）。
- `build:installers` 复用 Tauri 产物名的 `{productName}_{version}_{arch}` 前缀，自动追加 `online`/`offline`，例如 `CLI Launchpad_0.2.0_x64-online-setup.exe`。

macOS 使用独立的 ARM64 与 Intel DMG，不生成 Universal 包：

```zsh
pnpm tauri:build:macos        # 当前机器原生架构，M 系列 Mac 上为 ARM64
pnpm tauri:build:macos:arm64  # Apple Silicon DMG
pnpm tauri:build:macos:x64    # Intel DMG
```

显式指定 target 后，DMG 分别输出到：

- ARM64：`src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`
- Intel：`src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/`

正式打包前确保 Windows 的 `src-tauri/icons/icon.ico` 和 macOS 的
`src-tauri/icons/icon.icns` 均已就位。签名、公证和真实 Intel Mac 验证仍属于正式发布前检查。

## 内置字体

应用不依赖系统安装字体，固定使用 Maple Font v7.9：

- 全局 UI：Maple Mono NormalNL CN，使用 400、500、600、700 四个字重。
- 命令、路径和日志：Maple Mono NL NF-CN，使用相同四个字重并关闭连字。
- 字体文件随 Vite 前端产物进入 NSIS 与 DMG。
- 字体采用 SIL Open Font License 1.1，来源和授权见
  `src/assets/fonts/maple/README.md` 与 `src/assets/fonts/maple/LICENSE.txt`。

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
- 终端与 Shell 自动探测、Profile 选择和分层回退。
- 命令预览。
- 一键启动终端会话。
- 三项 CLI 的会话历史、每次 10 条懒加载与安全恢复。
- 按会话 ID 设置本地别名，不同步普通会话到业务数据库。
- 三项 CLI 的启动模型选择与手动模型/部署名。
