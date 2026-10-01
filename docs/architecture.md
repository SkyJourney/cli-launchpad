# 架构说明

CLI Launchpad 采用 Tauri + React + Rust + SQLite 的分层结构。0.2.4 基线通过系统外部终端启动 CLI；0.3.0 由 Rust 管理 PTY，React 在共享工作区内展示跨项目终端窗格，并可将单个 PTY 暂时呈现在独立 Tauri 窗口。窗格布局使用 React 分栏组件实现，支持递归嵌套与拖动分隔边界调整尺寸。

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
  按 Windows/macOS/Linux 分支负责 CLI 路径解析、外部终端兼容启动及 PTY 实现、参数边界和进程树管理
```

## 0.3.0 PTY 工作台目标架构

PTY 后端和输出流实施决策见 [ADR-0002](adr-0002-embedded-pty.md)。M1 使用 `portable-pty`、xterm.js/Fit addon 和带消费确认的 Tauri Channel；Windows 以 Job Object、Unix 以 PTY 进程组管理进程树。Rust PTY service 持有会话、输出读取和退出监控；UI 关闭或应用退出时由 service 执行有界清理。数据库仅保留会话元数据，启动时将遗留运行态标记为已结束。M1 的 Windows 验收先行，macOS/Linux 实机门禁补齐前不完成该里程碑。

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
- 前端以递归 split tree 表示布局；split 节点记录方向和比例，pane 节点记录会话 ID 列表及活动会话。每个 pane 渲染标题栏和会话切换项；稳定的会话注册区持有 xterm 实例，并通过 portal 容器挂到所属 pane，树结构变化时保留原终端实例。分栏 sash 拖动结果回写运行期比例。Allotment 只负责布局与尺寸约束，不持有 PTY 生命周期。
- 每个会话在布局树或独立窗口中恰好只有一个可见归属。PTY 退出事件从窗格会话列表、独立窗口和前端运行索引中移除该会话；窗格及分栏关系保留为空状态，供用户启动 CLI 或在指定窗格恢复历史会话。项目和 CLI 的窗口序号由工作区内全部 slot 共同维护，独立窗口 slot 也参与计数。失败启动保留错误呈现以便用户识别。
- 独立窗口接管期间提前到达的 PTY 退出事件须与接管返回的 session 元数据合并，避免接管竞态留下无法操作的窗口；独立窗复用 `PtyTerminal` 的会话状态变化，CLI 自然退出后先通知主工作区清理对应 slot，再直接销毁独立窗。关闭或返回的接管竞态可查询 Rust 的权威归属：会话已结束则关闭并清理，控制权已转交则关闭旧窗口，仍由当前窗口控制则保留 PTY 并允许重试交接。
- 每个 PTY 会话独立拥有稳定 ID、项目 ID、工具 key、工作目录、标题和运行状态；前端按 session ID 索引会话，不能再按项目 ID 只保存一个会话。
- CLI 对话 ID 是可选关联，只有从 CLI 权威来源可靠匹配时才保存；应用不缓存 CLI 会话正文或原始摘要。
- 多项目 PTY 在同一工作区中混排。项目选择只改变启动/恢复目标，并突出显示归属该项目的窗格/会话项；聚焦窗格或会话会同步其项目上下文。
- M2 主工作区布局树只保存 PTY 面板引用、排列方向与尺寸比例；分隔条直接调整比例。拖动标题跨窗格、从标题菜单打开独立窗口，或将独立窗口标题拖回指定窗格时，仅转移视图归属；直接移动后清空的源窗格仍保留。M3 再持久化全局混合项目布局和可选布局预设；M2 不持久化独立窗口位置。布局的切换、编辑和删除不能直接终止 PTY。
- M3 持久化自动保存的当前工作区和用户显式保存的命名快照。布局记录包含版本化递归树、稳定 slot 身份、可空的 PTY session UUID、活动标签、焦点、比例和标题状态；当前工作区另存 detached slot 元数据，命名快照不记录独立窗口位置。为已结束或失效引用保存足够的项目/工具/标题快照以显示占位项。slot 身份先于 PTY session ID 产生，二者必须分开保存和校验。Rust workspace layout service 只读写布局元数据，不操作 PTY 生命周期。
- 应用启动先把旧运行状态标记为已结束，再读取、校验和恢复当前布局；hydration 完成前前端不得把空默认树自动保存覆盖数据库。恢复不重启 CLI，也不恢复终端输出或滚屏；已结束会话项从当前工作区移除，保留窗格树、编号、焦点和比例。应用命名快照时只调整主工作区呈现结构；快照外仍运行的主工作区 PTY 按稳定顺序追加到根 pane 并去重。独立窗口中的 PTY 和 detached slot 元数据保持原状，不参加窗格合并或重排，即使快照引用该 slot 也从目标 pane tree 中移除该引用，不触发交接；已结束会话项会被省略但不会收拢窗格。项目或会话身份失效的引用仍局部降级为诊断占位项。
- 当前工作区的用户改动自动保存；命名布局是相互独立的快照。PTY 自然退出时仅移除对应会话项，保留其空窗格和分割关系，且不修改已保存快照；自动标题随项目重命名更新，自定义标题保留原值。
- 跨窗口转移通过有序交接维护 xterm 画面：源窗口暂停输出派发并取得序号水位，等待此前输出写入完成后序列化终端缓冲；目标窗口恢复该快照，Rust PTY service 将事件通道切换至目标窗口并按序重放水位之后暂存的输出，再恢复实时输出。交接期间同一会话只有一个输入/尺寸控制方；失败时恢复源窗口订阅。输出暂存有明确上限，溢出时拒绝转移并恢复原视图，不丢弃或重启 PTY。
- 独立终端窗口由 Tauri `WebviewWindow` 创建，启动参数只含已验证的 session ID 与一次性交接令牌；窗口启动后从 Rust 读取会话元数据，不信任 URL 中的项目、CLI 或路径。独立窗口只提供一个终端和“返回工作区”入口，不暴露分栏操作。关闭请求先完成交接并将 PTY 送回主窗口当前焦点 pane；若该 pane 已不存在则回退到根 pane。
- 标题在主窗口内跨 pane 拖放使用 HTML 拖放；跨 Tauri WebView 的标题拖放作为 Windows 能力探测项。失败或不支持时，右键菜单的“返回工作区”保持完整功能，不以拖放 API 是否可用作为 PTY 生命周期的前提。
- PTY 输出使用有界、可背压的数据通道，避免高频 TUI 输出阻塞 Tauri IPC 或耗尽前端内存；具体传输机制和 PTY crate 在 M1 技术评审确认。
- 数据库持久化 PTY 会话元数据；M2 的活动布局仅驻留当前应用运行期，M3 增加布局持久化，不持久化终端输出或滚屏。隐藏到托盘时应用及 PTY 继续运行；用户显式退出时，若有活动 PTY 先请求确认，确认后由 Rust 结束全部托管 PTY 再退出，取消则保留应用和会话。PTY 进程树必须受应用与平台进程隔离机制管理，应用异常退出时不得遗留失管子进程；M1 实现并验证，M5 跨平台复验。系统重启后不接管进程；旧会话元数据与布局恢复为已结束状态，可重新启动或通过 CLI 历史恢复，不能显示成仍在运行。
- PTY service 必须为 Windows、macOS 与 Linux 提供一致的上层会话接口，并在平台层处理终端尺寸、信号/进程树、编码和环境差异。

```text
projects
  └── pty_sessions (session_id, project_id, tool_key, cwd, title, cli_conversation_id?, state)

workspace_state (M3, 单条当前布局记录)
  ├── versioned pane tree (pane/split IDs, pane number, slot_instance_id, pty_session_id?, project/tool/title snapshot, orientation, size_ratio, focus)
  └── detached slot metadata (session view was in a standalone window)

workspace_layout_presets (M3, 多条命名快照)
  └── versioned pane tree (独立快照，不拥有 PTY)
```

以上为目标概念模型；具体 JSON DTO 和 SQL 字段由 M3 阶段 0 设计确认。M2 实现运行期工作区布局；M3 验收 SQLite schema、数据迁移、自动保存、命名快照、活跃 PTY 合并与失效引用策略。当前布局和命名快照都属于 SQLite 业务数据，包含在 SQLite 一致性备份中；JSON 配置 bundle 不导出也不覆盖这两类布局数据。

## 0.2.x 外部终端兼容启动架构

0.2.4 的完整路径解析、终端探测、结构化参数和安全边界作为兼容基线保留。0.3.0 工作台的普通 CLI 启动与历史恢复统一使用内置 PTY；用户界面不提供外部 CLI 启动选项或普通启动命令预览，PTY 启动失败时直接显示错误。内置 PTY 启动不得退化为临时拼接命令字符串。

## 全局 CLI 状态

应用启动时检测当前已接入的 CLI，G1 完成后为四项工具提供统一全局状态，可手动刷新。打开设置页时同步刷新 Grok 官方最新版本；其他最新版本沿用缓存和手动刷新策略。前端引入轻量全局状态库（如 Zustand）持有该状态。

```text
cli_status
  claude:  { status, path, version, latest_version, resolved_command }
  codex:   { status, path, version, latest_version, resolved_command }
  agy:     { status, path, version, latest_version, resolved_command }
```

状态只有两种：available（绿色，可启动可编辑）、missing（灰色，禁用）。由于启动一律走解析出的完整路径，"PATH 是否可见"不再单独建模——在 PATH 或已知目录找到全路径即为 available。详见 `docs/ui-design.md`。

## Tauri commands 清单

```text
项目
  list_directories / add_directory / update_directory / remove_directory / set_directory_pinned

启动
  preview_launch / launch_tool / resume_session

PTY 工作台（0.3.0 目标）
  create_pty_session（新建或按已验证的 CLI session ID 恢复） / write_pty_session / resize_pty_session
  terminate_pty_session / list_pty_sessions / get_pty_session
  outputs and state changes streamed from Rust to the matching terminal view

工具
  list_tools

CLI 状态与版本
  detect_cli_status            被动检测安装与全路径；显式刷新时才执行 --version
  fetch_latest_versions        从已接入 CLI 的官方来源查询最新版本
  get_install_plan             返回结构化安装/更新命令（仅预览，不执行）
  start_execution_task         创建后台安装/更新任务
  list/get/cancel/clear_execution_task(s)  查询、终止与清理任务

会话历史
  list_sessions                按目录和工具实时读取会话
  set/delete_session_alias     设置或删除匹配会话 ID 的本地别名
  PTY 恢复前重新验证 CLI session ID 属于目标项目，再将 CLI 专用参数传给内置 PTY

模型目录
  get_model_catalog            获取已接入 CLI 的模型选项，支持强制刷新（0.3.0 工作台不展示模型配置）

终端启动配置
  detect_terminal_environment / get_launch_target / set_launch_target

桌面行为配置
  get_close_behavior / set_close_behavior

配置备份
  export_config_to_path / import_config_from_path   读写 JSON 文件（配合文件对话框）
```

commands 保持小而清晰，业务组合放在 services。

## 桌面集成

- 系统托盘：核心 `tray-icon` 能力，菜单提供"显示主界面/退出"，左键双击托盘显示并聚焦窗口。
- 关闭窗口行为：设置页可选"最小化到托盘"或"退出应用"，默认关闭到托盘；策略持久化到 SQLite，Rust 窗口事件直接执行该策略。
- 0.3.0 生命周期：关闭到托盘不退出应用，PTY 保持运行；关闭行为设为退出或从托盘菜单显式退出时，活动 PTY 必须经过确认，确认后终止托管进程树，取消则不退出。异常退出/系统重启后不接管旧进程；启动时将持久化活动记录标记为已结束并从当前工作区移除对应会话项，保留窗格和分栏，不恢复终端输出或滚屏。项目或会话身份失效时仍显示局部诊断占位项。
- 窗口状态持久化：`tauri-plugin-window-state` 在 Rust 层自动保存/恢复窗口尺寸与位置，并排除可见性状态，避免关闭到托盘导致下次启动隐藏。插件恢复后，启动校正按与窗口重叠最大的显示器工作区约束窗口；完全离屏时回退主显示器，再回退第一台可用显示器。校正保留显示器可容纳的窗口最小尺寸，并在小屏上降低最小值；最大化和全屏状态交由系统恢复。
- 文件对话框：`tauri-plugin-dialog` 用于添加目录的文件夹选择器、配置导入导出的文件选择（capability 放行 `dialog:allow-open` / `dialog:allow-save`）。
- 单实例：`tauri-plugin-single-instance` 阻止多个 GUI 进程并行写入同一业务数据库，二次启动改为聚焦现有主窗口。
- macOS 生命周期：用户点击 Dock 图标重新激活应用时处理 `RunEvent::Reopen`，显示、取消最小化并聚焦主窗口；菜单栏状态项沿用“显示主界面/退出”入口，不依赖 Windows 双击语义。

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

可移植 JSON 配置 bundle 不再导出全局或项目级 CLI 参数；导入旧版 bundle 时忽略这些兼容字段。配置导入不接受 Shell 程序或初始化脚本。导入目录必须是绝对路径，存在的目录会规范化为稳定身份。配置导出不包含日志、缓存、备份、窗口位置、自动保存的当前工作区、命名布局快照或外部 CLI 会话正文；配置导入也不覆盖工作区布局。SQLite 备份包含当前工作区和命名布局。SQLite 中 0.2.x 遗留的参数字段与记录暂时保留以兼容旧数据库和备份，但当前启动链不读取它们。

`launch_history` 仅记录目录、工具、启动或恢复动作、成功状态与错误
类别，不持久化最终命令或参数文本。添加目录和实际发起启动时，Rust
服务层均验证项目路径存在且为目录，失效路径会保留配置并返回修正提示。

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
- `.github/workflows/release.yml` 以 `v*.*.*` Tag 作为正式发布入口，先校验 `package.json`、Tauri 配置和 Cargo 包版本，再并行构建 Windows 在线/离线 NSIS、Linux x64/arm64（deb+rpm+AppImage，arm64 用原生 ARM64 Runner）、macOS ARM64 DMG 和 macOS Intel DMG。只有全部 target 成功后才汇总产物、生成 `SHA256SUMS.txt` 并自动创建 GitHub Release；手动触发仅产生短期 Actions Artifacts。发布资产统一使用 `CLI.Launchpad_<版本>_<系统>_<架构>[后缀]` 命名，不沿用各打包工具（尤其是 rpm）的原生命名格式。
- macOS 线上构建当前使用 ad hoc 签名，不依赖仓库 Secret，也不执行 Apple 公证。后续购买 Developer ID 后，可在保持矩阵与产物汇总结构不变的前提下补充证书导入、公证和 stapling 步骤。
- UI 内置 Noto Sans SC 的 100–900 可变 TTF，并采用 400、500、600、700 四个主要字重；命令、路径、参数和日志内置 Maple Mono NL NF-CN v7.9 的相同四个静态字重。两套字体通过 Vite 前端产物进入各平台安装包，不依赖系统字体安装，并在关于页内置各自的 SIL OFL 1.1 文本。

## 目标 CLI 范围

0.3.0 G1 完成后支持四个核心 CLI：

| 工具            | 默认命令 | 兼容命令      | 说明                                               |
| --------------- | -------- | ------------- | -------------------------------------------------- |
| Claude Code CLI | `claude` | 无            | 打开 Claude Code 工作会话                          |
| Codex CLI       | `codex`  | 无            | 打开 Codex CLI 工作会话                            |
| Antigravity CLI | `agy`    | `antigravity` | `agy` 是官方主命令，`antigravity` 仅作保守兼容探测 |
| Grok Build CLI  | `grok`   | 无            | 官方 Grok Build 交互式 CLI                         |

其他 CLI 工具不进入当前检测、安装或启动设计。M1/M2 文档记录的是 Grok 接入前的阶段验收事实；G1 完成后，当前产品能力以四 CLI 为准。

## 0.2.x 外部终端启动组合

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

恢复会话通过 `resume_session`，按工具拼装恢复参数后复用同一组合逻辑（Claude `--resume <id>`、Codex `resume <id>`、Antigravity `--conversation=<id>`）。

## CLI 检测与安装

CLI 检测区分两种状态（启动走全路径，不再区分 PATH 可见性）：

- available：在当前 PATH 或已知安装目录解析到完整路径（含 `agy` → `antigravity` 兼容探测）。
- missing：未找到。

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

安装通道只服务 `claude`、`codex`、`agy`、`grok` 四个目标 CLI，不扩展为通用包管理或通用 CLI 安装器。

## 版本检测与更新

设置页提供最新版本查询与应用内更新入口。为避免应用启动时执行 PATH
中的第三方程序，被动检测不自动调用 CLI 的 `--version`；只有用户显式
点击重新检测或安装/更新完成后的刷新才会对已解析的完整路径执行有界版本
探测。版本命令固定为 `--version`，并以超时、无窗口方式捕获输出。

```text
最新版本
  Claude：downloads.claude.ai 原生发布 latest 端点
  Codex：releases.openai.com Codex latest channel
  Antigravity：官方安装器使用的平台 manifest
  Grok Build：打开设置页或用户显式刷新版本时运行官方 `grok update --check --json`，解析 `latestVersion` 和 `installer`，不触发更新；启动子进程时移除 pnpm 注入的 `npm_config_user_agent`，避免把官方原生安装误判为 npm 安装；Windows 官方 stable 二进制地址不作为版本号 API。

更新命令（结构化参数，先预览后确认）
  Claude：claude update
  Codex：codex update
  Antigravity：agy update
  Grok Build：grok update（计划只定位可执行文件；任务启动后在后台复核 JSON 的 `installer=internal` 与 `.grok/bin` 或 `GROK_BIN_DIR` 路径，校验通过才执行；更新子进程移除 pnpm 注入的 `npm_config_user_agent`）
```

更新与安装走同一流程：预览命令、用户确认、输出日志、完成后主动探测当前
版本并刷新全局 CLI 状态。当前版本和最新版本查询分别返回失败原因；网络
查询失败时可使用已有缓存，不阻塞安装状态与路径展示。

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

任务创建时只接受内置四工具清单生成的 `InstallPlan`，持久化工具、类型、来源、
程序、参数数组和预览，不保存环境变量或自由命令。任务管理器按 `ToolKey` 保存
活动任务：同一 CLI 内互斥，四个 CLI 之间可并行；每项任务持有独立取消信号和
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
```

读取逻辑放在 service，解析出原始标题、时间、session id，并严格匹配当前项目目录或
workspace URI。Claude 标题优先级为 `summary`、`firstPrompt`、首条用户消息；Codex 为
`name`、`preview`、首条用户消息；Antigravity 为数据库 `title`、metadata `summary`、
数据库 `preview`；Grok 仅从 summary metadata 取标题/摘要和 `cwd` 等归属字段，不读取
`updates.jsonl` 或 transcript。读取故障会明确返回错误而不是伪装为空列表；恢复或修改别名前会再次
验证 session 仍归属于当前目录。

路径身份比较遵守平台语义：Windows 规范化分隔符并忽略大小写；macOS 对存在
路径优先使用 `canonicalize` 后比较，不将路径统一转为小写，对暂时不存在的路径
只做 POSIX 分隔符与尾部分隔符的词法规范化。CLI 状态缓存中的可执行路径比较
使用同一规则，避免大小写敏感卷上的错误复用。

列表默认每页 10 条，Claude、Antigravity 与 Grok 使用有界 offset cursor，Codex 透传并封装
App Server cursor。前端为每个 CLI 保留独立无限查询，点击“更多”按 10 条追加。项目级
搜索读取可重建的 cache DB 索引，只匹配四个 CLI 实际展示的标题、summary 和受限首条用户消息/preview，
不扫描完整正文；不调用 `grok sessions search`（官方定义的结果可能混合本地索引和远端会话）。项目激活或手动刷新时
有界更新索引，FTS5 trigram 支持子串查询，1–2 个字符使用短词回退；每次查询最多返回 2,000 条匹配结果。
前端只在内存中保留当前查询快照，并按 10 条递增显示。清除查询或切换项目时释放该快照；缓存索引按项目 ID
隔离，不持久保存项目路径或完整对话正文。超过结果上限或来源读取不完整时，响应列出受影响的 CLI。

用户手动重命名时才向 `session_aliases` 写入 `tool_key + session_id + alias`；普通会话不会
批量入库。列表读取到真实会话后才合并匹配别名，因此孤立记录不会生成虚假会话。删除别名
即恢复 CLI 原始标题。

恢复会话通过 `resume_session` command，按工具拼装恢复参数：Claude 用 `--resume <id>`，Codex 用 `resume <id>`，Antigravity 用 `--conversation=<id>`，Grok Build 用 `--resume <id>`。恢复参数与普通启动共用命令组合与转义逻辑。

## 安全边界

- 目录路径来自用户输入，启动前必须验证。
- Windows 路径切换使用 `Set-Location -LiteralPath`。
- macOS 路径和参数使用 POSIX 单引号字面值编码，单引号按关闭、转义、重新打开的规则处理，不允许未编码内容进入启动载荷。
- 工具可执行文件和参数分开建模。
- 终端探测与启动计划分别集中在 `platform/terminal.rs` 和 `platform/terminal_launch.rs`，内部通过平台模块隔离 Windows、macOS 与 Linux 逻辑。
- CLI 安装与更新计划在用户确认前显示来源和命令；0.3.0 普通 CLI PTY 启动不展示命令预览。
- 不在 SQLite 中保存密钥。如果未来需要凭据，使用操作系统凭据存储。

## 跨平台发布约束

- 0.2.x 的外部终端启动策略已在 Windows、macOS、Linux 实现，仅作为旧版本兼容能力保留；0.3.0 工作台不提供外部启动入口，PTY 启动失败时显示明确错误，不静默回退。
- macOS 分别发布 Apple Silicon 与 Intel DMG，不发布 Universal DMG；两个架构均需独立完成构建和运行验证。
- macOS DMG 的 target 配置与功能实现分离；内部未签名测试包可以用于本机验证，正式跨设备分发仍需有效 Developer ID Application 身份、公证凭据和 stapling 验证。
- 0.3.0 的 PTY 生命周期、内置终端交互、布局、升级迁移和安装包验收按 `docs/milestones/0.3.0/M5-release-readiness.md` 执行。
