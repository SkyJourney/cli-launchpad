# Memory Index
> _Last synced: 2026-05-23 | Base commit: `b99a354`_

## 启动引导

新会话或上下文压缩后，先读本文件索引，再按需加载记忆文件。代码、文档与记忆冲突时，以代码和当前文档为准，并更新记忆。

### 读取流程

1. 读取 `MEMORY.md` 获取清单。
2. 必读 project 和 feedback 类型文件。
3. 按需读取 user、reference、synthesis、lint 类型文件。

| 文件 | 描述 | 类型 | 引用 | Commit |
| --- | --- | --- | --- | --- |
| `decisions.md` | 当前关键架构和产品决策 | project | 8* | `b99a354` |
| `feedback.md` | 用户协作偏好和范围纠正 | feedback | 4* | `b99a354` |
| `reference.md` | 官方资料摘要和外部依据 | reference | 3* | `b99a354` |
| `project_overview.md` | 项目技术栈、边界、工具链和核心 CLI 范围 | project | 2 | `b99a354` |
| `project_progress.md` | 当前项目进度、已完成事项和近期待办 | project | 2 | `b99a354` |
| `lint_report.md` | 记忆健康检查报告 | lint | 0 | `b99a354` |
