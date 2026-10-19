# 架构说明

CLI Launchpad 采用 Tauri + React + Rust + SQLite 的分层结构。0.2.4 基线通过系统外部终端启动 CLI（该启动链已在 0.4.0 M6 期间整体删除，见下文“0.2.x 外部终端启动（历史，已删除）”）；0.3.0 由 Rust 管理 PTY，React 在共享工作区内展示跨项目终端窗格，并可将单个 PTY 暂时呈现在独立 Tauri 窗口。0.4.0 在保留 PTY 所有权边界的前提下，把工作窗格扩展为多种内容适配器，并由 Rust 服务提供项目文件与系统 Git 能力。当前 CLI 只通过内置 PTY 启动；本文凡标注“待收口”的条目，表示当前实现与目标设计之间存在已确认差距，对应编号见 [M6 收口复核报告](milestones/0.4.0/M6-closure-review.md)，在差距关闭前不得把目标描述当作已实现事实。

## 分层

```text
React UI
  调用 Tauri commands，维护项目选择、PTY 会话索引、焦点和工作区布局状态

Commands
  处理 IPC 边界，转换请求和响应类型

Services
  负责目录管理、工具配置、依赖检测、命令预览、启动流程、会话读取、版本检测与更新

DB repositories
  负责 SQLite 查询和迁移

Platform helpers
  按 Windows/macOS/Linux 分支负责 CLI 路径解析、PTY 与进程树管理（`execution_process.rs`）、受限子进程执行（`process.rs`）、
  项目文件路径规则与 CAS 原子替换（`path_rules.rs`、`file_cas.rs`）、路径身份比较和窗口几何；0.2.x 外部终端探测与启动已删除
```

## 0.3.0 PTY 工作台目标架构

PTY 后端和输出流实施决策见 [ADR-0002](adr-0002-embedded-pty.md)。M1 使用 `portable-pty`、xterm.js/Fit addon 和带消费确认的 Tauri Channel；Windows 以 Job Object、Unix 以 PTY 进程组管理进程树。Rust PTY service 持有会话、输出读取和退出监控；UI 关闭或应用退出时由 service 执行有界清理。数据库仅保留会话元数据，启动时将遗留运行态标记为已结束。M1–G4 的 macOS/Linux 配置、目标平台编译和实机验收统一留待 M5 跨平台门禁。

终端文本复制和粘贴通过 Tauri clipboard-manager 读写系统文本剪贴板，并只在用户快捷键触发时访问；剪贴板内容不会入库或写入诊断日志。图片内容留在操作系统剪贴板中，应用只将 Claude Code 或 Codex 对应的按键序列送入 PTY，不读取、编码或经 PTY 传输图片字节。Antigravity 图片粘贴能力未验证，不对其提供支持承诺。

```text
React 工作台
  项目导航、窗格内会话切换、递归分栏布局、终端模拟器
          │ Tauri commands / 有界输出流
Rust services
  PTY 会话生命周期、进程归属、输出缓冲、项目/工具/标题关联
          │ platform helpers
Windows ConPTY / macOS PTY / Linux PTY
          │
claude / codex / agy / grok
```

架构边界：

- Rust service 拥有 PTY 与子进程的创建、输入输出、尺寸调整、退出监控和终止；React 管理可见面板、焦点和布局。主工作区和独立窗口共享同一个 session ID 和 PTY，任一时刻只有一个窗口可写入或调整尺寸。关闭窗格标题中的会话关闭控件才终止对应 PTY；仅从布局移除引用或关闭独立窗口不终止会话。
- 前端以递归 split tree 表示布局；split 节点记录方向和比例，pane 节点以有序、带类型的 `contents` 列表记录 PTY slot/文件文档引用，并以 `activeContent` 标识活动项。未知内容 kind 保留原始 JSON 并显示局部占位，不允许移动、拆分、分离或返回；用户可以单独关闭该占位项。稳定的 PTY 会话注册区持有 xterm 实例，并通过 portal 容器挂到所属 pane；文件编辑缓冲由工作区内容协调器管理。内容引用与呈现树结构变化时，各自的运行期状态保持稳定。Allotment 只负责布局与尺寸约束，不持有 PTY/文件生命周期。
- 每个会话在布局树或独立窗口中恰好只有一个可见归属。PTY 退出事件从窗格会话列表、独立窗口和前端运行索引中移除该会话；窗格及分栏关系保留为空状态，供用户启动 CLI 或在指定窗格恢复历史会话。项目和 CLI 的窗口序号由工作区内全部 slot 共同维护，独立窗口 slot 也参与计数。失败启动保留错误呈现以便用户识别。
- 独立窗口接管期间提前到达的 PTY 退出事件须与接管返回的 session 元数据合并，避免接管竞态留下无法操作的窗口；独立窗复用 `PtyTerminal` 的会话状态变化，CLI 自然退出后先通知主工作区清理对应 slot，再直接销毁独立窗。关闭或返回的接管竞态可查询 Rust 的权威归属：会话已结束则关闭并清理，控制权已转交则关闭旧窗口，仍由当前窗口控制则保留 PTY 并允许重试交接。
- 每个 PTY 会话独立拥有稳定 ID、项目 ID、工具 key、工作目录、标题和运行状态；前端按 session ID 索引会话，不能再按项目 ID 只保存一个会话。
- CLI 对话 ID 是可选关联，只有从 CLI 权威来源可靠匹配时才保存；应用不缓存 CLI 会话正文或原始摘要。
- 多项目 PTY 在同一工作区中混排。项目选择只改变启动/恢复目标，并突出显示归属该项目的窗格/会话项；聚焦窗格或会话会同步其项目上下文。
- M2 主工作区布局树只保存 PTY 面板引用、排列方向与尺寸比例；分隔条直接调整比例。拖动标题跨窗格、从标题菜单打开独立窗口，或将独立窗口标题拖回指定窗格时，仅转移视图归属；直接移动后清空的源窗格仍保留。M3 再持久化全局混合项目布局和可选布局预设；M2 不持久化独立窗口位置。布局的切换、编辑和删除不能直接终止 PTY。
- M3 持久化自动保存的当前工作区和用户显式保存的命名快照。布局记录包含版本化递归树、稳定 slot 身份、可空的 PTY session UUID、活动内容、焦点、比例和标题状态；当前工作区以 `detachedContents: WorkspacePaneContentRef[]` 记录独立窗口中的 PTY 与文件归属，命名快照不记录独立窗口位置。0.4.0 schema v4 将 v3 的 `detachedSlotIds` 迁移为 PTY 内容引用；v5 增加未知 kind 的保留信封。布局迁移只在 Rust 一处实现（`WorkspaceLayoutDocument::from_json` 把 v1 至 v4 迁移到 v5，保存时同一事务回写版本），TypeScript 的 `migrateWorkspaceLayoutDocument` 只接受当前版本 v5，收到其他版本抛 `UnsupportedWorkspaceLayoutVersionError` 并使 hydrate 进入 needsReset（PD-16，m6-090）；未知 kind 的原始 JSON 在读取、保存、再读取后保持不变。Rust 与 TypeScript 都拒绝已知内容重复归属 pane/独立窗口，并保留未知内容供旧版安全显示和关闭。文件窗口完成 ready → init → attached 握手后（`detach` 命令）才从源 pane 移除文件引用（主窗口目前不校验 init 已发出就接受 attached，FE-NEW-03，待修）；返回、移动和应用命名布局时先清除旧引用，再独占放入目标 pane。重启时 detached 文件回到焦点 pane 并从磁盘重读，编辑缓冲不持久化；已 detached 或正在 detaching 的文件不会被重复插入命名布局。为已结束或失效 PTY 引用保存足够的项目/工具/标题快照以显示占位项。slot 身份先于 PTY session UUID 产生，二者必须分开保存和校验。Rust workspace layout service 只读写布局元数据，不操作 PTY 生命周期。
- 应用启动先把旧运行状态标记为已结束，再读取、校验和恢复当前布局；hydration 完成前前端不得把空默认树自动保存覆盖数据库。恢复不重启 CLI，也不恢复终端输出或滚屏；已结束会话项从当前工作区移除，保留窗格树、编号、焦点和比例。重启时，detached PTY 沿用恢复规则回到工作区，detached 文件回到焦点 pane 并从磁盘重读，编辑缓冲不持久化。应用命名快照时只调整主工作区呈现结构；快照外仍运行的主工作区 PTY 按稳定顺序追加到根 pane 并去重。独立窗口中的内容保持原有窗口归属，不参加窗格合并或重排；即使快照引用该内容，也从目标 pane tree 中移除该引用，不触发交接。已 detached 或正在 detaching 的文件不会被追加到命名布局；正在交接的内容在布局应用期间仍保持唯一 pane 归属。已结束会话项会被省略但不会收拢窗格。项目或会话身份失效的引用仍局部降级为诊断占位项。
- 当前工作区的用户改动自动保存；命名布局是相互独立的快照。PTY 自然退出时仅移除对应会话项，保留其空窗格和分割关系，且不修改已保存快照；自动标题随项目重命名更新，自定义标题保留原值。
- 跨窗口转移通过有序交接维护 xterm 画面：源窗口暂停输出派发并取得序号水位，等待此前输出写入完成后序列化终端缓冲；目标窗口恢复该快照，Rust PTY service 将事件通道切换至目标窗口并按序重放水位之后暂存的输出，再恢复实时输出。交接期间同一会话只有一个输入/尺寸控制方；失败时恢复源窗口订阅。输出暂存有明确上限，溢出时拒绝转移并恢复原视图，不丢弃或重启 PTY。
- 独立终端窗口由 Tauri `WebviewWindow` 创建，启动参数只含已验证的 session ID 与一次性交接令牌；窗口启动后从 Rust 读取会话元数据，不信任 URL 中的项目、CLI 或路径。独立窗口只提供一个终端和“返回工作区”入口，不暴露分栏操作。关闭请求先完成交接并将 PTY 送回主窗口当前焦点 pane；若该 pane 已不存在则回退到根 pane。
- 标题在主窗口内跨 pane 拖放使用 HTML 拖放；跨 Tauri WebView 的标题拖放作为 Windows 能力探测项。失败或不支持时，右键菜单的“返回工作区”保持完整功能，不以拖放 API 是否可用作为 PTY 生命周期的前提。
- PTY 输出使用有界、可背压的数据通道，避免高频 TUI 输出阻塞 Tauri IPC 或耗尽前端内存；具体传输机制和 PTY crate 在 M1 技术评审确认。
- 数据库持久化 PTY 会话元数据；M2 的活动布局仅驻留当前应用运行期，M3 增加布局持久化，不持久化终端输出或滚屏。隐藏到托盘时应用及 PTY 继续运行；用户显式退出时，若有活动 PTY 或未保存文件先请求确认（详见“应用退出门与恢复门”），确认后由 Rust 结束全部托管 PTY 再退出，取消则保留应用和会话。PTY 进程树必须受应用与平台进程隔离机制管理，应用异常退出时不得遗留失管子进程；M1 实现并验证，M5 跨平台复验。系统重启后不接管进程；旧会话元数据与布局恢复为已结束状态，可重新启动或通过 CLI 历史恢复，不能显示成仍在运行。
- PTY service 必须为 Windows、macOS 与 Linux 提供一致的上层会话接口，并在平台层处理终端尺寸、信号/进程树、编码和环境差异。

## 0.4.0 内容窗格、文件与 Git

0.4.0 的工作区扩展遵循以下所有权：

- Workspace 内容宿主/协调器是视图归属和 pane 拓扑的唯一所有者：维护 pane ID、分栏树、焦点、每 pane 的有序内容引用及活动项，并为标签激活/关闭、批量关闭、移动、拆分和窗口交接提供统一命令入口。适配器不得直接改布局树，也不得以内容类型分支复制通用 UI 行为。内容自身的权威状态仍由领域所有者管理：Rust PTY service 拥有 PTY 进程和会话事实，文件 service 校验文件身份/读写版本，Git service 以系统 Git 为事实来源。**当前实现与目标的差距（待收口）：** `reduceWorkspaceTree`（`src/lib/workspaceContentCommand.ts`，原名 `executeWorkspaceCommand`，M6 目标 028 改名以免被误认为命令执行器）只是应用 activate/close/move/split/detach/return 拓扑变化的纯树 reducer，不触碰 coordinator、adapter 和领域操作，并不是“统一命令入口”；coordinator 转移、领域关闭、树提交和持久化调度的先后顺序仍由 `PtyWorkspace.tsx` 的各个回调分别决定，宿主中仍有约 58 处 `kind ===` / `"slot" in` 内容类型分支（S3G-A02、S3G-A07，门禁计数基线见 FE-T56）。`WorkspaceContentCoordinator` 在内容入树时即登记（M6 目标 019：新建 PTY、打开文件、应用命名布局都立即 `ensureAttached`），归属事实读 coordinator；窗口句柄表（`detachedFilesRef`/`detachedByInstanceRef`）只用于取窗口对象做聚焦与销毁，不再充当归属判据（`PtyWorkspace.ratchet.test.ts` 守着 `.has(` 不回退）。剩余差距：`openProjectFile` 仍以句柄表条目是否存在决定“聚焦已有窗口而不入树”（S3G-A03 余项，随 m6-046、m6-051 评估）。
- 内建内容适配器通过应用启动期注册 API 装配；registry 校验稳定 ID、API 版本、支持的内容类型和冲突。当前内容 adapter 契约为 `apiVersion: 3`，版本号以 `contracts/content-kinds.json` 的 `adapterApiVersion` 为唯一来源，Rust 与 TypeScript 双端契约测试共同校验；adapter 契约已删除 `labels.close`，关闭入口文案不再由 adapter 提供；关闭操作可在领域层返回 pending，内容在退出事件确认前保持 `closing`，不接受取消、移动、拆分或窗口交接，退出后以关闭原因完成 dispose。当前只允许编译进应用的内建适配器，不从磁盘或网络加载第三方代码。每个适配器声明类型化展示信息与菜单文案，接收宿主注入的内容引用和受限服务能力，并实现真实的 pane/独立窗口内容呈现、内部交互及类型特有生命周期驱动。通用菜单、标签关闭按钮、焦点/激活、pane 拓扑、window shell 和 Tauri capability 不由 adapter 复制或动态授予。
- **扩展点注册表共用同一工厂（m6-067 已落地）：** 内容 adapter、编辑器引擎、主题三类扩展点都由 `src/lib/createRegistry.ts` 的 `createRegistry` 实现（`register`、`get`、`getByKey`、`list`、`subscribe`、`revision`）；`supportedApiVersions` 来自 `src/lib/extensionApiVersions.ts`（内容 adapter 读 `contracts/content-kinds.json` 的 `adapterApiVersion`，引擎与主题各一个常量）。版本不符、ID 或类型冲突只让该项贡献注册失败：`register` 抛出固定文案的错误，启动期由 `registerContributionSafely` 逐项捕获并以 `[bootstrap.contribution_rejected]` 记录，其余贡献照常注册。内建主题在 `src/lib/themes.ts` 加载时同步注册（`appStore` 在导入期就要解析主题），启动期的 `registerBuiltinThemes` 幂等且不会注销它们；原生 `setTheme` 传主题的 `base`（`system` 传 `null`）；`ThemeDefinition.labelKey` 的类型是 `LocaleKey`；终端运行时固定使用深色调色板（PD-07 登记的例外，`TERMINAL_RUNTIME_THEME_ID`）。
- 工作区在三处整体替换文件文档集合时（`createWorkspacePersistence`（`src/workspace/persistence/workspacePersistence.ts`）的 `hydrate` 恢复布局、`rehydrate` 清空、`applyPreset` 应用命名布局）经文件 adapter 的 `lifecycle.dispose` 释放被丢弃文档的编辑器 model：`droppedFileDocumentIds` 按文档 id 计算差集，保留下来的文档不释放，同一文档在一次替换中最多释放一次；释放失败只记 `console.error`，不影响替换完成。窗口原生同步失败（`setTheme`、`setFocus`、托盘文案、偏好广播）统一经 `src/lib/windowSyncDiagnostics.ts` 的 `reportWindowSyncFailure` 上报：始终 `console.warn`，开发构建额外 toast；经 `report_window_sync_failure` 命令（m6-111）把失败写入应用诊断日志（Rust `log` 门面，文件目标），窗口标签取自调用窗口，code 与消息经服务端清洗后单行写入；上报失败静默忽略。
- Adapter 契约分为三类入口：`render(context)` 承载实际内容视图；`presentation(content, context)` 提供标题、图标、状态与类型文案；可选的同步关闭钩子 `beforeClose`/`beforeWindowClose` 实现应用特有拦截。需要独立窗口的 adapter 另外提供类型化 `prepareHandoff`、`attachHandoff`、`rollbackHandoff` 驱动以及终态 `dispose`。Handoff driver 只负责调用该内容领域 service、携带类型 payload 和恢复内容内部运行态；不创建 Tauri 窗口、不改 pane tree、不自行订阅公共协议。宿主传入内容身份、owner、目标、一次性交接 ID 与被授权的 service callbacks；未知能力不得由 adapter 自行从全局 API 获取。`beforeClose` 仍为同步否决点；领域关闭返回 pending 后，`closing` 不能撤销，只有 owner 结束事件能完成该关闭。**当前实现状态（待收口）：** `presentation` 返回 `{ title, icon, status, tooltip, closeLabelKey }`，但其 `context` 同时携带 PTY slot、PTY 会话、文件文档与 buffer 等两种内容的宿主数据，registry 门面（`workspaceContentAdapterRegistry.ts` 的 `presentation`/`projectContextOf`）内部仍按 `kind` 分支，`RegisteredWorkspaceContentKind` 是封闭联合 `"pty" | "file"`；两个内建 adapter 都没有实现 `beforeClose`/`beforeWindowClose`（宿主调用点存在、无实现者），实际使用的生命周期钩子是 `describeDisposalImpact`；`dispose` 只有文件 adapter 实现（释放默认编辑器引擎中的 model），PTY 终止与关闭后清理仍由宿主注入的领域操作完成；`prepareHandoff/attachHandoff/rollbackHandoff` 只是把调用转发给宿主构造的 capabilities 闭包，真实的领域逻辑仍在 `PtyWorkspace.tsx`（回环转发，S3G-A10）。统一执行器、领域操作注入表与 contribution 形态见 M6 收口复核报告 3A.5、3A.6。
- 宿主统一执行关闭决策：`beforeClose` 用于关闭 pane 内容、关闭其他/全部等会丢弃内容归属的动作，返回 `true` 才继续、返回 `false` 则拦截；同一批量关闭在执行前先评估所有目标，任一目标拦截时不部分删除。`beforeWindowClose` 在原生子窗口关闭导致内容销毁前执行，同样 `true` 继续、`false` 保持窗口和内容。钩子当前同步且抛错按拒绝处理；如未来需要异步确认，须版本化契约并明确 pending UI/取消语义。pane 内移动、激活、分栏以及成功的交接不是破坏性关闭，不得误触发 `beforeClose`。
- 领域操作注入表（`WorkspaceDomainTable`，`src/workspace/domains/workspaceDomainTable.ts`）是宿主访问内容类型行为的唯一入口，当前只注册 `file` 与 `pty` 两个领域：每个领域提供 `closeInput`（返回标题、脏状态与运行状态；窗口归属，文件另含交接进行中，都返回 `undefined`）和 `close`（返回 closed、pending、failed 三类结果）。宿主 `closeContents` 按注入表键序（file 在前、pty 在后）依次调用，不再按 kind 分支。关闭前的确认影响由 `collectWorkspaceImpacts`（`src/workspace/impacts/workspaceImpacts.ts`）汇总：adapter 声明了 `describeDisposalImpact` 时以其结果为准（空数组即不回退），未声明时回退到运行中 PTY 与脏文件的默认描述。activate、move、split、detach 等操作的 kind 分支尚未迁入注入表，由后续目标逐步收口。
- **命令执行器（0.4.0 M6 RW3 步骤 4，已落地部分）：** 宿主的拓扑类命令（focus、activate、move、split、splitPane、place、launch、closeEmptyPane）统一经 `createWorkspaceCommandExecutor`（`src/workspace/host/workspaceCommandExecutor.ts`）执行，管线固定为：预检（含对源登记 coordinator）、预演（`reduceWorkspaceTree`）、无变化即止、登记目标、一次 `store.commit`、调度持久化（仅在宿主提供显式触发时）、提交后效果（同步项目上下文）。`execute` 是同步的，以保持门面回调的 act 时序。detach、return、ownerLost、applyPreset 与 closeContents 尚未并入执行器（closeContents 经 closeWorkspaceContentBatch 管线执行，见上一条）。
- **独立窗口共用逻辑与启动参数（0.4.0 M6 RW3 步骤 5，已落地部分）：** 终端窗口与文件窗口共用 `useDetachedContentWindow`（`src/workspace/windows/useDetachedContentWindow.ts`）提供返回超时器、returning/error 状态、拖动载荷与窗口销毁；窗口启动参数经 `src/workspace/windows/windowLaunchParams.ts` 集中读写，参数名（终端：detachedSessionId、handoffToken、instanceId、detachedTitle、detachedToolKey、sourcePaneId；文件：detachedFileId、fileHandoffToken、sourcePaneId）是主窗口与子窗口之间的线上契约，不得改名。监听注册与握手流程（终端窗口 attach 后发 ready，文件窗口收到 init 后 attach）仍各自实现，这一不对称尚未收口。
- **视图拆分、context 拆分与内容身份（0.4.0 M6 RW3 步骤 6，已落地部分）：** 工作区视图位于 `src/workspace/views/`（WorkspaceRegion、WorkspaceTreeView、WorkspacePaneView、PaneContentStack、WorkspaceLayoutManager、ImpactConfirmDialog），只经 props、`useWorkspaceSelector` 与 `useWorkspaceCommands` 访问宿主；`usePtyWorkspace()` 仍是兼容门面（键集合冻结），由稳定的命令对象与其余状态字段合成。内容身份只有 `workspaceContentKey`（及 `ptyContentKey`、`fileContentKey`、`contentRefFromKey`）一套；拖放载荷为 `{ key, sourceWindowLabel, sourcePaneId? }`，前缀 `cli-launchpad-content-v2:`，旧 PTY 拖放格式已删除。窗口编排与持久化仍在 `PtyWorkspaceProvider`，kind 分支以 `PtyWorkspace.ratchet.test.ts` 只减不增。
- 窗口壳只负责平台标题栏/拖动/尺寸控件、原生 close-request 进入点、返回入口和生命周期协调器的调用；G3 的主窗口托盘/退出确认、macOS overlay 与平台装饰策略保持其既有 owner。子窗口关闭、返回和 pane 内容关闭最终统一经过 workspace/window lifecycle coordinator，具体 adapter 负责准备类型化交接数据和执行 PTY/file 领域操作。`beforeWindowClose` 返回 true 表示允许宿主继续执行该窗口已配置的关闭策略；该策略可以是交还工作区、结束只属于该窗口的内容或销毁空壳，不将所有内容强制套成相同的 dispose 行为。
- 内容交接状态由前端生命周期协调器管理视图归属，使用随机一次性交接身份并核验来源/目标窗口、内容身份和代次；Rust PTY service 的会话/窗口归属仍是 PTY 权威事实。主窗只在目标窗口 ready 并完成领域 attach 后提交 pane 移除；任一步失败回滚到原 owner。返回流程对称，防止两个窗口同时呈现可写内容或内容暂时无 owner。重复、乱序、过期事件必须幂等忽略；关闭、自然退出和应用卸载负责移除监听、计时器、窗口引用和内容运行时资源。
- 交接通用状态：`attached → detaching → detached → returning → attached`。分离失败回到 `attached`，返回失败回到 `detached`；明确关闭经过关闭钩子后进入 `disposed`。PTY payload 只传令牌、身份和必要终端快照，由 Rust attach/detach；文件 payload 经 Tauri 窗口事件在运行期传递项目 ID、相对路径、编辑缓冲和版本；协议核对事件版本、一次性 token 与窗口 label，不将 payload 持久化，不写入布局或业务数据库。文件路径授权与每次读写校验不能由 payload 替代：文件独立窗读写文件只能使用按窗口 label 登记的 `open_granted_file`/`save_granted_text_file`（见下文“文件独立窗按窗口授权”）。**当前信任边界（待收口）：** 协议订阅使用 `getCurrentWebviewWindow().listen`（`workspaceContentWindowProtocol.ts`），本应用的接收方只处理发给本窗口的事件；但 Tauri 事件系统本身不携带经过验证的发送方，`emitTo` 的目标也可写成 `Any`，任何窗口使用全局 `listen` 仍能窃听全部事件（含 token 与最多 2 MiB 的缓冲）。envelope 中的 `windowLabel` 是发送方自报，主窗口以“token + 自报 label”核对。因此事件通道不是保密通道，也不是隔离边界；Rust 中继加盖发送方、PTY token 绑定目标窗口等改造属于 M7 开工前门禁（S3H-A03、S3H-A04、S3H-A05，M6 收口复核报告 3A.9）。
- **窗口编排（0.4.0 M6 RW3 步骤 9，已落地部分）：** 独立窗口的句柄表、pending 表与返回等待中止器归 `createContentWindowOrchestrator`（`src/workspace/windows/contentWindowOrchestrator.ts`）持有；detach、拖放归属判定、pending 回滚与卸载清理由它的方法提供，依赖全部经 `ContentWindowDeps` 注入。协议处理按内容类型分在 `protocolHandlers.pty.ts`、`protocolHandlers.file.ts`，监听由 `useContentWindowProtocol` 的单个 effect 只注册一次。detach 与 return 尚未并入命令执行器，事件仍是专用事件名。

- **布局持久化（0.4.0 M6 RW3，已落地部分）：** 布局的保存队列、快照构造、hydrate、rehydrate、重置、命名布局应用与分隔条保存防抖归 `createWorkspacePersistence`（`src/workspace/persistence/workspacePersistence.ts`）；hydrate 只由挂载、重试与恢复完成事件触发，保存只由 `schedulePersist` 触发（`startAutoPersist` 在挂载时订阅 store 的 tree、focusedPaneId、slots、documents、hydrationStatus 与 coordinator 修订一次，同一段同步变化合并为一次落定后的保存），目录查询、语言与 buffers 的变化不触发保存；持久化状态（hydrationError、layoutSaveError、layoutResetError、layoutResetPending）由模块自带的 status store 提供，宿主经 `useSyncExternalStore` 读取。

- **宿主组装与 ratchet（0.4.0 M6 RW3，已落地部分）：** `PtyWorkspace.tsx` 只调用 `useWorkspaceRuntime`（实例构造与接线）与 `useWorkspaceFacade`（命令与门面合成）并渲染 JSX，不超过 400 行，不含任何 React 状态或副作用 hook，宿主内 kind 分支数不超过注入表条目数，由 `PtyWorkspace.ratchet.test.ts` 固定；协调器投影、关闭确认、退出与恢复守卫分别位于 `useCoordinatorProjection`、`useCloseConfirmation`、`workspaceLifecycleGuards`，关闭内容的批量流程位于 `useCloseContents`；视图层的 kind 分支属于渲染分派，不计入宿主指标，但宿主以外 `src/workspace/` 的分支总数同样只减不增。

- **当前实现状态（M6 阶段 6）：** `WorkspaceContentCoordinator` 驱动 owner 状态；`workspaceContentWindowProtocol` 统一版本化跨窗事件；`workspaceContentHandoffRuntime` 统一创建窗口并调用 adapter 的 prepare/attach/rollback drivers；`closeWorkspaceContentBatch` 统一关闭前置拦截、批量批准、部分成功回滚和 dispose 完成通知。PTY 终止返回 pending 时 coordinator 保持 `closing`，禁止取消和拓扑变更；退出事件完成 `disposed` 并通知 adapter。未知内容及缺失 adapter 显示内容级占位，adapter render 错误由内容级 ErrorBoundary 隔离；但已知 kind 渲染出错时占位上的“关闭”按钮当前无效（宿主只对 `kind === "unknown"` 真正关闭，S1A-N04，待修）。PTY 终止与文件状态移除仍由宿主注入为领域操作。`workspaceContentWindowRegistry` 共用待启动窗口注册、超时、撤销与 pending→detached 转移机制；PTY token、文件 buffer 和树更新保留领域边界。pane 标签序列和堆叠列表共同覆盖 PTY/文件内容，关闭菜单按 pane 全部内容计数；PTY adapter 经渲染上下文挂载由 `WorkspacePtySessionRegistry` 持有的稳定 portal target，不接管 PTY 会话。pane 树的提交经命令执行器与宿主 store，窗口事件回调编排位于 `src/workspace/windows/`（`contentWindowOrchestrator`、`protocolHandlers.pty`、`protocolHandlers.file`），`PtyWorkspace` 只做组装；PTY 结束与文件状态移除仍由各自领域操作执行。阶段状态与剩余门禁以 `docs/milestones/0.4.0/M6-workspace-files.md` 为准。
- 每类子窗口由静态 Tauri capability 按 label 前缀授予最小权限。Adapter registry 只能声明需要的能力以供审查，不能生成或扩大 ACL；新增窗口类别必须同步增加静态 capability 和覆盖窗口 kind 与静态 capability 一致性、窗口 API 权限的自动化契约测试。应用不授予工作区内容窗口任意文件系统权限。当前契约来源为 `contracts/window-kinds.json`（label 前缀、capability、`appCommands`、`corePermissions`）与 `contracts/app-commands.json`，由 Rust 测试 `window_kind_contract_matches_capabilities`（`src-tauri/src/contracts.rs`）和前端 `src/lib/windowApiPermissions.test.ts` 校验。**已知覆盖缺口（待收口）：** Rust 比较器只比较 `core:` 与 `allow-` 前缀字符串，跳过插件权限与对象形式权限（S1B-N02）；前端权限扫描测试的源码清单因 `import.meta.glob` 键名归一化错误而漏读 `appPreferences*.ts` 与 `workspaceContentWindowProtocol.ts`，删除子窗口的 `core:event:allow-emit-to` 后测试仍会通过（S1B-N01）。
- 内容标签采用共同的宽度分配规则：标题自然收缩，单项标题最大 200 CSS px 并省略；可用空间不足时活动项保持可见，其他类型统一收进内容堆叠列表。列表命令仍经宿主统一入口执行，使用 ResizeObserver/等价布局观测处理窗口尺寸变化，不能因窄 pane 隐藏内容或改变其 owner。
- 文本编辑器视图依赖独立的编辑器引擎接口；文件身份、读写、版本冲突和脏状态仍由工作区文件服务/协调器管理。Monaco 是首个引擎实现，语言贡献按需装载；后续 Git 差异、blame 与 LSP 能力作为受控贡献接入，不让 Monaco 内建功能替代应用的文件安全与生命周期。
- 工作区索引目前没有生产服务、Tauri command 或前端调用方；M6 的文件浏览直接读取有界目录列表。项目级元数据缓存、全文搜索和语言服务/LSP 是后续能力的分层设计参考，不代表当前已交付。若重新引入索引，元数据缓存不得保存文件正文，扫描须局限于项目根目录并在单条目错误时保留部分结果；语言服务失效不得影响文件浏览与文本编辑。B3R-F06 的原 partial-scan 修复建议及本次删除原因记录在 M6 审查报告 WP5。
- 文件引用由项目 ID 和项目内相对路径组成。Rust file service 在每次操作时从数据库读取项目根目录，并将其打开为保留的目录 capability；前端提供的相对路径经校验后，只通过该目录句柄进行枚举、读取、图片预览和写回。打开、列目录、保存和清理统一经 `ProjectDirectory::locate` / `open_directory` 定位，CAS 使用同一规则的 `locate_nofollow`（`platform/file_location.rs`）：中间组件逐个以 `symlink_metadata` 检查，符号链接与 junction 一律拒绝，最终组件不解析；之后只通过保留的父目录句柄加名称操作。保存拒绝符号链接的最终组件，打开、保存、列目录、清理对符号链接策略一致。CAS 不再使用 `canonicalize`，Linux 的 ` (deleted)` 竞态因此从结构上消失；文件身份只有一份实现（`platform/file_identity.rs`）。保存前的非文本检查只在修订相等时执行，修订不等由 CAS 在锁内判定为冲突，修订比较的权威判断只在 CAS 内进行。已知限制：组件检查与 `open_dir` 之间的竞态只能把访问重定向到项目根内部，cap-std 沙箱仍拒绝逃出项目根；Windows 没有文件符号链接的 CAS 测试，符号链接 CAS 行为由 Ubuntu、macOS 的测试证明。特殊文件和不支持内容也在服务层拒绝。只向前端返回有界目录项、文本内容、版本/修改标识和错误，不把任意绝对路径当成授权凭据。
- 项目文件读取、写入和目录列表由 Rust service 通过受限 Tauri commands 提供；当前没有文件系统 watcher，也不提供变更通知流；不为文件浏览器授予整个用户目录的宽泛前端 fs 权限。所有项目文件命令均使用 Tauri async command，并将阻塞文件操作派发到 blocking pool。文本保存经 `platform/file_cas` 公共 CAS 协调器处理：锁内读取并比较调用方版本，目标文件身份仍匹配时才使用项目目录 capability 下的原子替换；锁等待有界，冲突作为类型化结果返回，保留编辑草稿并提供重新载入入口。普通无条件原子写入复用同一临时文件和平台替换机制，但不打开目标文件读取或加锁。临时文件在写入数据前就设置仅当前用户可访问的权限。Unix 在同目录原子 rename（cap-std `Dir::rename`）后，通过仍打开的文件句柄恢复目标权限，恢复失败只记录警告并以类型化保存结果提示，不把已落盘的保存报告为失败。Windows 不再使用 `ReplaceFileW`：临时文件创建时即写入仅当前用户可访问的保护 DACL；提交前先恢复原文件属性，复核已加锁目标的文件身份，再由 `preserve_windows_dacl` 把目标的 DACL 复制到临时文件（保护型 DACL 原样应用，非保护型只重放显式 ACE 并让继承 ACE 重新继承）；最后经 `replace_windows_anchored` 以 `FileRenameInformationEx`（`REPLACE_IF_EXISTS | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE`）原子替换：本地卷把父目录句柄作为 `RootDirectory` 做相对重命名；网络卷（UNC/远程重定向器不接受 `RootDirectory`）改走 `SetFileInformationByHandle(FileRenameInfoEx)`，使用由父目录句柄最终路径拼出的目标绝对路径（实现：`platform/file_cas.rs`）。平台 adapter 只负责锁、文件身份和原子替换，修订计算与 CAS 冲突语义由公共层统一。**已落地（m6-034）：** CAS 不再使用 `canonicalize`。`ProjectDirectory::locate` 逐组件检查并拒绝符号链接与 junction，最终组件不解析（`platform/file_location.rs`）；CAS 在 `FileLocation.parent` 内按名称创建临时文件、加锁、用 `FileIdentity`（`platform/file_identity.rs`）复核、读取并比较修订号、再次复核，再提交。原先 cap-std `canonicalize` 在 Linux 上遇 ` (deleted)` 竞态导致的“无法打开待保存文件”由此从结构上消失（复核报告 2.8 节，S3I-A16）。该锁协调遵守本协议的 Launchpad 写入方；不遵守操作系统文件锁协议的外部程序仍可能并发改写，跨平台文件系统没有可普遍依赖的内容条件替换原语，因此保存前需重读校验，且不得将锁描述为对任意外部写入的绝对互斥。项目目录仍是用户数据，不复制到业务数据库。
- Unix 原子 rename 成功后若恢复权限失败，文件内容仍视为已保存：后端记录警告，并通过类型化保存结果通知主工作区与独立文件窗口检查访问权限。CAS 的 `.UUID.writing` 文件默认不显示在项目浏览器；设置页只能由用户主动扫描登记项目中超过 24 小时的匹配文件，逐项预览和确认后，经 Rust service 重新校验项目相对路径、普通文件类型、修改时间、大小和文件身份再删除。
- Markdown renderer 对原始文件内容生成受清理的连续 HTML；浏览器渲染器和主题 CSS 必须与工作台 UI 样式隔离。Markdown 预览不使用分页引擎、不生成 PDF/Word，也不执行文档提供的脚本。ECharts 浏览器运行时在预览适配器生命周期内创建、重排和销毁。
- Markdown 主题是文档样式偏好，与应用浅色/深色主题分离；主题 CSS、图片字体资源和相对链接仅能在受控预览边界中解析。复用 md-to-pdf 分包之前，必须验证其浏览器入口、依赖打包、安全过滤和授权，不直接引入其分页/导出链路。
- Git service 以项目目录为仓库发现边界，由 Rust platform process runner 调用检测到的系统 Git 可执行文件；参数必须使用结构化数组，环境、工作目录、超时、取消和输出上限均由后端控制。前端不得执行自由 Git 命令，不解析任意 Shell 字符串。
- Git 仓库、索引、分支、提交、remote 与工作树由 Git 自身作为事实来源；Launchpad 不复制 Git 对象或提交历史到 SQLite。状态由有界查询返回，长耗时网络和提交任务通过可取消后台任务/事件反馈进度。
- HTTPS 认证通过用户已配置的 Git credential helper（包括 Git Credential Manager）和操作系统安全存储；SSH 认证委托给系统 SSH agent/配置。新增或修改 remote 后由明确的连接验证触发 Git 的凭据交互；验证成功后只由系统 helper 保存凭据。Launchpad 不接触、不记录、不持久化明文密码、token 或私钥。
- 凭据交互必须兼容无控制台的桌面进程：允许系统 helper 启动浏览器或原生认证界面，并区分等待用户、用户取消、helper 缺失和认证失败；不允许子进程静默阻塞等待 stdin/TTY。Linux 未配置可用安全凭据存储时提供明确的系统设置指引，不回退明文保存。
- 系统 Git helper 决定凭据是否持久保存及保存时长。优先支持 Windows Credential Manager、macOS Keychain、Linux Secret Service 等安全存储；若检测到仅内存缓存或无法判断的自定义 helper，说明其持久性由系统配置决定，并提供安全配置建议。Launchpad 不绕过 helper 自行保存凭据。
- fetch、push、pull、branch switch、rebase、merge、冲突继续/跳过/中止均是显式工作区状态转换。运行前检查脏工作区和当前 Git 操作状态；失败时重新读取 Git 真相状态。非快进情况不得暗中选择整合策略；破坏性覆盖与删除操作需预览影响并确认。
- Commit、merge、rebase 等显式操作可能按 Git 配置运行 repository/system hooks；UI 应说明当前操作及仓库路径，进程输出须受限并可取消，不得把 hooks 转为后台自动执行。
- Git blame 和 diff 装饰以编辑器打开的相对路径为键，按需读取并缓存于运行期；文件切换、提交或仓库状态变化后失效。暂存区与工作树差异需明确区分，避免将同一行标记误显示为单一状态。

跨窗格拖动与右键菜单只依赖统一内容引用和目标窗格，不允许不同内容通过复制进程/文档来伪装移动。独立窗口载荷带随机一次性交接身份并校验来源窗口标签；所有者完成 ready 握手后才从源 pane 移除内容。文件窗口返回时将最新缓冲与版本交还主窗口；交接失败则保留源 pane 和原缓冲。窗口原生标题栏、返回操作和关闭保护由共享壳协调，PTY/file adapter 仅负责各自内容接管和恢复。

建议内容引用概念模型：

| 内容类型      | 持久化引用                      | 运行期状态                        | 关闭与恢复                                     |
| ------------- | ------------------------------- | --------------------------------- | ---------------------------------------------- |
| PTY 终端      | 现有 slot/session 引用          | 由 Rust PTY service 管理          | 沿用现有交接与退出语义                         |
| 文本编辑器    | 项目 ID、相对路径、活动文档状态 | 编辑缓冲、脏状态、外部变更版本    | 关闭前处理未保存内容；恢复时重新读取并检测冲突 |
| Markdown 预览 | 项目 ID、相对路径、文档主题 ID  | 安全 HTML、ECharts 实例和滚动位置 | 关闭释放实例；恢复时从文件重新渲染             |

以上是 0.4.0 目标边界，不预先固定 SQLite schema、Git 输出协议、编辑器具体依赖或 renderer 的跨仓库发布方式；这些细节须在对应里程碑阶段 0 通过可复现验证后再实现。

### 0.4.0 M6 已落地的运行期机制（事实记录）

以下机制已在代码中实现；每条列出实现位置和仍待收口的差距，避免文档与代码再次漂移。

- **文件独立窗按窗口授权。** `ContentWindowGrantRegistry`（`services/content_window_grants.rs`）保存“窗口 label → 一个项目文件”（项目 ID、路径快照、相对路径），label 必须是 `workspace-content-*`，同一窗口只能有一个授权。主窗口在交接开始时调用仅主窗口可用的 `grant_content_window_file`，返回、关闭或窗口销毁时由 `revoke_content_window_file` 与 `lib.rs` 的 `WindowEvent::Destroyed` 分支撤销。文件窗只能使用 `open_granted_file`/`save_granted_text_file`：命令用 `tauri::WebviewWindow` 读取调用方 label，只访问授权表中登记的那一个文件（`commands/files.rs`）。通用的 `open_project_file`/`save_project_text_file` 不在文件窗 capability 中。差距：授权表在备份恢复和删除项目时不清理（运行时仍会二次校验路径快照，不会越权）。
- **项目路径快照校验。** 全部项目文件命令都携带 `directory_path` 快照，`ProjectDirectory::open_for`（`services/project_directory.rs`）与数据库中的项目路径比较，不一致返回 `project_identity_changed`，避免恢复备份后项目 ID 被复用时读写到另一个项目；相对路径规则集中在 `platform/path_rules.rs`（Windows 拒绝 `:`、保留设备名等，Unix 允许 `:` 与 `\`），列目录时不可引用的条目被跳过并计数。已落地（m6-037a）：规则单一来源于 `platform/path_rules.rs`，列表、打开、布局一律拒绝控制字符并由列表计入跳过数（PD-02，S1D-N08）；Windows 保留名补充 `COM0`、`LPT0`（S1D-N13）。在 Windows 上实际创建 `COM0.txt` 失败的实机结论仍待实测（R-15）。
- **内容窗口销毁与 PTY 回收。** `lib.rs` 的 `on_window_event` 在 `Destroyed` 时只做一件事：解析窗口标签并调用 `services/window_lifecycle.rs` 的 `on_window_destroyed`，由它依次撤销文件窗口授权（内容窗）与调用 `PtySessionManager::reclaim_window`（终端窗），把失主会话路由交回主窗口，并为每个失主会话与内容窗口发出对应事件；发送失败只记日志。
- **失败与重试原语。** `src/lib/retryPolicy.ts` 提供 `retryWithBackoff`（次数有上限、可中止、可注入 sleep）与 `registerIsolated`（监听逐项注册，单项失败只重试并报告该项）。主窗口的 PTY 交接组、文件窗交接组与 `workspace-content-window-lost` 监听经 `workspaceContentListenerSetup.ts` 逐项隔离（3 次尝试，间隔 100 ms、300 ms），耗尽后用一条 toast 列出失败的事件名，其余监听保持；独立窗口共用一个底层协议监听，失败按整组处理：先注销已成功项，再向主窗口发送 `workspace-file-window-attach-failed` 或 `pty-detached-failed`，不重试。PTY owner-lost 重新接管最多 8 次（500 ms 起指数退避，上限 4000 ms，`ptyOwnerLostRecovery.ts`），同一会话同一时刻只有一个恢复循环，Provider 卸载时中止，会话已结束或已被其他窗口持有时立即停止；分离超时对账的 `retry-owner-query` 最多重试 10 次（间隔 1 秒）后按超时回滚；布局保存队列对“后端拒绝却不推进 revision”的情况在第 2、3 次发送前分别等待 250 ms、500 ms。差距：owner-lost 事件仍被当作事实使用，Rust 侧没有 `owner_lost` 状态字段（事件源改造属 RW5）。
- **独立窗口交接的 pending 阶段。** 主窗口为每个正在创建的独立窗口保存一条 `PendingContentWindow<K>` 记录（`src/workspace/windows/contentWindowOrchestrator.ts`，由编排器的状态持有），带 `kind` 与 `stage`（`creating`、`ready`、`initSent`、`attached`）；阶段只能通过 `src/lib/workspaceContentPendingStage.ts` 的 `advancePendingWindowStage` 推进，规则由纯函数 `reducePendingStage` 决定。文件窗依次经过 creating（窗口已创建）、ready（收到子窗口 ready，准备 init）、initSent（init 已发出）、attached；重复或晚到的 ready、init 之前的 attached 都被忽略，`completeHandoff("detachReady")` 只在 `initSent` 阶段调用。终端窗的令牌与会话信息随窗口创建交付，没有 init 消息，所以从 `initSent` 开始，`pty-detached-ready` 即 attached 确认。差距：拓扑命令已统一进命令执行器（m6-050），分离完成与返回完成的提交尾部仍由各 handler 自行决定，合入执行器由 m6-096 负责。
- **独立窗口返回管线的提交顺序。** PTY 与文件的返回处理器（`src/workspace/windows/protocolHandlers.pty.ts` 的 `handlePtyReturnRequest` 与 `protocolHandlers.file.ts` 中 `workspace-file-window-return-requested` 的监听）按固定顺序执行：预检并 `beginReturn`；领域操作（PTY `attachHandoff`、文件写入返回的 buffer，可 `await`）；复核 coordinator 仍处于该 token 的 `returning`；目标 pane 在 `beginReturn` 之前经 `resolveWorkspaceReturnPaneId` 解析（请求的 pane、上次所在 pane、焦点 pane、第一个 pane，只取树中存在的），协调器记录的即为它；提交前在 `store.getLive().tree`（最新树）上调用纯函数 `planWorkspaceReturn`，结果 pane 与记录不一致则失败；`completeHandoff("returnReady")`，不是 `changed` 就失败且不改树；最后 `commitTree`、聚焦并清理窗口句柄。从计算目标 pane 到提交树之间不得 `await`，因此 attach 期间用户对树的改动不会被覆盖。返回完成之后到达的同一 token 的重复请求，被 `WorkspaceContentCoordinator.isReturnCompleted` 静默忽略（PTY 在处理器入口，文件在身份校验之后、任何窗口查询之前），不会把已在树里的内容重新判为 detached。差距：这仍是两个处理器各自遵守的约定，返回完成尚未并入命令执行器（m6-096 负责）。
- **命令执行策略（已全量落地，m6-059）。** `src-tauri/src/runtime.rs` 提供 `Db::call`、`CacheDb::call`（在阻塞线程池上取连接锁并执行闭包；锁中毒返回 `db.poisoned`，闭包 panic 或任务被取消返回 `internal.task_failed`）与 `blocking(op, budget, f)`（文件系统、进程、`canonicalize`、可执行文件解析的唯一入口；超过预算返回 `blocking.timeout`，闭包无法被取消，会继续运行到结束）；写操作（项目文件保存与删除残留）使用 `blocking_unbounded`：同样经统一线程池、panic 映射为 `internal.task_failed`，但不设预算，因为超时后写入仍可能完成，不能报告为超时；预算常量集中在 `src-tauri/src/budgets.rs`。规则：命令一律写成 `async fn`（必须在主线程执行的 UI 操作除外并注释说明）；数据库只经 `Db::call`/`CacheDb::call`；禁止在 `Db::call` 的闭包里做文件系统操作；闭包内不得再次访问同一连接（连接锁不可重入，嵌套调用会死锁）；`Db`、`CacheDb` 是叶子锁，持有时不得再取任何 manager 锁，manager 锁内不得访问数据库。已迁移（m6-030）：会话命令、全部项目文件命令（含 `grant_content_window_file`）、CLI 状态与安装版本命令、`create_pty_session` 的启动目录校验、布局读取（`get_workspace_layout`）、应用计划（`plan_apply_workspace_layout_preset`）与保存；项目目录打开拆成数据库阶段（`ProjectDirectory::lookup`）与无库阶段（`open_snapshot`），布局服务拆成 `SlotFacts` 读取与无库的路径比较，因此 `canonicalize` 不再发生在数据库锁内或主线程上。m6-059a 起：除下列 11 个命令外，全部命令都是 `async`，数据库访问经 `Db::call`/`CacheDb::call`，文件系统与进程访问经 `blocking`（写操作与数据替换用 `blocking_unbounded`）；保持同步的 11 个命令都是纯内存或必须在主线程的 UI 操作，各带 `// sync: <理由>` 注释并由 contracts 测试固定：`acknowledge_pty_output`、`report_pty_frontend_stage`、`get_pty_session_window_status`、`write_pty_session`、`begin_pty_handoff`、`stage_pty_handoff_snapshot`、`cancel_pty_handoff`、`set_tray_menu_labels`、`revoke_content_window_file`、`report_window_sync_failure`、`take_startup_notices`。PTY 控制命令中的调整尺寸、终止、重新接管、交接完成与终结经 `blocking` 使用 `PTY_CONTROL` 预算（5 秒）。`Db`、`CacheDb` 定义在 `runtime.rs`，连接字段私有，由编译器强制：除 `runtime.rs` 外没有代码能取连接锁，旧的 `with_conn`、`with_connection`、`with_cache`、`with_cache_connection` 已删除；`Db::with_sync` 与 `CacheDb::with_sync` 只供非 async 线程使用（PTY 监控线程的存储端口、已在 `blocking` 闭包内运行的备份、配置、诊断服务函数、退出清理线程），锁中毒返回 `db.poisoned`，使用它的文件不超过 6 个并由 contracts 测试固定（`async fn` 内禁止调用）。命令里的 blocking 闭包不直接取连接：配置导入导出、诊断导出与备份创建通过 `config_service::{export_with, import_with}`、`diagnostics_service::export_with`、`backup_service::create_with` 这类接收 `&Db` 的服务函数完成。恢复编排 `restore_with_runtime_invalidation` 的准入在数据库锁之前（由 `AppLifecycle` 持有）。继承例外（行为与迁移前一致，未回退）：备份创建与恢复、配置导入导出、诊断导出仍在 `with_sync` 闭包内、即持有连接锁时做文件 IO，这与“持有数据库锁时不做文件 IO”的规则不符，归属后续目标；`AdapterContext` 仍同步构造（m6-035）。PTY 每会话诊断线程的周期快照日志为 `debug` 级，统一 ticker 与线程数收敛仍为 C 级待办。
- **应用生命周期与准入（最小版本）。** `services/app_lifecycle.rs` 的 `AppLifecycle` 是应用阶段（`Running`、`Restoring`、`Importing`、`Exiting`）与准入规则的唯一所有者，托管状态通过两个活动探针读取活动 PTY 数与活动执行任务数。所有会改变这些数量或替换数据的操作先 `admit`：`PtyStart` 与 `ExecStart` 取得只覆盖同步登记段的启动许可（`create_pty_session` 在完成路径与可执行文件校验后才准入）；`DataReplace`（恢复备份、导入配置）要求没有在途启动、没有活动 PTY、没有活动执行任务，许可持有到缓存清理与通知结束；`Exit` 先进入 `Exiting`（拒绝新的启动与数据替换），终止失败时许可析构使阶段回到 `Running`，成功时 `keep_exiting`。准入矩阵共 20 格，由表驱动测试固定。锁顺序：`AppLifecycle` 状态锁在前，会话表与执行任务表锁在后；持有数据库连接锁、会话表锁或执行任务表锁时不得调用 `admit`。`AppExitGate` 仍是独立的一次性退出授权。已移除：`PtySessionManager` 里的 `PtyLifecycleGate` 与两个守卫。差距：失效文件授权与缓存的统一清理钩子（`after_data_replaced`）、执行任务的终止与退出时的尽力清理、执行服务“预留槽位再写库”由 m6-040、m6-041、m6-058 完成（S3I-A04、S3I-A05）。
- **窗口身份与销毁编排。** `models/window_kind.rs` 的 `WindowLabel`（构造时校验窗口类别，非法返回 `window.label_invalid`）与 `CallerWindow`（Tauri 命令参数提取器，`require(&[WindowKind])` 不允许时返回 `window.not_allowed`）是窗口身份的类型；主窗口 label 从 `contracts/window-kinds.json` 读取（`main_window_label()`），`tauri.conf.json` 与 `tauri.macos.conf.json` 显式写 `"label": "main"` 并由契约测试校验（macOS 配置整体替换窗口数组，必须重复契约列出的字段（`decorations` 等平台差异字段不要求一致））。窗口销毁由 `services/window_lifecycle.rs` 的 `on_window_destroyed` 单一编排：`PtySessionManager` 与 `ContentWindowGrantRegistry` 实现 `WindowScopedResource`，各自释放该窗口持有的状态并返回 `AppEvent`（`pty-session-owner-lost`、`workspace-content-window-lost`），再经 `EventSink` 发给主窗口；`lib.rs` 的 `Destroyed` 分支只解析 label 并调用它（取代“内容窗口销毁与 PTY 回收”条目中已改写的内联描述）。服务层不再用 `"main"` 或 `starts_with("terminal-")` 判断窗口类别（`is_main_label`、`is_terminal_label` 从契约读取）。TS 的 `WindowKind` 是显式联合类型并与 JSON 逐项比对。差距：除 `get_pty_session_window_status` 与 `set_tray_menu_labels` 外，命令仍各自用 `WebviewWindow` 与 `ensure_main_window` 做调用方判断，manager 方法仍接收 `&str` label（m6-064 统一为 `CallerWindow::require`）；`execution_service.rs`、托盘与 `lib.rs` 其余位置仍有 `"main"` 字面量（S3I-A12）。
- **错误码与事件清单（契约冻结）。** `contracts/error-codes.json` 是后端错误码的唯一来源，结构 `{ codes, frontendCodes, reservedCodes, aliases }`：`codes` 为后端实际产出的 `domain.reason` 点分码，对应 Rust `error_codes.rs` 常量（`AppError::coded` 的第一个参数必须是常量，源码扫描测试强制）；`frontendCodes` 为前端自己产生的码（`layout.*`）；`reservedCodes` 为已定义并翻译、暂无产出点的码（`file.too_large`）；`aliases` 把旧下划线码与旧点分码映射到新码，保留一个版本。前端 `appErrors.ts` 导出 `APP_ERROR_TRANSLATION_KEYS`（键集合等于四个数组之和）并用 `normalizeAppErrorCode` 比较旧码与新码；10 个 locale 的翻译由测试逐个核对。`contracts/events.json` 登记跨窗口与前后端事件（名称、当前机制、方向、允许的发送与目标窗口类别、版本、计划层级）；Rust 事件名只在 `events.rs` 出现，前端事件名只在 `eventNames.ts`、`appPreferences.ts`、`workspaceContentWindowProtocol.ts` 出现，双端契约测试扫描字面量。`file.not_found` 不再表示“项目目录不存在”（改为 `project.not_found`，旧码作为别名）。已删除没有消费者的 `execution-task-persistence-failed` 事件（持久化失败仍记 `log::error!` 并作为错误返回）。差距：载荷没有快照夹具与版本校验（m6-071、m6-072），事件通道仍是 `emit_to`/广播，尚未迁到收件箱与 Rust 中继（m6-061、m6-062），错误码仍是字符串而非枚举（m6-077）。
- **偏好三层归属。** ① 设备本地、同源共享的 localStorage：主题偏好、界面语言、上次选中的项目等 UI 状态，由前端 `appStore` 与 `i18n` 读写，各窗口启动时直接读取，不进入业务 SQLite 与配置交换；② 业务 SQLite：关闭行为 `close_behavior`（随备份与配置交换）等需要持久并可迁移的设置；③ 仅内存：已解析主题 `ResolvedTheme` 运行期只由 `useThemeSync` 产出并写入 store（store 创建时的初值除外），托盘菜单文案由主窗口加载后推送给 Rust 的 `TrayMenuLabelsState`，不持久化，加载前显示 `lib.rs` 里的中文初值。跨窗口同步走 `app-preferences` 广播与 `app-preferences-requested` 请求（版本 1）。
- **PTY 输入写队列。** 每个会话有专用写线程和容量 32 的有界 `sync_channel`；`write_pty_session` 只做入队，单次输入上限 64 KiB，超限或队列满返回 `pty.input_backpressure`，写线程已退出返回 `pty.input_unavailable`（`services/pty_session_service/input.rs`）。前端 `src/lib/ptyInputWriter.ts` 在写入前按 UTF-8 字节分片（每片不超过 65536 字节，不拆多字节字符与代理对），遇到 `pty.input_backpressure`（旧下划线码为别名，经 `normalizeAppErrorCode` 归一化）按 16、32、64、128、256 毫秒退避重试最多 5 次且保序，用尽后丢弃该次输入的剩余分片并上报一次，非背压错误清空队列并上报一次；分片绑定 push 时刻的会话 ID；`PtyTerminal.tsx` 的全部输入（`onData`、快捷键转义序列、启动期间缓存输入）都只经它写入。已知限制：单次输入超过约 2 MiB（32 个分片的队列容量）且 CLI 在约 0.5 秒重试窗口内一直不读取输入时，仍会在重试用尽后失败并提示。
- **PTY 服务模块结构（0.4.0 M6 RW4，m6-053 起）。** `services/pty_session_service.rs` 是门面，职责拆在 `services/pty_session_service/` 目录：`flow`（输出流控）、`input`（输入队列）、`route`（事件路由）、`session`（`ManagedSession`）、`registry`（会话表 `SessionRegistry`）、`process`（终止原语与 `Terminator`，PTY 私有）、`ports`（`PtyEventSink`、`PtySessionStore`、`LaunchHistorySink` 三个端口，监控线程只依赖端口而不依赖 Tauri）、`window`（窗口状态、回收、重新接管）。真实 PTY 子进程的特征化测试覆盖 `terminate_all` 与退出清理。交接状态机、锁规则、活性权威、项目引用分别由后续的 m6-054 至 m6-057 收口。
- **PTY 窗口交接状态机（0.4.0 M6 RW4，m6-054 起）。** `services/pty_session_service/handoff.rs` 的 `HandoffState` 有 Idle、Paused、Staged、Bound 四个状态，begin、stage、complete（`check_complete` 与 `bind` 两阶段，中间是向目标窗口下发快照）、finalize（`check_finalize` 与 `commit_finalize` 两阶段）、cancel 是仅有的转移；暂停期限仍由 `OutputFlow` 持有，状态机在检测到过期时主动回到 Idle 并恢复输出；finalize 在路由校验失败时保持 Bound，目标通道不会丢失，可由 cancel 或销毁目标窗口清理；目标等于源的交接在 complete 中被拒绝（PD-09，错误码 `pty.handoff_target_is_source`）。交接绑定目标窗口由 m6-063 完成，锁规则由 m6-055 完成。
- **PTY 会话锁规则（0.4.0 M6 RW4，m6-055 起）。** 每个会话只有两把状态锁：`route_and_handoff`（事件路由与交接状态）与 `terminal`（master 与尺寸）；取锁顺序为 registry（只用于查找，取到 `Arc` 后立即释放）、`route_and_handoff`、`terminal`、`flow.state`；`process_tree` 与 `killer` 是只在单个调用内持有、从不嵌套的叶子句柄锁。持有这些锁期间不得发送 IPC、不得 sleep、不得访问数据库或文件系统。`send_event`、`reattach` 回放与 `complete_handoff` 的快照下发都在锁外执行：路由用 `epoch` 代次检测发送期间的变化（变化时重新规划，最多 3 次），`reattach` 用 `reattaching` 标志缓冲回放期间到达的事件并在提交前追赶，`bind` 在下发之后重新校验交接。
- **PTY 活性权威与持久化重试（0.4.0 M6 RW4，m6-056 起）。** 某个 PTY 会话是否在运行以 `PtySessionManager` 的内存会话表为准（`running_in`、`is_running`（目前只有测试使用）、`running_session_ids`）；`pty_sessions` 表只是持久记录。`create_inner` 先登记内存再写库（`register_then_persist`），写库失败时撤销登记；监控线程 `finish` 写库失败进入有界重试队列（`PendingFinishQueue`：64 条、每条最多 5 次，在下一次 `finish`、`insert_running` 或显式 `flush_pending` 时被动重试，队列锁是叶子锁），并通知 `PersistenceObserver`（默认写日志，不产生窗口事件）。删除项目时，内存报告该项目有运行中会话则拒绝（错误码 `directory.in_use`），否则在同一事务内把数据库里残留的 `running` 行标记为 `exited` 后再删除（`pty_session_repo::mark_directory_running_ended`，迁移触发器 `prevent_directory_delete_with_running_pty` 作为深度防御保留）；工作区布局槽位的 `Running` 状态也只在会话 ID 属于内存运行集合时成立，命令层在进入数据库阶段之前取 `running_session_ids()` 并先重试排队的 `finish` 写入（`flush_pending_persistence`）。唯一允许的 Db 到会话表的锁嵌套是 `remove_directory` 命令在数据库锁内读取 `running_in`；它只取会话表锁与各会话 `flow` 锁，这两者都不会在持有时再取数据库锁。删除项目与布局读取的命令层接线（先重试排队的 finish 写入、数据库闭包内读取 running_in、数据库阶段之前取内存运行集合）由 commands 层的接线函数承载并有测试固定顺序（m6-112）。
- **项目引用与路径身份（0.4.0 M6 RW4，m6-057 起）。** 路径身份分两层：`ProjectPathKey`（`platform/path_identity.rs`）用于库里存储的项目路径及其快照，纯词法比较，不访问文件系统，可在数据库锁内或主线程使用；`ProjectRootIdentity` 是已打开目录句柄的“卷标加索引”身份，用于确认目录仍是当时打开的那个；`paths_equal` 保留给外部来源的路径（会话文件、可执行文件）与库里路径的“磁盘同一性”比较，需要 `canonicalize`，不得在锁内调用。`ProjectDirectory::open_ref(db, directory_id, expected_path)` 先 `Db::call` 读目录行，再 `blocking` 打开目录，返回目录能力与 `ProjectRef`（id、path、key、root）；`open_snapshot` 的快照比较用键比较；文件命令的 `open_project` 委托它。PTY 启动只校验一次项目目录：`create_pty_session` 调用一次 `open_ref` 取得 `ProjectRef` 并复核工具已配置，`PtySessionManager::create` 接收 `&ProjectRef`，只做载荷路径的键比较与句柄身份复核（`verify_unchanged`，按路径重开目录比较身份，属尽力而为：删除后立即重建且 inode 被复用时无法区分），不再读取目录行或 `canonicalize`；布局槽位的项目路径与会话工作目录比较改用 `ProjectPathKey`。大小写折叠（PD-10）只作用于项目内相对路径，由 m6-076 实现，不改 `ProjectPathKey::of`（根路径的词法键）。
- **应用生命周期补全（0.4.0 M6 RW4，m6-058 起）。** 退出序列先等待在途的启动许可落地（`AppLifecycle::wait_for_starts`，`Condvar` 在 `Permit::drop` 时通知；`confirm_app_exit` 预算 3 秒、`RunEvent::Exit` 预算 1.5 秒，超时只记 warn 并继续，退出不被卡住），再终止 PTY（`exit_cleanup::terminate_ptys_after_starts_drain`），使退出准入之后才登记的会话也被终止；PTY 启动前的会话归属校验与可执行文件解析各有 20 秒预算（`runtime::bounded`、`budgets::PTY_LAUNCH_PREPARE`，超时返回 `blocking.timeout`），启动许可晚于最后一个外部 await。退出确认进入终止阶段后，待决请求被锁定：此期间到达的新退出请求返回同一请求，不会取代正在确认的那一个（K44-10）；终止失败时锁定解除。锁序：`AppLifecycle.state` 先于探针读取的会话表与执行任务表，探针不得回调生命周期。执行服务采用“预留槽位、锁外写数据库、确认或回滚”：`reserve` 只在内存占位（`reserved` 表，不进入活动表），任务行经 `Db::call` 写入，成功后 `confirm` 转入活动表并带上取消发送端，失败或丢弃时自动回滚；预留任务计入 `active_count()`，退出清理同时清空预留表，之后的 `confirm` 被拒绝；`cancel`、`transition_running` 与终态落库（`settle`）经一把异步互斥串行化状态迁移（取消写入的 `Cancelling` 不会晚于终态），`active` 锁从不跨 `.await` 持有；服务内不再有同步数据库访问（退出清理的一处连接使用保留到 m6-059）；日志泵按 100 毫秒或 32 KiB 合并写入（`LogCoalescer`），泵与任务外层 spawn 均经 `spawn_logged`，panic 会被记录。Unix `ProcessTree` 在已附加且从未发过信号时，`Drop` 会先用 `kill(-pgid, 0)` 确认进程组仍有成员再发 `SIGKILL`，与 Windows 作业对象的 `KILL_ON_JOB_CLOSE` 语义对齐；已发过信号或进程组已不存在时什么也不做。已接受的风险（m6-058 D1）：进程组全部退出后 pid 被无关进程复用并恰好成为进程组组长时理论上可能误杀。`after_data_replaced` 钩子（授权撤销与缓存统一清理）归 m6-099。
- **子进程创建与受监督原语（0.4.0 M6 RW4，m6-060 起）。** `ProcessTree::spawn_attached`/`spawn_attached_std` 保证子进程在运行任何代码之前已属于进程树：Windows 以 `CREATE_SUSPENDED` 创建、加入 Job 后再恢复主线程（经 `CreateToolhelp32Snapshot` 枚举线程，需要 `windows-sys` 的 `Win32_System_Diagnostics_ToolHelp` 特性；恢复失败会终止整棵树并返回错误），额外创建标志由调用方传入（`run_bounded` 传 `CREATE_NO_WINDOW`），Unix 沿用“进程组在 exec 之前由 `setpgid` 建立”。`platform/process.rs` 的 `Supervised` 与 `spawn_supervised` 持有子进程与进程树，丢弃（含丢弃外层 future）即终止整棵树（`terminate` 再 `force_kill`，不 `await`），`shutdown(grace)` 先终止、宽限后强杀并回收；`run_bounded` 与 Codex app-server 共用它，m6-039 的私有守卫已删除；`run_bounded_sync` 使用 `spawn_attached_std`。生产代码里 `.spawn()` 与 `kill_on_drop(` 只允许出现在 `platform/process.rs`、`platform/execution_process.rs`、`platform/opener.rs`（有意脱离的一次性启动）与 `services/execution_service.rs`（流式安装更新任务，使用自己的进程树与预留槽位），由 contracts 测试固定。PTY 的 `Terminator`（经 `portable_pty` 创建子进程）与平台层 `Supervised` 不合并。m6-060b：`PtySessionManager::terminate_all_within(total, force_after)`（`terminate_all` 的默认值仍是 3 秒与 750 毫秒）在等待会话退出期间对每个会话调用 `OutputFlow::begin_exit`（被背压阻塞的读取线程不再阻塞，但不关闭输出流），超时仍有存活会话时对它们 `cancel_exit` 恢复背压，存活会话的输出不再被永久冻结；`wait_for_capacity` 的判断顺序是 closed、paused、exiting、水位线。ConPTY 读取线程 EOF：Windows（实测版本 10.0.26300）在子进程退出后、主端仍被持有时读取线程拿不到 EOF，所以 `spawn_child_monitor` 在子进程退出、终止进程树并关闭输出流之后，最多等待读取线程结束 500 毫秒（`ManagedSession::reader_done`），仍未结束则 `release_terminal` 丢弃 PTY 主端（`TerminalState.master` 为 `Option`，释放后调整尺寸返回“PTY 终端已释放”），释放在一个脱离的线程里执行（Windows 11 24H2 之前 `ClosePseudoConsole` 会等到输出管道排空，不得拖住监控线程与终端锁；这些旧版本未经实测），读取线程随即收到 EOF 并退出；Unix 上读取线程通常自行结束，不会触发释放。
- **项目内相对路径的身份与大小写折叠（0.4.0 M6，m6-076 起，PD-10）。** 项目内相对路径的比较只经过 `PathKey::of`（Rust，`platform/path_key.rs`）与 `pathKeyOf`（TypeScript，`src/lib/pathKey.ts`），两端共用 `contracts/path-key/path-key-vectors.json` 的向量；折叠与否由 `PathSemantics` 决定，它有大小写与 Unicode 规范化两根轴，由各平台适配器（`platform/case_sensitivity/{windows,macos,linux}.rs`）按“平台 API、已有条目换大小写、临时文件、`Unknown`”的探测链得出，探测以项目根所在位置为准，`Unknown` 与 `Sensitive` 永不折叠，折叠后的键相同只表示候选，合并前必须有文件身份确认。探测结果由 `CaseSensitivityCache`（`services/project_path_semantics.rs`）按项目 id 与路径快照缓存：大小写轴已确定的结果缓存到失效，`Unknown` 缓存 60 秒；项目移除与备份恢复时失效；常量 `FOLD_PROJECT_FILE_CASE` 置为 `false` 即把所有项目强制为区分大小写（回滚开关）。后端经 `get_project_path_semantics` 与列目录结果的 `pathSemantics` 下发结果（前端注册表目前只用前一个命令取值），`check_project_files_same_identity` 给出文件身份比较；`open_ref` 不探测。前端打开文件时按语义与文件身份判定是否复用已有文档，hydrate 只做精确去重，语义到达之后才由 `mergeCaseVariants` 折叠合并大小写重复文档（一次提交，有未保存修改的变体整组保留）；保存侧在缓存语义为 `Insensitive` 时对重复项返回 `layout.case_duplicate`，前端合并后重试一次，仍被拒则降级丢弃后出现的变体且不再发送，并在首次保存已合并布局前创建 `pre_case_merge` 备份。第一版只探测项目根，嵌套挂载点与目录级标志是已知限制。
- **文件身份的 128 位文件号（0.4.0 M6，m6-113 起）。** `platform/file_identity.rs` 的 `FileIdentity` 由卷（设备）号和 128 位索引组成。Windows 优先用 `GetFileInformationByHandleEx(FileIdInfo)` 取 64 位卷序列号和 128 位文件号，因为 ReFS（Dev Drive 也是 ReFS）上旧接口的 64 位索引不保证唯一；不支持该信息类的文件系统（例如 FAT），或调用成功但文件号全为 0（文件系统没有 128 位文件号时该字段必须被忽略）的情况，回退到 `GetFileInformationByHandle` 的 64 位索引。NTFS 的文件号低 64 位等于旧索引、高 64 位为 0，所以 NTFS 上文件号的取值不变；卷序列号则由旧接口的 32 位变为 `FILE_ID_INFO` 的 64 位（身份只在一次会话内比较，不持久化）。Unix 的 inode 原样放入（扩成 128 位），`token()` 的 Unix 输出不变；Windows 的 `token()` 第三段是十进制的 128 位整数。真实 ReFS 与 Dev Drive 上的取值由 M6 最终验收的 W-20 步骤 3 记录。
- **错误模型（0.4.0 M6，m6-077 起）。** 后端错误码以 `contracts/error-codes.json` 为唯一来源，Rust 侧由 `error_codes::ErrorCode` 枚举表示，`AppError::coded` 与 `coded_with_params` 只接受枚举，`AppError::msg` 已删除。无法归类的内部失败用 `AppError::internal`（错误码 `app.internal`，前端显示通用文案，原消息只写日志）。面向用户的失败用 `domain_errors.rs` 的 `PtyError`、`FileError`、`LifecycleError` 三个 thiserror 领域错误构造，每个变体给出错误码与参数；`From<io::Error>` 按 `ErrorKind` 映射（`NotFound`→`file.not_found`，`PermissionDenied`→`file.permission_denied`，`TimedOut`→`blocking.timeout`，其余→`app.internal`），`From<anyhow::Error>` 先还原错误链中的领域错误，再回退到 `app.internal`。旧码 `app.error` 作为 `app.internal` 的别名保留。前端以结构化的 `AppErrorState`（码、参数、消息、可选包装键）保存错误，渲染时才格式化，语言切换后同一状态会重新渲染。
- **CSP。** `src-tauri/tauri.conf.json` 配置生产 `csp`（`default-src 'self'`、`script-src 'self'`、`worker-src 'self' blob:`、`img-src 'self' data: blob:` 等）与开发 `devCsp`（仅多出 `'unsafe-eval'` 与本地开发服务器来源）；Monaco worker、字体与图片预览依赖 `worker-src blob:`、`data:`。生产与开发策略由 Rust（`production_csp_matches_exact_directive_contract`）与 TypeScript（`csp.contract.test.ts`）两端精确断言，含 `object-src`、`base-uri`、`form-action` 三个 `'none'` 指令（见“安全边界”中的 m6-066 条目）；三平台生产包的实际表现尚待实机验证（S1B-N07，M6 实机清单 W-15/M-15/L-15）。M7 渲染 Markdown HTML 前必须先完成隔离边界改造（见“已知限制与待收口项”）。
- **契约清单与契约测试。** `contracts/tool-keys.json`、`app-commands.json`、`window-kinds.json`、`content-kinds.json` 是跨 Rust/TypeScript/SQL/capability 的名字集合清单：`build.rs` 从 `app-commands.json` 生成 `AppManifest`，`src-tauri/src/contracts.rs` 与 `src/lib/contracts.test.ts` 做双端比对。已知漏检：`generate_handler!` 为文本解析，注释掉的条目会被计为已注册；Rust 枚举新增变体而未同步手写 `ALL` 时检测不到；错误码与事件名的清单已在 `contracts/error-codes.json`、`contracts/events.json` 冻结（m6-033，双端扫描测试）；DTO 字段形状仍没有契约（S1D-N07、S3J-A05、S3J-A16）。
- **三平台 CI。** `.github/workflows/ci.yml` 在 Windows、macOS、Ubuntu 上运行前端测试、前端构建、`cargo fmt --check`、`cargo check`、`cargo test`（`fail-fast: false`），发布工作流通过 `workflow_call` 复用。差距：并发组 `ci-${{ github.ref }}` 在被发布工作流调用时可能误取消（S1D-N10）；未输出各平台测试执行清单，平台专属测试能否被静默跳过没有守卫；Windows ARM64、Linux ARM64、macOS Intel 目标尚未在 CI 运行测试。

## 主题偏好与跨窗口同步

主题偏好与界面语言是设备本地 UI 状态：主题存放在前端状态持久化（localStorage）中，语言同样存放在 localStorage，二者都不进入业务 SQLite 或配置交换；同源窗口启动时直接读取 localStorage，因此它也是一条隐式的跨窗口通道。主窗口通过版本化的 `app-preferences` 频道（`src/lib/appPreferences*.ts`，载荷 `{ apiVersion: 1, theme, language }`）广播偏好变化；终端与内容两类独立窗口在注册监听后经 `app-preferences-requested`（载荷含自报的 `windowLabel`）向主窗口请求当前偏好，主窗口只回复通过 `isDetachedWindowLabel` 判定的窗口 label（由 `contracts/window-kinds.json` 派生，覆盖 `terminal-*` 与 `workspace-content-*`）。接收方只用 `applyRemoteThemeMode`/`applyRemoteAppLanguage` 更新内存状态与 DOM，不回写 localStorage、不再次广播。语言切换同步 `lang`/`dir`（阿拉伯语为 RTL），并由主窗口通过 `set_tray_menu_labels` 把已翻译的托盘文案推给 Rust；托盘文案在主窗口前端加载完成前固定为中文初值。
`useThemeSync` 是已解析主题的唯一产出方：它把偏好（`"system"` 或已注册主题 id）解析为 `ResolvedTheme { id, base }` 写入 store（`useResolvedTheme()`/`subscribeResolvedTheme()` 供 xterm、Monaco、Sonner 等消费，不再各自观察 `data-theme`），同时写入 `data-theme` 与 `color-scheme`，并调用 `getCurrentWindow().setTheme(...)` 同步原生窗口外观（三类 capability 均已显式授予 `core:window:allow-set-theme`；失败只以 `console.warn("[window.theme_sync_failed]")` 暴露）。主题注册表为 `src/lib/themes.ts`（`THEMES`，内建 `light`/`dark`），主题语义色集中在 `src/styles.css` 并有 token 完整性测试；xterm 使用终端专属 CSS token，CLI 品牌、终端 ANSI 与执行日志配色仍是明确例外。**终端始终深色，作为主题例外（已确认 PD-07，2026-10-06）：** `--color-terminal-*` 在浅色与深色两个 token 块中取值相同（`src/styles.css` 88–90 行与 172–174 行），`PtyTerminal` 虽经 `useResolvedTheme()` 订阅已解析主题、并在主题变化时重新读取 token 写入 `terminal.options.theme`（`PtyTerminal.tsx` 约 356 行），但读到的值不变，没有可见效果（它已不再观察 `data-theme`）；该订阅待清理，或保留为将来提供浅色终端时的扩展点，登记在 G4 文档的例外清单中。**待收口：** `setTheme` 当前传入主题 id 而不是 `base`，新增 id 非 `light`/`dark` 的主题时原生调用会失败（S1B-N08）；`appStore` 初始化时存在第二处解析（S3H-A16）；`labelKey`、`monacoTheme` 仍是封闭联合类型；业务 effect 依赖翻译函数 `t` 的问题（语言切换触发运行期 rehydrate）见“已知限制与待收口项”与项目规则 R-FE-1。

工作区中的 xterm 会话注册与 portal 由 `WorkspacePtySessionRegistry` 承载；`PtyWorkspace` 只做组装，布局、焦点与项目上下文由宿主 store 和命令执行器持有，跨窗口交接协调位于 `src/workspace/windows/`。终端运行辅助（fit 尺寸边界、PTY 事件消费、剪贴板空文本分类和 WebView2 可见 renderer 恢复）集中在 `ptyTerminalRuntime`，PTY 创建和会话权威仍由 Rust service 持有。纵向长内容使用 `ThemedScrollArea` 的覆盖式滚动条：沿用项目列表的主题色、静止隐藏、滚动显现和拖动滑块行为，不占内容宽度；其他原生溢出区共享全局细轨和主题色，xterm 保留自己的终端滚动规范。

```text
projects
  └── pty_sessions (session_id, project_id, tool_key, cwd, title, cli_conversation_id?, state)

workspace_state (M3, 单条当前布局记录)
  ├── versioned pane tree (pane/split IDs, pane number, slot_instance_id, pty_session_id?, project/tool/title snapshot, orientation, size_ratio, focus)
  └── detachedContents[] (PTY slot / 文件内容引用，当前由独立窗口持有；schema v5，v3 的 detachedSlotIds 已迁移)

workspace_layout_presets (M3, 多条命名快照)
  └── versioned pane tree (独立快照，不拥有 PTY)
```

以上为目标概念模型；具体 JSON DTO 和 SQL 字段由 M3 阶段 0 设计确认。M2 实现运行期工作区布局；M3 验收 SQLite schema、数据迁移、自动保存、命名快照、活跃 PTY 合并与失效引用策略。当前布局和命名快照都属于 SQLite 业务数据，包含在 SQLite 一致性备份中；JSON 配置 bundle 不导出也不覆盖这两类布局数据。

**布局版本现状与已知缺口（待收口）：** `WORKSPACE_LAYOUT_SCHEMA_VERSION` 当前为 5（`models/workspace_layout.rs`）。版本同时存在于 payload 的 `schemaVersion` 与表列 `workspace_state.schema_version` 两处：读取时 Rust 只在内存中把旧版本迁移到 v5，不回写数据库；保存时 `workspace_layout_repo::save_current` 却要求数据库列等于当前版本，否则返回 `saved:false`，前端保存队列（`workspaceLayoutPersistence.ts`）对 `saved:false` 立即重新入队。0.3.0 发布时布局版本为 1，因此从 0.3.0 升级且已有布局行的用户，布局改动会一直保存失败且前端持续重试（S3J-A01，待修，门禁 A 层）。`reset_current` 对可读布局拒绝重置，用户无法自行恢复。

## 0.2.x 外部终端启动（历史，已删除）

0.2.4 通过 Windows Terminal/PowerShell/CMD、macOS Terminal.app/iTerm2/Ghostty/WezTerm/kitty、Linux `xdg-terminal-exec`/`x-terminal-emulator`/Ghostty/kitty/WezTerm/xterm 等外部终端启动 CLI。该启动链已在 0.4.0 M6 期间（提交 `318a821`）整体删除：`platform/terminal.rs`、`platform/terminal_launch.rs`、`platform/macos_launch_artifacts.rs`、`commands/terminal.rs`、`commands/launch.rs`，以及 `launch_tool`、`preview_launch`、`resume_session`、终端环境探测与 `launch_target` 读写等 Tauri 命令均已移除（命令集合以 `contracts/app-commands.json` 为准）。0.3.0 起工作台的普通 CLI 启动与历史恢复统一使用内置 PTY：`create_pty_session`（`commands/pty_session.rs`）校验项目目录，经 `launch_service` 解析完整路径与恢复参数，再由 `PtySessionManager` 创建 PTY；界面不提供外部启动选项或命令预览，PTY 启动失败时直接显示错误。内置 PTY 启动不得退化为临时拼接命令字符串。

删除后遗留的数据库对象已在 0.4.0 M6 的迁移 0015_legacy_cleanup（m6-078）中清理：application_settings.launch_target 行、shell_profiles 与 directory_tool_args 两张表、tools.display_name 与 tools.executable 列、directories.last_used_at 列均已删除（PD-05）；tools 表保留为 ToolKey 外键注册表（列只有 id 与 key）；配置 bundle 的 shell_profiles 字段只读不写，导入 v1 至 v3 旧 bundle 时继续容忍并忽略这些旧字段（配置包版本保持 4）。本文“0.2.x 外部终端启动组合”一节保留 0.2.4 的历史设计供迁移与考古参考，不描述当前行为。

## 全局 CLI 状态

应用启动时通过 CLI 适配器检测当前已接入的工具；G2 完成后范围为五项 CLI。进入设置页和手动刷新时，前端为每项 CLI 分别查询安装状态、当前版本与更新状态；单项查询的等待或失败不阻塞其余行。查询前先载入执行任务状态；某 CLI 存在安装/更新任务时暂停该 CLI 的最新版本查询、取消并忽略在途结果，且不展示缓存的最新版本。任务结束后仅强制刷新对应 CLI，并在刷新完成前显示过渡状态。当前版本、更新状态、缓存来源和本次错误使用统一状态模型（DTO 中没有“最后成功检查时间”字段；缓存时间戳只在 Rust 缓存层使用），具体命令与输出语义由适配器提供。更新状态与托管更新资格当前由后端 `LatestVersion` 的 `updateAvailability` 与 `managedUpdate`（`allowed`/`denied { reasonKey }`/`notApplicable`）表达；前端适配器元数据 `latestStatusKind`（仅 Hermes 为 `branch-update`）与 Rust `version_service` 的映射并存两份（S3J-A15），Grok/Hermes 版本查询失败时后端会报成 `denied` 而不是未知或 `notApplicable`（S1C-N07），且 `managedUpdate.denied.reasonKey` 因 serde 缺少 `rename_all_fields` 实际以 `reason_key` 序列化，前端读取 `reasonKey` 得到 undefined（S3J-A03，待修）。以上均待收口。

```text
cli_status
  claude:  { status, path, version, latest_version, resolved_command }
  codex:   { status, path, version, latest_version, resolved_command }
  agy:     { status, path, version, latest_version, resolved_command }
  grok:    { status, path, version, latest_version, resolved_command }
  hermes:  { status, path, version, latest_version, resolved_command }
```

状态有三种：available（绿色，可启动可编辑）、missing（灰色，确认未安装）和 unknown（中性提示、禁用启动）。适配器检测异常、超时或崩溃时只将对应 CLI 标为 unknown，不把探测失败误报成未安装，也不阻塞其他 CLI。由于启动一律走解析出的完整路径，"PATH 是否可见"不再单独建模——在 PATH 或已知目录找到全路径即为 available。详见 `docs/ui-design.md`。

## Tauri commands 清单

Tauri command 名称和窗口 capability 授权以 `contracts/app-commands.json` 为人工维护的契约清单；Rust 测试 `app_command_contract_matches_the_registered_handler` 校验清单与实际 handler 注册一致，`window_kind_contract_matches_capabilities` 校验窗口类别与 capability 对应关系。此处不复制易过期的命令名列表。IPC 入口保持小而清晰，业务组合放在 services。

## 桌面集成

- 系统托盘：核心 `tray-icon` 能力，左右键单击均可打开包含"显示主界面/退出"的菜单；左键双击切换主窗口的隐藏/显示状态，显示时取消最小化并聚焦窗口。
- 关闭窗口行为：设置页可选"最小化到托盘"或"退出应用"，默认关闭到托盘；策略持久化到 SQLite，Rust 窗口事件直接执行该策略。
- 0.3.0 生命周期：关闭到托盘不退出应用，PTY 保持运行；关闭行为设为退出或从托盘菜单显式退出时，活动 PTY 与未保存的文件缓冲必须经过确认（见下文“应用退出门与恢复门”），确认后终止托管进程树，取消则不退出；macOS 系统级退出入口与执行任务当前不在该保护范围内。异常退出/系统重启后不接管旧进程；启动时将持久化活动记录标记为已结束并从当前工作区移除对应会话项，保留窗格和分栏，不恢复终端输出或滚屏。项目或会话身份失效时仍显示局部诊断占位项。
- 窗口状态持久化：`tauri-plugin-window-state` 在 Rust 层自动保存/恢复窗口尺寸与位置，并排除可见性状态，避免关闭到托盘导致下次启动隐藏。插件恢复后，启动校正按与窗口重叠最大的显示器工作区约束窗口；完全离屏时回退主显示器，再回退第一台可用显示器。校正保留显示器可容纳的窗口最小尺寸，并在小屏上降低最小值；最大化和全屏状态交由系统恢复。
- 自定义窗口标题栏（G3）：主工作区和独立 PTY 窗口由 React 绘制统一标题栏；Windows/Linux 显式关闭系统装饰并由前端提供窗口控件、拖动和需要时的缩放命中区，macOS 保留原生窗口装饰与红黄绿交通灯，使用原生 overlay 标题栏隐藏系统标题文字并显示应用操作。动态独立窗口必须显式采用同一平台策略；标题栏关闭/返回操作复用现有 Rust 窗口关闭拦截和 PTY 交接状态机，不新增 PTY 所有权路径。
- 窗口控件边界：React 只调用 Tauri 窗口 API，不以隐藏视图模拟系统窗口状态；主窗口 close 仍经过托盘/退出确认和活动 PTY 保护，独立窗口 close 仍先交还运行中 PTY 或清理已结束会话。标题栏窗口拖动区域与独立会话 HTML 拖放区域必须互斥。
- 文件对话框：`tauri-plugin-dialog` 用于添加目录的文件夹选择器、配置导入导出的文件选择（capability 放行 `dialog:allow-open` / `dialog:allow-save`）。
- 单实例：`tauri-plugin-single-instance` 阻止多个 GUI 进程并行写入同一业务数据库，二次启动改为聚焦现有主窗口。
- macOS 生命周期：用户点击 Dock 图标重新激活应用时处理 `RunEvent::Reopen`，显示、取消最小化并聚焦主窗口；菜单栏状态项沿用“显示主界面/退出”入口，不依赖 Windows 双击语义。

### 应用退出门与恢复门（现状）

- **退出门。** 退出请求进入 `lib.rs` 的 `handle_run_event`（`RunEvent::ExitRequested`）：`AppExitGate`（`services/app_lifecycle.rs`，一次性布尔授权）已授权则放行并消费授权；否则只要主窗口存在就 `prevent_exit`、显示主窗口并向主窗口发出 `app-exit-requested { requestId, ptyCount, executionTaskCount }`（无论 PTY 数是多少，因为未保存文件只有前端知道）；主窗口不存在且有活动 PTY 时永久阻止退出（没有任何界面能确认，S3H-A14）；主窗口不存在且无 PTY 时直接退出。主窗口关闭行为设为“退出”和托盘“退出”都经 `app.exit(0)` 进入同一入口。
- **前端预检。** `App.tsx` 用全局 `listen` 接收事件，调用宿主 `collectExitImpacts(ptyCount)` 汇总影响：PTY 数取自事件载荷；脏文件取自主窗口 buffer 与分离到独立窗口的文件镜像，向这些窗口请求 flush（`workspaceFileExitFlush.ts`，500 ms 内无应答按脏处理）。无影响则直接调用 `confirm_app_exit`，否则弹出统一确认对话框。`confirm_app_exit`（`commands/pty_session.rs`）为 async，终止前先取得 `AppLifecycle` 的 `Exit` 许可（阶段进入 `Exiting`，拒绝新的启动与数据替换；终止失败时许可析构、阶段回到 `Running`）：在阻塞线程中 `terminate_all` 结束全部托管 PTY，授权退出门，再 `app.exit(0)`。
- **退出请求一致性（R-EXIT-1，044 确定）。** 每次进入 `PreventAndAskMain` 都由 `AppExitGate::begin_request` 生成新的 requestId，同一时刻只保留最新一个待决请求；`app-exit-requested` 载荷携带该 requestId。`confirm_app_exit` 必须回传 requestId：没有待决请求返回 `exit.no_pending_request`，id 与待决请求不一致返回 `exit.request_mismatch`，两者都不终止任何 PTY；只有校验通过且终止成功，才授权退出门。退出授权 5 秒后过期，且只能消费一次。前端对话框只确认自身展示的那次请求（`AppExitRequest.requestId`），不读取最新收到的 id；新请求到达时先收起旧对话框，待新请求的影响收集完成后再展示。因此屏幕上的内容、被确认的请求与后端待决请求始终一致；被取代的旧请求确认时，后端以 `exit.request_mismatch` 拒绝；前端对过期的失败不显示任何内容，也不覆盖当前对话框，只解除自身的“终止中”状态。新请求到达时“终止中”同样被解除，新对话框的确认按钮可用。已知限制：若旧确认已进入终止阶段（PTY 已被结束）而新请求此时到达，旧确认会因 requestId 不一致而不授权退出，其错误被丢弃，由用户对新对话框重新确认（台账 K44-10）。主窗口已不存在而仍有 PTY 会话时，没有地方可以询问，`decide_exit_request` 仍返回 `PreventWithoutMain`；但用户明确发起的退出（托盘“退出”、macOS 应用菜单 Quit）经 `quit_plan` 判定为 `ForceQuit`，先 `AppExitGate::authorize` 再 `app.exit(0)`，由退出清理终止全部会话（F13）。
- **已知差距（待收口，见“已知限制与待收口项”）：** `confirm_app_exit` 已核对 requestId（R-EXIT-1）；子窗口已不再有 `core:event:allow-emit-to` 权限（m6-062），退出请求通知经主窗口私有收件箱（m6-061）；S3H-A02 的剩余部分由 m6-101 处理；伪造请求无法通过 requestId 校验，不能使应用退出，只可能弹出对话框、收起当前对话框或显示错误提示（经 `setExitRequest(null)` 的收起同样可被伪造，属同一剩余风险）；`ptyCount` 等界面文案仍由前端直接采信；退出影响不统计正在运行的执行任务（安装/更新），退出会直接中断它们（S3H-A13）；macOS 的 Cmd+Q 等系统退出入口不产生可阻止的 `ExitRequested`，直接绕过退出门（S1C-N01）；静默退出路径中 `confirm_app_exit` 失败后对话框按钮会保持禁用（S1A-N03）。
- **恢复门。** `restore_backup`（`commands/backup.rs`，async 并在阻塞线程执行）先经 `AppLifecycle` 取得 `DataReplace(RestoreBackup)` 许可（在取得数据库锁之前；存在已登记 PTY 会话返回 `pty_sessions_active`，会话正在启动返回 `pty_session_starting`，有活动执行任务返回 `app.data_replace_blocked`；许可存活期间新的 PTY 启动与执行任务启动被拒绝为 `backup_restore_in_progress`），数据库恢复成功后读取关闭行为，再清理 `sessions:`、`workspace-file-index:` 缓存与会话搜索索引，向主窗口发出 `workspace-data-restored`；主窗口 `WorkspaceDataRestoreListener` 触发工作区 rehydrate，前端在恢复前冻结自动保存并 flush（`workspaceRestorePolicy.ts`）。恢复请求被拒绝或在替换数据库之前失败时，前端只调用 `resumeAfterFailedRestore` 解除持久化冻结，并立即保存冻结期间的变更；不重新加载工作区，以免清掉恢复检查之后启动的运行中 PTY。已接受的残余：替换数据库之后，命令层仍可能因 blocking 任务 panic（`JoinError`）或关闭行为状态锁中毒返回 Err，此时前端同样只解除冻结而不 rehydrate；回滚本身失败时数据库可能处于未知状态，同样未单独编码。这些路径均未在宿主或 Rust 测试中构造。**差距：** 数据库替换成功后，缓存清理与通知失败只记录日志、不再使命令失败；前端在 restored 事件送达前保持冻结，若通知本身失败，前端保持冻结直到重启（023 已接受的已知限制）。恢复与导入会被活动执行任务阻止（`app.data_replace_blocked`），但不撤销内容窗口授权（S3I-A04，剩余部分由 m6-058 完成）。
- **恢复代次（m6-088 已落地）。** `RestoreGeneration`（`services/session_service.rs`，托管状态，内部是共享的 `AtomicU64`）在 `restore_with_runtime_invalidation`（`services/backup_service.rs`）里数据库恢复成功之后、仍持有数据库锁时递增，备份不存在或`AppLifecycle` 准入被拒（在途启动或活动会话）等数据库未被替换的失败不递增，缓存清理失败时仍然递增；`refresh_session_search_index`（`commands/session.rs`）在读取项目路径的同一个数据库闭包内取得代次，写缓存只经 `session_service::write_search_index_if_current`，它在调用方持有的缓存锁内比较代次，不一致返回 `Discarded`，命令转成错误并由前端恢复成功后的 `invalidateQueries()` 重新发起刷新。因此恢复前开始的索引刷新不会把旧数据库的索引写回缓存（N7、J1）。**配置导入（B1920 D2）：** `import_with` 在导入成功后同样递增代次（回滚不递增），在途索引刷新被丢弃，前端导入成功后让 `sessionSearchIndex` 查询重新执行。**其余差距：** `after_data_replaced` 统一钩子未做，递增位置待 `AppLifecycle` 完整版迁入；缓存清理两级都失败时恢复前已写入的索引不会被清除（只写 `cache_warning` 日志）。

## 本地存储根目录

业务数据使用稳定且与 Tauri 打包身份解耦的用户目录：

```text
~/.cli-launchpad/
├─ data/       cli-launchpad.db（事实数据）
├─ cache/      后续可重建缓存
├─ logs/       后续诊断日志
└─ backups/    后续一致性恢复点
```

应用启动时若新数据库不存在而旧
`%APPDATA%\dev.local.cli-launchpad\cli-launchpad.db` 存在，则复制到新
`data/` 目录；旧文件不自动删除。数据库迁移通过 SQLite 一致性备份 API
读取旧库，而非复制活动数据库文件。数据库连接启用外键、忙等待与 WAL，
并在打开既有数据库时运行 `quick_check`，拒绝高于当前应用支持版本的
schema，避免在损坏或未来版本数据库上继续写入。

窗口状态由官方插件保存在 Tauri 配置目录。由于插件不公开自定义根目录
能力，应用更换稳定 `identifier` 时仅迁移其 `.window-state.json`，不将
该运行时文件混入业务数据库目录。

关闭窗口策略属于应用行为配置，保存在业务库 `application_settings` 中，
并包含在版本化 JSON 配置导入导出中。配置导入或数据库恢复完成后，Rust
运行时同步刷新当前策略，保证本次进程内的关闭行为与持久化数据一致。

## 数据备份与恢复

`backups/` 保存 SQLite 一致性恢复点，不等同于面向迁移的 JSON 配置导出：

```text
~/.cli-launchpad/backups/
├─ database/    cli-launchpad-<timestamp>-<reason>.db
└─ manifests/   cli-launchpad-<timestamp>-<reason>.json
```

备份使用 SQLite Online Backup API 生成，支持手动创建，并在配置导入、
数据库 schema 迁移和恢复覆盖前自动创建保护恢复点。恢复时先校验备份
完整性，拒绝来自更新 schema 的文件；恢复较旧 schema 后重新执行当前
migrations。恢复期间所选源恢复点不参与剪枝，后处理失败会回写恢复前
保护点。manifest 仅接受应用生成的文件名。自动备份保留最近 10 个，手动恢复点保留最近 5 个。

## 日志与诊断

应用使用官方日志插件将脱敏后的运行事件写入
`~/.cli-launchpad/logs/cli-launchpad.log`，覆盖启动、数据库初始化、
备份恢复、CLI 检测、安装更新和配置导入导出。日志不写入工具参数、
命令正文、会话标题或安装原始输出。日志单文件限制为 2 MiB，并最多
保留 10 个应用日志文件。

设置页提供诊断导出，JSON 报告包含应用版本、平台、存储根目录、数据库
schema 版本与日志内容，用于本地排障。

## 配置交换与启动历史

可移植 JSON 配置 bundle 不再导出全局或项目级 CLI 参数；导入旧版 bundle 时忽略这些兼容字段。配置导入不接受 Shell 程序或初始化脚本。导入目录必须是绝对路径，存在的目录会规范化为稳定身份。配置导出不包含日志、缓存、备份、窗口位置、自动保存的当前工作区、命名布局快照或外部 CLI 会话正文；配置导入也不覆盖工作区布局。SQLite 备份包含当前工作区和命名布局。SQLite 中 0.2.x 遗留的参数字段与记录（directory_tool_args、shell_profiles、application_settings.launch_target 等）已由迁移 0015_legacy_cleanup 删除；从 schema 8 或更高版本的数据库与旧备份恢复时，迁移会在恢复后补跑，遗留对象随之清理；配置导出不再写出 shellProfiles 键，导入仍容忍旧字段。

`launch_history` 记录目录名与启动时路径快照、工具、启动或恢复动作、成功状态、
错误类别和成功创建的工作台 PTY Session ID，不持久化最终命令或参数文本。
内置 PTY 启动与恢复由共享 PTY service 统一记录（旧版外部终端启动链已删除）；
历史写入失败不影响会话生命周期。历史保留上限默认 100 条，
用户可选 50、100、200 或 500 条；新增记录及降低上限时立即裁剪更早记录。
添加目录和实际发起启动时，Rust 服务层均验证项目路径存在且为目录，失效路径会保留配置并返回修正提示。

## 可删除缓存

缓存数据库固定为 `~/.cli-launchpad/cache/cache.db`，与业务数据库隔离。
缓存内容包括 CLI 状态短期快照、官方最新版本查询结果、动态模型目录和本地会话搜索索引。
搜索索引按项目 ID 保存各 CLI 实际展示标题、摘要及受限的首条用户消息或 preview，并建立
SQLite FTS5 trigram 索引；不保存项目路径或完整对话正文。查询只访问缓存数据库，1–2 个字符
使用短词回退。用户手动设置的稀疏会话别名仍属于业务配置，单独保存在 `session_aliases`，
搜索时与索引结果合并。索引在项目激活或用户手动刷新时从 CLI 本地 metadata 有界重建；来源
失败时保留该来源上次成功的索引并标记结果不完整。删除或损坏缓存库后索引自动重建；清除缓存
会同时清除搜索索引。CLI 状态使用 30 秒 TTL，最新版本使用 30 分钟
TTL；过期后重新检测路径时，仅在可执行路径未变化的情况下保留上次主动
探测到的当前版本；目录删除、配置导入和数据库恢复会清除旧版本遗留的
会话缓存；手动刷新强制绕过缓存并执行有界 `--version` 探测。网络查询失败时可回退到已
存在的最新版本缓存。删除或损坏缓存库后应用自动重建；持久缓存不可用时
退化为当前进程的内存缓存，不阻断业务数据库和恢复功能启动。实际启动仍
实时解析工具路径，不以缓存决定执行目标。

## 打包与运行依赖

- 公共配置位于 `src-tauri/tauri.conf.json`，平台 target 通过 Tauri 标准平台配置自动合并。
- Windows 配置位于 `src-tauri/tauri.windows.conf.json`，只生成 NSIS，避免 WiX 依赖；构建同时产出 NSIS 安装包与裸 exe。
- **VC++ 运行库**：`src-tauri/.cargo/config.toml` 用 `+crt-static` 静态链接 MSVC CRT，目标机无需安装 Visual C++ Redistributable。
- **WebView2 两种策略**：
  - 在线版（默认 `downloadBootstrapper`）：安装包小，安装时按需联网下载。
  - 离线版（`src-tauri/tauri.offline.conf.json` 覆盖 `webviewInstallMode=offlineInstaller`）：内嵌完整 WebView2，离线可装。
- 多版本命名：`scripts/build-installers.ps1` 依次构建在线/离线两版，复用 Tauri 产物名的 `{productName}_{version}_{arch}` 前缀并追加 `online`/`offline`（架构自动继承），归档到 `dist-installers/`。标准维度（版本/架构/格式）由 Tauri 自动命名，非标准维度（WebView2 模式）由脚本补名。
- macOS 配置位于 `src-tauri/tauri.macos.conf.json`，只生成 DMG。Apple Silicon 与 Intel 分别使用 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` target 独立编译与测试，不生成 Universal 包。
- `.github/workflows/release.yml` 以 `v*.*.*` Tag 作为正式发布入口，先校验 `package.json`、Tauri 配置和 Cargo 包版本，再并行构建 Windows x64/ARM64 在线/离线 NSIS（ARM64 使用原生 Windows ARM64 Runner）、Linux x64/arm64（deb+rpm+AppImage，arm64 用原生 ARM64 Runner）、macOS ARM64 DMG 和 macOS Intel DMG。只有全部 target 成功后才汇总产物、生成 `SHA256SUMS.txt` 并自动创建 GitHub Release；手动触发仅产生短期 Actions Artifacts。发布资产统一使用 `CLI.Launchpad_<版本>_<系统>_<架构>[后缀]` 命名，不沿用各打包工具（尤其是 rpm）的原生命名格式。
- macOS 线上构建当前使用 ad hoc 签名，不依赖仓库 Secret，也不执行 Apple 公证。后续购买 Developer ID 后，可在保持矩阵与产物汇总结构不变的前提下补充证书导入、公证和 stapling 步骤。
- UI 内置 Noto Sans SC 的 100–900 可变 TTF，并采用 400、500、600、700 四个主要字重；命令、路径、参数和日志内置 Maple Mono NL NF-CN v7.9 的相同四个静态字重。两套字体通过 Vite 前端产物进入各平台安装包，不依赖系统字体安装，并在关于页内置各自的 SIL OFL 1.1 文本。

## 目标 CLI 范围

0.3.0 G1 完成后支持四个核心 CLI；G2 完成后扩展为五个：

| 工具             | 默认命令 | 兼容命令      | 说明                                               |
| ---------------- | -------- | ------------- | -------------------------------------------------- |
| Claude Code CLI  | `claude` | 无            | 打开 Claude Code 工作会话                          |
| Codex CLI        | `codex`  | 无            | 打开 Codex CLI 工作会话                            |
| Antigravity CLI  | `agy`    | `antigravity` | `agy` 是官方主命令，`antigravity` 仅作保守兼容探测 |
| Grok Build CLI   | `grok`   | 无            | 官方 Grok Build 交互式 CLI                         |
| Hermes Agent CLI | `hermes` | 无            | G2 接入的本地交互式 Hermes CLI；窗口简称 `HA`      |

其他 CLI 工具不进入当前检测、安装或启动设计。M1/M2 文档记录的是后续独立 CLI 接入前的阶段验收事实；G1 完成后当前能力为四 CLI，G2 完成后以五 CLI 为准。

## 0.2.x 外部终端启动组合（历史设计，已于 0.4.0 M6 删除）

> **本节只记录 0.2.4 的历史设计，不描述当前行为。** 下列终端探测、`launch target`、Windows Terminal Profile、macOS `.command` 载荷与 Linux 终端回退逻辑对应的代码（`platform/terminal.rs`、`platform/terminal_launch.rs`、`platform/macos_launch_artifacts.rs`、`commands/terminal.rs`、`commands/launch.rs`）已全部删除，当前 CLI 只通过内置 PTY 启动，见上文“0.2.x 外部终端启动（历史，已删除）”。保留本节仅为迁移 0.2.x 数据、理解旧文档和审查旧安全设计时参考。

启动输入按以下顺序组合：

```text
launch target（auto / platform terminal host / Windows Terminal Profile / direct shell）
+ selected directory
+ resolved full path of shell / terminal
+ resolved full path of tool（候选命令解析，agy 优先于 antigravity）
+ CLI 默认启动参数（不读取 0.2.x 遗留自定义参数）
```

其中 launch target 使用跨平台稳定 ID：Windows 保留现有 `wt:*` 与
`direct:*`；macOS 使用 `macos:terminal`、`macos:iterm2`、
`macos:ghostty`、`macos:wezterm` 与 `macos:kitty`；Linux 使用
`linux:xdg-terminal-exec`、`linux:x-terminal-emulator`、`linux:ghostty`、
`linux:kitty`、`linux:wezterm` 与 `linux:xterm`。终端环境响应包含
`platform`、平台中立的 host 列表、Windows 专属 Profile 信息、Shell 信息、
推荐目标和告警。旧数据库中的其他
平台显式目标不会被执行，而是作为当前平台不可用目标进入自动回退。

**执行边界**：工具在启动或版本探测前解析为完整路径；普通启动使用 CLI 默认行为，会话恢复只附加该 CLI 所需的内部恢复参数；安装计划在用户确认前解析实际目标，并按该目标执行。终端与 Shell 由平台探测结果生成结构化候选，所有参数只在最终 Shell 边界编码。

**Windows 启动策略**：

```text
自动推荐
  → Windows Terminal 默认 Profile
      A. Profile 原生命令追加（支持 appendCommandLine）
      B. PowerShell Profile 命令续接
      C. 保留 Profile 外观，替换为受控 Shell 命令
  → PowerShell 7 独立窗口
  → Windows PowerShell 独立窗口
  → CMD 独立窗口
```

Windows Terminal Stable、Preview、Canary 和非打包版本分别探测；读取其 `settings.json` 后解析默认 Profile、Profile 名称、命令行和来源。用户也可在设置中指定某个 Profile 或直接 Shell。显式目标启动失败时仍按安全候选继续回退，保证至少存在一种可用方式。

PowerShell 命令使用 UTF-16LE Base64 传递受控脚本，避免参数被 Windows Terminal 或 PowerShell 再次拆分。CMD 兜底不直接拼接不可信字符串，而是通过固定系统 PowerShell 解码同一受控载荷。PowerShell 脚本包含目录切换和结构化调用：

```powershell
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=...
Set-Location -LiteralPath '<directory>'
& '<tool-full-path>' <args>
```

**macOS 启动策略**：

```text
自动推荐
  → Terminal.app（系统内置，默认）
显式选择
  → Terminal.app / iTerm2（一次性、自删除的 .command 文档）
  → Ghostty（AppleScript 原生窗口 + 安全命令输入）
  → WezTerm / kitty（应用包内原生 CLI 参数）
显式目标不可用或启动失败
  → Terminal.app
  → 返回可操作错误，不在 GUI 进程中静默运行 CLI
```

macOS 不使用 Terminal.app 或 iTerm2 的 AppleScript `do script`，避免触发
跨应用自动化权限。Ghostty 使用其官方 AppleScript 字典创建原生窗口，并将
经过 POSIX 引用的完整命令作为 `osascript` argv 传入后，通过 `input text` 与
`send key` 输入目标终端。自动模式固定选择系统 Terminal.app，不因安装第三方
终端而改变；第三方终端仅在用户显式选择时使用。

启动服务先在 `~/.cli-launchpad/cache/launch/` 原子创建权限为 `0700` 的临时
`.command` 文件，供 Terminal.app 与 iTerm2 通过 LaunchServices 按已验证的
Bundle ID 打开。载荷只包含应用生成的固定控制流程和经过 POSIX 单引号规则
编码的目录、完整工具路径与参数，执行开始即删除自身，CLI 退出后回到用户
登录 Shell。WezTerm 与 kitty 直接使用包内 CLI 的结构化参数，其中 kitty 使用
`--hold` 保留命令退出后的窗口。应用启动时清理超过限定时长的残留载荷，启动
失败也主动清理本次文件。所有平台的终端启动子进程都会移除调用方继承的
`NO_COLOR`、`TERM`、`COLORTERM`、`CI` 与强制配色变量，让目标终端建立自己的
交互环境；这也避免 Windows 开发版或从非交互终端启动的安装版把无颜色环境
继续传给 Windows Terminal、PowerShell 和目标 CLI。Windows 启动边界还会从
注册环境读取 Machine PATH 与 User PATH，将当前进程缺失的条目补入子终端 PATH，
避免开发沙箱或隔离父进程隐藏用户级工具入口；该过程不修改注册表或系统环境。

**Linux 启动策略**：

```text
自动推荐
  → xdg-terminal-exec（委托桌面环境配置的默认终端）
  → x-terminal-emulator（Debian alternatives，找不到 xdg-terminal-exec 时）
显式选择
  → Ghostty / kitty / WezTerm（应用包内官方 CLI 结构化参数，与 macOS 分支复用同一套参数格式）
  → x-terminal-emulator / xterm（-e 参数 + 内联 shell 脚本）
显式目标不可用或启动失败
  → 按检测顺序回退到下一个候选终端
```

Linux 不复刻 macOS 的一次性 `.command` 载荷机制：`xdg-terminal-exec` 原生接受
`--dir` 与结构化 argv；Ghostty/kitty/WezTerm 同 macOS 一样接受官方 CLI 参数
（Ghostty 用 `--working-directory` + `--wait-after-command=true` + `-e`）；
`x-terminal-emulator`/xterm 没有工作目录标志，退化为 `-e bash -c '<脚本>'`
内联执行，脚本本身用 POSIX 单引号规则编码目录与参数，命令结束后 `exec bash
-li` 回到交互 Shell，不落地任何临时文件。既有目标 CLI 的官方安装脚本
（claude.ai、chatgpt.com/codex、antigravity.google）本身按 `uname -s` 识别
Linux/macOS，因此 Linux 安装计划直接复用 macOS 分支的脚本 URL 与解释器。

终端探测先检查 `/Applications` 与 `~/Applications` 中的标准应用路径，再使用
`/usr/bin/mdfind` 按 Bundle ID 查找被用户移动的应用。所有候选必须读取
`Info.plist` 复核 Bundle ID；需要直接启动的终端还要验证应用包内可执行文件，
探测过程不执行候选应用。

0.2.4 的恢复会话通过 `resume_session` 命令（已删除）按工具拼装恢复参数后复用同一组合逻辑；当前的恢复参数见下文“会话历史读取”。

## CLI 适配器与生命周期

按 `ToolKey` 注册 CLI 适配器，将五项 CLI 的产品差异收敛到一套稳定合约。适配器负责提供 CLI 专属定义和数据转换；公共层负责并发、缓存、持久化、PTY/窗口生命周期、统一检索及安全边界：

```text
CLI Adapter Registry (ToolKey)
  product/presentation definition: name, short label, icon
  management: detect, current version, update status, install/update plan
  runtime: launch arguments, resume arguments, supported capabilities
  history: source discovery, ownership validation, DTO normalization
        |
        v
Shared Services
  query lifecycle / per-tool cache / stale fallback
  project validation / PTY lifecycle / workspace and independent windows
  session indexing / search / deduplication / alias merge
        |
        v
Platform primitives and persistent execution task manager
  OS process, path, PTY and filesystem operations
  structured command execution / per-tool task slot / logs / cancellation
```

- 管理能力由适配器声明命令候选、CLI 专属已知安装目录、安装来源、当前版本探测与解析、更新检查与比较语义，以及固定结构化安装/更新计划。Grok 安装来源校验、Hermes 官方更新语义、Codex Windows PowerShell 5.1 安装和更新封装均保留为对应 CLI 差异。
- 启动参数由各 CLI 的 `resume_args` 和 PTY 创建组合逻辑生成；`CliAdapter` 通过 `descriptor()` 声明能力（见下一条），并以 `requires_executable_path()` 声明是否需要解析可执行文件（决定公共层是否在预算内解析可执行文件），项目目录归属校验、PTY 创建/尺寸/退出、会话窗口与独立窗口状态机仍由公共服务管理。关闭、移动窗格或应用布局不得由适配器创建或复制 PTY。
- **Provider 描述与能力契约（m6-068 已落地）：** `CliAdapter::descriptor()` 返回 `ProviderDescriptor`（`history`、`resume`、`update_semantics`（`Version` 或 `Branch`）、`managed_update`（`Always` 或 `SourceVerified { denied_reason_key }`）、`install_effects_key`），没有默认实现，新增 Provider 必须声明；`contracts/tool-capabilities.json` 与各适配器的描述逐项相等（Rust 契约测试），前端经 `src/lib/toolCapabilities.ts` 直接读取该契约，不再自有 `latestStatusKind`。托管更新状态由适配器的策略决定：`managed_update(source_verified)` 在没有来源验证证据时等同拒绝，`managed_update_after_failed_query()` 在版本查询失败时对需要验证的 Provider 返回 `notApplicable`（不再报成“来源被拒”），合并旧缓存时恢复旧的托管状态。`InstallPlan.effects` 仍是未使用的字段（由 m6-107 删除）。
- **可执行文件解析与启动环境统一（m6-069 已落地）：** 检测、安装计划、启动解析与 PTY 子进程使用同一个 `platform::launch_environment::LaunchEnvironment`（进程 PATH，Windows 上合并注册表中的机器与用户 PATH）和同一个 `platform::executable_resolver`（`resolve` 异步带预算，`resolve_blocking` 只在阻塞线程里调用；Windows 的 `where.exe` 只在这里调用，并使用 `LaunchEnvironment` 的 PATH）。适配器版本查询的超时与 panic 隔离由 `services::cli_runtime::run` 在外层统一执行一次，适配器内部的 `blocking_latest` 不再自己加超时。更新计划使用 `AdapterContext::resolved_path`（`claude_update_plan_for`、`antigravity_update_plan_for`、Codex 与 Grok、Hermes 同形），构造计划上下文时总是解析可执行文件；Antigravity 的更新只接受主命令 `agy`。适配器专属测试位于各自的 `history.rs`、`version.rs`，适配器内部函数不再因测试放宽可见性。仍未收口：共享工具下沉到 `cli_adapters/support/`、`models`、`db` 对 `services` 的反向依赖、会话读取与归属校验的预算统一（S3I-A17、S3I-A19 部分关闭）。
- **契约外层格式与窗口角色（m6-070 已落地）：** `contracts/` 下的清单统一为 `{ "formatVersion": 1, "items": [...] }`（`content-kinds.json` 只含 `formatVersion` 与 `items`（顶层 `adapterApiVersion` 已由 m6-072 迁入 `api-versions.json`），`error-codes.json` 额外保留顶层 `frontendCodes`、`reservedCodes`、`aliases`）；`rust-platform-tests.json`、`window-label-fixtures.json`、`serde-lint-allowlist.json` 与 `fixtures/` 不是清单，在两端的格式测试里以豁免表登记，新增任何 `contracts/*.json` 都必须归类。`window-kinds.json` 的每个窗口类别声明角色：`primary`（唯一主窗口）、`ptyHost`（可显示 PTY 视图）、`ownsPty`（销毁时归还 PTY 会话）、`fileGrant`（持有文件授权）、`contentKinds`（可渲染的内容 kind）；`content-kinds.json` 的每项声明 `windowKind` 与 `dragAllowed`。Rust 经 `WindowKind::is_primary/is_pty_host/owns_pty/has_file_grant` 读取（`services/` 的生产代码不再按窗口类别变体分支，PTY 交接方向由 `ptyHost` 与 `primary` 推出），前端经 `windowRoleOf`、`windowKindOfContent`、`isDraggableContentKind`、`registeredContentKinds` 与 `MAIN_WINDOW_LABEL` 读取；拖放来源窗口、窗口 label 前缀、adapter 注册白名单、`App` 路由（`route`）不再有手写副本。`"main"` 字面量有增长上限（前端 55 处；Rust 生产代码 0 处，纯测试文件不计）。`contracts/window-chrome.json` 统一 macOS 交通灯位置与标题栏 inset：`windowChrome.ts` 的 inset 与原生控件判定读它，子窗口工厂经 `getChildWindowChromeOptions` 在 macOS 上传 `trafficLightPosition`，`tauri.macos.conf.json` 由两端契约测试核对；内容 kind 的 Rust 枚举副本（`workspace_layout.rs`）与前端联合类型仍是手写，依赖编译期覆盖与契约测试。
- **DTO 与事件载荷的 golden fixture、`AppCommand` 类型（m6-071 已落地）：** 每个 Tauri 命令的返回 DTO 都在 `src-tauri/src/contracts/fixtures.rs` 的 `ipc_dto_samples()` 里登记并生成 `contracts/fixtures/*.json`（`UPDATE_CONTRACT_FIXTURES=1 cargo test golden_fixtures` 重新生成，CI 校验无变化）；自动完整性测试 `every_command_return_dto_has_a_golden_fixture` 按命令签名的返回类型（`CommandDef.return_type`）保证新增命令返回的新 DTO 必须登记样本。前端 `src/lib/dtoShapes.contract.test.ts` 用 `keysOf<T>()` 在编译期要求键清单覆盖 TypeScript 类型的全部键，并在运行期断言它等于 Rust 序列化的键集合。事件载荷（`workspace-content-window-lost`、`pty-session-owner-lost`）与收件箱消息 `InboxMessage` 有 fixture，`events.json` 的每个事件都映射到载荷 fixture 或登记为无 Rust 载荷。`scripts/gen-contracts.mjs` 从 `contracts/app-commands.json` 生成 `src/generated/appCommands.ts`（`AppCommand`），`invokeApp` 是前端调用命令的唯一入口（`tauri.ts` 里不再有裸 `invoke`，`appCommands.contract.test.ts` 只豁免 `invokeApp.ts`），CI 校验生成物无变化。布局共享样例 `contracts/fixtures/layouts/{valid,invalid}` 由 Rust 生成，Rust 与 TypeScript 的布局校验对同一批文件给出同样的结论。命令的参数键仍不受静态约束；ts-rs 等代码生成不在本阶段范围。
- **版本化规则与线协议版本不匹配处理（m6-072 已落地）：** 版本规则 R1 至 R5 与登记表见“版本化规则与版本号登记表”小节，`src/lib/versionRegistry.contract.test.ts` 扫描 Rust 与 TypeScript 的版本常量保证登记完整；扩展点 API 版本来自 `contracts/api-versions.json`（三个扩展点注册表在运行时读取）；线协议收到版本不一致的信封时，`onWindowMessage` 打 `[protocol.version_mismatch]` 警告，并对 `workspace-file-window-init`、`workspace-file-window-return-requested`、`pty-return-requested` 向发送方回送对应的失败消息（`src/lib/windowProtocolVersion.ts` 的 `VERSION_MISMATCH_REPLIES`），同一 `seq` 只处理一次；偏好协议的版本不一致只告警；字段名统一为 `protocolVersion` 仍未实施。
- **业务 effect 不依赖翻译函数的 AST 守护（m6-073 已落地）：** `src/test/effectTranslationScan.ts` 用 TypeScript compiler API 扫描 `src/` 生产代码：对每个 `useEffect`/`useLayoutEffect`/`useInsertionEffect` 计算依赖闭包（含经 `useCallback`/`useMemo` 的间接依赖），凡引用由 `useTranslation()` 解构出的翻译标识符（`t`、`i18n` 别名）即违规；唯一豁免是语句前带 `// R-FE-1:language-sync` 注释、依赖数组含 `*.resolvedLanguage` 且无其他翻译标识符的语言同步 effect。存量违规登记在 `src/lib/effectTranslationBaseline.json`（只减不增，键不含行号；m6-b24-cleanup-C2 起已清空，新增违规一律直接修复），测试 `src/lib/effectTranslationDependencies.contract.test.ts` 同时要求新增代码无违规、基线条目仍然违规。同名遮蔽按“标识符到持有翻译函数的函数”之间的作用域路径判断（函数参数与 `var`、块级 `let`/`const`、`for` 头、`catch` 变量，m6-b24-cleanup-C3），块内遮蔽不会让块外的真实引用漏报。已知局限：只识别 `useTranslation()` 解构，不跟踪 props 传入或自定义 hook 返回的 `t`，不分析非 hook 函数里的间接引用。
- **适配器调用隔离、引擎按记录释放、主题单一解析与命令授权并入主契约（m6-074 已落地）：** `presentWorkspaceContent` 与 `workspaceContentProjectContext` 经 `src/lib/safeAdapterCall.ts` 调用适配器，抛错时降级为与“未注册适配器”相同的占位或 `null` 并按“标签加消息”只记录一次 `[workspace.adapter_call_failed]`；`WorkspaceEditorSurface` 记录文档实际使用的编辑器引擎，文件适配器的 `dispose` 通过 `releaseEditorDocument` 释放记录的引擎，没有记录时回退默认引擎；已解析主题只由 `src/lib/themes.ts` 的 `resolveCurrentTheme` 产出（`appStore` 初始状态与 `useThemeSync` 共用）；应用命名布局时活动布局分离区里的 `Unknown` 内容原样保留（`preserve_detached_unknown_contents`）；命令授权规则并入 `contracts/app-commands.json`（每项 `{ name, callerCheck, kinds? }`，按 `name` 排序），`build.rs`、Rust 与前端测试都读取这一个文件。未完成：引擎使用记录只在 `dispose` 时清理（文件适配器的主题注入已由 m6-107 完成）。
- **扩展点收尾（m6-107 已落地）：** `InstallPlan` 不再有 `effects` 字段（安装效果提示只由前端适配器的 `installEffects` 与 descriptor 的 `install_effects_key` 提供）；旧前端载荷里的 `"effects"` 键被 serde 忽略（`InstallPlan` 不带 `deny_unknown_fields`）；golden fixture 样本合并为单一样本 `install`，`contracts/fixtures/install-plan.json` 由 Rust 测试重新生成。设置页分支型更新使用通用的 `settings.branchUpdate*` 文案（不写死分支名，十个 locale 同步）；`InstallEffectsNotice` 的 `headingKey`、`effectKeys` 使用由 `en` 推导的 `LocaleKey` 类型（`src/i18n/localeKeys.ts`），写错键在 `tsc` 阶段失败。内容适配器渲染上下文携带宿主注入的 `theme`（`WorkspaceContentView` 从 `useResolvedTheme()` 取得，必填字段），`workspaceContentAdapters/` 目录下不得读取全局主题，由测试 `themeInjection` 守护。
- 历史适配器只负责定位各 CLI 的本地事实来源、读取所需 metadata、校验项目归属并映射到规范会话 DTO。公共历史服务、SQLite FTS 索引和搜索负责统一分页、查询、别名合并和去重，去重键为 `ToolKey + session_id`；适配器不各自建立检索引擎，也不把完整 transcript 或项目路径写入搜索缓存。
- 适配器上下文由 `cli_adapters::context_within_budget` 构造：只有声明 `requires_executable_path()` 的适配器（Codex、Grok、Hermes）才在 `spawn_blocking` 内解析可执行文件，解析与适配器调用共享同一预算，解析耗尽即该工具超时且适配器不被调用，解析 panic 视为未找到。会话列表、索引刷新与归属校验通过 `session_service::*_with` 入口注入解析器；会话列表与归属校验各有 30 秒预算，索引刷新中任一工具的失败、超时、panic 或标识不符只让该工具变为不完整，`home_dir()` 不可用时整批降级为不完整。`build_plan` 的同步解析对所有适配器执行（更新计划总是需要可执行文件），并要求在阻塞线程中调用。
- CLI 图标与名称属于展示能力，存放在前端适配器/注册表中，并使用与 Rust 相同的 `ToolKey`；不把 React 资源塞进 Rust CLI 适配器。公共 UI 负责选择展示，不复制各 CLI 的交互状态逻辑。
- Rust 适配器按 CLI 组织公共实现与平台实现：`<cli>/common.rs` 放稳定的命令候选、命令语义、解析、参数和数据转换；`<cli>/platform.rs` 放安装/更新等平台命令计划，并通过平台条件分支覆盖确有操作系统差异的实现。只有平台差异需要独立维护时再拆成 `platform/{windows,macos,linux}`。共享路径解析、进程执行、PTY 和文件访问能力优先留在公共 platform primitives；不为每种 CLI 和每个平台复制一份无差异实现。
- 适配器合约为可选能力提供安全默认值：未接入历史时返回显式错误、未配置安装/更新时明确报错、未配置状态查询时返回未知并附错误；一个适配器能力缺失不得阻塞其他 CLI 或主应用启动。接入新 CLI 时按阶段替换默认能力，不要求一次实现全部模块。
- 公共协调器按 CLI 独立执行状态查询；路径探测、当前版本和更新状态查询可并行，单项慢响应或失败不得阻塞其他 CLI。前端查询 Hook 使用每 CLI 的缓存键与状态，支持设置页自动刷新、手动强制刷新和任务完成后的定向回读。
- 统一查询结果包含安装状态与路径、当前版本及探测错误、更新状态、最新版本或提交差异、缓存来源与最近一次查询错误；`CliStatus` DTO 没有最后成功检查时间字段。Hermes 等非语义版本工具通过适配器映射到同一更新状态模型。
- Rust 持久缓存只保存成功的更新探测结果；失败时可一并返回最后成功数据与本次错误，但不得刷新成功缓存时间。没有可用历史结果时返回未知状态和错误，不推断为已是最新。
- 适配器只生成受信任的结构化命令计划和受限执行准备信息，不接收任意命令或用户拼接参数。公共平台执行器负责进程启动、超时、输出通道和参数边界；环境修改仅在受控执行时临时应用，不持久化环境变量或密钥。
- 安装/更新确认后仍进入现有 Rust `ExecutionTaskManager`。任务按 `ToolKey` 分槽：同一 CLI 同时最多运行一个任务，不同 CLI 可并行；管理器继续负责状态、日志、取消、平台进程树及 SQLite 历史，适配器不另建任务生命周期。
- 适配器只服务产品范围内的五项 CLI，不是通用 CLI 自动发现或插件机制。新增 CLI 必须在固定 `ToolKey`、适配器和前端展示注册表中登记，不扩展为任意用户命令入口。
- 每个 CLI 的可选能力都采用失败关闭、按工具隔离的兜底：缺少实现时返回结构化未知/不支持结果；panic、任务 JoinError、单个 SQLite 数据源损坏或超时均转为该工具或该数据源的错误，不向主状态协调器传播 panic，不取消其他 CLI 的并行任务。历史来源失败保留该来源最后成功的可重建索引并标记不完整；状态查询失败保留最后成功缓存并附加本次错误，且不得刷新成功时间。
- 当前五项工具分别由 Rust `cli_adapters/{claude,codex,antigravity,grok,hermes}` 适配器与前端 `src/lib/cliAdapters/` 展示注册表提供专属行为。注册表按 `ToolKey` 做穷尽匹配；增加工具必须同时覆盖 Rust/TypeScript 类型、固定顺序、图标与名称注册，避免运行时缺项。操作系统差异留在平台模块；适配器不得拥有应用、PTY、窗格、独立窗口、索引或执行任务的生命周期。

## CLI 检测与安装

CLI 检测区分三种状态（启动走全路径，不再区分 PATH 可见性）：

- available：在当前 PATH 或已知安装目录解析到完整路径（含 `agy` → `antigravity` 兼容探测）。
- missing：未找到。
- unknown：检测适配器发生异常或不能可靠判断；仅禁用对应 CLI，不影响其他 CLI。

安装能力不做自动静默执行。UI 必须先展示将要执行的安装命令、来源、权限影响和预计结果，由用户确认后再执行。

Windows 默认安装后端优先级：

1. 官方安装方式或官方包管理建议。
2. `winget`。
3. 仅当某个目标 CLI 的官方安装方式明确要求时，才使用对应的补充安装通道。

当前官方安装来源：

- Claude Code：`winget install --id Anthropic.ClaudeCode --exact` 或官方 PowerShell 安装脚本。
- Codex：Windows 官方 PowerShell 独立安装器，npm 作为备选安装方式。
- Antigravity：`irm https://antigravity.google/cli/install.ps1 | iex`。
- Grok Build：官方 Windows PowerShell 安装器 `https://x.ai/cli/install.ps1`，固定 stable 通道；安装前明确展示其会写入用户级 PATH 和 Grok CLI 配置。默认安装目录为当前用户目录下的 `.grok/bin`，同时尊重 `GROK_BIN_DIR`。
- Hermes Agent：Windows CLI 官方源码安装器 `https://hermes-agent.nousresearch.com/install.ps1`；默认 CLI 入口为 `%LOCALAPPDATA%\hermes\bin\`，源码与用户数据位于 `%LOCALAPPDATA%\hermes\`。G2 只管理经核实的官方源码安装，确认前展示运行时、依赖、数据目录及安装器副作用；MSIX/Store 更新由所属渠道负责。

macOS 使用官方原生安装脚本：

- Claude Code：`curl -fsSL https://claude.ai/install.sh | bash`。
- Codex：`curl -fsSL https://chatgpt.com/codex/install.sh | sh`。
- Antigravity：`curl -fsSL https://antigravity.google/cli/install.sh | bash`。
- Grok Build：`curl -fsSL https://x.ai/cli/install.sh | bash`（macOS/Linux 实机对齐仍属于 M5）。

这些管道字符串是内置清单中的固定常量，只允许由对应工具的安装计划生成，
不拼接用户输入；执行程序固定解析为系统 `/bin/bash` 或 `/bin/sh`，参数数组
固定使用 `-c` 和对应常量。UI 必须展示完整脚本来源和网络脚本风险。更新仍
执行已解析完整路径上的 `claude update`、`codex update`、`agy update` 或 `grok update`。Grok 安装来源无法确认时禁用应用内自动更新，并提供官方手动说明。

安装命令必须用结构化参数建模，例如：

```text
program: winget
args: ["install", "--id", "...", "--exact", "--accept-package-agreements", "--accept-source-agreements"]
```

避免在业务层拼接自由字符串。

安装通道只服务 `claude`、`codex`、`agy`、`grok`、`hermes` 五个目标 CLI，不扩展为通用包管理或通用 CLI 安装器。

## 版本检测与更新

设置页提供最新版本查询与应用内更新入口。为避免应用启动时执行 PATH
中的第三方程序，被动检测不自动调用 CLI 的 `--version`；只有用户显式
点击重新检测或安装/更新完成后的刷新才会对已解析的完整路径执行有界版本
探测。版本命令固定为 `--version`，并以超时、无窗口方式捕获输出。
Claude 版本探测设置 `DISABLE_AUTOUPDATER=1`，避免查询当前版本时触发 CLI
自身后台更新；原生版本化安装则按被探测二进制所在目录恢复安装所属的 `HOME`
与 `XDG_DATA_HOME`。

```text
最新版本
  Claude：downloads.claude.ai 原生发布 latest 端点
  Codex：releases.openai.com Codex latest channel
  Antigravity：官方安装器使用的平台 manifest
  Grok Build：进入设置页或用户手动刷新版本时独立运行官方 `grok update --check --json`，解析 `latestVersion` 和 `installer`，不触发更新；启动子进程时移除 pnpm 注入的 `npm_config_user_agent`，避免把官方原生安装误判为 npm 安装；Windows 官方 stable 二进制地址不作为版本号 API。
  Hermes Agent：进入设置页或手动刷新时，对已识别的官方源码安装独立运行一次 `hermes update --check`，使用 CLI 默认更新目标并按落后提交数显示状态，不做语义版本比较；浅克隆可能只有“有更新”而没有精确提交数。检查不应用代码、不安装依赖或重启 Gateway，但会获取 Git 更新 metadata。仅根据已解析的完整可执行路径及默认源码 checkout 目录判定托管资格，不再串行运行 `--install-id` 与 `--plan`。读取 `hermes --version` 时使用临时 `HERMES_HOME` 禁用默认的被动更新网络检查，不更改用户配置。MSIX/Store 状态由所属更新渠道提供。

更新命令（结构化参数，先预览后确认）
  Claude：claude update
  Codex：codex update
  Antigravity：agy update
  Grok Build：`grok update`（计划依据已解析的可执行路径生成，计划阶段不运行检查；任务创建后后台任务先运行官方 `grok update --check --json` 复核，只校验 JSON 的 `installer` 精确为 `internal`，校验通过才执行，不再限制可执行文件必须位于 `.grok/bin` 或 `GROK_BIN_DIR`——实现：`grok/common.rs` 的 `validate_execution`、`grok/version.rs`；更新子进程移除 pnpm 注入的 `npm_config_user_agent`。文档曾写“还要求路径位于 `.grok/bin` 或 `GROK_BIN_DIR`”，与代码矛盾，已按代码事实改正，G1 与 tooling 文档同步；是否重新引入路径校验已确认（PD-04，2026-10-06）：保留现行代码行为，文档统一到代码事实）
  Hermes Agent：解析到的 Hermes CLI 完整路径加 `update` 参数（确认浮窗展示完整路径；默认分支、安装渠道及更新过程交由 Hermes CLI 处理，不指定分支或确认参数）。任务创建后、更新进程启动前，后台会调用 `hermes/common.rs` 的 `validate_execution` → `version::validate_managed_install`，复核该可执行文件仍是受管的官方源码安装（Windows/POSIX 默认 bin 与源码 checkout 位置），复核失败任务直接失败；计划阶段不重复读取更新计划
```

更新与安装走同一流程：预览命令、用户确认、输出日志、完成后主动探测当前
版本并刷新全局 CLI 状态。当前版本和最新版本查询分别返回失败原因；网络
查询失败时可使用已有缓存，不阻塞安装状态与路径展示。
Claude 原生更新子进程使用目标版本化二进制所属的用户目录，而不是开发版应用
隔离用的临时 `HOME`；退出码为 0 后还要复探同一可执行路径，只有版本确实改变
才报告更新成功。

## 执行任务与日志

安装和更新由 Rust 执行任务管理器统一调度，不在前端确认浮层或 React 组件中直接管理子进程：

```text
Settings / Execution View
  -> Tauri command（创建、查询、终止、清理）
  -> ExecutionTaskManager（按 CLI 互斥、跨 CLI 并行、状态机、进程句柄）
  -> platform process runner（Windows Job Object / Unix process group）
  -> SQLite execution_tasks / execution_task_logs
  -> Tauri events（状态与 stdout/stderr 日志增量）
```

任务状态机为 `preparing -> running -> succeeded | failed`。用户终止时进入
`cancelling -> cancelled`；超时进入 `timed_out`。应用启动时将数据库中遗留的
`preparing`、`running`、`cancelling` 任务统一标记为 `interrupted`，避免把已不存在的
进程继续显示为运行中。

Windows 执行器将任务子进程加入独立 Job Object；终止时关闭整个作业进程树，
防止 PowerShell、包管理器或自更新器留下子进程。该行为是强制终止而不是向
终端发送字面 `Ctrl+C`，UI 统一使用“终止任务”并提示更新中断风险。

macOS 执行器在 spawn 前把任务命令放入新的 Unix process group。终止或超时
时先向整个进程组发送 `SIGTERM`，经过有界宽限期仍未退出时发送 `SIGKILL`，
随后回收根子进程与输出管道。非 Windows 平台不得继续使用空实现，否则取消
任务会在 `child.wait()` 上无限等待。

任务创建时只接受内置五工具清单生成的 `InstallPlan`，持久化工具、类型、来源、
程序、参数数组和预览，不保存环境变量或自由命令。任务管理器按 `ToolKey` 保存
活动任务：同一 CLI 内互斥，五个 CLI 之间可并行；每项任务持有独立取消信号和
平台进程树。日志按序号分别记录 `stdout`、`stderr`、`system`，通过 Tauri event 实时
增量下发，同时写入 SQLite。每个任务日志上限 1 MiB，达到上限后写入截断标记；
默认保留最近 50 个任务，裁剪时级联删除日志。执行中任务不可被历史清理。

前端按 `toolKey` 独立维护命令计划、确认浮层、创建状态和错误。任务进入终态后，
对应 CLI 进入短生命周期的版本回读状态；该状态结束前压住旧版本数据计算出的
更新标签和操作按钮，其他 CLI 不受影响。任务终态通过右上角 Toast 提示，完整
状态与日志仍以“执行任务”视图和 SQLite 记录为准。

## 会话历史读取

会话历史按需读取各 CLI 的本地事实来源：

```text
Claude Code  ~/.claude/projects/<slug>/sessions-index.json + <uuid>.jsonl
Codex        App Server thread/list，失败时回退 ~/.codex/sessions/**/rollout-*.jsonl
Antigravity  ~/.gemini/antigravity-cli/conversation_summaries.db + conversation metadata
Grok Build   ~/.grok/sessions/**/summary.json（目录受 GROK_HOME 配置影响）
Hermes Agent %LOCALAPPDATA%\hermes\state.db（HERMES_HOME 可覆盖；每个 Profile 独立数据库）
```

读取逻辑放在 service，解析出原始标题、时间、session id，并严格匹配当前项目目录或
workspace URI。Claude 标题优先级为 `summary`、`firstPrompt`、首条用户消息；Codex 为
`name`、`preview`、首条用户消息；Antigravity 为数据库 `title`、metadata `summary`、
数据库 `preview`；Grok 仅从 summary metadata 取标题/摘要和 `cwd` 等归属字段，不读取
`updates.jsonl` 或 transcript。Hermes 遵循当前有效 home/Profile 解析结果，只读一个 `state.db` 的元数据，过滤
`source=cli`，按 `git_repo_root`/`cwd` 匹配项目；只提取长度受限的列表预览，不读取其他来源、Profile 或全文 FTS。
读取故障会明确返回错误而不是伪装为空列表；恢复或修改别名前会再次验证 session 仍归属于当前目录。

Codex 的 App Server 读取使用短生命周期的 `codex app-server --stdio` 进程，由 `ProcessTree` 管理（Windows 为 Job，Unix 为进程组）；进程由 `spawn_supervised` 启动（见“子进程创建与受监督原语”），`Supervised` 在请求正常结束、出错或外层超时丢弃 future 时终止整棵进程树，覆盖 `.cmd` shim 外壳与脚本派生的后台进程；子进程在运行任何代码之前已属于进程树（m6-060a 消除了 spawn 与 attach 之间的窗口；`services/execution_service.rs` 的流式任务仍是先 spawn 后 attach，不在该原语范围内）。

路径身份比较遵守平台语义：Windows 规范化分隔符并忽略大小写；macOS 对存在
路径优先使用 `canonicalize` 后比较，不将路径统一转为小写，对暂时不存在的路径
只做 POSIX 分隔符与尾部分隔符的词法规范化。CLI 状态缓存中的可执行路径比较
使用同一规则，避免大小写敏感卷上的错误复用。

列表默认每页 10 条，Claude、Antigravity 与 Grok 使用有界 offset cursor，Codex 透传并封装
App Server cursor。前端为每个 CLI 保留独立无限查询，点击“更多”按 10 条追加。项目级
搜索读取可重建的 cache DB 索引，只匹配五个 CLI 实际展示的标题、summary 和受限首条用户消息/preview，
不扫描完整正文；不调用 `grok sessions search`（官方定义的结果可能混合本地索引和远端会话），也不查询 Hermes 全文 FTS。项目激活或手动刷新时
有界更新索引，FTS5 trigram 支持子串查询，1–2 个字符使用短词回退；每次查询最多返回 2,000 条匹配结果。
前端只在内存中保留当前查询快照，并按 10 条递增显示。清除查询或切换项目时释放该快照；缓存索引按项目 ID
隔离，不持久保存项目路径或完整对话正文。超过结果上限或来源读取不完整时，响应列出受影响的 CLI。

用户手动重命名时才向 `session_aliases` 写入 `tool_key + session_id + alias`；普通会话不会
批量入库。列表读取到真实会话后才合并匹配别名，因此孤立记录不会生成虚假会话。删除别名
即恢复 CLI 原始标题。

恢复会话通过 `create_pty_session` 命令的 `resume_session_id` 参数进入内置 PTY（不再有独立的 `resume_session` 命令）：命令先按工具校验会话 ID 格式并复核该会话仍归属当前项目目录，再由各适配器的 `resume_args` 拼装内部恢复参数——Claude 用 `--resume <id>`，Codex 用 `resume <id>`，Antigravity 用 `--conversation=<id>`，Grok Build 用 `--resume <id>`，Hermes Agent 用 `--resume <id> --no-restore-cwd`。恢复参数与普通启动共用 `launch_service` 的参数组合，以结构化数组传给 PTY 进程。会话 ID 校验的公共规则为 `safe_session_id`（字符集 `[A-Za-z0-9_-]`、最长 200、拒绝前导 `-`），注册表层 `valid_session_id` 再次拒绝前导 `-`；Grok 强制 UUID，Claude/Codex 目前未强制规范 UUID（B1-F05 部分关闭；已确认 PD-08：Claude/Codex 仅接受规范小写 UUID，待落地）。

## 版本化规则与版本号登记表

版本号只有四类，各有各的含义，不得混用：`schemaVersion`（持久化数据）、`apiVersion`（进程内扩展契约）、`protocolVersion`（线协议）、`formatVersion`（契约清单格式）。改动某个格式的 PR 负责递增对应版本，并在同一提交里更新下面的登记表；`src/lib/versionRegistry.contract.test.ts` 扫描代码里的版本常量并核对登记表。

- **R1 持久化数据用 `schemaVersion`。** 版本只存一处（payload）；数据库列若保留，只是只读镜像，CAS 只比较 `revision`。迁移链只在 Rust 一处实现，TypeScript 只断言版本等于当前值。读到旧版本时迁移并在同一事务内回写；读到更新的版本时进入 `needsReset` 并保留原始数据；写入方永远写当前版本。
- **R2 进程内扩展契约用 `apiVersion`。** 每个注册表声明 `supportedApiVersions`，取值来自 `contracts/api-versions.json`，源码里不写字面量；版本不符只拒绝这一项贡献并记录日志，不中断整个启动；只有破坏性改动才递增。
- **R3 线协议用 `protocolVersion`。** 同一构建内要求精确匹配；不匹配时必须打 `console.warn` 并回送失败消息（有失败对应物的请求回送，其余只告警），不能静默丢弃。已知例外：线协议的字段名当前仍是信封里的 `apiVersion` 与 `contracts/window-messages.json` 里的 `payloadVersion`，R3 要求的统一结构 `{ protocol, protocolVersion }` 尚未实施（改名会同时改动 Rust relay、20 个消息、拖放载荷与全部相关测试，另开目标）。
- **R4 契约清单用 `formatVersion`。** 外层固定为 `{ "formatVersion": 1, "items": [...] }`（顶层额外键只允许格式测试里登记的白名单）；`formatVersion` 只在格式变化时递增，与内容增减无关；扩展点 API 版本集中在 `contracts/api-versions.json`。
- **R5 版本号登记表与扫描测试。** 下表是全部版本号的登记处；新增版本常量必须先登记，否则扫描测试失败；增加数据库迁移时同一提交更新“数据库 user_version”一行。

<!-- version-registry:start -->

| 名字                       | 类别            | 当前值     | 来源                                                                                   | 谁递增、何时递增                                                      | 遇到更新版本时              |
| -------------------------- | --------------- | ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| 布局 schemaVersion（Rust） | schemaVersion   | 5          | `rs:src-tauri/src/models/workspace_layout.rs:WORKSPACE_LAYOUT_SCHEMA_VERSION`          | 布局 JSON 有不兼容变化时，由改动该格式的 PR 递增并增加 Rust 迁移步骤  | 进入 needsReset，保留原数据 |
| 布局 schemaVersion（前端） | schemaVersion   | 5          | `ts:src/lib/workspaceLayoutPersistence.ts:WORKSPACE_LAYOUT_SCHEMA_VERSION`             | 与 Rust 常量同一提交递增，值必须相等                                  | 抛错，不迁移                |
| 配置交换格式               | schemaVersion   | 4          | `rs:src-tauri/src/models/config_bundle.rs:CONFIG_BUNDLE_VERSION`                       | 导出格式有不兼容变化时                                                | 拒绝导入                    |
| 数据库 user_version        | schemaVersion   | 15         | `migrations:src-tauri/migrations`                                                      | 新增迁移文件时（编号等于新版本）                                      | 拒绝启动                    |
| 备份清单 schemaVersion     | schemaVersion   | 15         | `same-as:数据库 user_version`                                                          | 等于数据库版本，不单独递增                                            | 拒绝恢复                    |
| Provider 描述              | apiVersion      | 1          | `rs:src-tauri/src/services/cli_adapters/descriptor.rs:PROVIDER_DESCRIPTOR_API_VERSION` | ProviderDescriptor 字段有破坏性变化时                                 | 契约测试失败                |
| Provider 描述（契约）      | apiVersion      | 1          | `json:contracts/api-versions.json:providerDescriptor`                                  | 与 Rust 常量同一提交递增                                              | 契约测试失败                |
| 内容 adapter               | apiVersion      | 3          | `json:contracts/api-versions.json:workspaceContentAdapter`                             | adapter 接口有破坏性变化时                                            | 拒绝该项贡献并记录日志      |
| 编辑器引擎                 | apiVersion      | 1          | `json:contracts/api-versions.json:workspaceEditorEngine`                               | 引擎接口有破坏性变化时                                                | 拒绝该项贡献并记录日志      |
| 主题                       | apiVersion      | 1          | `json:contracts/api-versions.json:theme`                                               | 主题定义有破坏性变化时                                                | 拒绝该项贡献并记录日志      |
| 窗口消息协议               | protocolVersion | 1          | `ts:src/lib/windowMessages.ts:WINDOW_MESSAGE_API_VERSION`                              | 信封或载荷有不兼容变化时，同时更新契约                                | 告警并回送失败消息          |
| 窗口消息协议（契约）       | protocolVersion | 1          | `json:contracts/api-versions.json:windowMessage`                                       | 与前端常量同一提交递增，并同步 window-messages.json 的 payloadVersion | 告警并回送失败消息          |
| 偏好协议                   | protocolVersion | 1          | `ts:src/lib/appPreferences.ts:APP_PREFERENCES_API_VERSION`                             | 偏好载荷有不兼容变化时                                                | 告警并忽略                  |
| 偏好协议（契约）           | protocolVersion | 1          | `json:contracts/api-versions.json:appPreferences`                                      | 与前端常量同一提交递增                                                | 告警并忽略                  |
| 内容拖放载荷               | protocolVersion | 2          | `prefix:src/lib/workspaceContentDrag.ts:cli-launchpad-content-v2:`                     | 拖放载荷有不兼容变化时，前缀版本递增                                  | 解析返回 null               |
| 内容拖放载荷（契约）       | protocolVersion | 2          | `json:contracts/api-versions.json:workspaceContentDrag`                                | 与前缀同一提交递增                                                    | 契约测试失败                |
| 契约清单格式               | formatVersion   | 1          | `json:contracts/tool-keys.json:formatVersion`                                          | 清单外层格式变化时                                                    | 格式测试失败                |
| 应用版本                   | release         | 见三处文件 | `app:package.json,src-tauri/Cargo.toml,src-tauri/tauri.conf.json`                      | 发布时三处同时修改                                                    | 不适用                      |

<!-- version-registry:end -->

规则 R1 至 R5 与登记表按 m6-072 落地；已知例外只有 R3 的字段统一改名一项。

## 安全边界

- 目录路径来自用户输入，启动前必须验证：`create_pty_session` 校验项目目录存在且为目录，并复核项目路径快照。
- 内置 PTY 启动通过 `portable-pty` 的 `CommandBuilder` 传入完整可执行路径、参数数组和 `cwd`（`pty_session_service.rs`），工作目录与参数不经 Shell 拼接；不得为了启动 CLI 而生成 Shell 命令字符串。0.2.x 外部终端启动链中的 PowerShell `Set-Location -LiteralPath`、POSIX 单引号编码、`.command` 载荷等转义规则随该链路一起删除，仅在上文历史章节保留。
- 工具可执行文件和参数分开建模。
- 安装/更新等会执行平台命令的进程统一经 `platform/process.rs`（`cli_command` 与带超时、输出上限、进程树回收的 `run_bounded`）与任务管理器的 `platform/execution_process.rs` 启动；`platform/terminal*.rs` 已删除。
- CLI 安装与更新计划在用户确认前显示来源和命令，并带有计划指纹（`InstallPlan.fingerprint`），任务创建时后端重新生成计划并比对指纹，不一致返回 `plan_changed` 要求重新确认；0.3.0 起普通 CLI PTY 启动不展示命令预览。
- 跨窗口事件不是安全边界：Tauri 事件不携带经过验证的发送方，任何窗口都可用全局 `listen` 窃听，子窗口的 `emit-to` 权限可广播到任意目标；不得在事件载荷中传递应被保密的数据或把事件当作鉴权依据（待收口，见 M7 前必须完成的边界改造）。
- **Rust 通知走主窗口私有收件箱（m6-061 已落地，L1）：** Rust 发起的通知（退出请求、执行任务更新与日志、PTY 所有者丢失、内容窗口丢失、数据恢复完成）不再用 `emit_to`，而是由 `WindowInboxRegistry`（`services/window_inbox.rs`）写入主窗口通过 `subscribe_window_inbox` 提供的私有 `Channel`；订阅前的消息进入每窗口最多 256 条的有界缓冲，订阅时按序冲刷，缓冲溢出丢弃最旧并计数；发送在注册表锁之外进行。前端把冲刷出的消息交给已登记 handler 的事件；没有 handler 的事件，只有 `REPLAYABLE_RUST_EVENTS` 中的幂等事件（`app-exit-requested`、`workspace-data-restored`、`execution-task-updated`、`execution-task-log`）按事件名有界暂存（每个事件最多 64 条，超出丢弃最旧），在该事件的第一个 handler 登记时回放；`window-message`、`pty-session-owner-lost`、`workspace-content-window-lost` 等带时效或发送方语义的事件不暂存、直接丢弃。通道在 Rust 侧失效后没有自动重订阅（页面重载前通知只进缓冲），这是已知限制。其他窗口既不能订阅主窗口的收件箱，也无法用全局 `listen` 窃听这些通知。子窗口之间的消息与偏好请求已由 m6-062 迁移到 Rust 中继（见下一条）。
- **窗口之间的消息经 Rust 中继（m6-062 已落地，L2）：** `send_window_message(target, messageType, payload)`（`services/window_relay.rs`）按 `contracts/window-messages.json`（20 个消息类型，逐类型限定发送方类别与接收方类别、`contentKind`、`payloadVersion`）校验：类型已登记、调用方类别在 `from` 内、目标标签合法、目标类别在 `to` 内、信封是对象且 `type` 与 `apiVersion` 匹配；通过后写入目标窗口的私有收件箱，`source` 由 Rust 取自调用方的 `CallerWindow`，与载荷无关。目标没有收件箱（窗口不存在或未订阅的终端窗与文件窗）返回 `delivered: false` 且不缓冲，目标是主窗口且尚未订阅则缓冲。`subscribe_window_inbox` 放开给三类窗口（各自只能订阅自己的收件箱）。子窗口 capability 与 `contracts/window-kinds.json` 不再含 `core:event:allow-emit-to`（保留 `allow-listen`/`allow-unlisten` 以监听 `app-preferences` 公共广播）；前端非测试源码没有 `emitTo`，`emit` 只用于主窗口的 `app-preferences` 广播；旧事件 `workspace-content-window-event` 与 `app-preferences-requested` 已从契约删除。前端协议层 `workspaceContentWindowProtocol.ts` 的对外签名不变，内部改为 `sendWindowMessage`/`onWindowMessage`（`lib/windowMessages.ts`）：来自子窗口的消息，其自报 `windowLabel`（若有）必须等于 Rust 盖戳的发送方，否则丢弃；偏好请求只在 `windowLabel` 等于盖戳时才被应答，回复经中继发回该窗口。已知限制：契约只限定窗口类别，不限定具体哪个终端窗，PTY 交接的令牌与目标窗口的绑定已由 m6-063 完成（见下一条）；信封序列化后超过 16 MiB 返回 `window.message_too_large` 且不投递（B1920-19），没有速率限制；`delivered: false` 只记警告，不重试；泛型 `content-handoff-*` 事件未做（S3J-A09 仅做到白名单与分类）。
- **PTY 交接绑定目标窗口（m6-063 已落地）：** `begin_pty_handoff` 要求源窗口在创建目标窗口之前登记目标窗口标签，Rust 在 begin 时校验标签合法且方向合法（主窗口只能交给终端窗，终端窗只能交回主窗口），并把它保存为交接状态（`Paused`、`Staged`）里的 `reserved_target`；`complete_pty_handoff` 要求调用方窗口等于登记的目标（否则 `window.not_allowed`），目标等于源仍先被拒绝（`pty.handoff_target_is_source`）；被登记的目标窗口在 complete 之前被销毁时，待决交接被清除并恢复输出（`clear_for_reserved_target`）。令牌不再决定谁是目标，只用于关联同一次交接。命令调用方授权统一为 `CallerWindow::require` 已由 m6-064 完成（见下一条）。
- **命令调用方授权统一（m6-064 已落地）：** 授权分为 ACL 与运行时两层，规则写入 `contracts/app-commands.json`（每项 `name`、`callerCheck`、`kinds`，每个命令恰好一项）：依赖调用方身份的命令、以及被授予任何非主窗口类别的命令，必须在函数体第一条语句调用 `CallerWindow::require(&[WindowKind::…])`（命令入口用 `CallerWindow` 取代 `WebviewWindow`，非规范 label 在入口被 `window.label_invalid` 拒绝，类别不符返回 `window.not_allowed`）；高影响的主窗口命令（`confirm_app_exit`、`restore_backup`、`import_config_from_path`、`set_close_behavior`）同样声明 `require` 作为纵深防御；其余只授予主窗口且不读取调用方身份的命令声明 `acl-only`。Rust 测试按源码逐命令核对契约与 ACL，前端测试核对契约与 `window-kinds.json`；capability 的窗口 glob 与 label 前缀规则由契约测试保证一致。`subscribe_window_inbox` 与 `send_window_message` 接受全部三类窗口，所以不存在“类别不符被拒绝”的调用方，由契约测试断言它们的 `kinds` 等于全部窗口类别。未完成：数据替换（备份恢复、配置导入、删除项目）时不撤销内容窗口的文件授权（S3I-A13 的另一半）。
- **导航与新窗口拦截（m6-065 已落地）：** 内置插件 `navigation-guard`（`services/navigation_guard.rs`）用 Tauri 插件级 `on_navigation` 钩子对所有 webview 生效，只放行 `about:blank`、`about:srcdoc`、`tauri://localhost`、`http(s)://tauri.localhost` 与调试构建下的 `devUrl` 来源，其余导航一律取消并记录只含协议与主机的 `navigation_blocked` 日志；新窗口请求一律拒绝：应用不设置任何 `on_new_window` 处理器，而 Tauri/wry 在没有处理器时三个平台默认拒绝（Windows `SetHandled(true)`、macOS 返回空、Linux 不连接 `create` 信号），静态测试禁止生产代码启用新窗口创建。JavaScript 创建的子窗口无法挂处理器，同样依赖该默认行为；升级 Tauri 或 wry 时必须复核这条默认。前端源码不得使用 `window.open`、`target="_blank"`、`location` 赋值与带 `href` 的 `<a>`（卫生测试保证）。外链用系统浏览器打开的体验属于 M7。守卫只在 webview 登记之后的导航上生效（首次页面加载在登记前开始，守卫放行），所以放行名单要靠重载与后续导航验证；`tauri dev --release` 下 `devUrl` 不放行，整页重载会被拦截。
- **CSP 契约与渲染隔离门禁（m6-066 已落地）：** 生产 CSP 由 10 个指令精确定义（`default-src`、`script-src 'self'`、`style-src 'self' 'unsafe-inline'`、`img-src`、`font-src`、`worker-src`、`connect-src`，加 `object-src 'none'`、`base-uri 'none'`、`form-action 'none'`），Rust 与 TypeScript 两端各有精确断言；平台与离线覆盖配置不得定义 `app.security`；`withGlobalTauri`、资源协议与 `dangerousDisableAssetCspModification` 保持关闭，capability 不含 `remote`；`scripts/ci/assert-dist-html-csp.mjs` 在 CI 的三个平台检查生产 `dist/index.html` 不含内联样式与脚本、事件属性、`javascript:` URL、外部来源资源和禁用元素（Tauri 在 HTML 含内联 `<style>` 时会注入 nonce，使 `'unsafe-inline'` 失效）；前端卫生测试禁止动态代码执行与原始 HTML sink。M7 的 Markdown 渲染必须满足 `M7-markdown-preview.md` 中的 9 条“渲染隔离设计门禁”（sandbox iframe、不放宽 CSP、受授权约束的资源协议等）。生产包在三个平台上的 CSP 实机实测由 H-2 的 H2-07 至 H2-09 提供，在其通过之前，实测状态为未完成。
- 不在 SQLite 中保存密钥。如果未来需要凭据，使用操作系统凭据存储。

## 跨平台发布约束

- 0.2.x 的外部终端启动策略（Windows、macOS、Linux）已在 0.4.0 M6 期间删除，不再作为兼容能力保留；0.3.0 起工作台不提供外部启动入口，PTY 启动失败时显示明确错误，不静默回退。三平台的 PTY、进程树回收和平台专属行为以 CI 与实机验收为准（见 `.github/workflows/ci.yml` 与 M6 收口复核报告第二章）。
- macOS 分别发布 Apple Silicon 与 Intel DMG，不发布 Universal DMG；两个架构均需独立完成构建和运行验证。
- macOS DMG 的 target 配置与功能实现分离；内部未签名测试包可以用于本机验证，正式跨设备分发仍需有效 Developer ID Application 身份、公证凭据和 stapling 验证。
- 0.3.0 的 PTY 生命周期、内置终端交互、布局、升级迁移和安装包验收按 `docs/milestones/0.3.0/M5-release-readiness.md` 执行。

## 已知限制与待收口项（2026-10-06）

下表是 M6 收口复核（[M6 收口复核报告](milestones/0.4.0/M6-closure-review.md)，基准提交 `cd4feac`）确认的**事实性限制**，不是产品决策；“待修”表示代码尚未修复，修复后须同步更新本表和对应架构段落。编号含义：`S1*`/`S3*`/`FE-NEW-*` 为第二轮复核编号，`PD-*` 为产品决策项，已全部确认（2026-10-06，见复核报告 4.7.1），其目标与当前代码现状的差距见本节之后的“已确认的产品决策与代码现状”。

| 限制                               | 现象                                                                                                                                                                                                                                                                                                                                                                       | 影响范围                                                                                     | 临时缓解                                                                                                                                                                                                                                                                                               | 收口编号                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| macOS 系统级退出入口绕过退出门     | Tauri 默认应用菜单的 Quit 映射到 `terminate:`，tao 只实现 `applicationWillTerminate`，Cmd+Q 不产生可阻止的 `ExitRequested`（已对照 tao 0.35.3、muda 0.19.2 源码）；Dock 退出、AppleScript `quit`、注销预计同样绕过（未实测）。已确认（PD-12）：Cmd+Q 由自定义 Quit 菜单项经 `app.exit(0)` 进入退出门（待落地）；Dock 退出、AppleScript、注销不引入原生钩子，登记为已知限制 | macOS：未保存文件被丢弃，运行中的 PTY 被一并结束，执行任务被中断                             | 用托盘“退出”或主窗口关闭按钮（关闭行为设为“退出”）；退出前手动保存。已确认兜底（PD-12，待落地）：干净退出标记，下次启动发现标记残留即提示“上次应用异常退出，未保存的编辑可能丢失”（不保存正文）；`RunEvent::Exit` 尽力终止 PTY 与执行任务并标记意外中断；后续可选 PD-12b（未保存草稿恢复存储，未采用） | S1C-N01、PD-12                            |
| 退出确认不统计运行中的执行任务     | 退出影响只统计运行中的 PTY 与未保存文件，退出会直接中断运行中的安装/更新任务（`appExitImpacts.ts`、`app_lifecycle.rs`）。已确认（PD-01）：退出确认提示活动任务数，确认后终止任务，活动任务数由 Rust 计算并随退出请求下发，待落地                                                                                                                                           | 三平台：安装/更新被静默中断，下次启动标记为意外中断                                          | 退出前在“执行任务”页确认任务已结束或手动终止                                                                                                                                                                                                                                                           | S3H-A13、S3I-A05、PD-01                   |
| 事件系统不是隔离边界               | Tauri 事件不带经过验证的发送方；全局 `listen` 可收到发给任意窗口的 `emitTo`；子窗口的 `core:event:allow-emit-to` 已移除（m6-062），窗口之间的消息经 Rust 中继并盖发送方戳；交接 token 与文件缓冲在事件中传输；`confirm_app_exit` 已核对 requestId（R-EXIT-1），伪造事件不能使应用退出                                                                                      | 目前子窗口只渲染 xterm 与 Monaco，利用门槛高；M7 在窗口内渲染 Markdown HTML 后会成为可利用面 | 在 M7 之前不得引入渲染不可信 HTML 的内容窗口                                                                                                                                                                                                                                                           | S3H-A01~A05、S3H-A17（M7 开工前必须完成） |
| 返回主工作区过程中持久化抛异常     | PTY/文件从独立窗口返回时，`returning` 阶段的内容既不在布局树也不在 `detachedContents`，自动保存校验抛出 “unowned content”，主窗口 React 树可能被卸载                                                                                                                                                                                                                       | 所有独立窗口返回路径                                                                         | 返回前先保存文件；避免在返回进行中操作                                                                                                                                                                                                                                                                 | S1A-N01（P0，待修）                       |
| 切换界面语言触发工作区 rehydrate   | `hydrateWorkspace` 依赖翻译函数 `t`，语言切换会重新读取布局并重置运行期状态                                                                                                                                                                                                                                                                                                | 未保存的编辑被丢弃，PTY 从界面消失，分离的文件窗口失去主窗口归属                             | 切换语言前保存文件、关闭独立窗口                                                                                                                                                                                                                                                                       | FE-NEW-01（P0，待修）、规则 R-FE-1        |
| 0.3.0 升级用户的布局保存失败       | 数据库列 `schema_version` 为 1，保存要求等于 5，返回 `saved:false`，前端无限重试                                                                                                                                                                                                                                                                                           | 升级前保存过布局的用户：布局改动不落盘，前端持续发起保存请求                                 | 无自助办法（`reset_current` 拒绝重置可读布局）                                                                                                                                                                                                                                                         | S3J-A01（P1，待修）、PD-16                |
| 图片预览与更新拒绝原因字段名漂移   | `ProjectFileOpenResult::Image`、`ManagedUpdateStatus::Denied` 缺 `rename_all_fields`，实际输出 `mime_type`/`base64_data`/`reason_key`，前端读 camelCase 得到 undefined                                                                                                                                                                                                     | 图片预览显示 `data:undefined;base64,undefined`；托管更新被拒时原因文案为空                   | 无                                                                                                                                                                                                                                                                                                     | S3J-A02、S3J-A03（P1，待修）              |
| Linux 保存遇外部原子替换           | CAS 经 cap-std `canonicalize` 解析目标，遇 ` (deleted)` 竞态时 2 秒后报“无法打开待保存文件”                                                                                                                                                                                                                                                                                | Linux：保存同时有 git/格式化器/编辑器原子写同一文件；HEAD 上 Ubuntu 跨进程 CAS 测试间歇失败  | 重试保存                                                                                                                                                                                                                                                                                               | 待 CI 确认（m6-034）                      |
| 文件独立窗被销毁无回收             | 窗口崩溃或被强制销毁后，Rust 只撤销授权，主窗口不回收，文件内容与最后镜像缓冲停留在“窗口拥有”状态                                                                                                                                                                                                                                                                          | 文件独立窗                                                                                   | 退出应用前先保存；重启后文件回到焦点 pane（缓冲不持久化）                                                                                                                                                                                                                                              | S1A-N02（P1，待修）                       |
| Windows 注销/关机与 Linux SIGTERM  | 系统直接结束进程，不经过 `ExitRequested`；缓冲不保存；PTY 与执行任务被结束，下次启动标记为已结束/中断                                                                                                                                                                                                                                                                      | 三平台                                                                                       | 重要编辑及时保存；已确认兜底同上（PD-12，待落地）                                                                                                                                                                                                                                                      | S3H-A14、PD-12，文档化限制                |
| 默认“关闭到托盘”在无托盘宿主的桌面 | 默认关闭行为为 `MinimizeToTray`；GNOME 未装 AppIndicator 扩展等环境下窗口隐藏后无入口；托盘创建失败会使 `setup` 返回错误导致启动失败（`lib.rs` 的 `setup_tray(...)?`）                                                                                                                                                                                                     | Linux 部分桌面                                                                               | 在设置中改为“退出应用”；再次启动应用会经单实例唤起已隐藏的主窗口；已确认（PD-13，待落地）：托盘创建失败或无托盘宿主时降级，只记日志并强制有效关闭行为为“退出”                                                                                                                                          | S3H-A15、PD-13                            |
| 托盘文案启动阶段固定中文           | 托盘菜单初始文案为中文，主窗口前端加载后才推送翻译文案                                                                                                                                                                                                                                                                                                                     | 非中文用户的启动早期                                                                         | 无                                                                                                                                                                                                                                                                                                     | S3H-A16                                   |
| 单实例二次启动忽略命令行参数       | 单实例回调只聚焦主窗口，不处理参数                                                                                                                                                                                                                                                                                                                                         | 全平台                                                                                       | 无                                                                                                                                                                                                                                                                                                     | 无（文档化）                              |
| 已知 kind 渲染出错时占位“关闭”无效 | 占位的关闭回调只对 `kind === "unknown"` 生效                                                                                                                                                                                                                                                                                                                               | 内容渲染异常时                                                                               | 通过标签关闭按钮或右键菜单关闭                                                                                                                                                                                                                                                                         | S1A-N04（待修）                           |

## 已确认的产品决策与代码现状（2026-10-06）

M6 第二轮复核的 16 项产品决策已全部确认（详见 [M6 收口复核报告](milestones/0.4.0/M6-closure-review.md) 4.7.1）。下表只记录“已确认目标”与“当前代码现状”的差距；凡标注“待落地”的，代码尚未实现，不得当作已实现的行为。

| 决策                                   | 已确认目标                                                                                                                                               | 当前代码现状                                                                                                                                                                                                         | 状态                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| PD-01 退出时有运行中的执行任务         | 退出确认提示活动任务数，确认后终止任务；活动任务数由 Rust 计算并随退出请求下发                                                                           | 退出影响只统计运行中的 PTY 与未保存文件（`appExitImpacts.ts`），不含安装/更新任务，退出会直接中断它们                                                                                                                | 待落地（S3H-A13、S3I-A05）                                             |
| PD-02 Unix 控制字符文件名              | 列表、打开、布局一律拒绝并计入跳过数，规则单一来源于 `platform/path_rules.rs`                                                                            | 已落地（m6-037a）：`path_rules::common_component_violation` 在所有平台拒绝控制字符，列表、打开、布局一致，列表跳过并计入 `skippedCount`；`windows_component_violation` 不带 cfg，三平台可测，保留名含 `COM0`、`LPT0` | 已落地（m6-037a）                                                      |
| PD-03 工作区文件索引服务               | 登记为范围变更：实现已删除，仅以 `M6-editor-and-index-research.md` 交付可行方案，M8/全文搜索阶段再设计                                                   | 服务、命令与缓存前缀写入方均已删除；调研文档保留                                                                                                                                                                     | 已落实（文档已登记）                                                   |
| PD-04 Grok 更新来源校验                | 以官方更新检查的 `installer=internal` 为准，不限制可执行文件所在目录                                                                                     | 与目标一致（`grok/common.rs` 的 `validate_execution`、`grok/version.rs`）                                                                                                                                            | 已落实                                                                 |
| PD-05 `directory_tool_args` 遗留表     | 在 `0015_legacy_cleanup` 删除，配置导入容忍旧字段                                                                                                        | 迁移 0015_legacy_cleanup 已删除 directory_tool_args、shell_profiles、launch_target、tools 的无用列与 directories.last_used_at；配置包字段只读不写                                                                    | 已落地（S3I-A29，m6-078）                                              |
| PD-06 Markdown 渲染隔离                | sandbox iframe（`srcdoc`，不给 `allow-scripts` 与 `allow-same-origin`），图片与字体经受授权约束的自定义资源协议提供，全局 CSP 不放宽                     | M7 尚未开始，无代码                                                                                                                                                                                                  | M7 设计门禁                                                            |
| PD-07 终端配色                         | 终端始终深色，作为主题例外                                                                                                                               | 终端 token 在两套主题下相同，`PtyTerminal` 的主题订阅无可见效果                                                                                                                                                      | 已确认；订阅待清理                                                     |
| PD-08 会话 ID 格式                     | Claude、Codex 仅接受规范小写 UUID                                                                                                                        | 已落地（m6-037b）：Claude、Codex 覆盖 `valid_session_id`，仅接受规范小写 UUID（`session_service::is_canonical_uuid`）；会话历史列表的过滤仍为宽松规则（已知不一致）                                                  | 已落地（m6-037b）                                                      |
| PD-09 PTY 交接目标等于源               | 拒绝                                                                                                                                                     | 已落地（m6-037c）：`complete_handoff` 目标等于源返回 `pty.handoff_target_is_source`，且在任何状态变更之前拒绝，之后用正确目标仍可完成同一次交接；显式状态机由 m6-054 负责                                            | 已落地（m6-037c）                                                      |
| PD-10 大小写不敏感文件系统上的文档身份 | 在 Windows 与 macOS 默认文件系统上按 `ProjectPathKey` 折叠大小写                                                                                         | 文档身份键为区分大小写的 `directoryId:relativePath`（`PtyWorkspace.tsx`、`workspaceLayoutPersistence.ts:224`，Rust 侧布局重复检查同样按原样比较），`A.txt` 与 `a.txt` 会成为两个文档                                 | 已确认；设计草案已评审通过，**实现前须先完成平台实现调研并经用户确认** |
| PD-11 布局单项含平台非法文件名         | 单项降级为占位，其余布局保持                                                                                                                             | 已落地（m6-037d）：仅因路径规则无效的文件文档降级为 `Unknown`（`originalKind = invalidFile`）占位，`read_current`、`save_current`、`reset_current` 联动；其他结构性损坏仍进入 `needsReset`；命名布局（preset）仍严格 | 已落地（m6-037d）                                                      |
| PD-12 系统级退出入口                   | 登记为已知限制，不引入原生钩子；兜底为干净退出标记 + 异常退出提示（不保存正文）+ `RunEvent::Exit` 尽力清理；草稿恢复存储（PD-12b）未采用，作为后续可选项 | Cmd+Q 绕过退出门（S1C-N01），其余入口同样绕过；无干净退出标记                                                                                                                                                        | 待落地                                                                 |
| PD-13 托盘不可用                       | 降级，记日志并强制有效关闭行为为“退出”                                                                                                                   | 托盘创建失败使 `setup` 返回错误导致启动失败                                                                                                                                                                          | 待落地（S3H-A15）                                                      |
| PD-14 `acceptance-hooks` cargo feature | 采用，仅验收构建启用，用于强制销毁子窗口，不进入发布包                                                                                                   | `Cargo.toml` 与 `src-tauri/src` 中不存在该 feature                                                                                                                                                                   | 待落地（SEAM-18）                                                      |
| PD-15 错误码命名                       | 统一 `domain.reason` 点分，旧码保留一个版本的别名，别名映射放入 `contracts/error-codes.json`                                                             | 现有码两种风格并存（`file.not_found` 与 `plan_changed`），后端多数错误仍是无码的 `app.error`                                                                                                                         | 待落地（S1B-N03、S3H-A10、S3I-A20）                                    |
| PD-16 布局 schema 版本来源             | 以 payload 为唯一权威，数据库列降为只读镜像或删除，CAS 仅比较 revision，迁移只保留 Rust 一处                                                             | 已落地（m6-090）：迁移只在 Rust 一处实现，TypeScript 的 `migrateWorkspaceLayoutDocument` 只接受当前版本 v5，收到其他版本进入 needsReset；数据库列仍为只读镜像（m6-014）                                              | 已落地（m6-090）                                                       |
