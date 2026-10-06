# Agent 说明

## 记忆体系（会话启动必读）

> 新会话或上下文压缩后，必须先读记忆目录的 `MEMORY.md` 索引，再按需加载文件。代码事实与项目记忆冲突时，以代码事实为准并更新项目记忆。

### 读取流程

1. 读取 `.codex/memory/MEMORY.md` 获取文件清单、类型和引用计数。
2. **必读锚点**：`decisions.md`、`feedback.md`、`project_overview.md`、`project_progress.md`。
3. **选读锚点**：`reference.md`、`synthesis_*.md`、`lint_report.md`。
4. 若仓库使用 `.claude/memory/`，直接读取该目录；不要复制到 `.codex/memory/`。

### 权威优先级

1. 当前代码、配置、测试和真实文件状态。
2. 仓库内项目记忆：`AGENTS.md`、`CLAUDE.md`、`.claude/memory/` 或 `.codex/memory/`。
3. Codex 原生 Memories（个人本地召回层，仅作辅助上下文）。

## 当前项目状态

- 项目默认分支为 `main`。
- 项目使用 Tauri 2 + React + TypeScript + Rust + SQLite。
- 当前发布基线为 0.3.0（2026-10-03 发布）：以项目和内置 PTY 会话为中心的轻量本地工作台。0.4.0 正在开发，主线是内容窗格、项目文件编辑、Markdown 预览与本地/远程 Git（M6–M10）；M6 已实现但**收口门禁未通过**（第二轮复核，2026-10-06），M7 在 B 层门禁关闭前不得开工，详见 `docs/milestones/0.4.0/M6-closure-review.md`。
- 0.2.x 的外部终端启动能力已在 0.4.0 M6 期间删除；工作台只通过内置 PTY 启动 CLI。
- M6 第二轮复核的产品决策 PD-01…PD-16 已于 2026-10-06 确认，详见 `docs/milestones/0.4.0/M6-closure-review.md` 4.7.1；其中 PD-10（折叠大小写）的设计草案已评审通过，实现前须先完成平台实现调研并经用户确认调研结论。
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
8. `docs/roadmap.md` 与 `docs/milestones/0.3.0/`、`docs/milestones/0.4.0/`：目标版本路线图及分阶段验收条件。
9. 0.4.0 M6 收口三件套（按序阅读）：`docs/milestones/0.4.0/M6-abstraction-baseline-audit.md`（第一轮基础抽象审查）、`docs/milestones/0.4.0/M6-closure-review.md`（第二轮复核：修复验收、测试专项、架构与抽象、收口路线与产品决策）、`docs/milestones/0.4.0/M6-closure-test-spec.md`（逐条测试补充规格、CI 改进与三平台实机验收清单）。

文档之间的关系：

- `README.md` 面向快速上手，不承载完整设计细节。
- `AGENTS.md` 面向协作执行，约束 Agent 如何读代码、改代码和运行命令。
- `product-requirements.md` 定义做什么和不做什么。
- `adr-0001-technology-stack.md` 解释为什么选择当前技术栈。
- `architecture.md` 解释模块边界和关键技术路径。
- `ui-design.md` 定义工作台布局、终端视图和会话交互。
- `tooling-and-installation.md` 细化五项 CLI 的检测、安装、更新和 UI 状态设计。
- `roadmap.md` 记录版本转型目标与优先级；里程碑文档定义阶段验收，不覆盖需求和架构文档。
- `M6-closure-review.md` 与 `M6-closure-test-spec.md` 是 M6 验收和 M7 开工的强制引用文档：前者给出问题、根因、修复指导、门禁与产品决策，后者给出可直接执行的测试规格；两者与第一轮报告冲突时，以第二轮复核为准。

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
5. **完成代码审查闭环。** 里程碑实现完成后，对照需求、任务计划和差异进行一次完整审查，重点检查功能遗漏、生命周期与数据一致性、安全边界、平台差异、错误处理、测试缺口及文档偏差。修复审查发现的问题后，对修复及相关调用路径再次审查；若复审引入新问题，继续修复和复审，直到没有未处理的里程碑级问题。非阻断遗留项须记录负责人或后续阶段、影响和理由，不得隐去。里程碑文档中的“已满足/已交付/已通过”须附代码位置及测试名或实机记录，并按 R-EV-1 标注证据等级、提交号与平台；最终门禁必须引用本次执行证据，不能沿用历史结果。
6. **执行最终测试与门禁。** 在审查修复闭环之后，重新运行计划中适用的完整测试覆盖和全部里程碑门禁，不能用代码审查前的结果代替最终结果。逐项记录通过、失败、跳过或受环境限制的检查及证据；失败项先修复并重跑受影响检查，最终门禁不通过时不得宣告里程碑完成或提交为已验收状态。
7. **提交并汇报。** 所有必需门禁通过后，检查最终差异与工作区，仅暂存本里程碑相关变更，按 Git 提交规范提交代码。随后更新路线图/里程碑进度，生成里程碑汇报，说明目标与交付、关键设计、审查及修复结果、测试和门禁证据、提交信息、未完成事项及其后续安排。若存在无法执行的门禁或明确保留的非阻断问题，应在汇报中清楚说明，不得将其表述为通过。

## 架构边界

- `src/` 负责展示状态，并调用 Tauri commands。
- `src-tauri/src/commands/` 暴露小而清晰的 IPC 入口。
- `src-tauri/src/services/` 负责命令组合、校验等行为逻辑。
- PTY 生命周期、输出流与进程归属由 Rust service 管理，React 负责终端呈现和布局。
- `src-tauri/src/db/` 负责 SQLite schema、连接和 repositories。
- `src-tauri/src/platform/` 负责操作系统相关的细节：PTY 与进程原语（`process.rs`、`execution_process.rs`）、文件 CAS 与路径规则（`file_cas.rs`、`path_rules.rs`、`path_identity.rs`）、可执行文件探测、窗口几何和环境差异；平台条件编译（`cfg(...)`）应收敛在此处及各 CLI 适配器的 `platform.rs` 内。

## 项目级规则（第二轮复核新增，2026-10-06）

这三条规则来自 M6 第二轮复核的跨层根因（详见 `docs/milestones/0.4.0/M6-closure-review.md` 第三、四章），新增代码和修复都必须遵守。尚未迁移的存量代码按审查报告的工作包逐步收口，收口前不得在存量模式上继续扩展。

### R-FE-1 前端：业务 effect 不依赖翻译函数，监听只依赖稳定身份

- `useEffect`、`useLayoutEffect` 以及被它们间接调用的 `useCallback`/`useMemo` 的依赖闭包中，不得出现 `t`、`i18n` 或 `translation.language`。唯一例外是“语言同步 effect”（例如托盘文案推送），它必须以 `i18n.resolvedLanguage` 为键且只负责推送已翻译的文案。
- 注册 Tauri 命令回调、事件、跨窗协议监听的 effect，依赖只能是稳定身份（窗口 label、token、documentId 等）；业务回调通过 ref（latest-ref / useEvent 模式）读取最新逻辑，语言切换、查询刷新和派生集合的对象身份变化都不得导致监听注销重建、hydrate 重新执行或布局保存。
- 翻译函数只在渲染路径和事件处理函数的最外层使用。异步回调、服务代码和错误处理里需要文案时使用 `i18n.t` 或 latest-ref；state 中保存结构化消息（`{ code, params, fallback }`），渲染时再格式化，不要在 catch 时就把本地化字符串存进 state。
- hydrate、持久化等“命令式动作”只能由显式入口触发（挂载、重试、恢复完成事件、命令执行器的提交后调度），不得靠依赖数组副作用隐式触发。
- 涉及跨窗口或前后端的消息，不得承载敏感数据（交接 token、文件正文）作为广播；身份以 Rust 在命令入口通过 `WebviewWindow` 判定的结果为准，不信任 payload 自报的 label。

### R-EV-1 证据：关闭声明必须带证据等级、提交号与平台

- 里程碑与审查文档里每一条“已满足/已交付/已关闭/已通过”，必须同时写出：问题或需求编号、代码位置、测试名（或实机记录路径）、证据等级、对应提交号、验证平台。
- 证据等级：E1 纯函数/单元；E2 组件；E3 宿主集成（Provider+Probe 或 manager 级）；E4 三平台 CI 在**当前提交**上通过；E5 实机验收记录（含证据文件）。数据安全类至少 E3+E5；权限与契约类至少 E4 且前后端双端有测试；宿主编排类至少 E3。
- 只验证 mock 自身行为、同义反复（期望值与实现读同一份常量）、读不到被测对象或静默通过的测试，不计入证据。
- HEAD 的 CI 非绿，不得宣称 E4；不得用更早提交的绿色运行代替当前提交；追溯文档必须随同一提交更新。
- 预期“当前失败”的测试规格，先以失败状态落地（`it.fails` 或 `#[ignore = "待修复 <编号>"]`），修复后转绿并删除标注；需产品决策的规格在决策前保持 ignore。

### R-RS-1 Rust：IO 命令异步化，数据库只经统一执行器，锁内禁止 IO

- 触及数据库、文件系统、进程或 `canonicalize`/可执行文件解析的命令必须是 `async` 且阻塞部分放入 `spawn_blocking`（或统一的 `blocking(op, budget, …)` 包装）；同步命令只允许纯内存操作和必须在主线程执行的 UI 操作（须加注释说明）。
- 数据库访问统一经 `Db::call` / `CacheDb::call`（落地前，新增代码使用现有 helper，但不得新增直接 `.0.lock()` 的写法）；持有数据库锁或任一 manager 锁时，不得做文件系统、进程、`where.exe`、IPC 发送或 `sleep`；锁层级遵守审查报告 3B.3 节的规定，`Db`/`CacheDb` 为叶子锁。
- 窗口身份由 `WebviewWindow`（`CallerWindow`/`WindowLabel`）在命令入口取得并校验类别，服务层不得再用字符串字面量（`"main"`、`"terminal-"`）判断窗口类别；窗口类别、命令、内容 kind、tool key、错误码等跨语言事实以 `contracts/*.json` 为唯一来源，并有双端契约测试。
- 路径定位采用“父目录句柄 + 名称”，禁止用 `canonicalize` 的结果作为写入位置；平台差异进入 `platform/`，不得新增到普通 services。
- 面向用户的失败使用带 `domain.reason` 错误码的 `AppError`，预期内的业务分支用结构化结果返回，两者不得重复表达同一事实；不得新增裸字符串错误码。

## 安全规则

- 将用户配置的目录视为不可信输入。
- PTY 工作目录以结构化 `cwd` 传入，并经项目目录校验（项目 ID + 路径快照），不经 Shell 字符串拼接；任何会走 Shell 的路径必须在最终边界做字面量转义。
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

外部终端探测与启动（0.2.x 历史：Linux 的 `xdg-terminal-exec`/`x-terminal-emulator` 回退链、macOS 的一次性 `.command` 载荷、Windows Terminal Profile 分层）已在 0.4.0 M6 期间连同 `platform/terminal.rs`、`platform/terminal_launch.rs`、`platform/macos_launch_artifacts.rs` 一起删除；所有平台的 CLI 启动统一通过内置 PTY。已有 CLI 的安装脚本（`services/install_service.rs`）复用与 macOS 相同的官方 URL；Grok Build 与 Hermes Agent 的 Linux 安装路径按 G1、G2 确认，并已在 M5 跨平台对齐时验证。Antigravity 官方版本查询（`services/version_service.rs`）已补齐 `linux_amd64`/`linux_arm64` 清单映射。

持续集成（`.github/workflows/ci.yml`，三平台 Windows、macOS、Ubuntu，`fail-fast: false`，发布流程通过 `workflow_call` 复用）运行 `pnpm test`、`pnpm run build`、`cargo fmt --check`、`cargo check --locked`、`cargo test --locked`。本机提交前应至少运行同等命令；平台专属测试（Windows ACL/保留名、Unix 权限/FIFO/文件名、Linux 非 UTF-8）只在对应平台的 CI 上执行，不能用本机结果替代。
