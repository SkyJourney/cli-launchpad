# Agent 说明

## 记忆体系（会话启动必读）

> 新会话或上下文压缩后，必须先读记忆目录的 `MEMORY.md` 索引，再按需加载文件。代码事实与项目记忆冲突时，以代码事实为准并更新项目记忆。

### 读取流程

1. 读取 `.codex/memory/MEMORY.md` 获取文件清单、类型和引用计数。
2. **必读锚点**：`decisions.md`、`feedback.md`、`project_overview.md`、`project_progress.md`。
3. **选读锚点**：`reference.md`、`lint_report.md`。
4. 若仓库使用 `.claude/memory/`，直接读取该目录；不要复制到 `.codex/memory/`。

### 权威优先级

1. 当前代码、配置、测试和真实文件状态。
2. 仓库内项目记忆：`AGENTS.md`、`CLAUDE.md`、`.claude/memory/` 或 `.codex/memory/`。
3. Codex 原生 Memories（个人本地召回层，仅作辅助上下文）。

## 当前项目状态

- 项目默认分支为 `main`。
- 项目使用 Tauri 2 + React + TypeScript + Rust + SQLite。
- 当前发布基线为 0.2.4；0.3.0 目标是转型为以项目和内置 PTY 会话为中心的轻量本地工作台。
- Node 包管理器统一使用 pnpm，仓库中应只维护 `pnpm-lock.yaml`。
- Rust 工具链采用 stable MSVC，Windows 构建依赖包含 Visual Studio Build Tools 2022、MSVC C++ x64/x86 编译工具、Windows SDK 和 WebView2 Runtime。
- 各平台应用标识使用统一的圆角正方形图形，Windows 不使用圆形专属变体。
- 0.3.0 当前目标范围聚焦五个 CLI：Claude Code（`claude`）、Codex（`codex`）、Antigravity（官方主命令 `agy`）、Grok Build（`grok`）和 Hermes Agent（`hermes`）；Grok Build 由 G1 接入，Hermes Agent 由 G2 规划接入，窗口简称 `HA`。
- `antigravity` 仅作为保守兼容探测命令，不作为推荐启动命令。
- 其他 CLI 不进入当前检测、安装或快速启动范围；Hermes G2 仅覆盖 CLI，不接入其 Gateway、消息平台或 Desktop。
- Antigravity 是 Google 新品牌下的目标 CLI，不再关注 Gemini CLI。

## 工作原则

- 保持应用轻量，不引入 Electron 或服务端运行时。
- 优先沿用现有 Tauri + React + Rust 结构。
- 除非明确是设备本地 UI 状态，否则用户数据保存在 SQLite 中。
- 启动逻辑放在 Rust services 中，不放在 React 组件里。
- 避免临时拼接命令字符串。应先构造参数列表，只在 Shell 边界做必要转义。
- 功能设计只服务 `claude`、`codex`、`agy`、`grok`、`hermes` 五个已确认目标 CLI，不扩展为通用 CLI 管理器；Hermes 按 G2 范围逐步接入。

## 文档关系

推荐按以下顺序阅读和使用文档：

1. `README.md`：项目概览、依赖、运行和打包入口。
2. `AGENTS.md`：协作规则、当前状态、架构边界和执行约束。
3. `docs/product-requirements.md`：产品目标、MVP、五项 CLI 范围、非目标。
4. `docs/adr-0001-technology-stack.md`：技术栈选择及其原因。
5. `docs/architecture.md`：分层结构、启动组合、全局 CLI 状态、会话读取、检测安装边界。
6. `docs/ui-design.md`：大窗口工作台设计、项目/PTY/CLI 对话/布局关系、会话历史数据源。
7. `docs/tooling-and-installation.md`：`claude`、`codex`、`agy`、`grok`、`hermes` 的检测、安装和更新设计。
8. `docs/roadmap.md` 与 `docs/milestones/0.3.0/`：目标版本路线图及分阶段验收条件。

文档之间的关系：

- `README.md` 面向快速上手，不承载完整设计细节。
- `AGENTS.md` 面向协作执行，约束 Agent 如何读代码、改代码和运行命令。
- `product-requirements.md` 定义做什么和不做什么。
- `adr-0001-technology-stack.md` 解释为什么选择当前技术栈。
- `architecture.md` 解释模块边界和关键技术路径。
- `ui-design.md` 定义工作台布局、终端视图和会话交互。
- `tooling-and-installation.md` 细化五项 CLI 的检测、安装、更新和 UI 状态设计。
- `roadmap.md` 记录 0.3.0 转型目标与优先级；里程碑文档定义阶段验收，不覆盖需求和架构文档。

## 执行顺序

实现或调整功能时按以下顺序推进：

1. 先确认需求是否仍在 `claude`、`codex`、`agy`、`grok`、`hermes` 范围内。
2. 如涉及新模块、架构变化或数据流变化，先更新或对齐 `docs/product-requirements.md` 与 `docs/architecture.md`。
3. 如涉及技术栈或长期约束变化，再更新 ADR。
4. 先设计 Rust service、Tauri command、SQLite schema 和 platform helper 的边界，再实现 React UI。
5. 启动和安装命令必须先形成结构化参数模型，再做 PowerShell 或平台层转义。
6. 功能实现后同步更新相关 docs 和 README。
7. 最后执行必要验证，例如 `pnpm run build`、`pnpm exec tauri --version`、`cargo check --manifest-path src-tauri/Cargo.toml`。

## 里程碑执行流程

开始一个里程碑时，按以下流程推进；具体任务可以依里程碑规模细分或合并，但不得省略范围确认、验收门禁和最终复核：

1. **建立开发基线。** 阅读 `docs/roadmap.md`、目标里程碑文档及其引用的需求、架构和 UI 文档；检查当前分支、工作区改动、代码实现、测试和依赖状态。对照里程碑前置条件和上一阶段验收结果，确认哪些已满足、哪些仍未完成，以及本次开发是否受阻。保留用户已有改动，不把未提交内容误认为本次工作。
2. **确认开发范围。** 汇总本阶段目标、明确不做的内容、交付物、依赖和验收标准。发现文档冲突、需求歧义或会影响产品/架构选择的问题时，先整理具体选项并向用户交互确认；可由现有决策和代码事实确定的细节直接采用，不重复询问。范围和关键设计对齐后再进入实施。
3. **制定可验收计划。** 将工作拆分为有顺序、可检查的任务，标明依赖、涉及模块、文档同步点和阶段产物。逐项列出与变更风险相称的完整测试覆盖要求，包括适用的单元、集成、前端构建、跨平台/真实 CLI 手工验证，以及可复现的边界和失败场景；同时写清前置门禁、每项任务的验收条件、最终里程碑门禁和无法在当前环境执行的检查。计划应能证明需求、数据与进程生命周期、错误恢复和回归范围均已覆盖，而不只列一个构建命令。
4. **分阶段实施并持续推进。** 按计划完成实现、必要迁移、文档和测试。每个阶段汇报已完成内容、验证结果、剩余事项及下一步。非阻断问题记录为待办或风险并继续推进独立工作；只有会使方案不安全、验收标准无法判断或后续工作无法正确开展的阻断问题才暂停相关部分并请求用户决策。遇到超出已确认范围的架构或产品变更时，先对齐后再实施。
5. **完成代码审查闭环。** 里程碑实现完成后，对照需求、任务计划和差异进行一次完整审查，重点检查功能遗漏、生命周期与数据一致性、安全边界、平台差异、错误处理、测试缺口及文档偏差。修复审查发现的问题后，对修复及相关调用路径再次审查；若复审引入新问题，继续修复和复审，直到没有未处理的里程碑级问题。非阻断遗留项须记录负责人或后续阶段、影响和理由，不得隐去。
6. **执行最终测试与门禁。** 在审查修复闭环之后，重新运行计划中适用的完整测试覆盖和全部里程碑门禁，不能用代码审查前的结果代替最终结果。逐项记录通过、失败、跳过或受环境限制的检查及证据；失败项先修复并重跑受影响检查，最终门禁不通过时不得宣告里程碑完成或提交为已验收状态。
7. **提交并汇报。** 所有必需门禁通过后，检查最终差异与工作区，仅暂存本里程碑相关变更，按 Git 提交规范提交代码。随后更新路线图/里程碑进度，生成里程碑汇报，说明目标与交付、关键设计、审查及修复结果、测试和门禁证据、提交信息、未完成事项及其后续安排。若存在无法执行的门禁或明确保留的非阻断问题，应在汇报中清楚说明，不得将其表述为通过。

## 架构边界

- `src/` 负责展示状态，并调用 Tauri commands。
- `src-tauri/src/commands/` 暴露小而清晰的 IPC 入口。
- `src-tauri/src/services/` 负责命令组合、校验等行为逻辑。
- PTY 生命周期、输出流与进程归属由 Rust service 管理，React 负责终端呈现和布局。
- `src-tauri/src/db/` 负责 SQLite schema、连接和 repositories。
- `src-tauri/src/platform/` 负责操作系统相关的命令启动细节。

## 安全规则

- 将用户配置的目录视为不可信输入。
- Windows 路径使用 PowerShell `Set-Location -LiteralPath`。
- 安装/更新等会执行平台命令的操作，必须在 UI 中预览最终命令及来源；工作台中的 CLI 启动只能通过对应 CLI 按钮在当前项目下创建内置 PTY，不展示或接受自由拼装命令。
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

项目目标包括构建为公司内部使用的 Windows 安装包，同时通过 GitHub Actions 发布 macOS 和 Linux 安装包。各平台安装包、应用内 Logo 和 README 使用同一圆角正方形品牌图形。打包前维护并验证 `src-tauri/icons/icon.ico`（Windows）、`src-tauri/icons/icon.icns`（macOS）和 Linux PNG 图标。

Windows 后续根据内部分发策略选择 MSI 或 EXE 安装器，并按 Tauri Windows 打包要求补齐 WiX、NSIS 或相关工具链。

Linux 打包产出 deb、rpm、AppImage 三种格式（`pnpm tauri:build:linux`），本机开发/打包环境需要：

- rustup + Rust stable
- pnpm（版本与 CI 一致，见 `.github/workflows/release.yml` 中的 `pnpm/action-setup`）
- Tauri v2 官方 Linux 依赖：`build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev`
- `xdg-utils`（提供 `xdg-open`）：`tauri-plugin-opener` 的运行时依赖，打包时会校验，缺失会导致 AppImage 打包失败（精简版 CI 镜像，例如 ARM64 Runner，可能不预装）
- AppImage 打包若报 FUSE 错误，补装 `libfuse2t64`（新发行版）或 `libfuse2`（旧发行版），CI 里已按此顺序尝试

Linux 终端探测与启动（`platform/terminal.rs`、`platform/terminal_launch.rs`）已实现：优先探测 `xdg-terminal-exec`（委托桌面环境默认终端），其次 `x-terminal-emulator`（Debian alternatives），再回退到 Ghostty/kitty/WezTerm（参数格式与 macOS 分支一致）与 xterm。已有 CLI 的安装脚本（`services/install_service.rs`）复用与 macOS 相同的官方 URL；Grok Build 与 Hermes Agent 的 Linux 安装路径和终端行为分别按 G1、G2 确认，并在 M5 跨平台对齐时验证。Antigravity 官方版本查询（`services/version_service.rs`）已补齐 `linux_amd64`/`linux_arm64` 清单映射。Linux 不需要 macOS 那套一次性 `.command` 载荷机制，终端参数或 `-e` 内联脚本直接完成传参。
