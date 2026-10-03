---
name: 项目决策
description: 当前关键架构、产品范围和安装策略决策
type: project
last_updated: 2026-10-02
commit: 2e345ea
---

# 项目决策

## 不使用 Electron

**结论：** 项目使用 Tauri 2，不引入 Electron 或服务端运行时。
**Why：** 产品目标是轻量桌面工具，Electron 的包体积和运行时开销不符合目标。
**How to apply：** 新功能应沿用 Tauri + React + Rust 架构，本地能力放在 Rust 层实现。
**See Also：** [[project_overview.md#技术栈]]

## 0.3.0 目标范围为五项 CLI

**结论：** 0.3.0 目标范围固定为 `claude`、`codex`、`agy`、`grok`、`hermes` 五项 CLI；不建设通用 CLI 管理器。
**Why：** 产品聚焦项目目录中的 CLI 会话工作流；Grok 与 Hermes 分别通过 G1、G2 独立关卡批准接入。范围演进与边界分析见 [[synthesis_scope_fixed-five-clis.md#结论]]。
**How to apply：** 检测、安装、启动、UI 状态和文档围绕五项工具展开；Hermes 限定为本地交互式 CLI，不接入 Gateway、消息平台、Desktop 或 Profile 管理。
**Synthesized：** [[synthesis_scope_fixed-five-clis.md]]
**See Also：** [[project_overview.md#核心-CLI-范围]] [[feedback.md#不要扩展为通用-CLI-管理器]] [[project_progress.md#G2-Hermes-Agent-CLI-接入]]

## Antigravity 使用 agy 作为官方主命令

**结论：** Antigravity CLI 以 `agy` 作为官方主命令；`antigravity` 只做保守兼容探测。
**Why：** 官方资料显示 Antigravity CLI 使用 AGY CLI；项目不再关注 Gemini CLI。
**How to apply：** UI 推荐启动命令和安装设计都应围绕 `agy`，不要把 `antigravity` 展示成推荐路径。
**See Also：** [[reference.md#官方-CLI-资料]] [[feedback.md#不再关注-Gemini-CLI]]

## 安装命令必须来自官方来源

**结论：** 一键安装命令必须来自官方文档或官方推荐包，并在执行前展示来源和完整命令。
**Why：** 安装 CLI 属于用户机器上的高影响操作，尤其是 PowerShell 网络脚本，需要明确来源和风险。
**How to apply：** Claude 优先使用官方 winget 包或官方 PowerShell 脚本；Codex 在 Windows 优先使用官方 PowerShell 安装器，npm 只作为手动备选；Antigravity 使用官方 PowerShell installer。业务层使用结构化参数模型，不拼接自由字符串。
**See Also：** [[reference.md#官方-CLI-资料]] [[feedback.md#修改前说明和确认]]

## 安装与更新使用持久化后台任务

**结论：** 五项目标 CLI 的安装与更新统一创建 Rust 后台任务，通过 Tauri 事件推送实时日志，并将任务状态和受限日志持久化到业务 SQLite；同一 CLI 内互斥，不同 CLI 可并行，每项任务拥有独立取消信号和平台进程树。
**Why：** 缓冲式静默执行无法判断任务是否卡住，也无法可靠终止子进程或在重启后查看历史；同一 CLI 的安装和自更新会争用同一工具状态，但三个不同 CLI 已具备独立命令、日志和进程树边界，无需互相阻塞。
**How to apply：** 任务管理器按 `ToolKey` 维护活动任务，每个 CLI 同时最多一个任务；只接受五项目标工具生成的结构化计划，不开放自由命令或保存环境变量；Hermes 更新入口按独立状态查询开放，任务使用已解析的 CLI 完整路径和单独的 `update` 参数，不指定分支或额外确认参数，也不重复读取应用侧更新计划，默认目标、安装渠道和更新交互交由 Hermes CLI；确认浮窗仅展示来源和完整路径命令；版本刷新期间保留已知缓存状态，失败时注明错误，无缓存时不猜测结果；默认保留最近 50 个任务，每项日志上限 1 MiB；启动时将遗留活动任务标记为意外中断；UI 按 CLI 独立维护执行与版本回读状态，并使用“终止任务”表达强制结束进程树。
**See Also：** [[project_overview.md#执行任务边界]] [[project_progress.md#0.2.0-发布完成]] [[project_progress.md#Unreleased-累积更新]]

## 启动使用完整 CLI 路径与平台分层候选

**结论：** CLI 启动前解析为完整路径；Windows 优先保留 Windows Terminal Profile，并按 Profile 原生追加、PowerShell 命令续接、保留外观替换命令、PowerShell 7、Windows PowerShell、CMD 建立分层候选。
**Why：** 桌面进程继承的 PATH 可能落后于用户安装状态，开发沙箱还可能传入残缺 PATH、`NO_COLOR` 或 `TERM=dumb`；固定替换 Shell 会丢失用户 Profile 的参数、初始化和样式，而只依赖单一终端又无法覆盖未安装 Windows Terminal 或 Profile 命令不兼容的机器。
**How to apply：** 终端探测与启动计划放在 Rust platform/services；设置页持久化 `auto`、指定 Profile 或直接 Shell 目标；启动参数先结构化建模，只在最终 Shell 边界编码；进程创建失败时继续尝试安全候选。启动终端前移除非交互配色变量，Windows 子终端补入注册环境中当前进程缺失的 Machine/User PATH 项。CMD 只作为最终受控兜底，不直接拼接不可信字符串。配置导入不接受外部可执行 Shell 字段或初始化脚本。
**See Also：** [[project_overview.md#启动与检测边界]] [[project_progress.md#0.2.0-发布完成]]
**See Also：** [[project_overview.md#启动与检测边界]]

## 会话历史按需读取本地事实来源

**结论：** 普通历史列表按查看时读取各 CLI 本地事实来源，每项 CLI 独立按 10 条分页；G1.4 搜索索引独立按项目存入可重建缓存，G2 计划将 Hermes 的受限 SQLite metadata 纳入同一索引。
**Why：** CLI 自有索引和会话存储是标题、时间及项目归属的权威来源，按需读取可避免缓存陈旧；Antigravity 新版本已在本机暴露可按 workspace 匹配的摘要库。
**How to apply：** 列表读取后仍要按项目目录或 workspace URI 过滤，恢复前重新验证归属；普通列表不从搜索索引读取。Hermes 遵循当前有效 home/Profile 解析结果，只读单个数据库中的 `source=cli` 会话元数据；不枚举或切换其他 Profile，不查询 Hermes 全文 FTS；索引不得保存项目路径或完整 transcript。
**See Also：** [[project_overview.md#会话与配置数据]]

## CLI 差异由固定适配器提供，软件层拥有生命周期

**结论：** 五个目标 CLI 的安装/检测、当前与更新状态解析、结构化命令计划、启动/恢复参数、会话事实读取及前端图标/标题等差异通过 `ToolKey` 适配器提供；公共服务拥有并发、缓存、执行任务、PTY/窗格/独立窗口、索引和统一搜索的生命周期。
**Why：** 每个 CLI 的官方命令、安装渠道、版本语义和会话格式不同；若把差异分散在 React 与公共服务分支中，新接入会使单 CLI 故障容易影响全局并发和数据处理。
**How to apply：** Rust 适配器位于 `src-tauri/src/services/cli_adapters/<cli>/`，按 common/platform/version/history 拆分，只实现该 CLI 能力；前端元数据位于 `src/lib/cliAdapters/<cli>.ts` 并由穷尽 `Record<ToolKey, ...>` 注册。默认能力安全关闭；单项 panic、JoinError、查询错误或数据源损坏转为该工具 unknown/error 或不完整来源，保留其他 CLI 的缓存/索引并继续生命周期。平台执行仍进入共享任务管理器，同 CLI 互斥、跨 CLI 并行。新增 CLI 不扩展为用户自定义插件。
**See Also：** [[project_overview.md#CLI-适配器与公共生命周期]] [[project_progress.md#G2-Hermes-Agent-CLI-接入]]

## 会话本地别名使用稀疏关联

**结论：** 用户手动重命名会话时，才以 `tool_key + session_id` 向业务 SQLite 写入别名；普通会话不入表，删除别名即恢复 CLI 原始标题。
**Why：** 会话 ID 足以稳定关联用户命名，同时避免复制 CLI 会话索引、正文或源路径，也不会因为项目目录移动丢失别名。
**How to apply：** 别名必须在写入或删除前验证 session 属于当前项目；列表先读取真实会话，再合并匹配别名，孤立记录不得生成虚假会话。配置 JSON 暂不交换别名，但数据库备份与恢复自然包含该表。
**See Also：** [[decisions.md#会话搜索-metadata-只进入独立可重建缓存]] [[project_overview.md#会话与配置数据]]

## Windows 内部分发使用 NSIS 双安装包策略

**结论：** Windows 打包以 NSIS 为目标，提供在线 WebView2 引导版和内嵌 WebView2 离线版，并静态链接 MSVC CRT。
**Why：** 内部分发需要覆盖有网与无网环境，同时减少目标机器对 VC++ 运行库和 WiX 工具链的额外依赖。
**How to apply：** 默认 Tauri 配置构建在线版，离线覆盖配置构建离线版，归档脚本为产物添加 `online` / `offline` 标识。
**See Also：** [[project_overview.md#桌面体验与分发]] [[project_progress.md#已完成功能]]

## 业务数据使用稳定用户目录并提供一致性恢复点

**结论：** 业务数据固定存放在 `~/.cli-launchpad/`，分离 `data/`、`cache/`、`logs/` 与 `backups/`；旧开发标识目录仅在新库缺失时迁移且不自动删除。
**Why：** release 不应继续依赖 `dev.local` 身份目录；配置事实、可重建缓存、诊断记录和恢复点必须具备不同的保留与故障语义。
**How to apply：** 数据库迁移与备份使用 SQLite 一致性备份；恢复校验 manifest、完整性和 schema，并在覆盖前生成保护恢复点；缓存损坏可重建或降级内存，不阻断业务数据。
**See Also：** [[project_overview.md#存储与可靠性边界]] [[project_progress.md#可靠性治理完成]]

## 会话搜索 metadata 只进入独立可重建缓存

**结论：** 普通历史列表仍实时读取 CLI 事实来源；G1.4 搜索可将受限的实际显示标题、summary 与首条用户消息/preview 存入按项目 ID 隔离的可重建 cache DB 索引。索引不保存项目路径或完整正文。用户改名仍只写业务库 `session_aliases`。
**Why：** 每次键入都扫描 CLI 文件导致搜索缓慢且字段与历史列表展示不一致；独立缓存索引可复用 bounded metadata，同时与业务配置和完整 transcript 隔离。
**How to apply：** 项目激活或手动刷新时有界更新索引；FTS5 trigram 匹配子串，1–2 字符查询回退；失败来源保留上一份可用索引并标记不完整。恢复会话或修改别名前重新验证 session 与当前目录的归属关系。
**See Also：** [[decisions.md#会话本地别名使用稀疏关联]] [[project_overview.md#会话与配置数据]] [[project_progress.md#G1.4-会话搜索索引]]

## 关闭窗口策略由 Rust 执行并持久化为业务配置

**结论：** 主窗口默认关闭到系统托盘，可在设置中切换为退出应用；关闭策略保存在 SQLite 并由 Rust 窗口事件直接执行。
**Why：** 应用需要常驻托盘且在窗口关闭前即可可靠判断行为；仅保存在 React 状态或窗口状态文件中无法覆盖启动、配置导入和数据库恢复后的统一行为。
**How to apply：** 托盘菜单固定提供显示主界面和退出，左键双击显示主界面；配置导入或数据库恢复后同步刷新运行时策略。
**See Also：** [[project_overview.md#桌面体验与分发]] [[project_progress.md#已完成功能]]

## 多语言翻译按中文语义源和英文语源分层

**结论：** 中文是界面文案的设计语义源；日语和韩语直接依据中文翻译。英文应从中文准确翻译，并作为西欧语系文案的源语言，供西班牙语、德语、法语和葡萄牙语翻译使用。
**Why：** 中文承载产品原始设计意图；先将其准确表达为英文，可为西欧语言建立一致的中间源，同时日语和韩语直接从中文翻译能减少经英文转译造成的语义损失。
**How to apply：** 新增或修改文案时先确认中文语义，再更新英文；日语和韩语直接对照中文翻译，西班牙语、德语、法语和葡萄牙语以英文为翻译源并对照中文校验。阿拉伯语、俄语等其他语言须以中文语义为准，可使用英文交叉校对；除非另行确认，不假定它们必须经过特定中间语言。
**See Also：** [[project_overview.md#国际化与翻译源语言]]

## Git Tag 驱动跨平台自动发布

**结论：** 正式发布由匹配版本的 `v*.*.*` Tag 驱动；当前工作流覆盖八个构建目标，只有全部成功才生成校验和并发布。手动触发用于预检，不创建 Release。
**Why：** 单机验证无法覆盖所有平台和架构；独立预检能在正式发布前验证同一构建矩阵，Tag 发布则提供可审计且完整的跨平台产物。当前矩阵和门禁分析见 [[synthesis_release-tag-cross-platform.md#结论]]。
**How to apply：** 先运行手动预检，再创建与版本文件一致且指向 `main` 历史的 Tag；保留 Windows x64/ARM64 双 NSIS、Linux x64/arm64 三格式包及 macOS ARM64/Intel DMG 的八个构建目标。平台签名与公证按当前发布约定执行。
**Synthesized：** [[synthesis_release-tag-cross-platform.md]]
**See Also：** [[project_overview.md#桌面体验与分发]] [[project_progress.md#0.2.1-发布完成]] [[reference.md#发布工具官方资料]] [[synthesis_release-tag-cross-platform.md#结论]]
