# M10：Rebase 与冲突恢复

## 目标

体系化支持分支分叉后的显式整合、rebase/merge 冲突管理和安全恢复，完成 0.4.0 Git 工作流。

## 依赖与设计门禁

- 依赖 M9 remote、认证、Fetch/Push 和快进拉取能力。
- 在用户可见策略中区分快进、rebase 和 merge；任何非快进操作均须由用户选择，不跟随未经提示的 Git 全局默认配置。
- Git 操作状态由仓库本身判定；应用重启或外部 Git 命令改变状态后，重新发现进行中的 merge/rebase，不以 UI 本地标记伪造状态。
- 冲突 UI 与 M6 编辑器共享文件打开能力；区分 base/ours/theirs/current result，继续操作前验证冲突已解决并加入索引。
- 检查脏工作树、未暂存与已暂存修改、冲突期间的禁用操作、取消与进程中断恢复边界。

## 范围

- 提供分支分叉状态和整合策略说明；支持显式快进、rebase 与 merge 流程。
- Pull 分叉时可选择 rebase 或 merge；不隐式 stash、覆盖或改写已发布提交。
- 冲突列表提供文件路径、冲突类型、差异预览和打开编辑器入口。
- 文本冲突可查看 base/ours/theirs 和当前结果；用户解决后将文件加入 index 并验证 Git 冲突状态清除。
- 提供 continue、skip（适用于当前 rebase commit）和 abort 操作；每项操作展示作用及历史改写影响。
- 支持应用重启、网络失败、用户取消和外部 Git 修改后恢复正在进行的操作。
- 只有操作完成并重新读取状态后，才更新本地/远端 ahead-behind 和编辑器 gutter/blame。

## 非目标

- 不提供自动替用户选择 ours/theirs 或自动删除冲突一方内容。
- 不实现复杂交互式 rebase todo 编辑、提交拆分/重排、cherry-pick 工作台或任意 mergetool 管理。
- 二进制冲突不在编辑器内合并；展示冲突并说明须使用外部工具处理。

## 任务清单

1. 建立 merge/rebase Git 原生状态检测、冲突 stage 映射和可恢复状态机。
2. 设计脏工作区保护、操作预览、进程取消和退出/重启恢复契约。
3. 实现显式整合策略、快进/rebase/merge 流程与状态回读。
4. 实现冲突文件列表、三方差异、编辑、stage、continue/skip/abort。
5. 对文档编辑、Git stage 和 conflict resolution 的并发修改进行保护。
6. 完成全量代码审查闭环、M6–M10 回归及 0.4.0 发布门禁。

## 验收覆盖

- Pull：无需更新、正常快进、远端已前进、本地分支分叉且 ff-only 被拒绝、rebase 成功、merge 成功。
- 冲突：单文件文本冲突、多文件冲突、已解决但未 stage、stage 后 continue、rebase skip、rebase abort、merge abort。
- 保护：有 staged/unstaged 修改时启动整合、冲突期间切换分支/commit/push、二进制或删除/重命名冲突、外部 Git 同时操作。
- 生命周期：应用在冲突期间重启；用户取消网络操作；Git 子进程异常退出；再次打开仓库后状态仍准确可操作。
- 一致性：每次继续/中止后重新查询 Git；冲突标记消除、stage、分支指针、ahead-behind、编辑器行标记和 remote 状态一致。
- 实机：Windows、macOS、Linux 使用本地构造仓库完成所有自动化冲突 fixture；各平台至少一次真实远程快进和分叉同步验收。

## 验收条件

- 所有 pull 整合策略显式且可理解；快进失败不会隐式转成 merge/rebase。
- 用户可在应用内理解和恢复 rebase/merge 冲突，或安全中止回到操作前状态。
- 任何不确定/损坏状态都禁止可能丢数据的后续 Git 操作，并提供重新扫描和恢复说明。
- M6–M10 全部验收通过、最终代码审查与修复复审闭环、跨平台发布门禁通过，才可将 0.4.0 标记为发布候选。
