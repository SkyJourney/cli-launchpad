# G2：Hermes Agent CLI 接入

**状态：** 实现、代码审查、自动化门禁与 Windows CLI 实机验收完成（用户确认，2026-10-02）
**归属版本：** 0.3.0
**依赖：** M3、G1
**后续依赖：** M4、M5

## 目标

在 M3 完成后、M4 开始前，将 Hermes Agent 的本地交互式 CLI 纳入 CLI Launchpad。G2 先完成 Windows 的检测、官方安装/更新、项目内 PTY 启动、会话历史、项目内搜索与恢复。Hermes 窗口标题简称为 `HA`，标题格式沿用 `项目名-HA-01`；macOS/Linux 的 POSIX 安装/更新适配已在 M5 接入，实机对齐仍由 M5 负责。

G2 只接入 `hermes` CLI。它不把 Hermes 的 Gateway、消息平台、远程服务、Hermes Desktop、Profile 管理或工具生态接入 Launchpad。

## 官方调研结论

- Hermes Agent 的官方 CLI 主命令是 `hermes`，当前版本可用 `hermes --version` 查询。普通工作台启动在所选项目目录运行 `hermes`，不添加用户自定义参数。
- Windows CLI 官方安装器为 `https://hermes-agent.nousresearch.com/install.ps1`。G2 使用官方 PowerShell 调用和 `-NonInteractive -Branch main -SkipBrowser -SkipComputerUse`，不触发交互式 setup/Gateway 配置，也不安装工作台不提供的可选浏览器和 computer-use 工具。源码安装默认将 CLI 入口放在 `%LOCALAPPDATA%\hermes\bin\`，安装代码位于 `%LOCALAPPDATA%\hermes\hermes-agent\`，用户数据默认放在 `%LOCALAPPDATA%\hermes\`；安装器仍会准备 uv/Python、PM 管理的运行时与基础依赖、launcher、数据目录并修改用户 PATH。确认页必须呈现命令来源及这些环境影响。[官方安装说明](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md) [Windows 安装参数](https://github.com/NousResearch/hermes-agent/blob/main/website/i18n/zh-Hans/docusaurus-plugin-content-docs/current/user-guide/windows-native.md)
- 官方更新流程依安装归属而异：源码受管安装使用 `hermes update`；`hermes update --check` 不应用代码、不安装依赖或重启 Gateway，但会获取 Git 更新 metadata，不能承诺零文件写入；`hermes update --plan` 可用于了解安装类型及服务影响；`hermes update --install-id` 可辅助识别来源。MSIX、Microsoft Store 等包管理安装由所属渠道更新。`hermes update` 会拉取源码、准备依赖，并可能处理多个 Profile 和运行中的 Gateway。经过范围确认，Launchpad 只在状态查询阶段核实托管更新资格；用户确认更新后只执行完整路径的 `hermes update`，不额外展示计划或应用层预检，后续语义交由 Hermes CLI。[官方更新说明](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/updating.md)
- 会话使用 Hermes home 中每 Profile 独立的 SQLite `state.db`。Windows 默认 home 为 `%LOCALAPPDATA%\hermes\`，显式 `HERMES_HOME` 与 Hermes 自身的活动 Profile 解析规则可能将当前 home 指向其他单一 Profile；`sessions` 表包含 `source`、`title`、`cwd`、`git_repo_root` 等字段，`messages` 表保存完整正文。官方 `hermes sessions list` 提供人类可读列表及 `--workspace` 过滤；当前官方文档未描述稳定的机器可读列表格式，因此不解析其表格文本。[官方会话存储说明](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md) [官方会话命令说明](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)
- G2 采用只读、有界的 SQLite 元数据读取：遵循当前有效 `HERMES_HOME`/Hermes 活动 Profile 解析结果，只打开一个 Profile 的 `state.db`；不枚举、管理或切换 Profile。仅纳入 `source=cli` 的交互式 CLI 会话，以 `git_repo_root` 或 `cwd` 规范化匹配当前项目；不读 Hermes FTS 索引，不扫描完整会话。可读取与历史卡片一致的短预览，但必须设置严格长度上限并纳入现有可重建搜索索引。
- 指定会话恢复使用 `hermes --resume <validated-session-id> --no-restore-cwd`。会话 ID 必须来自已读取并再次验证归属的记录；`--no-restore-cwd` 保证 Hermes 不把 PTY 从用户所选项目切换到历史记录中的其他目录。[官方恢复参数说明](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)

## 已确认范围

- 增加 Hermes Agent 工具身份和全局状态，显示完整名称；终端标题使用 `HA`。窗口计数沿用项目与 CLI 全局序号规则，独立窗口也参与计数。
- 检测 PATH、官方 Windows/macOS/Linux 源码安装器的受管入口及 `HERMES_HOME`；只对确认属于官方默认源码安装且由该安装器管理的实例提供 Launchpad 托管更新。其他来源允许在可信解析到命令时启动，但更新交给其所属渠道。
- 设置页进入时为每个 CLI 独立启动最新状态查询；Hermes 单独运行 `hermes update --check`，采用官方默认更新目标，慢查询或失败只影响 Hermes 自身一行，不阻塞其他 CLI。手动刷新重新启动各自查询。检查不拉取应用代码、不安装依赖或重启 Gateway，但可能获取 Git metadata；若输出无法可靠判断更新状态或通道，显示未知状态，不猜测版本。
- 官方 PowerShell 安装计划进入现有预览、确认、后台任务、实时日志、取消和安装后回读流程。固定使用 `-NonInteractive -Branch main -SkipBrowser -SkipComputerUse`；确认内容说明受管运行时、基础依赖、安装入口、数据目录和 PATH 等副作用。
- 设置页版本查询对已识别的官方 Windows/POSIX 默认源码安装只运行一次 `hermes update --check`；托管资格由解析到的执行文件完整路径和默认源码 checkout 位置确认，不再为一次查询串行运行 `--install-id` 与 `--plan`。更新任务在启动前重复校验该路径和 checkout，随后运行完整路径的 `hermes update`，由官方 CLI 处理默认更新目标、安装渠道与更新过程。
- 普通启动使用 `hermes` 与当前项目目录；PTY 创建、输入输出、尺寸同步、自然退出、独立窗口及窗格行为复用现有共享生命周期。
- 右侧项目上下文区展示当前项目 Hermes 会话，按 10 条分页，支持稀疏别名、可重建的本地搜索索引和安全恢复。遵循 Hermes 当前有效 home/Profile 解析结果，只读一个 Profile；不枚举或管理命名 Profile。
- G2 验收以 Windows 为准。macOS/Linux 官方 POSIX 安装计划、默认来源识别、版本检查、托管更新校验和安装脚本影响预览均已接入；目标平台的安装、路径、SQLite、PTY 和会话恢复实机验收统一列入 [M5 跨平台对齐清单](0.3.0/cross-platform-alignment.md)。

## 非目标

- 不启动 Hermes Desktop，不接入 Hermes Gateway、消息平台、远程会话、云端 API、Agent 编排或 Hermes 插件/技能管理。
- 不管理 Hermes 命名 Profile；不枚举其 `state.db`，也不替用户切换 Hermes 配置。
- 不调用 `hermes sessions export`、全文 `session_search` 或 FTS 表；不读取、复制或长期保存完整对话正文。
- 不展示或接受任意 Hermes 启动参数，不提供外部终端，不把 Hermes 接入通用 CLI 插件框架。
- G2 不要求 macOS/Linux 实机验收；平台对齐属于 M5，具体检查项只在 [M5 跨平台对齐清单](0.3.0/cross-platform-alignment.md)维护。

## 实施计划与阶段门禁

### G2.1 工具身份、迁移与状态展示

- 为工具模型、Rust/TypeScript IPC、数据库迁移、全局 CLI 状态及前端展示增加 Hermes 身份；原有数据和四项 CLI 行为保持兼容。
- 将 `HA` 纳入标题与计数规则；Hermes Agent 图标使用 LobeHub `@lobehub/icons-static-avatar` v1.15.0 的白底 `hermesagent.webp`，深浅主题共用同一素材，第三方素材许可证见品牌图标目录中的 MIT 声明。
- 为工具 key、迁移往返、旧数据保留、标题生成与五 CLI 状态枚举增加自动验证。

**验收：** Hermes 状态与其他 CLI 独立；迁移不改变已有项目、会话别名、布局和任务记录。

**实施结果（2026-10-01）：** 已新增 `hermes` 工具身份、`HA` 窗口简称、LobeHub 本地品牌素材、全局状态探测和项目启动入口；SQLite schema 升至 12，迁移新增 Hermes 工具并保留既有别名与 PTY 元数据。Hermes 安装/更新操作保持关闭，会话历史留待 G2.4。Rust 199 项测试、前端 59 项测试、`cargo check`、前端生产构建及格式检查通过。当前未执行真实 Hermes 安装或 Windows CLI 实机验收。

### G2.2 Windows 检测、安装、版本与更新

- 被动检测只解析 PATH、Windows 官方源码安装路径和当前进程可见的 `HERMES_HOME`，不得运行候选程序。Hermes `--version` 默认会做被动更新检查；读取当前版本时用独立临时 `HERMES_HOME` 关闭该检查，避免网络等待影响版本探测且不改写用户配置。
- 设置页打开时自动运行独立的 Hermes 官方 `hermes update --check` 查询，使用官方默认更新目标，手动刷新也会重查；每项 CLI 独立显示查询状态和结果。状态按落后提交数表达，不伪造语义版本；浅克隆无法统计时只显示“有更新，提交数未知”，失败或未知不显示为已同步。空闲时后台刷新沿用有效缓存并在失败时附带错误提示；Hermes 安装/更新任务活动期间暂停检查、不展示旧缓存，并在任务结束后强制重新读取 Hermes 状态。
- 用结构化命令计划构造官方 PowerShell 安装流程，预览来源、命令和副作用；所有任务复用现有任务持久化与进程树取消机制。
- 版本状态查询验证官方安装身份与默认执行文件归属；仅对已识别的官方 Windows 源码安装显示托管更新入口。未知来源或检查结果不完整时禁用托管更新。
- 确认更新时只展示来源和解析到的 Hermes CLI 完整路径加 `update` 命令，不指定分支、不传额外确认参数、不重复执行应用侧更新计划或任务前检查；由 Hermes CLI 自身决定更新目标并处理更新过程。
- 覆盖隔离版本探测与用户配置不变、错误版本输出、更新检查超时、浅克隆未知提交数、包管理来源、来源复核、安装/更新预览、并发任务互斥、任务取消与任务终态 main 状态回读。

**验收：** 被动检测不启动 CLI；隔离版本探测不会触碰用户 Hermes 配置；状态查询结果按提交落后情况显示；更新确认只展示完整可执行路径与 `update` 参数，不等待应用侧计划检查；刷新期间缓存状态与更新入口保持稳定，失败或未知不会被显示为已同步。

### G2.3 PTY 启动与生命周期

- 普通启动使用固定命令 `hermes`，当前项目路径作为 PTY 工作目录，不提供自定义参数。
- 会话恢复只接受已校验 ID，使用 `--resume <id> --no-restore-cwd`；项目目录仍以当前已选项目为准。
- 覆盖 TUI 输入输出、窗口 resize、分栏重排、拖入/移出窗格、独立窗口、关闭、自然退出、异常终止和应用重启后的失效会话显示。

**验收：** Windows Hermes TUI 在项目目录正确启动和交互；窗格尺寸变化后输入显示正确；退出后 PTY、窗格标签、独立窗口和项目 CLI 计数按现有生命周期收敛。

### G2.4 历史列表、搜索、别名与恢复

- 只读打开当前有效 Hermes home 对应的单个 `state.db`，遵循 `HERMES_HOME` 和 Hermes 活动 Profile 解析结果；不枚举、切换或管理其他 Profile。只选择明确支持的元数据字段，并容忍可选列随官方 schema 演进。
- 过滤 `source=cli`；以规范化后的 `git_repo_root` 优先、`cwd` 兜底匹配当前项目。必须防止路径前缀碰撞、跨项目恢复和重解析期间归属变化。
- 对 `title` 和历史列表所需的一个短预览建立现有独立 cache DB 的可重建索引；预览长度、读取条数和扫描时间均有界。不查询 Hermes FTS，不保存项目路径或完整正文。
- 实现分页、分页边界、标题回退、别名合并、陈旧索引清理、锁定/损坏/缺失数据库隔离，以及恢复前的会话 ID、项目归属和目标路径再次校验。

**验收：** 当前项目的交互式 CLI 会话可列出、搜索、重命名别名并恢复；消息平台和其他项目会话不泄漏；缓存清除后可重建；Hermes 数据库故障不阻断其他四项 CLI。

### G2.5 复审、Windows 实机验收与最终门禁

- 对需求、代码差异、schema 迁移、安装/更新所有权、数据隐私、路径验证、PTY 生命周期、错误降级和既有 CLI 回归进行完整审查；修复后复审相关调用链。
- 复跑 Rust 格式、测试和编译，前端格式、测试和生产构建，以及文档引用、依赖顺序和差异检查。
- Windows 实机按检测、安装计划、更新计划、PTY 启动、项目内历史、短预览搜索、别名恢复、布局/独立窗口和 CLI 退出逐项记录。除非用户明确要改动真实 Hermes 环境，不在验收中直接执行其真实安装或更新。

**最终门禁：** G2.1–G2.5 的验收条件均有结果；失败或跳过项逐项记录；全部必需门禁通过且 Windows 手工验收确认后，方可关闭 G2 并进入后续里程碑。Windows 手工验收已由用户于 2026-10-02 确认通过。

### 实施与门禁记录

- Hermes 能力已接入统一 Rust/前端 CLI 适配器注册表；适配器缺省能力、单项 panic/任务异常和单一历史源错误均按 CLI 隔离降级，不中断应用启动、其他 CLI 状态查询、索引或 PTY 生命周期。
- Hermes 历史读取只读打开当前 home/Profile 的单个 `state.db`，限量扫描 `source=cli` 的记录并验证项目归属；短预览和扫描均有上限，缺失数据库返回空结果，锁定/损坏/无效 Profile 等错误保留旧索引并标记不完整。
- 自动化审查与门禁结果：2026-10-02，Rust 212 项测试通过、`cargo check` 通过、前端 62 项测试通过、TypeScript 检查及 Vite 生产构建通过、格式和差异检查通过。版本状态查询已覆盖同一 CLI 有活动任务时暂停查询、隐藏旧缓存、完成后定向强制刷新。生产构建仍报告已有的大型 bundle 提示；Rust 仍报告一个 macOS 专用字段在 Windows 构建未使用的警告。
- 适配器安全回归包含 panic 转成单 CLI 错误、Hermes 无效 Profile 拒绝回退、数据库只读、项目隔离、缺失数据库、可选 schema 字段及超量扫描标记不完整。
- 用户于 2026-10-02 确认 G2 Windows 实机验收通过；未执行真实 Hermes 安装与更新，避免改变本机环境。此项不是 G2 通过条件。
- macOS/Linux Hermes 安装、PTY、当前 home/Profile 历史读取和恢复验证统一纳入 [M5 跨平台对齐清单](0.3.0/cross-platform-alignment.md)。

## 测试覆盖要求

- **Rust/迁移：** 五工具 key 序列化、旧数据库迁移与数据保留、工具排序、执行任务互斥、HA 标题序号及独立窗口参与计数。
- **路径与所有权：** Windows PATH 候选、官方默认源码安装位置、HERMES_HOME、路径大小写与规范化、软链接/别名入口、来源未知时隐藏托管更新入口。
- **命令任务：** 固定官方 URL 与 PowerShell 安装参数（含非交互及跳过可选工具）、Hermes 更新参数仅为 `update`、确认快速弹出、超时、输出通道、实时日志、取消整棵进程树、版本回读。
- **SQLite 历史：** 只读连接、WAL 活跃写入、忙锁/损坏/缺失文件、schema 可选列缺失、source 过滤、活动 Profile 解析与 HERMES_HOME 覆盖、其他 Profile 不枚举、路径碰撞、项目切换、重复 ID、坏时间、分页游标、别名孤儿及恢复前重复校验。
- **数据边界：** 不访问消息平台来源、不枚举其他 Profile、不扫描 FTS/全文、不超限加载单条预览、不把项目路径或完整正文写入 Launchpad 搜索缓存。
- **前端：** Hermes 已安装/缺失/未知状态、HA 标题、启动禁用状态、安装/更新预览、任务状态、历史分页/搜索/更多/清除/别名/恢复及错误隔离。
- **PTY 与回归：** Windows 实际 Hermes TUI 输入、输出、resize、项目工作目录、恢复 cwd 保护、窗格变化、独立窗口回收/关闭和退出清理；Claude Code、Codex、Antigravity、Grok 的检测、启动、会话、更新任务和标题计数回归。

## 官方依据

- [Hermes Agent 官方安装说明](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)
- [Hermes Agent Windows 安装参数](https://github.com/NousResearch/hermes-agent/blob/main/website/i18n/zh-Hans/docusaurus-plugin-content-docs/current/user-guide/windows-native.md)
- [Hermes Agent 官方平台支持](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/platform-support.md)
- [Hermes Agent 官方更新说明](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/updating.md)
- [Hermes Agent CLI 与恢复参数](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/cli.md)
- [Hermes Agent 会话管理与工作区过滤](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)
- [Hermes Agent SQLite 会话存储与 Profile 路径](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md)
