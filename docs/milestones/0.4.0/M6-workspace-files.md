# M6：内容窗格与文件工作区

## 目标

将当前 PTY 专用工作区扩展为可承载多种内建内容的窗格体系，并交付安全的项目文件树和窗格内文本编辑。既有 PTY 继续由 Rust 独占生命周期。

## 依赖与设计门禁

- 依赖 0.3.0 已发布基线。
- 实现前对照产品需求、架构、UI 设计和本里程碑，确定窗格内容引用、关闭/恢复、脏文档、项目切换和布局版本迁移。
- 内容适配器由应用拥有生命周期，通过启动期注册 API 动态装配内建模块；本阶段不加载第三方插件代码，也不提供插件市场、任意脚本执行或宽泛文件系统权限。
- PTY、文件编辑器等适配器向公共宿主声明视图、类型文案、命令、关闭钩子和资源释放逻辑。工作区引用仍使用受校验的版本化类型；适配器不能接管窗格拓扑、PTY 生命周期或项目文件授权。
- 文件编辑器以 Monaco Editor 为首选实现，并验证 Vite/Tauri worker、按需语言加载、浅色/深色主题、常用编辑快捷键、模型生命周期和生产包体积；保留编辑器引擎接口，避免将文件保存与脏状态绑定到 Monaco。
- 项目文件列表每目录最多返回 5,000 项，并显式标记截断；文本文件最大 2 MiB，仅接受 UTF-8 普通文件。二进制/超限内容进入不可打开说明页；常见栅格图片使用安全的内置预览，限制大小并校验文件签名。
- 命名布局只持久化文件引用。布局恢复遇到同一项目、同一相对路径的当前文档时保留当前文档身份及其未保存缓冲。
- 保存发现外部修改时拒绝覆盖，保留本地缓冲并提供用户触发的重新载入操作。
- 所有 pane 内容共享窗口宿主：统一标签关闭按钮、激活、关闭当前/其他/全部、拖动换 pane、右键菜单、分栏/移窗格、独立窗口入口和原生标题栏关闭拦截。内容 adapter 只提供窗格内渲染、内部交互和类型文案，并可用 `beforeClose` 与 `beforeWindowClose` 返回布尔值继续或拦截关闭；workspace coordinator 注入 PTY/文件关闭与独立窗口交接回调。
- 适配器按 `render`、类型化 `presentation`、同步关闭钩子和可选类型化 handoff driver 分层；宿主拥有通用命令和 owner 转移，adapter 不直接操作 pane tree 或创建窗口。详见 [架构文档](../../architecture.md) 中的 0.4.0 内容生命周期契约。
- Pane 标题栏按可用宽度自适应：短标题自然收缩，长标题单项最大宽度为 200 CSS px 并以省略号呈现；总宽度不足时，当前活动内容保留为可见标签，其余内容收纳到共用的堆叠列表中。堆叠列表覆盖 PTY 与文件，不按内容类型分裂 UI，并保留激活、关闭及右键操作。
- 文件独立窗口使用随机一次性交接身份，将项目 ID、相对路径、编辑缓冲和版本在内存中转交；ready 握手成功后才从源 pane 移除。失败时源内容和脏缓冲保持不变。

## 生命周期契约（阶段 2）

| 边界                             | 唯一职责                                                                                                                               | 禁止形成的第二份事实                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Workspace 内容宿主               | Pane tree、pane ID、内容引用归属、焦点/活动项、标签/菜单命令、宽度溢出展示和布局持久化；统一接收 close/move/split/detach/return 请求。 | adapter 不维护另一套 pane tree，不自行关闭/移动其他内容。                |
| Workspace 生命周期协调器         | 维护内容视图 owner、窗口 label、交接身份与代次；建立/清理事件订阅和计时器；驱动状态机、等待 ready、提交转移或回滚。                    | 不复制 PTY 进程状态、文件授权或 Git 工作区状态。                         |
| 内容 adapter                     | 对一个受支持的内容 kind 提供实际渲染、类型展示、受限 callbacks、同步关闭钩子和可选 handoff driver/终态 dispose。                       | 不创建通用 Tauri 窗口、不动态增加 capability、不直接操作 pane topology。 |
| Rust PTY service                 | PTY 进程、session 和 PTY 所有权/attach/detach 的权威状态。                                                                             | React 状态不可覆盖 Rust 查询结果或自行宣称 PTY 已转移。                  |
| Rust 文件 service 与前端文档状态 | Rust 校验项目根目录、路径、文件版本和写回；workspace content state 持有当前编辑 buffer/dirty 标志并在 handoff 时做受控交接。           | 独立窗口 payload 不是路径授权；正文和 buffer 不进入布局持久化/业务 DB。  |
| Window shell / Tauri capability  | Window shell 提供平台标题栏、拖动/尺寸控件及统一 close-request 入口；capability 静态授予窗口类别的最小 API。                           | shell 不决定 PTY/file 领域策略；adapter registry 不可动态放宽 ACL。      |

公共交接状态为 `attached → detaching → detached → returning → attached`。分离失败恢复为原 `attached` owner，返回失败仍由原独立窗口持有；明确关闭经过关闭钩子及窗口关闭策略后进入 `disposed`。自然退出、关闭和卸载必须恰好清理监听、计时器、portal/窗口引用与运行期资源。所有事件以交接 ID、内容身份、源/目标 label 和代次核验，重复/乱序/过期事件幂等忽略。

```mermaid
stateDiagram-v2
  state "窗格归属" as attached
  state "分离准备中" as detaching
  state "独立窗口归属" as detached
  state "返回准备中" as returning
  state "关闭清理" as closing
  state "已释放" as disposed
  [*] --> attached
  attached --> detaching: detach
  detaching --> detached: target ready and attach succeeds
  detaching --> attached: creation, attach, or timeout failure
  detached --> returning: return requested
  returning --> attached: source ready and attach succeeds
  returning --> detached: return failure
  attached --> closing: content close approved
  detached --> returning: close policy returns content to workspace
  detached --> closing: window close policy destroys content
  closing --> disposed: dispose once
```

`beforeClose` 用于破坏性内容关闭，`beforeWindowClose` 用于独立窗口原生关闭策略；返回 `true` 表示允许宿主继续，`false` 表示拦截。钩子同步执行且抛错时拒绝关闭。批量关闭先检查全部目标，遇到拦截则不部分关闭。移动、激活、pane 分栏和成功交接不调用破坏性关闭钩子。任何异步确认需求须作为版本化 API 变更另行设计 pending/取消语义。

G3/G4 的继承项：保留窗口 chrome 平台策略、主窗口托盘/退出确认、PTY Rust owner 与 portal DOM 稳定、G4 主题单一偏好来源、五 CLI 固定 adapter 契约及已审核 CSS token 矩阵。只收敛重复的生命周期入口和实际主题订阅重复；不把 CLI/主题/PTY/file adapter 合并成万能接口。适配器仍由应用静态编入，未来插件安全模型不属于 M6。

## 范围

- 统一窗格内容容器负责标题、焦点、关闭、递归分栏与布局保存；初始支持 PTY 和文本编辑器适配器。
- 右栏增加项目上下文、文件管理、Git 管理三个页签框架；本阶段实现项目上下文和文件管理，Git 页签为可解释的后续阶段入口。
- 文件树以当前项目目录为根，按需枚举；提供打开、刷新、隐藏项展示及常见忽略内容处理。
- UTF-8 文本文件在中央窗格打开、编辑、保存；同一文件重复打开聚焦既有内容，不创建重复窗格内容。支持常见语言的语法高亮和主流基础编辑操作；语言智能服务、工作区符号索引和跨文件跳转不由语法高亮冒充。
- 非文本/二进制文件显示明确的不可编辑状态；PNG、JPEG、GIF、WebP、BMP 在 10 MiB 内经签名校验后以内存 data URL 预览，不开放项目目录任意 URL 访问。SVG、TIFF、AVIF、HEIC 等未纳入安全预览白名单，显示不支持说明。
- 记录工作区文件索引的可行方案：M6 的索引边界为受项目根目录约束的文件元数据缓存；全文搜索按需扫描，定义/引用等语义能力留给后续 LSP/语言服务接入。
- 布局持久化文件内容引用，不保存正文或编辑缓冲；编辑器沿用全局主题语义。
- Rust 文件服务执行项目目录读取和安全写回，复用现有目录身份与路径校验原则。
- 关闭未保存文档和布局恢复时保护脏内容；外部修改时提示并允许用户重新载入，不静默覆盖。

## 非目标

- 本阶段不实现 Git、Markdown 预览、二进制文件编辑或完整 IDE 功能。
- 不提供文件创建、重命名、删除、复制、移动或批量操作。

## 任务清单

1. 盘点现有窗格树、PTY slot registry、布局 DTO/schema、独立窗口交接和命名布局应用路径。
2. 设计版本化内容引用、内建动态适配器注册 API 与编辑器引擎接口，定义旧 PTY-only 布局无损迁移和损坏数据降级；记录未来第三方插件 API 与权限模型的非目标边界。
3. 实现窗格内容容器；迁移现有 PTY 到 PTY adapter，并保持 xterm 实例和交接行为。
4. 实现 Rust 文件服务和按需目录树；项目根目录 canonicalize 后拒绝路径穿越、越界符号链接、特殊文件及过大文本读取。
5. 实现 Monaco 编辑器 adapter、常用快捷键和语言识别；保留脏状态、保存、外部修改检测、重复打开聚焦和关闭保护在宿主/文件服务边界内。
6. 完成英文/中文以外已有语言资源、浅色/深色主题、错误状态和空状态适配。
7. 完成 Monaco/CodeMirror 与 VS Code 文件索引能力调研结论，验证工作区元数据缓存与 LSP 语义能力边界；完成文件安全边界、布局恢复、错误恢复、主题和多语言审查，修复后复审并执行本里程碑最终自动门禁。
8. 抽取通用内容标签、拖放载荷、右键菜单和独立窗口壳，分别接入 PTY 与文件适配器，并验证交接失败恢复。
9. 补齐三个图标页签/紧凑项目标题及文件编辑器保存按钮布局，并完成独立窗口、关闭与拖动回归。
10. 复核 G3 窗口标题栏与 G4 主题、PTY 生命周期、工作区拆分、CLI adapter 和全局 token 的已验收抽象；有明确证据的重复边界并入本次重构，无缺陷部分保持既有实现与行为。
11. 实现 pane 标签标题宽度限制与跨内容类型堆叠列表；覆盖活动项稳定可见、窄窗格、长路径/长标题、溢出列表激活/关闭/拖动与键盘可访问性。

## 验收覆盖

- 单元/集成：内容引用校验、旧布局迁移、分栏操作、重复文档去重、布局恢复 ID 映射、脏状态与保存队列、同一文件并发外部修改检测、有界目录枚举、共用拖放载荷、独立窗口 ready/return/failure 生命周期。
- 安全边界：路径穿越、盘符/UNC/绝对路径注入、符号链接逃逸、权限拒绝、二进制内容、超大文件、文件删除后读取和根目录变化。
- 回归：终端和文件标签的激活、关闭、拖动换窗格和右键操作；PTY/文件独立窗口往返、交接失败恢复、PTY 退出、命名布局应用、空窗格关闭、应用重启恢复均保持正确语义。
- 实机：Windows、macOS、Linux 检查项目浏览、文本打开/保存、窗口缩放、长路径/Unicode 路径、外部编辑冲突和主题样式。

## 验收条件

- PTY 和文件编辑器能在同一递归窗格布局中共存；布局保存和恢复后引用正确，旧布局仍可加载。
- 文件服务无法通过前端构造参数访问当前项目根目录之外的目标。
- 编辑器不会静默丢失未保存修改，也不会未检测外部修改就覆盖用户文件。
- 终端与文件通过同一 pane 内容行为壳完成关闭、拖动、右键操作和独立窗口/返回；adapter 仍保留各自的 PTY/文件安全边界。
- 长标题限制在 200 CSS px 并单行省略；pane 宽度不足时当前内容仍可见，其余内容收进跨类型共用的堆叠列表，列表操作与普通标签行为一致。
- Windows 本地已完成代码与自动化门禁；macOS/Linux 实机验收及跨平台 UI 检查须在对应环境完成并记录后，M6 才可整体验收。

## 全仓抽象边界审查与门禁

### 审查范围与结论

2026-10 对整个软件实现做了一轮边界审查，范围包含 `src/`、`src-tauri/src/`、Tauri capabilities、测试和本里程碑相关文档。审查以职责归属、生命周期、跨平台实现、内容扩展点和权限边界为标准；模块行数本身不作为重构理由。

审查结论：Rust 命令到 services、DB repositories 和 platform helpers 的分层总体清楚；Tauri invoke/DTO 集中在 `src/lib/tauri.ts`；五个 CLI 的 Rust trait 与前端固定 adapter registry 符合当前明确限定的五 CLI 产品范围；操作系统特有实现主要留在 `src-tauri/src/platform/` 并使用 target 条件编译。这些边界不需要为 M6 泛化成第三方插件框架。

M6 内容窗格边界尚未达到本文件目标，属于里程碑级待完成项。以下审查矩阵记录了阶段 3/4 基线和后续验收门禁；截至阶段 5，共用窗口工厂、类型化事件协议和 handoff adapter drivers 已接入，剩余边界在矩阵与后续阶段记录中标明。任何局部共用都不代表完整内容生命周期已经统一；以下审查门禁优先于早期概括性表述。

### 边界审查矩阵

| 子系统                      | 当前边界与代码依据                                                                                                                                                                                                                                                                                                                                                                     | 待对齐内容                                                                                                                                                                                                                              | M6 审查/验收要求                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内容引用与 adapter registry | `src/lib/tauri.ts` 定义固定的 `pty`/`file` 内容联合；`src/components/workspaceContentAdapterRegistry.ts` 按 kind 单例注册，render context 仅按 `file` 注入文档、buffer、edit/save；`src/components/WorkspaceContentView.tsx` 也直接按 kind 组装上下文。                                                                                                                                | 注册表当前是应用内建、固定类型的动态注册，不是加入一种类型即可工作的完整 adapter 边界；不得把它描述为第三方插件 API。PTY adapter 在 `src/components/workspaceContentAdapters/builtins.tsx` 中 render 为空壳，实际终端渲染绕过 adapter。 | 明确 adapter 的输入能力、生命周期钩子、标签/命令和资源清理契约；由宿主提供通用能力注入，adapter 只实现类型特有渲染/交互；PTY 与文件均须实际通过约定的内容呈现路径。注册、注销、冲突、未知类型和卸载资源都要有测试。 |
| Pane coordinator 与内容渲染 | `src/components/PtyWorkspace.tsx` 同时持有布局恢复、文件编辑状态、PTY 会话、窗格拓扑、拖放、菜单、文件和 PTY 独立窗口事件编排。关闭生命周期已通过 `closeWorkspaceContentBatch` 共用，右键菜单仍按 kind 组装目标及调用领域关闭操作。                                                                                                                                                    | 通用状态转换和 dispose 已集中；菜单内容选择、文件/PTY close operation、pane 树与跨窗事件回调仍留在工作区宿主。需要后续按内容命令能力继续缩小 UI kind 分支，但不能把领域操作错误地移进通用 reducer。                                     | 验证标签/菜单关闭、批量关闭、移动/拆分等主要用户动作走统一生命周期；剩余 kind dispatch 限定在宿主注入领域操作的位置，并具备各领域等价验收。独立窗口事件编排是否再抽层，结合 cleanup 审查结论处理。                  |
| 标签、菜单和命令            | `WorkspaceContentTab.tsx`、`WorkspaceContentContextMenu.tsx` 复用了界面；菜单仍导入 PTY 布局类型并直接使用 `pty.*` 翻译键，关闭回调由 `PtyWorkspace.tsx` 按 kind 构造。                                                                                                                                                                                                                | 菜单项的分组、可用性和文案有部分硬编码；标签/菜单共用尚未建立一个可测试的宿主命令模型。                                                                                                                                                 | 菜单接收宿主构造的通用命令/可用性/文案，执行动作经过统一内容身份和生命周期入口；PTY/file 都覆盖关闭当前、关闭其他、关闭全部、移动 pane、拆分移动和独立窗口动作。                                                    |
| 关闭钩子和脏内容生命周期    | `src/lib/workspaceContentClose.ts` 定义同步布尔 `beforeClose`/`beforeWindowClose`，语义为 true 继续、false 拦截；文件 adapter 有脏文档钩子，但内建 adapter 未提供独立窗口关闭钩子。共享 shell 捕获原生关闭请求，内容窗口回调仍由各窗口实现。                                                                                                                                           | pane 标签关闭、菜单批量关闭、原生窗口关闭、分离/返回时的钩子调用范围和资源释放顺序需统一验证；异常/拦截路径可能造成 UI 已移除但底层资源仍存活，或反之。                                                                                 | 用同一关闭决策入口覆盖单个、批量、原生窗口及交接前置检查；验证 true/false、脏/未脏、异常和批量部分拒绝的明确语义，保证被拦截时布局与 buffer/session 不变。若暂不支持异步 hook，应在 API 文档中明确。                |
| 独立窗口与 handoff 协议     | `workspaceContentHandoffRuntime.ts` 提供共用窗口工厂与 adapter prepare/attach/rollback drivers；`workspaceContentWindowProtocol.ts` 提供版本化事件 envelope、单频道订阅多路分发和 label 前缀；`workspaceContentWindowRegistry.ts` 共用 pending 注册、超时、撤销及 pending→detached 转移。`PtyWorkspace.tsx` 仍拥有 pane 树与领域事件编排；PTY token 和文件 buffer 操作仍由 host 注入。 | 共用窗口、消息、待启动登记和关闭/释放通知已落地；仍需复审事件回调组合、窗口销毁和 provider 卸载时的全量清理。注册表只处理公共计时器与归属登记，不接管 Rust/file-service 操作。                                                          | 保留 PTY 进程归 Rust 管理、文件 buffer/路径由文件服务约束；验证 pane→window、ready、window→pane、异常退出、ready 失败、重复/过期事件、源窗格关闭和目标 pane 消失，并提供实机 GUI 证据。                             |
| Tauri capability 与窗口策略 | `default.json` 仅授权 `main`，`terminal-window.json` 覆盖 `terminal-*`；新增的 `workspace-content-window.json` 覆盖文件窗口标签并提供事件/窗口能力。之前文件窗的 `event.listen` 报错证明新窗口创建与 ACL 声明会发生漂移。                                                                                                                                                              | capability 是静态安全策略，不能被运行时 adapter 注册绕过，也不应通过宽泛窗口通配来掩盖漏配。动态 label 前缀与明确 ACL 需要保持一致。                                                                                                    | 每类创建的窗口 label 必须恰好落入预期 capability；对 listen/emit、关闭、拖动、剪贴板等实际调用做配置门禁或窗口启动 smoke test；新增窗口类型必须同步审查最小权限，不授予不需要的文件系统权限。                       |
| 编辑器引擎扩展点            | `workspaceEditorEngineRegistry.tsx` 支持注册和查找，但 `WorkspaceEditorSurface.tsx` 固定请求 `core.monaco`。                                                                                                                                                                                                                                                                           | 当前 registry 暂未承担引擎选择、默认回退或不可用错误策略，多个引擎的可插拔性没有被消费端验证。                                                                                                                                          | M6 明确采用单一内建 Monaco 时，可将注册表定位为预留扩展 API；若声称支持可替换引擎，则须由宿主配置/能力探测选择注册引擎并测试缺失/注销/错误回退。两种选择须在文档与代码一致，不要求 M6 引入第二引擎。                |
| 布局与内容操作              | `src/lib/ptyWorkspaceLayout.ts` 已有通用 `WorkspacePaneContentRef` 操作，同时保留 PTY/file 专属 helper 和类型断言。                                                                                                                                                                                                                                                                    | 需要确认工作区调用链已以通用操作为主，专属 helper 仅为必要兼容封装；否则通用模型与旧的双路操作会持续分叉。                                                                                                                              | 对照所有布局修改调用点，验证 close/move/split/restore 使用统一内容引用操作；保留的类型专属封装须有调用理由和等价测试，不能各自维护不同拓扑语义。                                                                    |
| 事件、主题及前端系统边界    | `invoke` 入口集中在 `src/lib/tauri.ts`；主题同步由 `useThemeSync` 统一，但终端与文件 adapter 各自观察 `documentElement.dataset.theme`；handoff 的 listen/emit 仍分布在工作区和独立窗口组件。                                                                                                                                                                                           | 通用跨窗口事件 DTO/频道没有集中定义；主题 DOM 监听有低风险重复。前者直接影响 M6 生命周期，后者属于后续维护优化。                                                                                                                        | M6 统一 handoff 事件类型与订阅/清理入口并验证能力范围；主题状态可继续由 CSS 变量驱动，若编辑器/终端确需显式主题则复用解析后的主题服务，作为非阻断整理项。                                                           |
| Rust 与平台边界             | `src-tauri/src/commands/` 负责 IPC，services 组合行为，DB/platform 各有目录；CLI adapter 以 trait 统一行为并固定覆盖五项工具；平台终端启动实现位于 platform 并按目标系统隔离。                                                                                                                                                                                                         | 本轮未发现足以要求重做 Rust commands/services/DB/platform 或五 CLI adapter 架构的 M6 级跨层泄漏。大文件本身不构成抽象缺陷。                                                                                                             | 本阶段只修复与内容/文件能力直接相关的职责错位；任何新增平台差异仍须留在 platform/target boundary，新增 DB 行为经 service/repository；不因 M6 扩成通用 CLI 插件框架。                                                |
| 其他前端领域组件            | `ProjectDetailView.tsx` 同时含项目上下文、文件浏览和会话查询；`SettingsView.tsx` 汇集多类设置；`Sidebar.tsx` 集中项目导航/会话列表。                                                                                                                                                                                                                                                   | 这些组件规模和多个视图职责值得后续按领域拆分，但本轮未证明它们破坏 M6 pane 内容生命周期边界，也不能仅按文件行数纳入本阶段重构。                                                                                                         | M6 只在它们与文件树入口/工作区内容交互的接口处验证职责；其余拆分记录为常规维护候选，不阻塞 M6。                                                                                                                     |

### G3/G4 已验收抽象复核

复核原则是修补实际分叉而不推翻已验收的平台行为、PTY 所有权与主题策略。G3/G4 里程碑保持历史验收状态；以下是 M6 必须继承并验证的架构边界，不重开它们的产品验收。

| 已验收抽象                   | 当前实现复核                                                                                                                                                                                                                         | M6 处理边界                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3 自定义窗口标题栏          | `src/components/WindowTitlebar.tsx` 共用拖动区域、双击最大化/还原和非 macOS 控件；主窗与独立窗的操作仍由不同调用者提供，平台装饰策略来自 `windowChrome`。窗口关闭按钮调用 Tauri `close()`，真正关闭/交接策略由对应窗口生命周期处理。 | 保留 G3 平台差异与命中区行为；通过窗口生命周期壳统一“请求关闭”的 hook 和清理次序，不把 PTY/file 业务策略塞入通用标题栏组件。回归拖动、双击、最大化、关闭、macOS overlay 与主窗口托盘/退出确认。         |
| G3 Pane 标题内容             | `WorkspaceContentTab` 统一了单标签视觉与关闭按钮；标题目前依赖可伸缩 flex，`.pty-pane-tab-title` 未限制宽度且允许换行。`PtyWorkspace` 的 `PaneSessionStack` 只收纳 PTY session，文件标签仍逐个占用标题栏空间。                       | 实现本文件规定的 200 CSS px 单项上限、单行省略和宽度不足时的跨类型溢出列表；活动内容始终可见。堆叠项目复用统一内容身份、右键和关闭入口，不复制 CLI-only 交互路径。                                      |
| G4 主题解析与跨窗口同步      | `useThemeSync` 集中处理偏好解析、DOM/native theme 和跨窗事件；终端/文件呈现另用 MutationObserver 读取 `data-theme`。主窗对初始主题请求的回复当前仅允许 `terminal-*` label。                                                          | 保留 G4 的单一偏好来源、只由主窗广播与新窗清理监听规则；文件独立窗必须有明确定向初始主题的路径。合并重复的 DOM 主题观察入口，适配器消费解析后的主题状态。窗口事件仍受静态 capability 控制。             |
| G4 PTY 状态模型与会话 portal | `ptySessionLifecycle.ts` 提供退出合并、detached 身份匹配、失败动作和可终止判断等纯函数；G4 记录明确未重写完整 handoff state machine。Rust service 仍拥有 PTY 进程/会话，React portal 保持 xterm DOM 实例稳定。                       | 以现有 Rust 所有权及 portal 行为为基准，将前端窗口交接编排收敛成可测试的共享生命周期协调器；把 PTY 特有状态转换以 adapter hook/typed payload 承载，不建立第二份 Rust 会话真相，也不在重构中重建 xterm。 |
| G4 工作区与终端职责拆分      | G4 已抽取 `WorkspacePtySessionRegistry` 与 `ptyTerminalRuntime`，但原记录未宣称整个 `PtyWorkspace` 或 `PtyTerminal` 的拆分完成；M6 当前又加入文件状态与第二套 detached 流程。                                                        | 延续“按实际职责解耦”的原则，边界围绕宿主、生命周期协调、内容 adapter、窗口协议、内容视图划分；不以拆小文件或统一命名替代单一状态所有权。                                                                |
| G4 CLI adapter 契约          | Rust trait、穷尽 registry 与前端五项 CLI metadata registry 各自承载 CLI 差异；它们拥有明确的固定五 CLI 产品范围，契约测试防止跨语言注册漂移。                                                                                        | 保留 CLI adapter 与 Workspace Content Adapter 的领域隔离。复用“能力显式声明、缺失安全失败、生命周期由公共层持有”的设计原则，但不强行合并两个输入/输出、状态机和权限完全不同的 adapter API。             |
| G3/G4 全局语义 token         | G4 已审查 token 消费者，并为 Sonner/Allotment 第三方变量、品牌图标、xterm ANSI 和日志颜色记录例外。                                                                                                                                  | 本次只要求新增标题栏、堆叠列表及生命周期 UI 使用已有语义 token；若改动需新增 token，必须补双主题定义/消费者检查，不重做已通过的整张 token 矩阵。                                                        |

上述复核意味着“统一生命周期架子”指向稳定的应用窗口/工作区宿主、明确的状态 owner、内建 adapter 契约和类型化生命周期 hook；不等于把 CLI、主题、文件、PTY 和操作系统窗口强制并成一个万能接口。每个边界必须能说明创建者、状态权威、事件入口、清理者和失败恢复责任。

### M6 抽象审查门禁

以下门禁必须在 M6 最终验收前全部关闭；每项均需提供代码位置和测试/运行证据。实现未完成的，不得用“组件已共用”或“已注册 adapter”替代生命周期证据。

1. **边界清单复核：** 复核本矩阵覆盖的前端内容宿主、窗格协调器、独立窗口、editor registry、Tauri capability、Rust 文件 service/command/DB/platform 及相关测试；新增/删除窗口或 adapter 时同步更新矩阵结论。
2. **宿主与 adapter 职责：** PTY 与文件都经公共宿主完成内容身份、焦点/激活、标题/关闭按钮、右键动作和资源清理；adapter 只持有内容内部渲染/交互及显式注入的类型能力。核心窗格操作不得在组件中重复按 kind 实现。
3. **完整生命周期一致：** pane 标签关闭、菜单关闭当前/其他/全部、移动/拆分、pane 与独立窗口交接、原生窗口关闭及返回采用一致的关闭 hook 与回滚规则；单/多窗格均验证。dirty buffer、PTY 进程和布局身份在拦截、失败、重试、重复事件下不丢失、不重复释放。
4. **独立窗口协议：** PTY 与文件共用类型化 handoff 状态机/协议与清理策略，差异由内容数据和 hook 承担；ready/failure/return/异常退出/目标消失均有自动化覆盖。PTY 仍由 Rust 管进程，文件路径、buffer 和写回仍由文件 service 保护。
5. **权限闭环：** 每个 WebviewWindow label 前缀都有最小化且明确的 capability；自动检查或实际启动门禁验证窗口可注册所需事件监听、能完成关闭与返回，且不获得额外文件系统权限。禁止用主窗口 capability 或宽权限掩盖子窗口缺失。
6. **注册表与消费端一致：** 内容 adapter 的注册/注销/冲突/版本校验/渲染/卸载均有测试；editor registry 若保留可替换承诺，消费端必须使用其选择和回退策略，否则收窄文档承诺为单内建引擎。
7. **文档与实现一致：** 更新 `docs/architecture.md` 中 workspace host、adapter、window handoff 的职责描述，使每项架构声明都能指向现存模块和测试；M6 文档中的当前实现记录不得把 UI 复用写成生命周期统一。
8. **回归门禁：** 最终复跑窗格布局/关闭与适配器单测、前端完整测试和构建、Rust 测试/check/fmt、capability 检查、diff 检查；Windows 实机和 macOS/Linux 对应环境按本文件验收覆盖补录结果。此前实现测试结果不能替代边界重构后的复跑。
9. **G3/G4 行为继承：** 复审窗口标题栏平台分支、主窗口托盘关闭与 PTY 保护、PTY portal 稳定性、主题新窗初始化及 CLI 五项隔离；每项需有旧行为基线和本次变更后的自动/实机证据。历史里程碑保持已验收，不把保留的平台差异误判成重复实现。
10. **标题自适应：** 标题最大宽度/省略在浅深主题和不同 DPI 下稳定；短标题不被拉伸，当前项在窄窗格仍可见，其他内容进入通用堆叠列表；列表可访问所有内容类型，并通过激活、关闭、拖放、右键与键盘导航回归。

如某项经审查明确延期，必须在 M6 文档中写清原因、影响和后续里程碑，并经用户确认后才可从本阶段强制门禁中移除；不能以“非阻断”默认为通过。

## 实施与门禁记录

- **阶段 3：生命周期核心与 adapter 契约（已完成复审，尚未接入运行时）。** 新增纯生命周期 reducer，显式表示 `attached/detaching/detached/returning/closing/disposed`；交接完成/失败/取消事件校验 transfer ID、generation、内容身份及 source/target owner，关闭批准/释放事件校验 request ID、generation、内容身份及当前 owner。失败/取消按原 owner 回滚，重复、过期或身份不符事件无状态变化。adapter 将类型文案归入 `presentation`，关闭与窗口关闭钩子归入 `lifecycle`，并定义类型化 handoff payload/hook trio；部分声明会在注册时拒绝。关闭 hook 抛错时 fail closed，并增加批量关闭 preflight helper。
- 阶段 3 收尾时 reducer 尚未接入运行时，PTY 与文件 handoff/关闭路径仍分叉；该阶段不代表 pane/窗口生命周期统一。阶段 4 已开始由 workspace coordinator 驱动 owner 状态并接入关闭预检，剩余协议/执行器对齐见下方阶段 4 记录。
- 阶段 3 复审与门禁：新增生命周期测试覆盖成功转移、失败/取消回滚、stale/duplicate/identity mismatch、无效目标、返回 pane fallback、关闭身份和释放去重；adapter registry 与关闭 hook 测试一并覆盖。最终 `pnpm exec vitest run` 通过 21 个测试文件/146 项，`pnpm run build` 通过，变更前端文件 Prettier 检查和 `git diff --check` 通过。生产构建仍报告既有 Monaco 懒加载 chunk 超过 500 KB（本次约 3.56 MB）；这属于编辑器包体积跟踪项，不影响本阶段生命周期门禁。
- **阶段 4：协调器接入（已完成复审；handoff 执行器抽象仍待后续阶段）。** 新增 `WorkspaceContentCoordinator` 作为前端 owner 状态的唯一生命周期 reducer 宿主；PTY 与文件分离/返回事件、文件批量关闭与 dispose、PTY 显式关闭及自然结束均同步生命周期状态。跨 pane 移动会同步已登记内容的 pane owner；主窗口收到独立窗口返回但内存登记缺失时，先按现有窗口身份/项目文件身份或 Rust PTY owner 状态恢复 owner，再进入 return。相同 return transfer 重复投递会被忽略；失败、超时、窗口退出和文件关闭失败路径会回滚或结束协调记录。两个内容领域保留各自 Tauri/Rust 握手与 typed payload，协调器统一接入状态所有权，但现有 PTY/file 事件频道尚未合并成一个通用事件总线。
- 阶段 4 复审发现主应用入口从约 493 KB 增至约 505 KB；为避免新增生命周期核心继续挤占入口块，将 coordinator/reducer 放入独立 `workspace-content-lifecycle` 构建块。最新阶段验证：前端 22 个测试文件/151 项、Rust 240 项单元测试通过；TypeScript、Rust `cargo check`、Rust 格式检查、生产构建、Prettier 和 `git diff --check` 通过；主入口约 499.69 KB。构建仍有 Monaco 编辑器 chunk 约 3.56 MB 的既有体积警告。
- **阶段 4 未宣称完成的边界：** PTY 与文件的独立窗口创建、跨窗事件监听/发射和领域 payload 仍分别由 `PtyWorkspace` 与各自独立窗口组件执行；adapter registry 的 `prepareHandoff/attachHandoff/rollbackHandoff/dispose` 钩子目前是已定义并校验完整性的契约，协调器还没有把这些 hook 作为实际 driver 调用。后续必须将窗口工厂、公共协议订阅/清理和 adapter driver 调用收拢到专用 coordinator/runtime，再验证 window close hook、异常退出、重复事件及跨窗 pane 操作，之后才能满足本文件“共用窗口宿主”的最终门禁。

- **阶段 5：跨窗协议与 handoff driver 接入（已完成阶段复审，M6 未完成）。** 新增 `workspaceContentWindowProtocol`，将 PTY/文件窗口消息集中为版本 1 的类型化 envelope 和单频道订阅分发；新增 `workspaceContentHandoffRuntime`，统一独立窗口创建参数/平台 chrome/超时，并通过注册 adapter 的 prepare/attach/rollback drivers 调用宿主注入能力。PTY 和文件保留各自 Rust/file-service payload；文件 attach 失败可立即回报主窗，pane 身份通过窗口参数注入。窗口 label、超时和协议订阅清理已集中；Tauri capability 仍按 `terminal-*`、`workspace-content-*` 静态最小权限匹配，没有加入文件系统权限。
- **阶段 5 代码复审与修复：** 手工逐条检查 pane→window、ready、window→pane、attach 失败、timeout、重复/过期消息、监听卸载及 PTY Rust token 所有权。发现并修复文件 return 异常分支未执行 adapter rollback、PTY return-complete 未匹配当前 transfer token、协议 envelope 未在类型层关联事件名/payload、共享事件路由未隔离异步 handler rejection 四项问题。复审还发现主入口增至 504.62 KB；将通用 handoff runtime/protocol 并入独立生命周期 chunk 后，主入口降至 481.52 KB。仍有 Monaco 编辑器懒加载 chunk 3,558.16 KB 的既有 500 KB 警告。
- **阶段 5 门禁：** 最终前端 24 个测试文件/155 项通过，Rust 240 项通过；`pnpm run build`、Rust `cargo fmt --check`、变更文件 Prettier 和 `git diff --check` 通过。构建的 Monaco chunk 仍显示体积警告。该阶段没有进行 GUI 实机回归；独立窗口 Tauri capability 的真实运行注册、原生窗口关闭和 PTY/文件来回操作仍须纳入 M6 对应环境验收。
- **阶段 5 明确遗留：** `PtyWorkspace` 仍拥有 pending/detached 记录和 pane 树，并按内容 kind 注入 Rust/file-service 操作；adapter `dispose` hook 虽有类型声明，仍没有宿主消费端。故本阶段只关闭公共创建、协议及 handoff driver 分叉，不宣称完整生命周期已统一；继续审查 pane 命令分派、关闭/资源释放、窗口关闭与 dispose 的 owner/调用次序，再决定最小而完整的宿主边界。
- **阶段 6：关闭/dispose 与 pending-window 机制收敛（完成代码复审与自动门禁）。** 新增 `closeWorkspaceContentBatch`，统一关闭钩子预检、生命周期批量批准、宿主注入领域关闭操作、部分成功逐项完成 dispose，以及失败项取消关闭；文件关闭和 PTY 单项/批量关闭均接入该流程。自然结束走统一 `disposeWorkspaceContent` 通知入口，重复通知被生命周期状态阻止；适配器 dispose 抛错只记录错误，不复活已提交关闭的内容。独立窗口的计时器登记、超时移除、显式撤销、批量清理及 pending→detached 提升收敛到 `workspaceContentWindowRegistry.ts`，重复登记被拒绝；具体 PTY Rust token、file buffer 与 pane 树变更仍由 host 提供，不被通用设施吞并。
- **阶段 6 代码复审记录：** 第一轮测试发现待启动注册表直接依赖浏览器 `window`；已改用 `globalThis`，并增加无 DOM 测试。第二轮人工复审发现同一内容重复登记可能遗失旧 Promise；已改为拒绝重复 key 并保留原计时器。复审关闭域操作先提交后 dispose、部分成功仅释放成功成员、异常关闭取消 pending 生命周期、单个 PTY 关闭错误不阻止批次继续处理、自然结束和异步 adapter dispose 异常不回滚，并检查 ready/error/timeout/return/provider cleanup 分支均通过共享计时器清理工具移除 pending 注册。独立窗口 GUI 实机回归仍未执行。
- **阶段 6 门禁：** 前端全量 25 个测试文件/164 项通过，`pnpm run build` 通过，TypeScript 检查通过，`cargo test` 240 项通过，`cargo check` 与 `cargo fmt --check` 通过，变更代码和文档已执行 Prettier，`git diff --check` 通过。Monaco 编辑器懒加载 chunk 仍大于 500 KB 并输出既有体积警告。Tauri 原生窗口的 GUI 实机回归未执行；M6 尚不可据此标记整体验收。

- 当前实现使用统一的 pane `contents` 内容引用与 `activeContent`，布局 schema v3 从 v1/v2 迁移；内容标签、菜单、拖放载荷和独立窗口标题/关闭外壳已有共享组件，但内容关闭分派和 PTY/文件 handoff 生命周期仍分叉，详见“全仓抽象边界审查与门禁”。不能据此判定公共内容生命周期已经完成。关闭钩子约定返回 `true` 执行宿主默认关闭、返回 `false` 拦截。项目文件浏览、UTF-8 文本编辑/保存、二进制不可打开说明、安全栅格图片预览、多语言和主题适配已交付。文件服务限定项目根目录、有界目录枚举、2 MiB 文本读取和外部修改保护；命名布局恢复保留当前文档身份及未保存缓冲。
- 内建内容注册已从单体组件拆为启动期可变注册表，校验适配器 ID/API 版本/内容类型冲突并向 React 订阅方发布变化；渲染上下文只按类型注入能力。文本编辑器引擎另有独立注册表，当前首个引擎为懒加载 Monaco；已添加语言扩展名映射、项目路径模型 ID、浅/深主题和保存快捷键。注册表目前只接纳应用编译内建的 PTY/文件内容种类，不运行第三方插件。
- Monaco 构建验证：主应用 JS 492.82 KB（gzip 148.46 KB）；Monaco 懒加载包 3,558.07 KB（gzip 923.29 KB），CSS 151.12 KB（gzip 22.28 KB）；TS worker 最大，为 7,044.98 KB 未压缩。Vite 对懒加载编辑器包显示大于 500 KB 提示；主应用首屏包低于 500 KB。语言定义按文件动态加载。安装体积中 worker 仍需分发，调研细节见 [M6 编辑器与索引调研](M6-editor-and-index-research.md)。
- 工作区索引采用按需持久 metadata cache：使用现有 SQLite cache DB，按项目 ID 缓存相对路径、类型、扩展名、大小、修改时间、隐藏/忽略标记和符号链接状态；不缓存正文或绝对路径。首次请求、显式刷新或 5 分钟 TTL 过期时执行有界重扫，最多 50,000 项、每目录 5,000 项、深度 32；忽略目录只记录不递归，且不跟随符号链接。移除项目时删除对应索引缓存。当前不运行常驻 watcher；按需全文搜索和 LSP 语义索引仍分层留待后续，第三方插件加载未纳入 M6。
- Windows 自动门禁：前端 131 项测试、`pnpm run build`、Rust 240 项测试、`cargo check`、`cargo fmt --check`、变更文件 Prettier 检查及 `git diff --check` 均通过。工作区索引测试覆盖缓存复用与根路径变化/TTL失效、相对元数据、忽略目录、条目/目录/深度上限和符号链接边界。文件打开类型处理另覆盖前端 buffer、图片签名/大小校验和二进制拒绝保存。
- Unix 文件权限保留专项测试已添加，但当前 Windows 主机不能执行；需由 macOS/Linux 构建矩阵实际运行。
- **专项复审修复 1：** 再次核实应用自定义 Tauri commands 默认跨窗口可调用的风险后，为主窗、PTY 独立窗、文件独立窗配置分离的最小 command capability，并以 `AppManifest::commands` 显式生成 ACL；独立文件窗仅开放文本保存命令。恢复主窗 GitHub 外链 URL 限制。文件修订值改为 SHA-256，写回使用独占创建的随机同目录临时文件并由 RAII 清理，避免固定 `.writing` 路径被预置链接占用；补充摘要、非法控制字符、临时文件唯一性/清理测试。`cargo test` 243 项通过，`cargo check` 通过。跨平台文件系统没有对非协作进程写入提供通用 compare-and-swap，最后一次版本检查与原子替换之间仍有极窄竞态，需作为已知平台限制保留；macOS/Linux 权限保留测试仍待对应 CI 矩阵验证。
- **专项复审修复 2：** 确认上下文菜单此前按当前 kind 计算“其他/全部”，且文件标签绕过 PTY 堆叠列表。现在依据 pane `contents` 顺序建立混合 PTY/文件序列，活动项前后的内容统一进入堆叠列表；关闭范围按两类内容共同计数并分发，先统一确认脏文件和运行中的终端，拒绝任一确认时不开始关闭。通用堆叠项保留各 adapter 的标题、关闭文案、拖动与右键能力。新增混合顺序、活动引用缺失回退和跨类型“其他内容”选择测试；前端全量 25 个测试文件/168 项通过。
- **专项复审修复 3：** 确认 PTY adapter 之前返回 `null`、pane 组件自行搬动终端 portal DOM。PTY adapter 现在通过渲染上下文接收当前 portal target，并负责挂载/卸载到公共内容渲染容器；`WorkspaceContentView` 对 PTY 与文件均由已注册 adapter 产生视图。`WorkspacePtySessionRegistry` 仍负责终端实例、portal 生命周期和 PTY 进程，不转移给 UI adapter。注册表测试验证 PTY adapter 返回带注入 target 的视图。生命周期业务数据仍由 coordinator 与领域服务持有，adapter 不直接获得窗格树写权限。`pnpm run build`、`cargo check`、`cargo fmt --check`、Rust 243 项测试及 `git diff --check` 均通过；构建仍显示 Monaco chunk 超 500 KB 的既有体积提示。
- Windows、macOS、Linux 实机上的文件浏览、编辑保存、外部修改恢复、窗格/独立窗口回归尚未完成；在适用平台验收记录补齐前，不标记 M6 整体验收通过。

## 风险与后续

- 文件身份、项目移动、符号链接与布局迁移必须一起处理，不能只依靠前端字符串校验。
- M6 不依赖 IDE 编辑器库；语法高亮、差异装饰与 blame 标记交由后续 M8 评估。
