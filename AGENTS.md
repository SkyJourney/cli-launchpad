# Agent 说明

## 工作原则

- 保持应用轻量，不引入 Electron 或服务端运行时。
- 优先沿用现有 Tauri + React + Rust 结构。
- 除非明确是设备本地 UI 状态，否则用户数据保存在 SQLite 中。
- 启动逻辑放在 Rust services 中，不放在 React 组件里。
- 避免临时拼接命令字符串。应先构造参数列表，只在 Shell 边界做必要转义。

## 架构边界

- `src/` 负责展示状态，并调用 Tauri commands。
- `src-tauri/src/commands/` 暴露小而清晰的 IPC 入口。
- `src-tauri/src/services/` 负责命令组合、校验等行为逻辑。
- `src-tauri/src/db/` 负责 SQLite schema、连接和 repositories。
- `src-tauri/src/platform/` 负责操作系统相关的命令启动细节。

## 安全规则

- 将用户配置的目录视为不可信输入。
- Windows 路径使用 PowerShell `Set-Location -LiteralPath`。
- 执行启动前，必须在 UI 中预览最终命令。
- 不要把密钥存进 SQLite；如果后续需要密钥，使用系统凭据存储。
- 未经用户明确要求，不要加入破坏性的 git 或文件系统行为。

## 开发约定

项目使用 pnpm 作为 Node 包管理器。不要引入 `package-lock.json`、`yarn.lock` 或其他包管理器锁文件。

```powershell
pnpm install
pnpm tauri dev
```

较大提交前运行格式化：

```powershell
pnpm run format
cargo fmt --manifest-path src-tauri/Cargo.toml
```

单独检查 Rust 依赖和编译状态：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

## 本地工具链

Windows 开发环境应具备：

- Node.js
- pnpm
- rustup + Rust stable
- Cargo
- WebView2 Runtime
- Visual Studio Build Tools 2022
- MSVC C++ x64/x86 编译工具
- Windows SDK

VS Build Tools 自带的 CMake 和 Ninja 可以作为编译辅助工具；当前项目不要求它们在普通 PATH 中可见。

## 打包约定

项目目标包括构建为公司内部使用的 Windows 安装包。打包前需要补齐 Tauri 图标资源，例如 `src-tauri/icons/icon.ico`。

后续根据内部分发策略选择 MSI 或 EXE 安装器，并按 Tauri Windows 打包要求补齐 WiX、NSIS 或相关工具链。
