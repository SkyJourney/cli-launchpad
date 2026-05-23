# 路线图

## 阶段 1：可启动 MVP

- 启动时应用 SQLite migrations。
- 添加目录 CRUD。
- 添加工具和 Shell profile CRUD。
- 内置 Claude Code、Codex、Antigravity 三个工具配置。
- 实现命令预览。
- 通过 Windows Terminal 和 PowerShell 打开指定目录下的目标 CLI。

## 阶段 2：可用性增强

- 目录搜索和置顶。
- 最近使用排序。
- 拖拽导入文件夹。
- 目录级工具参数编辑。
- 命令复制按钮。
- 启动前检测目标 CLI 是否可用。
- 对 `agy` 不可用但 `antigravity` 可用的情况给出保守兼容提示，不把 `antigravity` 作为推荐启动命令。

## 阶段 3：依赖检测与安装引导

- 增加 Claude Code、Codex、Antigravity 的状态面板。
- 展示工具版本、可执行文件路径和 PATH 可见性。
- 为缺失工具提供安装建议。
- 设计一键安装流程：命令预览、用户确认、日志输出、完成后重新检测。
- 对安装后 PATH 未刷新的情况提供重启终端或刷新环境变量提示。

## 阶段 4：桌面体验和内部发布

- 系统托盘快速启动。
- 窗口状态持久化。
- 配置导入和导出。
- Tauri Windows 打包，优先支持公司内部可分发安装包。
- 明确 MSI/NSIS 选择、签名、版本号和升级策略。
- 后续评估 macOS/Linux 启动辅助。
