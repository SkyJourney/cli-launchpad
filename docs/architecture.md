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
- M3 持久化自动保存的当前工作区和用户显式保存的命名快照。布局记录包含版本化递归树、稳定 slot 身份、可空的 PTY session UUID、活动内容、焦点、比例和标题状态；当前工作区以 `detachedContents: WorkspacePaneContentRef[]` 记录独立窗口中的 PTY 与文件归属，命名快照不记录独立窗口位置。0.4.0 schema v4 将 v3 的 `detachedSlotIds` 迁移为 PTY 内容引用；v5 增加未知 kind 的保留信封。当前代码将 v3 直接迁移到 v5（执行 v4 的字段转换并写入当前版本），也将 v4 升级到 v5；未知 kind 的原始 JSON 在读取、保存、再读取后保持不变。Rust 与 TypeScript 都拒绝已知内容重复归属 pane/独立窗口，并保留未知内容供旧版安全显示和关闭。文件窗口完成 ready → init → attached 握手后（`detach` 命令）才从源 pane 移除文件引用（主窗口目前不校验 init 已发出就接受 attached，FE-NEW-03，待修）；返回、移动和应用命名布局时先清除旧引用，再独占放入目标 pane。重启时 detached 文件回到焦点 pane 并从磁盘重读，编辑缓冲不持久化；已 detached 或正在 detaching 的文件不会被重复插入命名布局。为已结束或失效 PTY 引用保存足够的项目/工具/标题快照以显示占位项。slot 身份先于 PTY session UUID 产生，二者必须分开保存和校验。Rust workspace layout service 只读写布局元数据，不操作 PTY 生命周期。
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
- 内建内容适配器通过应用启动期注册 API 装配；registry 校验稳定 ID、API 版本、支持的内容类型和冲突。当前内容 adapter 契约为 `apiVersion: 2`；关闭操作可在领域层返回 pending，内容在退出事件确认前保持 `closing`，不接受取消、移动、拆分或窗口交接，退出后以关闭原因完成 dispose。当前只允许编译进应用的内建适配器，不从磁盘或网络加载第三方代码。每个适配器声明类型化展示信息与菜单文案，接收宿主注入的内容引用和受限服务能力，并实现真实的 pane/独立窗口内容呈现、内部交互及类型特有生命周期驱动。通用菜单、标签关闭按钮、焦点/激活、pane 拓扑、window shell 和 Tauri capability 不由 adapter 复制或动态授予。
- Adapter 契约分为三类入口：`render(context)` 承载实际内容视图；`presentation(content, context)` 提供标题、图标、状态与类型文案；可选的同步关闭钩子 `beforeClose`/`beforeWindowClose` 实现应用特有拦截。需要独立窗口的 adapter 另外提供类型化 `prepareHandoff`、`attachHandoff`、`rollbackHandoff` 驱动以及终态 `dispose`。Handoff driver 只负责调用该内容领域 service、携带类型 payload 和恢复内容内部运行态；不创建 Tauri 窗口、不改 pane tree、不自行订阅公共协议。宿主传入内容身份、owner、目标、一次性交接 ID 与被授权的 service callbacks；未知能力不得由 adapter 自行从全局 API 获取。`beforeClose` 仍为同步否决点；领域关闭返回 pending 后，`closing` 不能撤销，只有 owner 结束事件能完成该关闭。**当前实现状态（待收口）：** `presentation` 返回 `{ title, icon, status, tooltip, closeLabelKey }`，但其 `context` 同时携带 PTY slot、PTY 会话、文件文档与 buffer 等两种内容的宿主数据，registry 门面（`workspaceContentAdapterRegistry.ts` 的 `presentation`/`projectContextOf`）内部仍按 `kind` 分支，`RegisteredWorkspaceContentKind` 是封闭联合 `"pty" | "file"`；两个内建 adapter 都没有实现 `beforeClose`/`beforeWindowClose`（宿主调用点存在、无实现者），实际使用的生命周期钩子是 `describeDisposalImpact`；`dispose` 只有文件 adapter 实现（释放默认编辑器引擎中的 model），PTY 终止与关闭后清理仍由宿主注入的领域操作完成；`prepareHandoff/attachHandoff/rollbackHandoff` 只是把调用转发给宿主构造的 capabilities 闭包，真实的领域逻辑仍在 `PtyWorkspace.tsx`（回环转发，S3G-A10）。统一执行器、领域操作注入表与 contribution 形态见 M6 收口复核报告 3A.5、3A.6。
- 宿主统一执行关闭决策：`beforeClose` 用于关闭 pane 内容、关闭其他/全部等会丢弃内容归属的动作，返回 `true` 才继续、返回 `false` 则拦截；同一批量关闭在执行前先评估所有目标，任一目标拦截时不部分删除。`beforeWindowClose` 在原生子窗口关闭导致内容销毁前执行，同样 `true` 继续、`false` 保持窗口和内容。钩子当前同步且抛错按拒绝处理；如未来需要异步确认，须版本化契约并明确 pending UI/取消语义。pane 内移动、激活、分栏以及成功的交接不是破坏性关闭，不得误触发 `beforeClose`。
- 窗口壳只负责平台标题栏/拖动/尺寸控件、原生 close-request 进入点、返回入口和生命周期协调器的调用；G3 的主窗口托盘/退出确认、macOS overlay 与平台装饰策略保持其既有 owner。子窗口关闭、返回和 pane 内容关闭最终统一经过 workspace/window lifecycle coordinator，具体 adapter 负责准备类型化交接数据和执行 PTY/file 领域操作。`beforeWindowClose` 返回 true 表示允许宿主继续执行该窗口已配置的关闭策略；该策略可以是交还工作区、结束只属于该窗口的内容或销毁空壳，不将所有内容强制套成相同的 dispose 行为。
- 内容交接状态由前端生命周期协调器管理视图归属，使用随机一次性交接身份并核验来源/目标窗口、内容身份和代次；Rust PTY service 的会话/窗口归属仍是 PTY 权威事实。主窗只在目标窗口 ready 并完成领域 attach 后提交 pane 移除；任一步失败回滚到原 owner。返回流程对称，防止两个窗口同时呈现可写内容或内容暂时无 owner。重复、乱序、过期事件必须幂等忽略；关闭、自然退出和应用卸载负责移除监听、计时器、窗口引用和内容运行时资源。
- 交接通用状态：`attached → detaching → detached → returning → attached`。分离失败回到 `attached`，返回失败回到 `detached`；明确关闭经过关闭钩子后进入 `disposed`。PTY payload 只传令牌、身份和必要终端快照，由 Rust attach/detach；文件 payload 经 Tauri 窗口事件在运行期传递项目 ID、相对路径、编辑缓冲和版本；协议核对事件版本、一次性 token 与窗口 label，不将 payload 持久化，不写入布局或业务数据库。文件路径授权与每次读写校验不能由 payload 替代：文件独立窗读写文件只能使用按窗口 label 登记的 `open_granted_file`/`save_granted_text_file`（见下文“文件独立窗按窗口授权”）。**当前信任边界（待收口）：** 协议订阅使用 `getCurrentWebviewWindow().listen`（`workspaceContentWindowProtocol.ts`），本应用的接收方只处理发给本窗口的事件；但 Tauri 事件系统本身不携带经过验证的发送方，`emitTo` 的目标也可写成 `Any`，任何窗口使用全局 `listen` 仍能窃听全部事件（含 token 与最多 2 MiB 的缓冲）。envelope 中的 `windowLabel` 是发送方自报，主窗口以“token + 自报 label”核对。因此事件通道不是保密通道，也不是隔离边界；Rust 中继加盖发送方、PTY token 绑定目标窗口等改造属于 M7 开工前门禁（S3H-A03、S3H-A04、S3H-A05，M6 收口复核报告 3A.9）。
- **当前实现状态（M6 阶段 6）：** `WorkspaceContentCoordinator` 驱动 owner 状态；`workspaceContentWindowProtocol` 统一版本化跨窗事件；`workspaceContentHandoffRuntime` 统一创建窗口并调用 adapter 的 prepare/attach/rollback drivers；`closeWorkspaceContentBatch` 统一关闭前置拦截、批量批准、部分成功回滚和 dispose 完成通知。PTY 终止返回 pending 时 coordinator 保持 `closing`，禁止取消和拓扑变更；退出事件完成 `disposed` 并通知 adapter。未知内容及缺失 adapter 显示内容级占位，adapter render 错误由内容级 ErrorBoundary 隔离；但已知 kind 渲染出错时占位上的“关闭”按钮当前无效（宿主只对 `kind === "unknown"` 真正关闭，S1A-N04，待修）。PTY 终止与文件状态移除仍由宿主注入为领域操作。`workspaceContentWindowRegistry` 共用待启动窗口注册、超时、撤销与 pending→detached 转移机制；PTY token、文件 buffer 和树更新保留领域边界。pane 标签序列和堆叠列表共同覆盖 PTY/文件内容，关闭菜单按 pane 全部内容计数；PTY adapter 经渲染上下文挂载由 `WorkspacePtySessionRegistry` 持有的稳定 portal target，不接管 PTY 会话。pane 树及窗口事件回调编排仍由 `PtyWorkspace` 管理，PTY 结束与文件状态移除仍由各自领域操作执行。阶段状态与剩余门禁以 `docs/milestones/0.4.0/M6-workspace-files.md` 为准。
- 每类子窗口由静态 Tauri capability 按 label 前缀授予最小权限。Adapter registry 只能声明需要的能力以供审查，不能生成或扩大 ACL；新增窗口类别必须同步增加静态 capability 和覆盖窗口 kind 与静态 capability 一致性、窗口 API 权限的自动化契约测试。应用不授予工作区内容窗口任意文件系统权限。当前契约来源为 `contracts/window-kinds.json`（label 前缀、capability、`appCommands`、`corePermissions`）与 `contracts/app-commands.json`，由 Rust 测试 `window_kind_contract_matches_capabilities`（`src-tauri/src/contracts.rs`）和前端 `src/lib/windowApiPermissions.test.ts` 校验。**已知覆盖缺口（待收口）：** Rust 比较器只比较 `core:` 与 `allow-` 前缀字符串，跳过插件权限与对象形式权限（S1B-N02）；前端权限扫描测试的源码清单因 `import.meta.glob` 键名归一化错误而漏读 `appPreferences*.ts` 与 `workspaceContentWindowProtocol.ts`，删除子窗口的 `core:event:allow-emit-to` 后测试仍会通过（S1B-N01）。
- 内容标签采用共同的宽度分配规则：标题自然收缩，单项标题最大 200 CSS px 并省略；可用空间不足时活动项保持可见，其他类型统一收进内容堆叠列表。列表命令仍经宿主统一入口执行，使用 ResizeObserver/等价布局观测处理窗口尺寸变化，不能因窄 pane 隐藏内容或改变其 owner。
- 文本编辑器视图依赖独立的编辑器引擎接口；文件身份、读写、版本冲突和脏状态仍由工作区文件服务/协调器管理。Monaco 是首个引擎实现，语言贡献按需装载；后续 Git 差异、blame 与 LSP 能力作为受控贡献接入，不让 Monaco 内建功能替代应用的文件安全与生命周期。
- 工作区索引目前没有生产服务、Tauri command 或前端调用方；M6 的文件浏览直接读取有界目录列表。项目级元数据缓存、全文搜索和语言服务/LSP 是后续能力的分层设计参考，不代表当前已交付。若重新引入索引，元数据缓存不得保存文件正文，扫描须局限于项目根目录并在单条目错误时保留部分结果；语言服务失效不得影响文件浏览与文本编辑。B3R-F06 的原 partial-scan 修复建议及本次删除原因记录在 M6 审查报告 WP5。
- 文件引用由项目 ID 和项目内相对路径组成。Rust file service 在每次操作时从数据库读取项目根目录，并将其打开为保留的目录 capability；前端提供的相对路径经校验后，只通过该目录句柄进行枚举、读取、图片预览和写回。越界符号链接由 capability 文件系统层拒绝，避免 canonicalize 检查与后续路径 I/O 之间被替换的竞态；特殊文件和不支持内容也在服务层拒绝。只向前端返回有界目录项、文本内容、版本/修改标识和错误，不把任意绝对路径当成授权凭据。
- 项目文件读取、写入和目录列表由 Rust service 通过受限 Tauri commands 提供；当前没有文件系统 watcher，也不提供变更通知流；不为文件浏览器授予整个用户目录的宽泛前端 fs 权限。所有项目文件命令均使用 Tauri async command，并将阻塞文件操作派发到 blocking pool。文本保存经 `platform/file_cas` 公共 CAS 协调器处理：锁内读取并比较调用方版本，目标文件身份仍匹配时才使用项目目录 capability 下的原子替换；锁等待有界，冲突作为类型化结果返回，保留编辑草稿并提供重新载入入口。普通无条件原子写入复用同一临时文件和平台替换机制，但不打开目标文件读取或加锁。临时文件在写入数据前就设置仅当前用户可访问的权限。Unix 在同目录原子 rename（cap-std `Dir::rename`）后，通过仍打开的文件句柄恢复目标权限，恢复失败只记录警告并以类型化保存结果提示，不把已落盘的保存报告为失败。Windows 不再使用 `ReplaceFileW`：临时文件创建时即写入仅当前用户可访问的保护 DACL；提交前先恢复原文件属性，复核已加锁目标的文件身份，再由 `preserve_windows_dacl` 把目标的 DACL 复制到临时文件（保护型 DACL 原样应用，非保护型只重放显式 ACE 并让继承 ACE 重新继承）；最后经 `replace_windows_anchored` 以 `FileRenameInformationEx`（`REPLACE_IF_EXISTS | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE`）原子替换：本地卷把父目录句柄作为 `RootDirectory` 做相对重命名；网络卷（UNC/远程重定向器不接受 `RootDirectory`）改走 `SetFileInformationByHandle(FileRenameInfoEx)`，使用由父目录句柄最终路径拼出的目标绝对路径（实现：`platform/file_cas.rs`）。平台 adapter 只负责锁、文件身份和原子替换，修订计算与 CAS 冲突语义由公共层统一。**待收口：** CAS 入口目前以 `root.canonicalize(relative)` 解析目标（`file_cas.rs` 约 259–262 行）；cap-std 在 Linux 上用 `/proc/self/fd` 实现 canonicalize，若另一进程恰好在其 `open(O_PATH)` 与 `readlink` 之间原子替换目标，会得到带 ` (deleted)` 后缀的名字，使后续加锁连续 ENOENT 直到 2 秒锁超时，用户看到的是“无法打开待保存文件”而不是冲突提示；这是 HEAD 上 Ubuntu 跨进程 CAS 测试间歇失败的根因（见 M6 收口复核报告第二章 2.8 节，目标设计为“父目录句柄 + 名称”模型，3B.5）。该锁协调遵守本协议的 Launchpad 写入方；不遵守操作系统文件锁协议的外部程序仍可能并发改写，跨平台文件系统没有可普遍依赖的内容条件替换原语，因此保存前需重读校验，且不得将锁描述为对任意外部写入的绝对互斥。项目目录仍是用户数据，不复制到业务数据库。
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
- **项目路径快照校验。** 全部项目文件命令都携带 `directory_path` 快照，`ProjectDirectory::open_for`（`services/project_directory.rs`）与数据库中的项目路径比较，不一致返回 `project_identity_changed`，避免恢复备份后项目 ID 被复用时读写到另一个项目；相对路径规则集中在 `platform/path_rules.rs`（Windows 拒绝 `:`、保留设备名等，Unix 允许 `:` 与 `\`），列目录时不可引用的条目被跳过并计数。差距：Windows 保留名列表当前只匹配 `COM1`–`COM9`/`LPT1`–`LPT9`（含上标数字），不含 `COM0`/`LPT0`，其在 Windows 上是否为保留名待实测（S1D-N13）；Unix 控制字符文件名在文件服务与布局校验之间判定不一致（S1D-N08）；已确认 PD-02：列表、打开、布局一律拒绝并计入跳过数，规则单一来源于 `platform/path_rules.rs`，待落地。
- **内容窗口销毁与 PTY 回收。** `lib.rs` 的 `on_window_event` 在 `Destroyed` 时：撤销该窗口的文件授权；对 `terminal-*` 窗口调用 `PtySessionManager::reclaim_window`，把以该窗口为所有者的会话路由改回 `main`、清空输出通道、无限期暂停输出并在不超过 256 KiB 的缓冲中暂存事件、清除以该窗口为源或目标的待决交接，并向主窗口发出 `pty-session-owner-lost`；主窗口通过仅主窗口可用的 `reattach_pty_session` 重新接管。文件独立窗（`workspace-content-*`）销毁后，Rust 在撤销授权之后向主窗口发出 `workspace-content-window-lost`（载荷 `{windowLabel}`，清理失败也发出），主窗口只处理 coordinator 状态为 `detached` 且 owner 是该窗口的文件：`ownerEnded`、删除窗口句柄、`ensureAttached` 到焦点 pane 并加入该 pane，保留已镜像的 buffer（S1A-N02；窗口销毁前尚未镜像的最后一次编辑不在保护范围内，待 H-1 实机核实）。`get_pty_session_window_status` 返回 `{ status, ownerWindowLabel }`（前端经 `toPtySessionWindowStatus` 映射为 `{ state, ownerLabel }`），分离超时对账比较 `ownerLabel` 与刚创建的子窗口 label，不一致时拒绝接受（S1C-N05）；owner-lost 重新接管与对账的重试上限、卸载中止见“失败与重试原语”条目。
- **失败与重试原语。** `src/lib/retryPolicy.ts` 提供 `retryWithBackoff`（次数有上限、可中止、可注入 sleep）与 `registerIsolated`（监听逐项注册，单项失败只重试并报告该项）。主窗口的 PTY 交接组、文件窗交接组与 `workspace-content-window-lost` 监听经 `workspaceContentListenerSetup.ts` 逐项隔离（3 次尝试，间隔 100 ms、300 ms），耗尽后用一条 toast 列出失败的事件名，其余监听保持；独立窗口共用一个底层协议监听，失败按整组处理：先注销已成功项，再向主窗口发送 `workspace-file-window-attach-failed` 或 `pty-detached-failed`，不重试。PTY owner-lost 重新接管最多 8 次（500 ms 起指数退避，上限 4000 ms，`ptyOwnerLostRecovery.ts`），同一会话同一时刻只有一个恢复循环，Provider 卸载时中止，会话已结束或已被其他窗口持有时立即停止；分离超时对账的 `retry-owner-query` 最多重试 10 次（间隔 1 秒）后按超时回滚；布局保存队列对“后端拒绝却不推进 revision”的情况在第 2、3 次发送前分别等待 250 ms、500 ms。差距：owner-lost 事件仍被当作事实使用，Rust 侧没有 `owner_lost` 状态字段（事件源改造属 RW5）。
- **独立窗口交接的 pending 阶段。** 主窗口为每个正在创建的独立窗口保存一条 `PendingContentWindow<K>` 记录（`PtyWorkspace.tsx`），带 `kind` 与 `stage`（`creating`、`ready`、`initSent`、`attached`）；阶段只能通过 `src/lib/workspaceContentPendingStage.ts` 的 `advancePendingWindowStage` 推进，规则由纯函数 `reducePendingStage` 决定。文件窗依次经过 creating（窗口已创建）、ready（收到子窗口 ready，准备 init）、initSent（init 已发出）、attached；重复或晚到的 ready、init 之前的 attached 都被忽略，`completeHandoff("detachReady")` 只在 `initSent` 阶段调用。终端窗的令牌与会话信息随窗口创建交付，没有 init 消息，所以从 `initSent` 开始，`pty-detached-ready` 即 attached 确认。差距：命令执行顺序与返回管线仍由各回调自行决定（RW2 步骤 3 与 RW3）。
- **独立窗口返回管线的提交顺序。** PTY 与文件的返回处理器（`PtyWorkspace.tsx` 的 `handlePtyReturnRequest` 与文件窗监听组的 `workspace-file-window-return-requested`）按固定顺序执行：预检并 `beginReturn`；领域操作（PTY `attachHandoff`、文件写入返回的 buffer，可 `await`）；复核 coordinator 仍处于该 token 的 `returning`；目标 pane 在 `beginReturn` 之前经 `resolveWorkspaceReturnPaneId` 解析（请求的 pane、上次所在 pane、焦点 pane、第一个 pane，只取树中存在的），协调器记录的即为它；提交前在 `treeRef.current`（最新树）上调用纯函数 `planWorkspaceReturn`，结果 pane 与记录不一致则失败；`completeHandoff("returnReady")`，不是 `changed` 就失败且不改树；最后 `commitTree`、聚焦并清理窗口句柄。从计算目标 pane 到提交树之间不得 `await`，因此 attach 期间用户对树的改动不会被覆盖。返回完成之后到达的同一 token 的重复请求，被 `WorkspaceContentCoordinator.isReturnCompleted` 静默忽略（PTY 在处理器入口，文件在身份校验之后、任何窗口查询之前），不会把已在树里的内容重新判为 detached。差距：这仍是两个处理器各自遵守的约定，不是统一的命令执行器（RW3 的 m6-050 负责）。
- **命令执行策略（helper 已落地，迁移进行中）。** `src-tauri/src/runtime.rs` 提供 `Db::call`、`CacheDb::call`（在阻塞线程池上取连接锁并执行闭包；锁中毒返回 `db.poisoned`，闭包 panic 或任务被取消返回 `internal.task_failed`）与 `blocking(op, budget, f)`（文件系统、进程、`canonicalize`、可执行文件解析的唯一入口；超过预算返回 `blocking.timeout`，闭包无法被取消，会继续运行到结束）；写操作（项目文件保存与删除残留）使用 `blocking_unbounded`：同样经统一线程池、panic 映射为 `internal.task_failed`，但不设预算，因为超时后写入仍可能完成，不能报告为超时；预算常量集中在 `src-tauri/src/budgets.rs`。规则：命令一律写成 `async fn`（必须在主线程执行的 UI 操作除外并注释说明）；数据库只经 `Db::call`/`CacheDb::call`；禁止在 `Db::call` 的闭包里做文件系统操作；闭包内不得再次访问同一连接（连接锁不可重入，嵌套调用会死锁）；`Db`、`CacheDb` 是叶子锁，持有时不得再取任何 manager 锁，manager 锁内不得访问数据库。已迁移（m6-030）：会话命令、全部项目文件命令（含 `grant_content_window_file`）、CLI 状态与安装版本命令、`create_pty_session` 的启动目录校验、布局读取（`get_workspace_layout`）、应用计划（`plan_apply_workspace_layout_preset`）与保存；项目目录打开拆成数据库阶段（`ProjectDirectory::lookup`）与无库阶段（`open_snapshot`），布局服务拆成 `SlotFacts` 读取与无库的路径比较，因此 `canonicalize` 不再发生在数据库锁内或主线程上。差距：其余同步命令（`app_setting`、`directory`、`execution`、`launch_history`、布局预设的 5 个命令、除 `create_pty_session` 外的 PTY 命令）仍使用旧 helper，`Db.0` 仍是公开字段，`AdapterContext` 仍同步构造（只是搬进了 `blocking`）；这些由 m6-035 与 m6-059 完成（S3I-A01、S3I-A02）。另有继承例外：恢复编排 `restore_with_runtime_invalidation` 的准入已移至数据库锁之前（由 `AppLifecycle` 持有），其数据库锁内的文件 IO 由 m6-058 处理；`backup.rs`、`config.rs`、`diagnostics.rs`、`cache.rs` 中既有的 `spawn_blocking` 写法未纳入本次统一入口，由 m6-059 统一。
- **应用生命周期与准入（最小版本）。** `services/app_lifecycle.rs` 的 `AppLifecycle` 是应用阶段（`Running`、`Restoring`、`Importing`、`Exiting`）与准入规则的唯一所有者，托管状态通过两个活动探针读取活动 PTY 数与活动执行任务数。所有会改变这些数量或替换数据的操作先 `admit`：`PtyStart` 与 `ExecStart` 取得只覆盖同步登记段的启动许可（`create_pty_session` 在完成路径与可执行文件校验后才准入）；`DataReplace`（恢复备份、导入配置）要求没有在途启动、没有活动 PTY、没有活动执行任务，许可持有到缓存清理与通知结束；`Exit` 先进入 `Exiting`（拒绝新的启动与数据替换），终止失败时许可析构使阶段回到 `Running`，成功时 `keep_exiting`。准入矩阵共 20 格，由表驱动测试固定。锁顺序：`AppLifecycle` 状态锁在前，会话表与执行任务表锁在后；持有数据库连接锁、会话表锁或执行任务表锁时不得调用 `admit`。`AppExitGate` 仍是独立的一次性退出授权。已移除：`PtySessionManager` 里的 `PtyLifecycleGate` 与两个守卫。差距：失效文件授权与缓存的统一清理钩子（`after_data_replaced`）、执行任务的终止与退出时的尽力清理、执行服务“预留槽位再写库”由 m6-040、m6-041、m6-058 完成（S3I-A04、S3I-A05）。
- **PTY 输入写队列。** 每个会话有专用写线程和容量 32 的有界 `sync_channel`；`write_pty_session` 只做入队，单次输入上限 64 KiB，超限或队列满返回 `pty_input_backpressure`，写线程已退出返回 `pty_input_unavailable`（`services/pty_session_service.rs`）。前端 `src/lib/ptyInputWriter.ts` 在写入前按 UTF-8 字节分片（每片不超过 65536 字节，不拆多字节字符与代理对），遇到 `pty_input_backpressure`（及别名 `pty.input_backpressure`）按 16、32、64、128、256 毫秒退避重试最多 5 次且保序，用尽后丢弃该次输入的剩余分片并上报一次，非背压错误清空队列并上报一次；分片绑定 push 时刻的会话 ID；`PtyTerminal.tsx` 的全部输入（`onData`、快捷键转义序列、启动期间缓存输入）都只经它写入。已知限制：单次输入超过约 2 MiB（32 个分片的队列容量）且 CLI 在约 0.5 秒重试窗口内一直不读取输入时，仍会在重试用尽后失败并提示。
- **CSP。** `src-tauri/tauri.conf.json` 配置生产 `csp`（`default-src 'self'`、`script-src 'self'`、`worker-src 'self' blob:`、`img-src 'self' data: blob:` 等）与开发 `devCsp`（仅多出 `'unsafe-eval'` 与本地开发服务器来源）；Monaco worker、字体与图片预览依赖 `worker-src blob:`、`data:`。Rust 测试 `tauri_csp_defines_production_and_development_policies` 只做包含断言，不防止生产策略被放宽；三平台生产包的实际表现尚待实机验证（S1B-N07，M6 实机清单 W-15/M-15/L-15）。M7 渲染 Markdown HTML 前必须先完成隔离边界改造（见“已知限制与待收口项”）。
- **契约清单与契约测试。** `contracts/tool-keys.json`、`app-commands.json`、`window-kinds.json`、`content-kinds.json` 是跨 Rust/TypeScript/SQL/capability 的名字集合清单：`build.rs` 从 `app-commands.json` 生成 `AppManifest`，`src-tauri/src/contracts.rs` 与 `src/lib/contracts.test.ts` 做双端比对。已知漏检：`generate_handler!` 为文本解析，注释掉的条目会被计为已注册；Rust 枚举新增变体而未同步手写 `ALL` 时检测不到；错误码、事件名、DTO 字段形状没有契约（S1D-N07、S3J-A05、S3J-A16）。
- **三平台 CI。** `.github/workflows/ci.yml` 在 Windows、macOS、Ubuntu 上运行前端测试、前端构建、`cargo fmt --check`、`cargo check`、`cargo test`（`fail-fast: false`），发布工作流通过 `workflow_call` 复用。差距：并发组 `ci-${{ github.ref }}` 在被发布工作流调用时可能误取消（S1D-N10）；未输出各平台测试执行清单，平台专属测试能否被静默跳过没有守卫；Windows ARM64、Linux ARM64、macOS Intel 目标尚未在 CI 运行测试。

## 主题偏好与跨窗口同步

主题偏好与界面语言是设备本地 UI 状态：主题存放在前端状态持久化（localStorage）中，语言同样存放在 localStorage，二者都不进入业务 SQLite 或配置交换；同源窗口启动时直接读取 localStorage，因此它也是一条隐式的跨窗口通道。主窗口通过版本化的 `app-preferences` 频道（`src/lib/appPreferences*.ts`，载荷 `{ apiVersion: 1, theme, language }`）广播偏好变化；终端与内容两类独立窗口在注册监听后经 `app-preferences-requested`（载荷含自报的 `windowLabel`）向主窗口请求当前偏好，主窗口只回复通过 `isDetachedWindowLabel` 判定的窗口 label（由 `contracts/window-kinds.json` 派生，覆盖 `terminal-*` 与 `workspace-content-*`）。接收方只用 `applyRemoteThemeMode`/`applyRemoteAppLanguage` 更新内存状态与 DOM，不回写 localStorage、不再次广播。语言切换同步 `lang`/`dir`（阿拉伯语为 RTL），并由主窗口通过 `set_tray_menu_labels` 把已翻译的托盘文案推给 Rust；托盘文案在主窗口前端加载完成前固定为中文初值。
`useThemeSync` 是已解析主题的唯一产出方：它把偏好（`"system"` 或已注册主题 id）解析为 `ResolvedTheme { id, base }` 写入 store（`useResolvedTheme()`/`subscribeResolvedTheme()` 供 xterm、Monaco、Sonner 等消费，不再各自观察 `data-theme`），同时写入 `data-theme` 与 `color-scheme`，并调用 `getCurrentWindow().setTheme(...)` 同步原生窗口外观（三类 capability 均已显式授予 `core:window:allow-set-theme`；失败只以 `console.warn("[window.theme_sync_failed]")` 暴露）。主题注册表为 `src/lib/themes.ts`（`THEMES`，内建 `light`/`dark`），主题语义色集中在 `src/styles.css` 并有 token 完整性测试；xterm 使用终端专属 CSS token，CLI 品牌、终端 ANSI 与执行日志配色仍是明确例外。**终端始终深色，作为主题例外（已确认 PD-07，2026-10-06）：** `--color-terminal-*` 在浅色与深色两个 token 块中取值相同（`src/styles.css` 88–90 行与 172–174 行），`PtyTerminal` 虽经 `useResolvedTheme()` 订阅已解析主题、并在主题变化时重新读取 token 写入 `terminal.options.theme`（`PtyTerminal.tsx` 约 356 行），但读到的值不变，没有可见效果（它已不再观察 `data-theme`）；该订阅待清理，或保留为将来提供浅色终端时的扩展点，登记在 G4 文档的例外清单中。**待收口：** `setTheme` 当前传入主题 id 而不是 `base`，新增 id 非 `light`/`dark` 的主题时原生调用会失败（S1B-N08）；`appStore` 初始化时存在第二处解析（S3H-A16）；`labelKey`、`monacoTheme` 仍是封闭联合类型；业务 effect 依赖翻译函数 `t` 的问题（语言切换触发运行期 rehydrate）见“已知限制与待收口项”与项目规则 R-FE-1。

工作区中的 xterm 会话注册与 portal 由 `WorkspacePtySessionRegistry` 承载；`PtyWorkspace` 保留布局、焦点、项目上下文和跨窗口交接协调。终端运行辅助（fit 尺寸边界、PTY 事件消费、剪贴板空文本分类和 WebView2 可见 renderer 恢复）集中在 `ptyTerminalRuntime`，PTY 创建和会话权威仍由 Rust service 持有。纵向长内容使用 `ThemedScrollArea` 的覆盖式滚动条：沿用项目列表的主题色、静止隐藏、滚动显现和拖动滑块行为，不占内容宽度；其他原生溢出区共享全局细轨和主题色，xterm 保留自己的终端滚动规范。

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

删除后遗留、当前启动链已不读取的数据：SQLite `application_settings.launch_target`、`shell_profiles` 与 `directory_tool_args` 表、配置 bundle 的 `shell_profiles` 空字段、`tools` 表中不再读取的列；清理迁移计划见 M6 收口复核报告 3B.9；已确认 PD-05：在 `0015_legacy_cleanup` 中删除 `directory_tool_args`（`shell_profiles`、`launch_target` 等一并清理），配置导入继续容忍旧字段，待落地，当前仍保留。本文“0.2.x 外部终端启动组合”一节保留 0.2.4 的历史设计供迁移与考古参考，不描述当前行为。

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

- **退出门。** 退出请求进入 `lib.rs` 的 `handle_run_event`（`RunEvent::ExitRequested`）：`AppExitGate`（`services/app_lifecycle.rs`，一次性布尔授权）已授权则放行并消费授权；否则只要主窗口存在就 `prevent_exit`、显示主窗口并向主窗口发出 `app-exit-requested { ptyCount }`（无论 PTY 数是多少，因为未保存文件只有前端知道）；主窗口不存在且有活动 PTY 时永久阻止退出（没有任何界面能确认，S3H-A14）；主窗口不存在且无 PTY 时直接退出。主窗口关闭行为设为“退出”和托盘“退出”都经 `app.exit(0)` 进入同一入口。
- **前端预检。** `App.tsx` 用全局 `listen` 接收事件，调用宿主 `collectExitImpacts(ptyCount)` 汇总影响：PTY 数取自事件载荷；脏文件取自主窗口 buffer 与分离到独立窗口的文件镜像，向这些窗口请求 flush（`workspaceFileExitFlush.ts`，500 ms 内无应答按脏处理）。无影响则直接调用 `confirm_app_exit`，否则弹出统一确认对话框。`confirm_app_exit`（`commands/pty_session.rs`）为 async，终止前先取得 `AppLifecycle` 的 `Exit` 许可（阶段进入 `Exiting`，拒绝新的启动与数据替换；终止失败时许可析构、阶段回到 `Running`）：在阻塞线程中 `terminate_all` 结束全部托管 PTY，授权退出门，再 `app.exit(0)`。
- **已知差距（待收口，见“已知限制与待收口项”）：** `confirm_app_exit` 不核对是否存在待决退出请求，且事件载荷里的 `ptyCount` 由前端直接采信，子窗口有 `core:event:allow-emit-to` 权限，理论上可伪造请求使应用无确认退出（S3H-A02，M7 前必须关闭）；退出影响不统计正在运行的执行任务（安装/更新），退出会直接中断它们（S3H-A13）；macOS 的 Cmd+Q 等系统退出入口不产生可阻止的 `ExitRequested`，直接绕过退出门（S1C-N01）；静默退出路径中 `confirm_app_exit` 失败后对话框按钮会保持禁用（S1A-N03）。
- **恢复门。** `restore_backup`（`commands/backup.rs`，async 并在阻塞线程执行）先经 `AppLifecycle` 取得 `DataReplace(RestoreBackup)` 许可（在取得数据库锁之前；存在已登记 PTY 会话返回 `pty_sessions_active`，会话正在启动返回 `pty_session_starting`，有活动执行任务返回 `app.data_replace_blocked`；许可存活期间新的 PTY 启动与执行任务启动被拒绝为 `backup_restore_in_progress`），数据库恢复成功后读取关闭行为，再清理 `sessions:`、`workspace-file-index:` 缓存与会话搜索索引，向主窗口发出 `workspace-data-restored`；主窗口 `WorkspaceDataRestoreListener` 触发工作区 rehydrate，前端在恢复前冻结自动保存并 flush（`workspaceRestorePolicy.ts`）。恢复请求被拒绝或在替换数据库之前失败时，前端只调用 `resumeAfterFailedRestore` 解除持久化冻结，并立即保存冻结期间的变更；不重新加载工作区，以免清掉恢复检查之后启动的运行中 PTY。已接受的残余：替换数据库之后，命令层仍可能因 blocking 任务 panic（`JoinError`）或关闭行为状态锁中毒返回 Err，此时前端同样只解除冻结而不 rehydrate；回滚本身失败时数据库可能处于未知状态，同样未单独编码。这些路径均未在宿主或 Rust 测试中构造。**差距：** 数据库替换成功后，缓存清理与通知失败只记录日志、不再使命令失败；前端在 restored 事件送达前保持冻结，若通知本身失败，前端保持冻结直到重启（023 已接受的已知限制）。恢复与导入会被活动执行任务阻止（`app.data_replace_blocked`），但不撤销内容窗口授权（S3I-A04，剩余部分由 m6-058 完成）。

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

可移植 JSON 配置 bundle 不再导出全局或项目级 CLI 参数；导入旧版 bundle 时忽略这些兼容字段。配置导入不接受 Shell 程序或初始化脚本。导入目录必须是绝对路径，存在的目录会规范化为稳定身份。配置导出不包含日志、缓存、备份、窗口位置、自动保存的当前工作区、命名布局快照或外部 CLI 会话正文；配置导入也不覆盖工作区布局。SQLite 备份包含当前工作区和命名布局。SQLite 中 0.2.x 遗留的参数字段与记录（`directory_tool_args`、`shell_profiles`、`application_settings.launch_target`）暂时保留以兼容旧数据库和备份，但当前启动链不读取它们，清理策略已确认（PD-05）：在 `0015_legacy_cleanup` 迁移中删除，配置导入继续容忍旧字段；待落地，当前仍保留。

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
- 启动参数由各 CLI 的 `resume_args` 和 PTY 创建组合逻辑生成；`CliAdapter` 不声明通用能力标记，项目目录归属校验、PTY 创建/尺寸/退出、会话窗口与独立窗口状态机仍由公共服务管理。关闭、移动窗格或应用布局不得由适配器创建或复制 PTY。
- 历史适配器只负责定位各 CLI 的本地事实来源、读取所需 metadata、校验项目归属并映射到规范会话 DTO。公共历史服务、SQLite FTS 索引和搜索负责统一分页、查询、别名合并和去重，去重键为 `ToolKey + session_id`；适配器不各自建立检索引擎，也不把完整 transcript 或项目路径写入搜索缓存。
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

Codex 的 App Server 读取使用短生命周期的 `codex app-server --stdio` 进程，由 `ProcessTree` 管理（Windows 为 Job，Unix 为进程组）；`AppServerTreeGuard` 在请求正常结束、出错或外层超时丢弃 future 时终止整棵进程树，覆盖 `.cmd` shim 外壳与脚本派生的后台进程。已知限制：Unix 的 `ProcessTree` 本身没有 `Drop`（由后续生命周期整改补上）；spawn 与 attach 之间存在极小的窗口（与 `run_bounded` 相同）。

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

## 安全边界

- 目录路径来自用户输入，启动前必须验证：`create_pty_session` 校验项目目录存在且为目录，并复核项目路径快照。
- 内置 PTY 启动通过 `portable-pty` 的 `CommandBuilder` 传入完整可执行路径、参数数组和 `cwd`（`pty_session_service.rs`），工作目录与参数不经 Shell 拼接；不得为了启动 CLI 而生成 Shell 命令字符串。0.2.x 外部终端启动链中的 PowerShell `Set-Location -LiteralPath`、POSIX 单引号编码、`.command` 载荷等转义规则随该链路一起删除，仅在上文历史章节保留。
- 工具可执行文件和参数分开建模。
- 安装/更新等会执行平台命令的进程统一经 `platform/process.rs`（`cli_command` 与带超时、输出上限、进程树回收的 `run_bounded`）与任务管理器的 `platform/execution_process.rs` 启动；`platform/terminal*.rs` 已删除。
- CLI 安装与更新计划在用户确认前显示来源和命令，并带有计划指纹（`InstallPlan.fingerprint`），任务创建时后端重新生成计划并比对指纹，不一致返回 `plan_changed` 要求重新确认；0.3.0 起普通 CLI PTY 启动不展示命令预览。
- 跨窗口事件不是安全边界：Tauri 事件不携带经过验证的发送方，任何窗口都可用全局 `listen` 窃听，子窗口的 `emit-to` 权限可广播到任意目标；不得在事件载荷中传递应被保密的数据或把事件当作鉴权依据（待收口，见 M7 前必须完成的边界改造）。
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
| 事件系统不是隔离边界               | Tauri 事件不带经过验证的发送方；全局 `listen` 可收到发给任意窗口的 `emitTo`；子窗口的 `core:event:allow-emit-to` 可广播到任意目标；交接 token 与文件缓冲在事件中传输；`confirm_app_exit` 不核对待决请求                                                                                                                                                                    | 目前子窗口只渲染 xterm 与 Monaco，利用门槛高；M7 在窗口内渲染 Markdown HTML 后会成为可利用面 | 在 M7 之前不得引入渲染不可信 HTML 的内容窗口                                                                                                                                                                                                                                                           | S3H-A01~A05、S3H-A17（M7 开工前必须完成） |
| 返回主工作区过程中持久化抛异常     | PTY/文件从独立窗口返回时，`returning` 阶段的内容既不在布局树也不在 `detachedContents`，自动保存校验抛出 “unowned content”，主窗口 React 树可能被卸载                                                                                                                                                                                                                       | 所有独立窗口返回路径                                                                         | 返回前先保存文件；避免在返回进行中操作                                                                                                                                                                                                                                                                 | S1A-N01（P0，待修）                       |
| 切换界面语言触发工作区 rehydrate   | `hydrateWorkspace` 依赖翻译函数 `t`，语言切换会重新读取布局并重置运行期状态                                                                                                                                                                                                                                                                                                | 未保存的编辑被丢弃，PTY 从界面消失，分离的文件窗口失去主窗口归属                             | 切换语言前保存文件、关闭独立窗口                                                                                                                                                                                                                                                                       | FE-NEW-01（P0，待修）、规则 R-FE-1        |
| 0.3.0 升级用户的布局保存失败       | 数据库列 `schema_version` 为 1，保存要求等于 5，返回 `saved:false`，前端无限重试                                                                                                                                                                                                                                                                                           | 升级前保存过布局的用户：布局改动不落盘，前端持续发起保存请求                                 | 无自助办法（`reset_current` 拒绝重置可读布局）                                                                                                                                                                                                                                                         | S3J-A01（P1，待修）、PD-16                |
| 图片预览与更新拒绝原因字段名漂移   | `ProjectFileOpenResult::Image`、`ManagedUpdateStatus::Denied` 缺 `rename_all_fields`，实际输出 `mime_type`/`base64_data`/`reason_key`，前端读 camelCase 得到 undefined                                                                                                                                                                                                     | 图片预览显示 `data:undefined;base64,undefined`；托管更新被拒时原因文案为空                   | 无                                                                                                                                                                                                                                                                                                     | S3J-A02、S3J-A03（P1，待修）              |
| Linux 保存遇外部原子替换           | CAS 经 cap-std `canonicalize` 解析目标，遇 ` (deleted)` 竞态时 2 秒后报“无法打开待保存文件”                                                                                                                                                                                                                                                                                | Linux：保存同时有 git/格式化器/编辑器原子写同一文件；HEAD 上 Ubuntu 跨进程 CAS 测试间歇失败  | 重试保存                                                                                                                                                                                                                                                                                               | 复核报告 2.8、S3I-A16（P1，待修）         |
| 文件独立窗被销毁无回收             | 窗口崩溃或被强制销毁后，Rust 只撤销授权，主窗口不回收，文件内容与最后镜像缓冲停留在“窗口拥有”状态                                                                                                                                                                                                                                                                          | 文件独立窗                                                                                   | 退出应用前先保存；重启后文件回到焦点 pane（缓冲不持久化）                                                                                                                                                                                                                                              | S1A-N02（P1，待修）                       |
| Windows 注销/关机与 Linux SIGTERM  | 系统直接结束进程，不经过 `ExitRequested`；缓冲不保存；PTY 与执行任务被结束，下次启动标记为已结束/中断                                                                                                                                                                                                                                                                      | 三平台                                                                                       | 重要编辑及时保存；已确认兜底同上（PD-12，待落地）                                                                                                                                                                                                                                                      | S3H-A14、PD-12，文档化限制                |
| 默认“关闭到托盘”在无托盘宿主的桌面 | 默认关闭行为为 `MinimizeToTray`；GNOME 未装 AppIndicator 扩展等环境下窗口隐藏后无入口；托盘创建失败会使 `setup` 返回错误导致启动失败（`lib.rs` 的 `setup_tray(...)?`）                                                                                                                                                                                                     | Linux 部分桌面                                                                               | 在设置中改为“退出应用”；再次启动应用会经单实例唤起已隐藏的主窗口；已确认（PD-13，待落地）：托盘创建失败或无托盘宿主时降级，只记日志并强制有效关闭行为为“退出”                                                                                                                                          | S3H-A15、PD-13                            |
| 托盘文案启动阶段固定中文           | 托盘菜单初始文案为中文，主窗口前端加载后才推送翻译文案                                                                                                                                                                                                                                                                                                                     | 非中文用户的启动早期                                                                         | 无                                                                                                                                                                                                                                                                                                     | S3H-A16                                   |
| 单实例二次启动忽略命令行参数       | 单实例回调只聚焦主窗口，不处理参数                                                                                                                                                                                                                                                                                                                                         | 全平台                                                                                       | 无                                                                                                                                                                                                                                                                                                     | 无（文档化）                              |
| 已知 kind 渲染出错时占位“关闭”无效 | 占位的关闭回调只对 `kind === "unknown"` 生效                                                                                                                                                                                                                                                                                                                               | 内容渲染异常时                                                                               | 通过标签关闭按钮或右键菜单关闭                                                                                                                                                                                                                                                                         | S1A-N04（待修）                           |

## 已确认的产品决策与代码现状（2026-10-06）

M6 第二轮复核的 16 项产品决策已全部确认（详见 [M6 收口复核报告](milestones/0.4.0/M6-closure-review.md) 4.7.1）。下表只记录“已确认目标”与“当前代码现状”的差距；凡标注“待落地”的，代码尚未实现，不得当作已实现的行为。

| 决策                                   | 已确认目标                                                                                                                                               | 当前代码现状                                                                                                                                                                         | 状态                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| PD-01 退出时有运行中的执行任务         | 退出确认提示活动任务数，确认后终止任务；活动任务数由 Rust 计算并随退出请求下发                                                                           | 退出影响只统计运行中的 PTY 与未保存文件（`appExitImpacts.ts`），不含安装/更新任务，退出会直接中断它们                                                                                | 待落地（S3H-A13、S3I-A05）                                             |
| PD-02 Unix 控制字符文件名              | 列表、打开、布局一律拒绝并计入跳过数，规则单一来源于 `platform/path_rules.rs`                                                                            | 文件服务允许、布局校验拒绝，导致打开后每次自动保存都失败                                                                                                                             | 待落地（S1D-N08）                                                      |
| PD-03 工作区文件索引服务               | 登记为范围变更：实现已删除，仅以 `M6-editor-and-index-research.md` 交付可行方案，M8/全文搜索阶段再设计                                                   | 服务、命令与缓存前缀写入方均已删除；调研文档保留                                                                                                                                     | 已落实（文档已登记）                                                   |
| PD-04 Grok 更新来源校验                | 以官方更新检查的 `installer=internal` 为准，不限制可执行文件所在目录                                                                                     | 与目标一致（`grok/common.rs` 的 `validate_execution`、`grok/version.rs`）                                                                                                            | 已落实                                                                 |
| PD-05 `directory_tool_args` 遗留表     | 在 `0015_legacy_cleanup` 删除，配置导入容忍旧字段                                                                                                        | 表、`shell_profiles`、`launch_target` 等仍保留，当前启动链不读取                                                                                                                     | 待落地（S3I-A29）                                                      |
| PD-06 Markdown 渲染隔离                | sandbox iframe（`srcdoc`，不给 `allow-scripts` 与 `allow-same-origin`），图片与字体经受授权约束的自定义资源协议提供，全局 CSP 不放宽                     | M7 尚未开始，无代码                                                                                                                                                                  | M7 设计门禁                                                            |
| PD-07 终端配色                         | 终端始终深色，作为主题例外                                                                                                                               | 终端 token 在两套主题下相同，`PtyTerminal` 的主题订阅无可见效果                                                                                                                      | 已确认；订阅待清理                                                     |
| PD-08 会话 ID 格式                     | Claude、Codex 仅接受规范小写 UUID                                                                                                                        | 公共规则为字符集 `[A-Za-z0-9_-]` 且拒绝前导 `-`，Claude、Codex 未强制 UUID（Grok 已强制）                                                                                            | 待落地（B1-F05）                                                       |
| PD-09 PTY 交接目标等于源               | 拒绝                                                                                                                                                     | `complete_handoff` 未拒绝目标等于源                                                                                                                                                  | 待落地（T2-N13）                                                       |
| PD-10 大小写不敏感文件系统上的文档身份 | 在 Windows 与 macOS 默认文件系统上按 `ProjectPathKey` 折叠大小写                                                                                         | 文档身份键为区分大小写的 `directoryId:relativePath`（`PtyWorkspace.tsx`、`workspaceLayoutPersistence.ts:224`，Rust 侧布局重复检查同样按原样比较），`A.txt` 与 `a.txt` 会成为两个文档 | 已确认；设计草案已评审通过，**实现前须先完成平台实现调研并经用户确认** |
| PD-11 布局单项含平台非法文件名         | 单项降级为占位，其余布局保持                                                                                                                             | 按审查推断，校验失败会使整份布局进入 `needsReset`（由 RS-T51 证实）                                                                                                                  | 待落地                                                                 |
| PD-12 系统级退出入口                   | 登记为已知限制，不引入原生钩子；兜底为干净退出标记 + 异常退出提示（不保存正文）+ `RunEvent::Exit` 尽力清理；草稿恢复存储（PD-12b）未采用，作为后续可选项 | Cmd+Q 绕过退出门（S1C-N01），其余入口同样绕过；无干净退出标记                                                                                                                        | 待落地                                                                 |
| PD-13 托盘不可用                       | 降级，记日志并强制有效关闭行为为“退出”                                                                                                                   | 托盘创建失败使 `setup` 返回错误导致启动失败                                                                                                                                          | 待落地（S3H-A15）                                                      |
| PD-14 `acceptance-hooks` cargo feature | 采用，仅验收构建启用，用于强制销毁子窗口，不进入发布包                                                                                                   | `Cargo.toml` 与 `src-tauri/src` 中不存在该 feature                                                                                                                                   | 待落地（SEAM-18）                                                      |
| PD-15 错误码命名                       | 统一 `domain.reason` 点分，旧码保留一个版本的别名，别名映射放入 `contracts/error-codes.json`                                                             | 现有码两种风格并存（`file.not_found` 与 `plan_changed`），后端多数错误仍是无码的 `app.error`                                                                                         | 待落地（S1B-N03、S3H-A10、S3I-A20）                                    |
| PD-16 布局 schema 版本来源             | 以 payload 为唯一权威，数据库列降为只读镜像或删除，CAS 仅比较 revision，迁移只保留 Rust 一处                                                             | 数据库列与 payload 双源：读取时在内存迁移，保存时要求列值等于当前版本，0.3.0 升级库保存被拒（见上表）                                                                                | 待落地（S3J-A01、S3J-A18）                                             |
