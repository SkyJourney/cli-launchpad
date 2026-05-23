# Agent 说明

## 当前项目状态

- 项目默认分支为 `main`。
- 项目使用 Tauri 2 + React + TypeScript + Rust + SQLite。
- Node 包管理器统一使用 pnpm，仓库中应只维护 `pnpm-lock.yaml`。
- Rust 工具链采用 stable MSVC，Windows 构建依赖包含 Visual Studio Build Tools 2022、MSVC C++ x64/x86 编译工具、Windows SDK 和 WebView2 Runtime。
- Tauri 图标资源已生成，主要文件为 `src-tauri/icons/icon.ico` 和 `assets/icon/final/icon.ico`。
- 产品当前只聚焦三个 CLI：Claude Code CLI（`claude`）、Codex CLI（`codex`）、Antigravity CLI（官方主命令 `agy`）。
- `antigravity` 仅作为保守兼容探测命令，不作为推荐启动命令。
- 其他 CLI 不进入当前检测、安装或快速启动范围。
- Antigravity 是 Google 新品牌下的目标 CLI，不再关注 Gemini CLI。

## 工作原则

- 保持应用轻量，不引入 Electron 或服务端运行时。
- 优先沿用现有 Tauri + React + Rust 结构。
- 除非明确是设备本地 UI 状态，否则用户数据保存在 SQLite 中。
- 启动逻辑放在 Rust services 中，不放在 React 组件里。
- 避免临时拼接命令字符串。应先构造参数列表，只在 Shell 边界做必要转义。
- 功能设计优先服务 `claude`、`codex`、`agy` 三个核心 CLI，不扩展为通用 CLI 管理器。

## 文档关系

推荐按以下顺序阅读和使用文档：

1. `README.md`：项目概览、依赖、运行和打包入口。
2. `AGENTS.md`：协作规则、当前状态、架构边界和执行约束。
3. `docs/product-requirements.md`：产品目标、MVP、三项 CLI 范围、非目标。
4. `docs/adr-0001-technology-stack.md`：技术栈选择及其原因。
5. `docs/architecture.md`：分层结构、启动组合、CLI 检测与安装边界。
6. `docs/tooling-and-installation.md`：`claude`、`codex`、`agy` 的检测和安装设计。
7. `docs/roadmap.md`：阶段计划和后续演进顺序。

文档之间的关系：

- `README.md` 面向快速上手，不承载完整设计细节。
- `AGENTS.md` 面向协作执行，约束 Agent 如何读代码、改代码和运行命令。
- `product-requirements.md` 定义做什么和不做什么。
- `adr-0001-technology-stack.md` 解释为什么选择当前技术栈。
- `architecture.md` 解释模块边界和关键技术路径。
- `tooling-and-installation.md` 细化三项 CLI 的检测、安装和 UI 状态设计。
- `roadmap.md` 记录实现优先级，不覆盖需求和架构文档。

## 执行顺序

实现或调整功能时按以下顺序推进：

1. 先确认需求是否仍在 `claude`、`codex`、`agy` 范围内。
2. 如涉及新模块、架构变化或数据流变化，先更新或对齐 `docs/product-requirements.md` 与 `docs/architecture.md`。
3. 如涉及技术栈或长期约束变化，再更新 ADR。
4. 先设计 Rust service、Tauri command、SQLite schema 和 platform helper 的边界，再实现 React UI。
5. 启动和安装命令必须先形成结构化参数模型，再做 PowerShell 或平台层转义。
6. 功能实现后同步更新相关 docs 和 README。
7. 最后执行必要验证，例如 `pnpm run build`、`pnpm exec tauri --version`、`cargo check --manifest-path src-tauri/Cargo.toml`。

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

项目目标包括构建为公司内部使用的 Windows 安装包。打包前需要维护并验证 Tauri 图标资源，例如 `src-tauri/icons/icon.ico`。

后续根据内部分发策略选择 MSI 或 EXE 安装器，并按 Tauri Windows 打包要求补齐 WiX、NSIS 或相关工具链。
