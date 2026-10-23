---
name: 项目决策
description: 当前关键架构、产品范围和安装策略决策
type: project
last_updated: 2026-10-06
commit: cd4feac
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

## M6 统一软件抽象并使用平台原生适配

**结论：** 工作区内容、资源归属和生命周期在软件层定义统一契约；操作系统差异按各平台原生能力在 platform 层适配，不能因统一抽象而失去任一平台的有效落点。
**Why：** M6 收口的目标是让每种抽象能力都能在 Windows、macOS 和 Linux 正确实现，同时让 pane、独立窗口、文件和 PTY 的公共生命周期可验证。
**How to apply：** Rust services 与前端协调器拥有通用状态和交接规则；平台行为放在 `src-tauri/src/platform/`，按各系统可用能力选择实现；使用跨平台 CI 与对应平台实机记录验证每个能力。
**See Also：** [[project_overview.md#CLI-适配器与公共生命周期]] [[project_progress.md#0.4.0-M6-基础抽象收口]]

## 0.4.0 以内容窗格、文件与 Git 工作区为主线

**结论：** 0.4.0 在 0.3.0 的本地项目与 PTY 工作台上，增加项目文件浏览与编辑、Markdown 连续预览和完整本地/远程 Git 协作，拆为 M6–M10 顺序推进，里程碑共同构成 0.4.0，不分别代表版本发布；不做仓库克隆与 worktree 管理。
**Why：** 产品仍以用户已登记的本地项目目录为中心，窗格容器从 PTY 专用扩展为多内容容器；Git 与文件能力由 Rust services 以项目根目录为安全边界提供。
**How to apply：** 新能力先对照 `docs/roadmap.md`、`docs/milestones/0.4.0/README.md` 与对应里程碑文档；不允许前端执行自由 Git 命令，不独立保存 Git 凭据。
**See Also：** [[project_progress.md#0.4.0-M6-进展与第二轮复核]]

## M6 收口分 A B 两层且 B 层是 M7 开工前提

**结论：** M6 收口分 A 层（M6 验收前提）与 B 层（M7 开工前提）；原先计划延期的问题经用户决定全部改为 M7 开工前必须收口，B 层关闭前 M7 不得开工。收口产生的产品决策待定项（PD-01…PD-16）已连同推荐写入 `docs/milestones/0.4.0/M6-closure-review.md` 4.7 节，用户已于 2026-10-06 逐项确认（见下一条决策）。
**Why：** M6 建立的内容生命周期、Provider、主题与窗口基线是未来插件 API 的雏形，必须在 M7 增加第三种内容类型前收口；2026-10-06 第二轮复核发现四波修复的“已关闭”口径不可靠。
**How to apply：** “已满足/已交付”的表述按主报告 4.4 节证据等级（E1–E5）认定并写明提交号与平台；A/B 门禁清单见主报告 4.5 节。
**See Also：** [[decisions.md#M6-统一软件抽象并使用平台原生适配]] [[project_progress.md#0.4.0-M6-进展与第二轮复核]]

## M6 第二轮复核产品决策已确认

**结论：** 用户于 2026-10-06 确认 PD-01…PD-16，全部取推荐项（A），仅 PD-12 增强、PD-10 经用户明确改选：①PD-01 退出时有运行中的执行任务：提示并显示数量，确认后终止；②PD-02 Unix 控制字符文件名：列表、打开、布局一律拒绝并计入跳过数；③PD-03 工作区文件索引服务的删除登记为范围变更，保留调研文档，M8/全文搜索阶段再设计；④PD-04 Grok 保留现行代码行为（以官方更新检查 `installer=internal` 为准），文档统一到代码；⑤PD-05 在 `0015_legacy_cleanup` 删除 `directory_tool_args`，配置导入容忍旧字段；⑥PD-06 Markdown 用 sandbox iframe（`srcdoc`，无 `allow-scripts` 与 `allow-same-origin`）加受授权约束的自定义资源协议，全局 CSP 不放宽；⑦PD-07 终端始终深色，登记为主题例外；⑧PD-08 Claude/Codex 仅接受规范小写 UUID；⑨PD-09 PTY 交接目标等于源时拒绝；⑩PD-10 **折叠大小写**（用户先选保持现状后明确改选折叠；会改变文档身份键，设计草案已于 2026-10-06 评审通过，**实现前须先完成平台实现调研并经用户确认调研结论**）；⑪PD-11 布局单项非法文件名降级为占位；⑫PD-12 增强版：登记为已知限制、不引入原生钩子，兜底为干净退出标记 + 下次启动异常退出提示（不保存正文）+ `RunEvent::Exit` 尽力清理 PTY 与执行任务并标记意外中断，草稿恢复存储作为后续可选项 PD-12b（未采用）；⑬PD-13 托盘不可用时降级，记日志并强制有效关闭行为为“退出”；⑭PD-14 采用 `acceptance-hooks` cargo feature，仅验收构建启用；⑮PD-15 错误码统一 `domain.reason` 点分，旧码保留一个版本别名；⑯PD-16 布局 schema 版本以 payload 为唯一权威，列降为只读镜像或删除，CAS 仅比较 revision，迁移只保留 Rust 一处。
**Why：** 这些决策把收口工作从“等待产品确认”变为“按确认目标落地”；推荐项都对应已核实的缺陷或安全面（例如 PD-16 是 0.3.0 升级用户布局保存永远失败的根因）。
**How to apply：** 已确认但代码尚未落地的目标，在追溯表中记为“待落地”，不得写成已实现；落地时按主报告 4.7.1 登记证据等级与提交号。PD-10 的设计草案已评审通过（主报告 4.7.2、4.7.4），平台实现调研（4.7.2.12）完成并经用户确认后再改文档身份键；PD-06 是 M7 设计门禁；其余按主报告 4.6 节波次推进。
**See Also：** [[decisions.md#M6-收口分-A-B-两层且-B-层是-M7-开工前提]] [[project_progress.md#0.4.0-M6-进展与第二轮复核]]

## PD-10 设计草案与四个判断已评审通过，实现前置为平台调研

**结论：** 用户于 2026-10-06 评审通过 PD-10（折叠大小写）的“探测前置钩子 + flag + 统一 `PathKey`”设计草案，并认可四个设计判断：①退出请求载荷字段统一为 `executionTaskCount`；②PD-15 连带调整 FE-T29（`pty.input_backpressure`、`exec.plan_changed` 转为后端产出码，`file.identity_changed` 并入 `project.identity_changed`）；③PD-12 异常退出提示走命令 `take_startup_notices`（取走即清空）而不是事件；④干净退出标记放在 `data_dir` 而不是 `cache_dir`。
**Why：** 大小写敏感性随卷、目录和挂载方式而变（macOS 要精确到项目所在 APFS 卷；Linux 可能挂载 NTFS 兼容驱动等外部卷），因此必须用平台适配器探测出 flag，再由统一的 `PathKey` 消费，不能按操作系统写死规则；探测只降低误判概率，CAS 的文件身份复核与打开前的身份比较是安全网，`Unknown` 一律不折叠。
**How to apply：** 实现与解除 `RS-T62`、`FE-T63` 的 ignore 前，先完成主报告 4.7.2.12 的平台实现调研（参考社区最佳实践，来源均需核实），把结论回写 4.7.2 并经用户确认平台探测矩阵；未经确认不得改动文档身份键。评审记录见主报告 4.7.4。
**See Also：** [[decisions.md#M6-第二轮复核产品决策已确认]] [[project_progress.md#0.4.0-M6-进展与第二轮复核]]

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
