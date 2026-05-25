# 路线图

界面采用 cc-switch 风格的多视图结构，详见 `docs/ui-design.md`。路线图按"先打通数据与启动，再叠加视图能力"推进。

## 阶段 1：可启动 MVP

- 启动时应用 SQLite migrations。
- 添加目录 CRUD。
- 添加工具和 Shell profile CRUD。
- 内置 Claude Code、Codex、Antigravity 三个工具配置。
- 实现命令预览。
- 通过 Windows Terminal 和 PowerShell 打开指定目录下的目标 CLI。

## 阶段 2：全局 CLI 状态与卡片主页

- Rust 层实现 CLI 检测 service，得出 available / missing（启动走全路径，不区分 PATH 可见性）。
- 前端引入全局状态库，持有全局 CLI 状态和视图状态。
- View A 项目主页：卡片网格、状态徽章、添加目录、排序、搜索、置顶。
- 卡片徽章直接启动，缺失工具灰色禁用。

## 阶段 3：项目详情与会话历史

- View B 项目详情：三个 CLI 会话历史 Tab、一键直接启动、可折叠命令预览和复制。
- 读取 Claude Code（`~/.claude/projects/`）和 Codex（`~/.codex/sessions/`）的会话索引并展示。
- Antigravity Tab 不展示历史，只提供直接启动。
- 实现 `resume_session`，按工具恢复指定会话。
- 会话索引缓存到 SQLite，可删除重建。

## 阶段 4：项目参数编辑

- View C 参数编辑：按 CLI 分区配置项目级参数。
- Claude 区提供模型快捷选择。
- 项目级参数与全局参数分离，保存到 SQLite。
- 未安装的 CLI 分区灰色禁用。

## 阶段 5：依赖检测、安装与版本更新

- View D 设置页：CLI 状态面板，展示版本、路径、PATH 可见性。
- 查询最新版本，对有新版的 CLI 提供应用内更新入口。
- 一键安装流程：命令预览、用户确认、日志输出、完成后重新检测。
- 更新流程复用安装流程的确认与日志机制。
- 对安装/更新后 PATH 未刷新的情况提供重启终端或刷新环境变量提示。

## 阶段 6：桌面体验和内部发布

- 系统托盘快速启动。
- 关闭窗口行为配置：默认最小化到托盘，支持改为退出应用，并支持双击托盘恢复主界面。
- 窗口状态持久化。
- 配置导入和导出。
- Tauri Windows 打包，优先支持公司内部可分发安装包。
- 明确 MSI/NSIS 选择、签名、版本号和升级策略。
- 后续评估 macOS/Linux 启动辅助。
