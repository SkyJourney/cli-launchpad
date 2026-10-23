# G1：Grok Build CLI 接入

**状态：** G1.1a–G1.5 全部完成；Windows 阶段验收通过
**归属版本：** 0.3.0
**依赖：** M2 已验收
**后续依赖：** M3、M4 和 M5

## 目标

把 Grok Build 作为第四个内置 CLI 接入 0.3.0 工作台。Windows 先完成检测、安装/更新、项目内 PTY 启动、历史会话搜索与恢复；macOS/Linux 真机对齐统一留到 M5。

Grok Build 终端标题使用 `项目名-GB-序号`，其他界面显示官方名称。普通启动执行 `grok`，不附加可配置启动参数；恢复历史会话时仅附加官方恢复参数 `--resume <session-id>`。

## 官方调研结论

- 官方产品为交互式 Grok Build CLI，主命令是 `grok`，官方入门文档描述 Windows、macOS 和 Linux 使用方式：[Grok Build 概览](https://docs.x.ai/build/overview)、[CLI 参数参考](https://docs.x.ai/build/cli/reference)。
- Windows 官方安装脚本为 `https://x.ai/cli/install.ps1`，默认安装至当前用户目录下的 `.grok/bin`，支持 `GROK_BIN_DIR` 覆盖；安装脚本会调整用户 PATH 并写入 Grok CLI 配置，应用必须在确认前说明这些改动。[官方 Windows 安装脚本](https://x.ai/cli/install.ps1)
- 官方提供 `grok update` 与 `grok update --check`。官方仓库当前实现也支持仅与 `--check` 搭配的 `--json`，输出包含 `currentVersion`、`latestVersion`、`updateAvailable`、安装来源、通道和错误字段；G1 只取严格校验后的 `latestVersion`。该命令只在用户显式刷新版本时运行，不触发更新。[CLI 参数参考](https://docs.x.ai/build/cli/reference)、[官方更新状态与 JSON 输出](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-update/src/auto_update.rs)、[官方参数校验与调用](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-bin/src/main.rs)
- 官方会话存放在 `~/.grok/sessions/` 下，支持 `grok --resume <session-id>` 与 `grok -c`。官方仓库文档描述了 `summary.json` 会话摘要 metadata 与 `updates.jsonl` 更新流：[会话功能说明](https://docs.x.ai/build/features/sessions)、[官方会话文件格式说明](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)。
- 官方 `grok sessions search` 会把本地 SQLite FTS 索引和远端结果组合。Launchpad 不调用它，也不访问 Grok 私有索引；搜索只读取官方会话摘要 metadata 中的本地标题/摘要与项目目录，不读取正文或更新流。
- 官方也提供 npm 包 `@xai-official/grok`，但 G1 的托管安装与更新优先覆盖官方原生安装器来源。检测到其他来源时可以启动已解析命令；若不能可靠确认更新所有权，禁用应用内更新并给出官方手动说明，禁止对未知安装执行 `grok update`。

## 已确认范围

- 增加 `grok` 工具身份、全局安装状态、版本读取和 `GB` 终端标题；复用现有 PTY 生命周期、输入输出、尺寸同步、退出清理和独立窗口行为。Grok 标志复用 LobeHub `@lobehub/icons-static-svg@1.94.0` 的 `grok.svg`，沿用现有 MIT 许可与主题色着色组件，不另行绘制品牌图形。
- Windows 检测当前 PATH、`GROK_BIN_DIR` 和官方默认用户目录中的 `grok.exe`；被动检测只解析可信候选，不运行 CLI。用户刷新时按现有约束主动执行有界版本探测。
- 设置页提供官方 PowerShell 安装和官方更新计划预览、确认、后台任务日志、取消及完成后版本回读。安装脚本的来源、用户 PATH 与配置文件副作用必须在预览中可见。
- 对官方原生安装来源提供 `grok update`，以官方检查 JSON 中的 `installer=internal` 确认来源，不因自定义安装路径或 PATH 入口而禁用更新。运行 `grok update --check` 获取最新版本时不得触发更新；来源未知或被识别为其他安装方式时不执行托管更新。
- 项目上下文区增加 Grok Build 启动按钮与会话历史。仅当前项目的官方本地摘要 metadata 可进入列表；每页 10 条，支持更多、稀疏别名、项目归属校验和恢复。
- 在当前项目的合并会话列表中提供本地搜索，覆盖四项 CLI 的显示标题、summary、受限首条用户消息或 preview；结果仍显示 CLI 品牌和时间。不得将完整对话正文复制到 Launchpad 数据库、缓存或日志。
- 普通启动在当前项目目录执行 `grok`，不暴露自定义参数、模型选择、`--cwd` 或任意命令输入。恢复只通过结构化参数模型追加 `--resume <id>`。
- 所有 CLI 新会话统一进入当前聚焦窗格；Grok PTY 与项目及工具身份关联，加入现有项目 CLI 会话计数。

## 非目标

- 不接入额度查询、Agent 编排、云端会话、远端搜索、聊天正文浏览或通用 CLI 插件系统。
- 不调用 `grok sessions search`，不读取 `updates.jsonl`、transcript 或内部 SQLite FTS 数据库。
- 不增加普通启动参数编辑、模型选择或外部终端入口。
- G1 不要求 macOS/Linux 实机验收；安装脚本虽有官方平台版本，平台对齐仍属于 M5。
- 不替换或迁移既有 Claude Code、Codex、Antigravity 会话来源与行为。

## 实施计划与分阶段门禁

### G1.1 工具基础与检测

#### G1.1a 工具身份、数据库与路径基础（已完成）

- Rust/TypeScript IPC 增加 `grok` 工具键，并将官方启动命令候选固定为 `grok`。
- 增加 SQLite schema 迁移，为工具表写入 Grok，并扩展会话别名与 PTY 工具键约束；迁移保留已有别名和 PTY 记录。
- Windows 可执行文件探测加入 `GROK_BIN_DIR` 和 `%USERPROFILE%\.grok\bin`，保留现有 PATH 与 `.local\bin` 解析。
- 当前平台 Rust 测试覆盖工具键序列化、路径候选与旧数据迁移；本阶段编译、128 项 Rust 测试和前端生产构建已通过。

#### G1.1b 状态、版本与展示（已完成）

- 将 Grok 加入 CLI 展示清单、工作台启动按钮、设置页状态、中英文文案与 `GB` 终端标题映射。当前使用 LobeHub `@lobehub/icons-static-svg@1.94.0` 中的 `grok.svg` 标志。
- Windows PATH、`GROK_BIN_DIR`、默认用户安装目录的候选路径识别已纳入 G1.1a；缺失时显示缺失状态，未验证路径不作为已安装工具。
- 当前版本通过 `--version` 主动读取；只有用户点击设置页刷新时才运行 `grok update --check --json`，将 `latestVersion` 按 SemVer 校验。其他自动刷新保留可用的 Grok 缓存，不运行联网检查。进程有 15 秒上限；CLI 不可用、返回错误、超时或 JSON/版本无效时显示查询错误，不推测版本号。
- G1.2 安装/更新预览接入前，设置页仅展示 Grok 状态和版本，不提供尚未实现的安装/更新按钮。

**阶段验证：** Rust 版本响应解析和失败场景测试、前端 `GB` 标题测试、Rust 测试/编译、前端测试/生产构建及差异检查通过后，标记完成。

**阶段验收记录（2026-09-30）：** 本机 Grok Build 实测 `--version` 返回 `1.0.41`；`update --check --json` 返回当前版本 `1.0.41`、最新版本 `1.0.44`、`updateAvailable: true`、安装来源 `internal`、通道 `stable`，没有执行更新。自动加载不运行该联网检查，只在用户手动刷新时调用。最终门禁：Rust 132 项测试通过，`cargo check` 通过；前端 32 项测试通过，生产构建通过；`git diff --check` 通过。Rust 仍有既存未使用字段警告，Vite 仍提示主 chunk 超过 500 KB。G1.3 再对设置页和工作台做真实窗口验收。

**验收：** Grok 缺失/可用状态独立且稳定；不会与其他工具状态、任务或会话串联；Windows 用户级路径能解析。

### G1.2 安装、更新与后台任务

- Windows 安装计划固定来自 `https://x.ai/cli/install.ps1`，以 PowerShell 程序和固定参数生成，并显式设为 stable 通道；macOS/Linux 计划对应官方 `https://x.ai/cli/install.sh`，不开放脚本输入。
- 安装确认界面展示完整程序调用，并说明安装目录、替换文件、`config.toml`、PowerShell 补全、用户 PATH、网络下载与可选部署密钥副作用。
- 安装和更新复用现有持久化任务管理器、并发隔离、日志、取消及历史；任务结束后重新读取 CLI 状态和版本/来源。
- Grok 更新计划根据已解析的可执行文件路径生成结构化命令；计划阶段不运行更新检查或复核安装路径。后台任务启动前运行 Grok 检查 JSON，并要求 `installer` 精确为 `internal`，不校验可执行文件所在目录（与上文第 28 行及代码一致：`grok/common.rs` 的 `validate_execution` 只检查 `installer`，`grok/version.rs` 注释明确不看安装路径）；来源未知或缺失标记时不执行更新并显示手动更新说明。**文档修订说明（2026-10-06）：** 此处原写“且当前可执行文件位于官方 `.grok/bin` 或 `GROK_BIN_DIR`”，与同文档第 28 行、`architecture.md`、`tooling-and-installation.md` 以及代码互相矛盾，已按代码事实改正；是否重新引入路径校验属产品决策 PD-04，已于 2026-10-06 确认：保留现行代码行为（以官方更新检查的 `installer=internal` 为准，不限制可执行文件所在目录），文档统一到代码事实（见 `docs/milestones/0.4.0/M6-closure-review.md` 4.7.1）。代码位置：`src-tauri/src/services/cli_adapters/grok/platform.rs`、`grok/version.rs`；任务前置校验：`grok/common.rs`。
- 版本刷新只运行 `grok update --check --json` 并读取 `latestVersion` 与 `installer`；此检查不执行更新。

**验收：** 安装计划来源不可被输入覆盖；完成/失败/取消都能回读并刷新状态；更新不会误操作 npm 或未知来源安装。

**阶段验证记录（2026-09-30）：** 完成代码审查，未发现需要修复的 G1.2 阻断问题；最终门禁全部通过：`cargo fmt -- --check`、`cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml`（136 项）、前端 Prettier 检查、`pnpm test`（34 项）、`pnpm run build` 和 `git diff --check`。Rust 有既存未使用字段警告；Vite 有主 chunk 超过 500 KB 的既存提示。没有实际运行安装或更新命令，以免改变本机环境；设置页手工预览和真实 CLI 行为留待 G1.3 验收。

### G1.3 PTY 启动与会话恢复

- 普通启动只使用 `grok` 和当前项目工作目录，复用现有 PTY 创建参数模型、面板计数、退出事件和布局。
- 为当前项目会话列表读取 Grok `summary.json` 中的会话 ID、工作目录、标题和活动时间；支持 `GROK_HOME`，未设置时使用用户目录下的 `.grok`。只读取 metadata，不打开 `updates.jsonl`、聊天记录或正文索引。
- Grok 历史恢复以 `--resume <session-id>` 作为内部恢复参数，先校验 UUID、摘要中的会话 ID 和项目目录归属，不能让标题或路径进入命令参数。
- 读取固定的 `sessions/<cwd-group>/<session-id>/summary.json` 深度；跳过符号链接、损坏或超限文件，并限制工作目录组数量、项目会话目录数量及摘要文件大小。长工作目录组只通过有界 `.cwd` metadata 与选中项目匹配。
- CLI 非零退出、初始化失败、PTY resize、会话自然退出和独立窗口交接覆盖现有生命周期。

**验收：** Windows 实际 Grok TUI 可在项目目录正常启动、输入、resize、恢复并退出；进程结束后会话计数和面板正确收敛。

**阶段验收记录（2026-09-30）：** 代码复核未发现 G1.3 阻断问题。Windows Grok Build 1.0.41 在选中项目目录内正常启动，输入请求后得到预期回复；会话摘要出现在历史列表。恢复后等待 metadata 加载完成，旧对话正常显示，并通过追问确认上下文连续。最大化/还原工作台后终端正常重绘；关闭窗格后项目会话计数归零。最终门禁：`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo test --manifest-path src-tauri/Cargo.toml`（139 项）、`cargo check --manifest-path src-tauri/Cargo.toml`、前端 Prettier 检查、`pnpm test`（34 项）、`pnpm run build` 与 `git diff --check` 均通过。Rust 有既存未使用字段警告；Vite 提示主 chunk 超过 500 KB。G1.4 本地搜索和 G1.5 最终审查/门禁尚未完成，故 G1 整体仍未验收。

### G1.4 本地历史与会话搜索

- 在 G1.3 的受限 Grok metadata 读取基础上，维护独立于别名和业务数据的可重建缓存索引，按项目 ID 隔离四 CLI 的实际显示标题、summary、受限首条用户消息或 preview；不保存项目路径。
- SQLite FTS5 使用 trigram tokenizer 提供大小写不敏感的子串搜索。1–2 个字符（包括中文单字/双字）走短词回退；查询有界、按最近活动排序，最多返回 2,000 条。
- 项目变为活动项目及用户手动刷新时，从四 CLI 本地 metadata 有界更新索引。完整来源刷新会移除已不存在的记录；不完整来源保留可用的旧记录并标出对应 CLI；读取失败不会阻断其他 CLI 的索引更新。
- 索引只包含历史列表实际展示的标题、summary 和受限 preview/首条用户消息，不扫描完整 transcript，不调用可能混入远端结果的 Grok 原生搜索。缓存清除、损坏或删除后索引可重建。
- 前端仅将最多 2,000 条匹配结果暂存在内存并按 10 条展开；清除搜索或切换项目后释放结果。用户别名仍只写入业务 SQLite，并在索引查询结果上合并。
- 保留普通历史列表各 CLI 当前的独立分页和恢复来源。

**验收：** 实际显示标题、summary、首条用户消息/preview 与别名可按子串命中且大小写不敏感；正文其余内容不命中；中文 1–2 字查询可用；项目间索引隔离；空查询回到普通历史；索引刷新清理陈旧项；损坏或不可用的单一来源不会伪造会话或阻断其他 CLI 查询；清除缓存后可重建索引。

**自动门禁记录（2026-09-30）：** Rust 格式检查、160 项 Rust 测试、`cargo check`、前端 Prettier 检查、37 项前端测试、`pnpm run build` 和 `git diff --check` 均通过。Rust 有既存未使用字段警告；Vite 提示主 chunk 超过 500 KB。

**Windows 手工验收记录（2026-09-30）：** 用户确认 G1.4 计划内的搜索、结果展示与历史交互场景全部通过。G1.3 已记录 Grok 启动、输入、窗口缩放、会话摘要读取、恢复上下文连续、退出及计数收敛。安装/更新界面按 G1.2 验收计划验证；未在本机执行真实安装或更新，避免改动已安装的 Grok 环境。

### G1.5 代码审查、复审与最终门禁（已完成）

- 实现后按本文件的功能、隐私、进程归属、更新来源和错误恢复要求完整审查；修复后对改动和调用路径复审。
- 审查闭环后重新运行 Rust 格式/测试/编译、前端格式/测试/生产构建、文档与版本一致性门禁。
- 汇总 G1.1–G1.4 的 Windows 手工验收证据：Grok 状态与安装计划、已安装启动、会话搜索/恢复、CLI 退出；旧三 CLI 的既有 Windows 验收记录保留在 M1/M2。
- 将 macOS/Linux 的 Grok 检测、安装、PTY、终端输入输出、历史读取和更新方式记入 M5 跨平台对齐待办，不把未执行项标为通过。

**最终复审与门禁记录（2026-09-30）：** 完整复审覆盖工具身份与迁移、官方更新来源校验、PTY 生命周期、Grok metadata 边界、项目归属、索引刷新/失败恢复、别名合并与前端查询缓存。审查中修复并复审了项目切换时索引刷新状态、Grok 搜索总读取上限、损坏摘要的来源状态、搜索别名展示、项目删除清理索引及写入前项目路径复核；未遗留 G1 阻断问题。最终复跑：`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 160 项通过；`cargo check --manifest-path src-tauri/Cargo.toml` 通过；前端 Prettier 检查通过；`pnpm test` 37 项通过；`pnpm run build` 通过；`git diff --check` 通过。Rust 有既存未使用字段警告；Vite 提示主 JavaScript chunk 为 843 KB，超过 500 KB 提示阈值。真实安装/更新未执行，Windows Grok CLI 已安装并实测启动/恢复；macOS/Linux Grok 验证按 M5 处理。

## 测试覆盖要求

- **Rust 单元测试：** 工具身份序列化和兼容、候选路径优先级、`GROK_BIN_DIR`/默认路径、版本输出解析、`update --check` 计划、官方安装来源与更新来源约束、普通启动与恢复参数区分。
- **Rust 会话测试：** 合法摘要、缺失字段、坏 JSON、超限文件、异常时间、重复 ID、错误 `cwd`、项目路径大小写/分隔符、分页游标、别名合并以及恢复前重新校验归属。
- **搜索测试：** 四 CLI 展示标题/summary/受限首条用户消息或 preview 合并、大小写与 FTS 查询转义、1–2 字符中英文回退、别名合并且忽略孤立别名、项目隔离、排序/去重/2,000 条上限及受影响 CLI 标记、刷新清理陈旧记录、不可用来源保留旧索引且不阻断其他来源、清除缓存后索引为空、不匹配正文其余内容、不调用远端 CLI 搜索。
- **前端测试：** 当前活动项目触发索引刷新，索引就绪后才允许查询；项目切换、刷新版本、查询清除与按 10 条展开；另覆盖四个工具状态/按钮禁用、GB 标题、恢复入口和设置页安装更新状态。
- **集成与手工：** Windows 启动真实 Grok TUI 并检查 cwd、输入、resize、恢复、exit 和退出后计数；安装与更新如环境中无法安全执行真实变更，则验证预览和结构化计划，并明确记录未做端到端执行。
- **回归：** Claude Code、Codex、Antigravity 检测/启动/会话列表/恢复/安装更新计划不得被新增工具改变；`ToolKey::ALL` 遍历和任务互斥须覆盖四工具并发关系。

## 最终验收条件

- [x] 产品文档、路线图、工具配置和 UI 对 Grok Build 官方命令、边界和 G1/M3/M4 依赖一致。
- [x] Windows 官方来源检测、当前/最新版本、安装预览、更新来源保护和任务回读通过自动及手工计划验证；未真实执行安装或更新，避免修改本机环境。
- [x] Grok 在选定项目内启动到内置 PTY，标题为 `项目名-GB-序号`，支持正常输入、窗口缩放、会话计数及退出清理。
- [x] 当前项目 Grok 本地历史可读取、搜索、别名和安全恢复；跨项目、坏数据、空结果与正文隐私边界均通过测试和 Windows 手工验收。
- [x] G1 定义的自动化检查、代码审查/修复/复审和最终门禁均有结果记录；macOS/Linux Grok 验证留给 M5。

## 官方依据

- [Grok Build 概览](https://docs.x.ai/build/overview)
- [CLI 参数参考](https://docs.x.ai/build/cli/reference)
- [官方 CLI 源码中的更新检查 JSON 格式](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-update/src/auto_update.rs)
- [会话功能说明](https://docs.x.ai/build/features/sessions)
- [Windows 官方安装脚本](https://x.ai/cli/install.ps1)
- [官方会话 metadata 文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)
- [Enterprise 网络与安装说明](https://docs.x.ai/build/enterprise)
