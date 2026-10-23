# m6-108 产品规格：“保存全部并退出 / 关闭”与共用确认组件

> 状态：已实现（2026-10-21）。退出对话框的按钮文案保持现状（“放弃更改并退出”），仅新增“保存全部并退出”。依据：待办台账 H1；现状调研见下文第 2 节（代码位置均已核对）。

## 1. 问题

退出应用与关闭内容时，只要存在未保存的文件，对话框就只给两个选择：取消，或“放弃更改并退出 / 确认”。用户想保留修改时，必须先离开对话框，逐个文件手动保存，再重新发起退出或关闭。

两个对话框的结构相同（标题、运行中会话行、未保存文件列表、取消与确认），却各自实现，文案也不一致：关闭对话框的标题只写“确认”，没有说明会丢弃修改。

## 2. 现状（代码位置）

| 项 | 现状 | 位置 |
| --- | --- | --- |
| 退出对话框 | 标题、运行中会话行、未保存文件列表；按钮为“取消”与“放弃更改并退出” | `src/App.tsx:394-443` |
| 退出确认的动作 | 先 `quitWithActiveSessions`，再 `confirmAppExit(requestId)`；确认前没有保存步骤 | `src/App.tsx:239-250`、`src/lib/tauri.ts:826` |
| 关闭对话框 | 组件 `ImpactConfirmDialog`，按钮为“取消”与“确认”；脏文件文案为“确定关闭并丢弃修改吗？” | `src/workspace/views/ImpactConfirmDialog.tsx:6-52`、`src/components/PtyWorkspace.tsx:38-44` |
| 关闭的动作 | 文件的 buffer 直接丢弃，不保存 | `src/workspace/domains/fileDocumentsDomain.ts:600-621` |
| 单文件保存 | `save(documentId)`，经单飞；失败分三类：冲突（`conflict`，提示带“重新加载”）、项目身份变化（`identityChanged`）、其他错误 | `src/workspace/domains/fileDocumentsDomain.ts:292-407` |
| 批量保存 | 不存在。`waitForAllSaves` 只等待进行中的保存，不发起保存 | `src/workspace/domains/fileDocumentsDomain.ts:755-759` |
| 脏判断 | `isWorkspaceFileBufferDirty`：内容与保存内容不同，或正在保存、冲突、身份变化 | `src/lib/workspaceFileBuffer.ts:50-60` |
| 翻译键 | 仓库中没有 `saveAll` 或“全部保存”；可复用 `common.save`、`workspaceFiles.save`、`workspaceFiles.reload` | `src/i18n/locales/zh.ts`、`en.ts` |

## 3. 目标与非目标

目标：

1. 两个对话框在存在未保存文件时，提供“保存全部并…”按钮，保存成功后继续原动作（退出或关闭）。
2. 两个对话框使用同一个确认组件（同一套按钮结构、同一组状态），文案与行为一致。
3. 任何一个文件保存失败，原动作必须中止，对话框保持打开，用户看到哪些文件没有保存。

非目标：

- 不新增设置项（不做“退出时自动保存”）。
- 不改变 Rust 端 `confirm_app_exit` 的语义；由 m6-101（Rust 重算退出影响）负责的数字来源不在本目标内。
- 不新增工作区工具栏上的“保存全部”入口。
- 不改变无脏文件时的对话框（保持现有按钮与文案）。

## 4. 交互规范

### 4.1 按钮组（共用组件 `ImpactDialogActions`）

| 场景 | 按钮（从左到右） |
| --- | --- |
| 仅运行中的会话，无脏文件 | 取消 · 确认（与现状相同） |
| 有脏文件（可有或无运行中的会话） | 取消 · **保存全部并退出 / 保存全部并关闭**（主按钮） · 放弃更改并退出 / 放弃修改并关闭（危险按钮） |
| 保存进行中 | 取消禁用；两个动作按钮禁用；主按钮显示“正在保存…”；按钮组保持布局不变 |

“取消”在保存进行中禁用，因为已经发出的写入无法撤回。

### 4.2 保存全部的行为

1. 按照对话框列表中的顺序，逐个调用单文件保存（串行，避免同时写入同一项目目录）。
2. 对每个文件的结果分类：成功、冲突、身份变化、其他错误。
3. 保存过程中，已经成功的文件保持已保存状态；失败的文件保持脏状态。
4. 全部成功：关闭对话框，继续原动作（退出：`quitWithActiveSessions` 再 `confirmAppExit`；关闭：`approveCloseBatch` 再执行）。
5. 任一失败：**不执行原动作**；对话框保持打开，列表只保留仍然脏的文件，并给出一条汇总提示：“N 个文件未能保存，已取消退出 / 关闭”。冲突文件提供“重新加载”动作（沿用 `workspaceFiles.reload`）。
6. 不强制覆盖：冲突文件不会被强制写入，与单文件保存的规则相同。

保存的顺序和“失败即中止”是推荐默认值（见第 7 节）。

### 4.3 运行中的会话

会话行仍由对话框显示。“保存全部并退出”在保存成功后继续退出流程，流程中仍会终止会话（与“确认”的效果相同）。用户点击按钮即视为对终止会话的确认，因此不再弹出第二个对话框。

### 4.4 退出的特殊规则

- 退出请求的 `requestId` 在保存期间仍需有效。若保存期间出现新的退出请求，旧对话框被替换（沿用现有“再次请求时替换对话框”的规则），保存的结果不影响新请求。
- 保存失败导致的中止不得留下半退出状态；`confirmAppExit` 只在全部保存成功后调用。

## 5. 文案（新增键，各语种须同步）

| 键 | zh | en |
| --- | --- | --- |
| `appExit.saveAllAndQuit` | 保存全部并退出 | Save all and quit |
| `workspaceFiles.saveAllAndClose` | 保存全部并关闭 | Save all and close |
| `workspaceFiles.discardAndClose` | 放弃修改并关闭 | Discard changes and close |
| `workspaceFiles.saveAllInProgress` | 正在保存… | Saving… |
| `workspaceFiles.saveAllFailedQuit` | {{count}} 个文件未能保存，已取消退出 | {{count}} file(s) could not be saved; quit cancelled |
| `workspaceFiles.saveAllFailedClose` | {{count}} 个文件未能保存，已取消关闭 | {{count}} file(s) could not be saved; close cancelled |

修正：关闭对话框的标题改为显示“确认关闭”，不再只写“确认”（`common.confirm` 仍用于无脏文件的情形）。新增键 `workspaceFiles.confirmCloseTitle`：zh“确认关闭”、en“Confirm close”。

遗留键 `appExit.confirm`（zh“结束会话并退出”）未被引用，已在全部语种中删除（见 8.2）。

其他语种先用 LLM 逐语种校对，母语审校仍在台账 C 组待办中。

## 6. 验收

- 宿主测试覆盖：退出与关闭两个对话框的三种场景（仅会话、有脏文件、保存中）；全部保存成功后原动作被调用一次；任一文件冲突或失败时原动作未被调用，对话框仍在且只列出仍脏的文件。
- 既有测试 `App.exit.host.test.tsx`、`PtyWorkspace.close.host.test.tsx`、`PtyWorkspace.exit.host.test.tsx` 的断言不改动（仅新增用例）。
- i18n 契约：新增键在全部语种存在；`{{count}}` 占位符数量一致。

## 7. 待确认项（已采用推荐默认值）

| 项 | 采用 | 理由 |
| --- | --- | --- |
| 某个文件保存失败后是否继续保存其余文件 | 继续保存其余文件，然后统一中止 | 用户能一次看到全部失败的文件；不会因为一个失败而丢失其他成功的保存 |
| 保存顺序 | 串行，按列表顺序 | 避免并发写入；列表顺序与用户看到的一致 |
| 与 m6-101 的依赖 | 本目标不依赖 101 落地 | 按钮只使用现有的前端脏集合；101 落地后数字来源改为 Rust，保存后脏集合为空，两者兼容 |

## 8. 残留与依赖

8.1 依赖：095（退出影响单一来源，已完成）。101 未完成，不阻断本目标，见第 7 节。

8.2 清理：已删除未使用的 `appExit.confirm` 键（全部语种）。关闭对话框的脏文件项通过 `WorkspaceContentDisposalImpact.documentId` 携带文件 id（汇总处补入）。

8.3 后续：母语审校（台账 C 组）；101 完成后让确认前的脏集合以 Rust 为准。
