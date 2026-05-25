# Memory Lint Report
> _Last checked: 2026-05-25 | Base commit: `3ad8ce1`_

## 健康概览

- 记忆目录：`.codex/memory/`
- 索引文件：6
- 磁盘记忆文件：6
- 孤儿：0
- 幽灵：0
- 断链：0
- NEED-HUMAN：1 类（8 条章节级反向链接待处理）

## AUTO-FIX 已执行

- 校验 Wiki 链接目标，当前无断链、孤儿或幽灵文件。
- 刷新 `MEMORY.md` 的同步锚点、文件 commit 和引用计数，并按引用次数重新排序。

## 条目级高频引用 Top

- `decisions.md`：16 次文件级引用。
- `project_overview.md`：8 次文件级引用。
- `project_progress.md`：6 次文件级引用。
- `feedback.md`：4 次文件级引用。
- `reference.md`：3 次文件级引用。

## NEED-HUMAN

### 章节级反向链接补齐

- **位置：** `decisions.md#只聚焦三项核心-CLI` → `project_overview.md#核心-CLI-范围`；`decisions.md#Antigravity-使用-agy-作为官方主命令` → `reference.md#官方-CLI-资料`；`decisions.md#安装命令必须来自官方来源` → `reference.md#官方-CLI-资料`；`project_overview.md#存储与可靠性边界` → `project_progress.md#可靠性治理完成`；`project_overview.md#See-Also` → `feedback.md#不要扩展为通用-CLI-管理器`；`project_progress.md#已完成功能` → `project_overview.md#桌面体验与分发`；`project_progress.md#See-Also` → `decisions.md#启动必须使用解析后的完整可执行路径`；`reference.md#官方-CLI-资料` → `project_progress.md#已完成功能`。
- **Q1：** 这些跨文件引用的目标章节是否仍是正确的事实归属？（是/否）
- **Q2：** 是否需要为上述 8 条引用在目标章节内补充精确反向链接？（是/否）
- **Q3：** 是否允许后续一次性调整现有 `See Also` 布局以满足章节级双链校验？（是/否）
- **决策矩阵：** Q1 否 → 删除或改向错误引用；Q1 是且 Q2 是 → 在目标章节补充反链并重新 lint；Q1 是且 Q2 否 → 保留文件级关联并将此检查项标记为接受的例外；Q3 是 → 可在一次独立记忆整理中统一处理全部反链。

## 未执行项或跳过项

- 章节级缺失反向链接共 8 条，超过自动补链阈值（5），未自动修改。
- 本次未创建 `synthesis_*.md`；`decisions.md`、`project_overview.md` 与 `project_progress.md` 达到高频引用候选阈值，仅作为候选保留。
- 未修改业务代码、产品文档或 Tauri 配置。
