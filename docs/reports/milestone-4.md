# 里程碑 4 阶段报告：项目参数编辑

## 目标

项目参数编辑视图（View C）：按 CLI 分区编辑项目级参数；Claude 提供模型快捷选择（映射 `--model`）；未安装 CLI 分区灰色禁用。复用 M1 已有的 `get_directory_tool_args`/`save_directory_tool_args` 命令，无后端改动。

## 设计要点

每个 (目录, 工具) 的参数存为单一 `args` 字符串（`directory_tool_args.args`）。Claude 的模型快捷选择是便捷操作，直接在该字符串里插入/替换/删除 `--model <id>` token——存储简单，模型选择与"附加参数"输入框是同一字符串的两个视图，天然一致。

## 完成内容

- `lib/args.ts`：`getFlagValue`/`setFlagValue` 操作单一参数字符串中的 flag；正确处理 flag 在末尾无值、删除 flag、以及"下一个 token 是另一个 flag"的情况。
- `lib/tools.ts`：`CLAUDE_MODEL_PRESETS`（默认 / Opus 4.7 / Sonnet 4.6 / Haiku 4.5）。
- `views/ProjectEditView.tsx`：加载目录/工具/CLI 状态/已存参数；按 CLI 分区显示全局参数（只读）、项目级附加参数（可编辑）、Claude 模型快捷选择；未安装工具整块禁用；保存对每个可用工具调用一次 `save_directory_tool_args`，完成后返回详情。
- 样式：编辑分区、模型预设按钮、只读参数块、操作栏。

## 代码审查与修复

经 code-reviewer 审查，修复：

- **C-1**（修复）：`useEffect` 依赖 `savedArgs.data` 引用，窗口失焦/重获焦点触发后台 refetch 会静默覆盖正在编辑的输入 → 用 `seededFor` ref 按目录 id 只 seed 一次。
- **I-2**（修复）：`setFlagValue` 把紧随的另一个 flag 误当作当前 flag 的值，替换时会丢失它 → `hasFollowingValue` 判断下一个 token 是否以 `-` 开头；并改用 `splice` 在正确位置插入值。
- **I-3**（修复）：保存时对未安装（禁用）工具也写空字符串，会清除其数据库中已有参数 → 保存只对非 missing 工具执行。

## 验证

- `pnpm run build`：tsc + vite 构建通过。
- Rust 侧无改动，沿用 M1-M3 的 `cargo test`（19 项）。
- **待人工 UI 验证**：编辑参数页分区渲染、模型快捷选择与附加参数联动、未安装工具禁用、保存后回详情且命令预览反映 `--model`、窗口失焦不丢失编辑。

## 已知限制 / 后续

- 参数字符串按空白分词，不支持带空格的引号值（当前模型 id 与常见 flag 无此需求；后端 `split_args` 已支持引号，前端编辑辅助暂未）。
- 版本检测/安装/更新在 M5；桌面体验与打包在 M6。
