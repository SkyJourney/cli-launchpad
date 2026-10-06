# 0.4.0 里程碑索引

目标：在 0.3.0 项目与 PTY 工作台上，增加项目文件管理、窗格内文本编辑、Markdown 连续预览，以及完整的本地和远程 Git 工作流。

仓库克隆不属于目标；项目仍从用户登记的已有本地目录开始。所有里程碑共同组成 0.4.0，阶段验收不等于版本发布。实施须遵守产品需求、架构和 UI 设计文档中定义的 Rust 所有权、路径安全、系统认证及窗格适配器边界。

| 编号 | 里程碑                    | 依赖  | 验收文档                       |
| ---- | ------------------------- | ----- | ------------------------------ |
| M6   | 内容窗格与文件工作区      | 0.3.0 | [M6](M6-workspace-files.md)    |
| M7   | Markdown 连续预览         | M6    | [M7](M7-markdown-preview.md)   |
| M8   | 本地 Git 管理与编辑器联动 | M6    | [M8](M8-local-git.md)          |
| M9   | Git 远程与系统认证        | M8    | [M9](M9-git-remotes-auth.md)   |
| M10  | Rebase 与冲突恢复         | M9    | [M10](M10-rebase-conflicts.md) |

M7 与 M8 可在 M6 验收后并行推进；M9 依赖 M8 的 Git service 和状态模型；M10 依赖 M9 的远程同步流程。M7 结果不阻塞 Git 主线，但必须纳入 0.4.0 最终集成验收。

## 全版本非目标

- 不克隆仓库；不管理 Git worktree。
- 不提供分页式 Markdown 排版或 PDF/Word 导出。
- 不嵌入完整 VS Code、Theia 或第三方 IDE 插件运行时。
- 不独立保存 Git 账号、密码、访问令牌或 SSH 私钥；认证依赖系统 Git credential helper、系统凭据存储和 SSH agent。
- 不允许前端执行自由 Git 命令；Git 能力通过 Rust 服务及结构化系统 Git 参数实现。

## 共同验收要求

- M6–M10 每阶段按文档中的门禁逐项记录通过、失败、跳过和环境限制。
- Windows、macOS、Linux 均执行适用的自动测试和实机验收；系统 Git 缺失、凭据助手缺失和 Linux 无可用凭据存储都必须可解释降级。
- 任何阶段均不得回归 0.3.0 已验收的 PTY 生命周期、独立窗口交接、窗格分栏、主题同步、布局保存/恢复和项目上下文。
- M10 完成后进行需求追踪、完整代码审查、审查修复复审、全量自动门禁和跨平台最终验收；通过后再独立准备 0.4.0 发布。

## 状态

- M6：第四波 WP7 文档追溯、扩展成本演练、本机自动门禁及三平台 CI 均已完成；CI run [37436033117](https://github.com/SkyJourney/cli-launchpad/actions/runs/37436033117) 的 Windows、macOS、Ubuntu jobs 全部通过。成本目标尚未达成，X-F05 CSP 三平台生产包运行检查和 Windows、macOS、Linux 实机验收尚未执行；A/B 层均未关闭，M7 不得开始。状态与实机验收矩阵见 [M6](M6-workspace-files.md) 和[基础抽象审查报告](M6-abstraction-baseline-audit.md)。
- M7–M10：M6 A/B 门禁关闭前不得开始。
