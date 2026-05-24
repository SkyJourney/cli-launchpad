# 里程碑 2 阶段报告：全局 CLI 状态 + 卡片主页

## 目标

启动时检测三个 CLI（claude/codex/agy）并作为全局状态贯穿所有视图；前端重写为 cc-switch 风格的多视图结构，项目主页以卡片网格展示，卡片上 CLI 状态徽章按可用性着色，可点击徽章直接启动。

## 完成内容

### 后端：CLI 检测

- `platform/detect.rs`：
  - `which`：用 `where.exe` 解析 PATH 命令。
  - `run_version`：`cmd /C <cmd> --version` 取版本，stdout 失败回退 stderr。
  - `find_in_known_dirs`：检查 npm 全局、WinGet Links、`~/.local/bin`，用于区分"已安装但 PATH 不可见"与"未安装"。
  - 所有子进程调用基于 `tokio::process` + `tokio::time::timeout` + `kill_on_drop(true)`，超时自动杀进程，杜绝挂起泄漏。
- `services/cli_detect_service.rs`：异步检测三工具，得出 `available | path_not_visible | missing`；agy 候选含 `antigravity` 兼容探测（不作推荐命令）。
- `commands/cli_status.rs`：`detect_cli_status`（async）。
- `models/cli_status.rs`：`CliStatus` / `CliAvailability`。
- 新增依赖 `tokio`（process + time）。

### 前端：视图路由 + 卡片主页

- `App.tsx`：按 Zustand `view` 状态切换四视图。
- `components/Sidebar.tsx`：品牌 + 项目/设置导航。
- `views/ProjectsView.tsx`：卡片网格、搜索（名称/路径）、排序（最近/名称）、添加目录表单（react-query useMutation）、重新检测按钮。
- `components/ProjectCard.tsx`：名称/路径/相对时间、三 CLI 状态徽章（available 可点击启动，missing 灰禁用）、置顶/编辑/移除操作；移除用应用内两步确认（点击→确认，4 秒自动取消）。
- `views/{ProjectDetail,ProjectEdit}View.tsx`：占位（M3/M4 填充），带返回与目录信息。
- `views/SettingsView.tsx`：用 M2 检测能力展示 CLI 状态面板（状态徽章、路径、当前版本）+ 重新检测；版本对比/更新留 M5。
- `hooks/useCliStatus.ts`、`lib/tools.ts`、`lib/format.ts`：全局 CLI 状态 hook、工具元数据、相对时间格式化。
- 删除被取代的 `DirectoryList.tsx` / `ToolLauncherPanel.tsx`（启动 UI 将在 M3 详情页回归）。

## 代码审查与修复

经 code-reviewer 审查，修复：

- **C-1**（修复）：`run_version`/`which` 无超时，子进程挂起会泄漏线程 → 改用 `tokio::process` + timeout + `kill_on_drop`。
- **C-2**（修复）：只读 stdout 忽略 stderr，部分 CLI 版本号显示"未知" → stdout 失败回退 stderr，不强制要求退出码为 0。
- **I-3**（修复）：ProjectsView 刷新按钮无 `isFetching` 防护，可快速点击堆积并发检测 → 加 `disabled` + 旋转指示。
- **I-4**（修复）：`window.confirm` 在 Tauri WebView2 行为不可靠 → 改为 ProjectCard 内的应用内两步确认，不依赖 dialog 插件。
- 审查另两项（事件冒泡、枚举键不匹配）经核验为非问题，未处理。

## 验证

- `cargo test`：14 项通过。
- `cargo check`：无警告。
- `pnpm run build`：tsc + vite 构建通过。
- **待人工 UI 验证**：卡片渲染、徽章着色随本机实际 CLI（本机 claude/codex 应为绿、agy 灰）、徽章启动、搜索/排序/添加/置顶/两步移除、视图切换、设置页检测刷新。

## 已知限制 / 后续

- 添加目录用文本输入路径，原生文件夹选择器留待 M6（需 tauri-plugin-dialog + capabilities）。
- 详情页会话历史与一键启动在 M3 实现；参数编辑在 M4；版本更新/安装在 M5。
