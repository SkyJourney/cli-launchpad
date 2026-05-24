# 里程碑 3 阶段报告：项目详情 + 会话历史

## 目标

项目详情视图：三个 CLI 的会话历史按 Tab 分离展示、一键直接启动、点击恢复历史会话、可折叠命令预览 + 复制。会话采用按需实时读取磁盘（不建缓存表，开销极小且永远最新）。

## 完成内容

### 后端：会话读取与恢复

- `services/session_service.rs`：
  - Claude：解析 `~/.claude/projects/<slug>/*.jsonl`，slug = 路径非字母数字字符替换为 `-`（单测锚定 `C:\Projects\cli-launchpad` → `C--Projects-cli-launchpad`）；session_id = 文件名 stem，title = 首条 user 文本，时间 = 文件 mtime。
  - Codex：递归扫描 `~/.codex/sessions/**/rollout-*.jsonl`，按 cwd 匹配目录，提取 id 与首条 user 文本；UUID 提取用滑窗校验 8-4-4-4-12 hex 形状。
  - Antigravity：无公开会话路径，返回空。
  - 防御式解析：JSON 行解析失败跳过，文件打不开返回空，扫描行数上限。
- `services/launch_service.rs`：新增 `resume()`，按工具构造恢复参数（Claude `--resume <id>` 追加；Codex `resume <id>` 打头并保留配置参数；Antigravity `--conversation=<id>`），复用命令组合。
- `commands/session.rs`：`list_sessions`（async：取目录路径后释放锁，再 spawn_blocking 扫描）、`resume_session`。
- 用 `USERPROFILE` 定位 home，未引入新依赖。

### 前端：项目详情视图

- `views/ProjectDetailView.tsx`：CLI Tab（按状态着色，missing 禁用，自动切到首个可用工具）、一键启动、历史会话列表 + 恢复、可折叠命令预览 + 复制；Antigravity Tab 显示"暂不支持历史列表"。
- `lib/clipboard.ts`：`navigator.clipboard` + `execCommand` 回退，适配 WebView2。
- `lib/format.ts`：新增 `formatRelativeMs`。
- `lib/tauri.ts`：`SessionInfo` 类型 + `listSessions`/`resumeSession`。

## 代码审查与修复

经 code-reviewer 审查，修复：

- **C-1**（修复）：UUID 文件名提取按段数截取不稳健 → 改为滑窗校验 8-4-4-4-12 hex 形状。
- **C-2 / I-3**（修复）：Codex 解析跨记录串话且读完不匹配文件 → 发现 cwd 即判断，不匹配立即返回；元数据扫描设行数上限。
- **I-4**（修复）：Codex 恢复丢弃用户配置参数 → `resume <id>` 后保留配置参数。
- **I-5**（修复）：默认 Tab claude 若未安装则禁用且无法切换 → CLI 状态加载后自动切到首个可用工具。
- **I-6**（修复）：启动/恢复 pending 互不约束可并发触发 → 合并 `anyPending` 守卫。
- 路径匹配的 UNC/8.3 短路径为已知限制（本地桌面场景概率极低）。

## 验证

- `cargo test`：19 项通过（slug、UUID 提取、路径匹配、消息文本解析等）。
- `cargo check`：无警告。
- `pnpm run build`：通过。
- **待人工 UI 验证**：本机 claude/codex 会话能否正确列出（本项目 Claude 会话目录 `C--Projects-cli-launchpad`）、恢复能否带正确 `--resume`/`resume <id>` 启动、Tab 切换与自动选可用工具、命令预览展开与复制。

## 已知限制 / 后续

- Codex 会话解析对 rollout 文件格式做了防御式假设；若官方格式变更需相应调整。
- 路径匹配不处理 UNC / 8.3 短路径。
- 参数编辑在 M4、版本更新/安装在 M5。
