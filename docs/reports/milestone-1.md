# 里程碑 1 阶段报告：数据层与启动打通

## 目标

把 SQLite 在启动时迁移并接入，让 launch 命令从真实 DB 数据组合命令，前端目录列表显示真实数据。此前 migration 未挂载、目录路径硬编码。

## 完成内容

### 数据库

- `db/connection.rs`：手写迁移 runner，基于 `PRAGMA user_version` 比对，`include_str!` 嵌入 `0001_initial.sql`。迁移与 `user_version` 更新包在同一事务内（BEGIN/COMMIT），避免半迁移状态。`init_database` 在给定路径打开连接并应用迁移。
- `migrations/0001_initial.sql`：`directories` 表新增 `pinned` 列（greenfield，迁移尚未部署）。
- 新增四个 repository：`directory_repo`、`tool_repo`、`shell_profile_repo`、`directory_tool_args_repo`。所有用户可控参数均用 `params![]` 绑定，无注入风险。

### 服务与平台

- `services/launch_service.rs`：`resolve_request` 从 DB 读取目录、工具、默认 shell profile、目录级参数，组合 `LaunchRequest`。`launch` 成功后更新 `last_used_at`。
- `platform/powershell.rs`：修正参数拼接缺陷——此前 `tool_args` 用 `"; "` 连接，会把 `--model opus` 拆成独立 PowerShell 语句；改为单条 `& tool arg1 arg2` 调用。新增 `quote_powershell_arg` 对含空格/特殊字符的参数和可执行文件名做单引号转义。

### 命令与状态

- `lib.rs`：定义 `pub type Db = Mutex<Connection>`；`setup` 中在 `app_data_dir` 初始化 DB 并 `manage`。
- 新增命令模块：`directory`（list/add/update/remove/set_pinned）、`tool`（list_tools）、`shell`（get/save profiles）、`tool_args`（get/save）；`launch` 改用 `State<Db>`。

### 模型

- `Directory` 增加 `pinned` 字段；`Directory`/`Tool`/`ShellProfile`/`DirectoryToolArgs` 统一 `camelCase` 序列化；`ToolKey` 增加 `as_str`/`from_key`。

### 前端

- `lib/tauri.ts`：全部 M1 命令的类型化 invoke 封装与类型定义。
- `store/appStore.ts`：Zustand store（视图、选中目录），视图导航将在 M2 扩展。
- `DirectoryList.tsx`：react-query 拉取真实目录，支持选中高亮、加载/错误/空态。
- `ToolLauncherPanel.tsx`：基于选中目录，从 DB 读工具，悬停预览命令、点击启动。

## 代码审查与修复

经 code-reviewer 审查，修复以下问题：

- **C-2**（修复）：`tool_executable` 未加引号，含空格路径会断裂 → 用 `quote_powershell_arg` 包裹。
- **I-1**（修复）：`directory_repo::add` 的 `.expect` 可能 panic → 改为返回 `QueryReturnedNoRows` 错误。
- **I-2**（修复）：迁移与 `user_version` 更新非原子 → 包进同一事务。
- **I-3**（修复）：`split_args` 不支持带空格的引号参数 → 实现引号感知分词器（单/双引号），并加单测。
- **C-1**（澄清）：`init_script` 未转义属设计如此（它本就是受信任的 shell 初始化脚本配置，非用户自由输入）→ 加注释说明，UI 层须将其排除在普通用户编辑路径之外。

## 验证

- `cargo test`：12 个单测通过（迁移幂等性/版本、命令组合与转义、参数分词）。
- `cargo check`：无警告。
- `pnpm run build`：tsc 类型检查 + vite 构建通过。
- **待人工 UI 验证**：无人值守下未运行 `pnpm tauri dev` 做交互验证。需人工确认：目录列表渲染、选中、悬停预览、点击启动终端的实际效果。

## 已知限制 / 后续

- 全局 CLI 状态、卡片主页 UI 在 M2 实现；当前前端仍是 M1 的列表+面板形态。
- `split_args` 已支持引号，但不处理转义引号（`\"`）等复杂情况，当前场景够用。
