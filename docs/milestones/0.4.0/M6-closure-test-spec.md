# M6 收口测试规格（第二轮复核配套）

> 编制日期：2026-10-06
> 基准提交：`cd4feac`（第二轮复核对象：`77d8ded..cd4feac` 共 20 个提交）
> 配套主报告：[M6 收口复核报告](M6-closure-review.md)；第一轮报告：[M6 基础抽象体检与收口审查报告](M6-abstraction-baseline-audit.md)
> 性质：逐条可执行的测试补充规格、测试基础设施设计、CI 改进与三平台实机验收清单。本文件不修改代码；实施按主报告第四章的工作包和波次执行。

## 使用说明

### 本文件回答什么

主报告回答“哪里有问题、为什么、怎么修、什么算通过”；本文件回答“用什么测试证明它被修好了”。每条规格写到**可以直接写成测试代码**的粒度：文件、用例名、前置构造、步骤、断言（含反向断言与不变量）、预期的当前结果、所需的生产代码 seam。执行者不应自行补充或改变断言含义；确需调整时，先在主报告的追溯表里登记原因。

### 文件结构

| 部分                              | 内容                                                                                                                                                                           | ID 范围                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 第一部分：前端测试专项            | 现有测试盘点、需求追踪矩阵、宿主测试 harness（HX-1~HX-6）、前端 seam（FE-SEAM-1~12）、前端测试规格、现有错误测试的修正清单、平台说明                                           | FE-T01~FE-T58                         |
| 第二部分：跨语言补充规格          | 第二轮复核后期核实的三条跨语言缺陷对应的前端侧规格                                                                                                                             | FE-T59~FE-T63                         |
| 第三部分：Rust、CI 与实机验收专项 | Rust 测试盘点与平台执行实况、Ubuntu CAS 根因与验证设计、需求追踪矩阵、Rust seam（SEAM-01~SEAM-27）、Rust 测试规格、CI 改进（CI-01~CI-10，含完整 `ci.yml`）、三平台实机验收清单 | RS-T01~RS-T63、W-xx、M-xx、L-xx、X-xx |

### 优先级与执行顺序

- **P0**：必须先写，且多数对应已核实的数据安全或权限缺陷；P0 全部转绿是 A 层门禁的前提。
- **P1**：契约、生命周期与跨平台正确性；与同一工作包的修复一同交付。
- **P2**：防回归、质量加固与平台参数化。
- 推荐顺序（与主报告 4.6 节波次一致）：CI 门禁修复与平台清单校验（CI-03、CI-04、CI-01、CI-02）→ 诊断与探针确认 CAS 根因（SEAM-17、CI-05）→ 测试基础设施（HX-1~HX-6、tauriMock 语义修正、权限扫描重写）→ P0 规格 → P1 → P2 → 实机验收。

### 通用约定

1. **预期当前失败的规格**：先以失败状态落地（前端 `it.fails`；Rust `#[ignore = "待修复 <编号>"]` 或在专用分支上展示失败输出），修复后转绿并**删除该标注**。不得把“预期失败”的测试留在主干且不带标注，也不得在没有看到失败的情况下直接写成绿色（那无法证明测试有效）。
2. **产品决策已全部确认（主报告 4.7.1）**：RS-T16 第 14 条、RS-T25、RS-T37、RS-T51 等规格不再因产品决策而保持 ignore，按最终决策实现，并遵循本节第 1 条（先以失败状态落地，修复后转绿并去掉标注）。**唯一例外是 PD-10**：折叠大小写的“探测钩子 + flag + PathKey”设计（主报告 4.7.2）已于 2026-10-06 评审通过，但实现前须先完成主报告 4.7.2.12 的平台实现调研并经用户确认调研结论，在此之前 RS-T62、FE-T63 保持 `#[ignore]` 或 `it.skip`（注明 PD-10）；SEAM-05、SEAM-09、SEAM-21 的 DTO 形状仍需在实施前向用户确认（它们不属于 PD-01 至 PD-16）。
3. **seam 的修改属于生产代码改动**：必须保持行为不变（纯抽取或依赖注入），改动与对应测试同一提交，并更新主报告追溯表。凡标注“同时是缺陷修复”的 seam，提交说明中写明被修复的编号。
4. **证据等级**：每条规格转绿后，在主报告追溯表登记证据等级（E1~E5，定义见主报告 4.4 节与 `AGENTS.md` R-EV-1）、测试名、提交号与平台。只验证 mock 自身行为的测试不计证据。
5. **fake timers**：宿主测试一律用 fake timers 推进时间窗口（15s/500ms/150ms 等），不要真实等待；`waitFor` 只用于等待微任务，超时 3000ms。
6. **临时文件与随机目录**：Rust 测试统一使用 `tempfile::tempdir()`，不使用固定路径；跨进程测试必须设置整体超时并在失败信息中带上子进程输出。
7. **三平台一致性**：前端测试在三平台 CI 都运行，涉及平台分支（`windowChrome`、UA、路径分隔符、RTL）的用例必须显式参数化，不依赖 jsdom 默认 UA；平台专属 Rust 测试用 `#[cfg(...)]` 限定，并登记到 `contracts/rust-platform-tests.json`（CI-02）。
8. **同义反复检查**：期望值不得与被测实现读取同一份常量或 JSON（例如用 `contracts/window-kinds.json` 同时生成期望与实际）；契约测试应写成“两侧各自独立导出再比对”。

### 编号对照

- 主报告中的问题编号：S1A/S1B/S1C/S1D-N**（第一步新发现）、FE-NEW-**与 N1~N15（测试步骤新发现）、S3G/S3H/S3I/S3J-A**（架构审查）、原 60 项沿用第一轮编号（B1-F**、B2-F**、B3F-F**、B3R-F**、X-F**、J1~J4）。
- 本文件规格的“关联审查编号”字段使用同一套编号。
- 前端 seam 为 `FE-SEAM-*`，Rust seam 为 `SEAM-*`，二者不冲突。

---

## 第一部分：前端测试专项

本专项为只读审查产物，审查期间没有修改任何仓库文件。原型代码已入库为参考文件：`docs/milestones/0.4.0/closure-prototypes/`（`.txt` 参考文件，用法见该目录 README）。

本次审查新确认了 5 个缺陷，其中 FE-NEW-01 已在原型中复现，其余 4 项由代码阅读得出，对应测试预期失败但尚未运行：

| 编号      | 问题                                                                                                        | 级别 |
| --------- | ----------------------------------------------------------------------------------------------------------- | ---- |
| FE-NEW-01 | 切换界面语言会让主窗口重新 hydrate：未保存的编辑丢失，运行中的 PTY 从界面消失，已分离的文件窗口变成无主窗口 | P0   |
| FE-NEW-02 | 文件独立窗切换语言后会重跑交接 setup，再发一次 ready                                                        | P2   |
| FE-NEW-03 | 主窗口收到 `workspace-file-window-attached` 时不检查 init 是否已发出，乱序或伪造的 attached 会被接受        | P1   |
| FE-NEW-04 | 备份恢复成功的响应先于 restored 事件到达时，用户任一操作都会让旧布局覆盖刚恢复的布局                        | P1   |
| FE-NEW-05 | 布局保存队列遇到不推进 revision 的拒绝时会无限重试，`flush()` 永不返回                                      | P2   |

### 1. 现有测试盘点与质量问题

#### 1.1 全量清单与分类

基线：53 个文件、282 项，全部通过。宿主集成测试 0 个。

| #   | 文件                                                        | 被测模块                   | 层级                | 环境       | 用例 | 质量标注                                         |
| --- | ----------------------------------------------------------- | -------------------------- | ------------------- | ---------- | ---- | ------------------------------------------------ |
| 1   | `src/bootstrap/registerBuiltinContributions.test.ts`        | 内建注册 bootstrap         | 注册表              | node       | 2    | 良好                                             |
| 2   | `src/components/WorkspaceContentView.test.tsx`              | 内容视图降级/ErrorBoundary | 组件                | jsdom      | 3    | ⚠ 名不副实（见 Q5）                              |
| 3   | `src/components/WorkspaceContentWindowShell.test.tsx`       | 独立窗外壳                 | 组件                | jsdom      | 2    | ⚠ 使用非规范 label `workspace-content-test`      |
| 4   | `src/components/WorkspaceDataRestoreListener.test.tsx`      | 恢复事件监听               | 组件                | jsdom      | 1    | ⚠ 只测 mock（Q4）                                |
| 5   | `src/components/WorkspaceEditorSurface.test.tsx`            | 编辑器缺失占位             | 组件                | jsdom      | 1    | 良好                                             |
| 6   | `src/components/workspaceContentAdapterRegistry.test.ts`    | adapter 注册表             | 注册表              | node       | 8    | 良好                                             |
| 7   | `src/components/workspaceContentAdapters/builtins.test.tsx` | 文件 adapter dispose       | 单元                | node       | 1    | ⚠ 只测直接调用（Q8）                             |
| 8   | `src/components/workspaceContentHandoffRuntime.test.ts`     | handoff runtime            | 单元                | node       | 1    | ⚠ 只测 happy path（Q9）                          |
| 9   | `src/components/workspaceEditorEngineRegistry.test.ts`      | 编辑器引擎注册表           | 注册表              | node       | 5    | 良好                                             |
| 10  | `src/hooks/useCliStatus.test.ts`                            | `refreshCliStatusForTool`  | 纯函数（不是 hook） | node       | 1    | ⚠ 名不副实，事件接线未测（Q11）                  |
| 11  | `src/hooks/useResolvedTheme.test.ts`                        | 主题快照订阅               | store               | jsdom      | 1    | 良好                                             |
| 12  | `src/hooks/useThemeSync.test.tsx`                           | 主题/语言跨窗、托盘        | hook                | jsdom      | 4    | 良好；缺主窗广播与失败暴露                       |
| 13  | `src/lib/abortableDelay.test.ts`                            | 可中止延时                 | 纯函数              | node       | 2    | 良好                                             |
| 14  | `src/lib/appErrors.test.ts`                                 | 错误格式化                 | 纯函数              | node       | 4    | ⚠ 未对照后端错误码（S1B-N03）                    |
| 15  | `src/lib/appExitImpacts.test.ts`                            | 退出影响合并               | 纯函数              | node       | 3    | 良好（宿主层缺失）                               |
| 16  | `src/lib/appPreferences.test.ts`                            | 偏好协议                   | 单元+mock           | jsdom/node | 5    | 良好                                             |
| 17  | `src/lib/contracts.test.ts`                                 | 跨端契约                   | 契约                | node       | 4    | ⚠ 同义反复（Q2/Q3）                              |
| 18  | `src/lib/installPlanConfirmation.test.ts`                   | plan_changed 重确认        | 纯函数              | node       | 2    | ⚠ 只测 happy path（Q10）                         |
| 19  | `src/lib/projectOrdering.test.ts`                           | 项目排序                   | 纯函数              | node       | 3    | 良好                                             |
| 20  | `src/lib/ptySessionDrag.test.ts`                            | PTY 拖放载荷               | 纯函数              | node       | 3    | 良好                                             |
| 21  | `src/lib/ptySessionLifecycle.test.ts`                       | PTY 失败/超时决策          | 纯函数              | node       | 19   | ⚠ 把“无 owner label 也接受”写成了期望（S1C-N05） |
| 22  | `src/lib/ptyTerminalRuntime.test.ts`                        | 剪贴板错误分类             | 纯函数              | node       | 3    | 良好                                             |
| 23  | `src/lib/ptyWorkspaceLayout.test.ts`                        | 窗格树                     | 纯函数              | node       | 41   | 良好                                             |
| 24  | `src/lib/sessionSearch.test.ts`                             | 会话搜索批次               | 纯函数              | node       | 3    | 良好                                             |
| 25  | `src/lib/themeMode.test.ts`                                 | 主题偏好解析               | 纯函数              | node       | 7    | 良好                                             |
| 26  | `src/lib/themes.test.mjs`                                   | CSS token 完整性           | 契约                | node       | 2    | ⚠ 名不副实（Q7）                                 |
| 27  | `src/lib/tools.test.ts`                                     | CLI 注册表                 | 纯函数              | node       | 9    | 良好                                             |
| 28  | `src/lib/versionQueryPolicy.test.ts`                        | 版本查询策略               | 纯函数              | node       | 3    | 良好                                             |
| 29  | `src/lib/windowApiPermissions.test.ts`                      | 窗口 API⊆capability        | 契约                | node       | 3    | ✗ 实际失效（Q1，S1B-N01）                        |
| 30  | `src/lib/windowChrome.test.ts`                              | 平台 chrome 策略           | 纯函数              | node       | 6    | 良好（组件层未参数化）                           |
| 31  | `src/lib/windowKinds.test.ts`                               | label 规则                 | 契约                | node       | 5    | 良好                                             |
| 32  | `src/lib/workspaceContentClose.test.ts`                     | 批量关闭                   | 纯函数              | node       | 19   | 良好                                             |
| 33  | `src/lib/workspaceContentCommand.test.ts`                   | 命令执行器                 | 纯函数              | node       | 4    | 良好                                             |
| 34  | `src/lib/workspaceContentCoordinator.test.ts`               | 归属协调器                 | 单元                | node       | 9    | 良好（未覆盖 returning 持久化）                  |
| 35  | `src/lib/workspaceContentDrag.test.ts`                      | 通用拖放载荷               | 纯函数              | node       | 4    | 良好                                             |
| 36  | `src/lib/workspaceContentKey.test.ts`                       | 身份键                     | 纯函数              | node       | 2    | 良好                                             |
| 37  | `src/lib/workspaceContentLifecycle.test.ts`                 | 状态机 reducer             | 纯函数              | node       | 13   | 良好                                             |
| 38  | `src/lib/workspaceContentListenerSetup.test.ts`             | 监听批注册                 | 单元                | node       | 3    | ⚠ 把“一项失败就全部注销”写成了期望（S1A-N10）    |
| 39  | `src/lib/workspaceContentWindowProtocol.test.ts`            | 跨窗协议                   | 单元+局部 mock      | node       | 5    | ⚠ 一项同义反复（Q6）                             |
| 40  | `src/lib/workspaceContentWindowRegistry.test.ts`            | pending 窗口注册表         | 单元                | node       | 8    | 良好                                             |
| 41  | `src/lib/workspaceEditorLanguage.test.ts`                   | 语言映射                   | 纯函数              | node       | 7    | 良好                                             |
| 42  | `src/lib/workspaceEditorModel.test.ts`                      | model URI                  | 纯函数              | node       | 1    | 良好                                             |
| 43  | `src/lib/workspaceEditorModelRegistry.test.ts`              | model 登记                 | 单元                | node       | 1    | 良好                                             |
| 44  | `src/lib/workspaceFileBuffer.test.ts`                       | buffer/flight              | 单元                | node       | 14   | 良好                                             |
| 45  | `src/lib/workspaceFileBufferPublisher.test.ts`              | 节流发布                   | 单元                | node       | 2    | 良好                                             |
| 46  | `src/lib/workspaceFileClose.test.ts`                        | 文件关闭状态               | 纯函数              | node       | 1    | 只测 happy path                                  |
| 47  | `src/lib/workspaceFileExitFlush.test.ts`                    | flush 请求                 | 单元                | node       | 3    | 良好                                             |
| 48  | `src/lib/workspaceFileWindow.test.ts`                       | 文件窗身份                 | 纯函数              | node       | 4    | 良好                                             |
| 49  | `src/lib/workspaceFileWindowSetup.test.ts`                  | 子窗 setup 卸载            | 单元                | node       | 1    | 良好                                             |
| 50  | `src/lib/workspaceLayoutPersistence.test.ts`                | 迁移/校验/保存队列         | 单元                | node       | 18   | 良好；缺 returning 与“拒绝不推进”场景            |
| 51  | `src/lib/workspaceRestorePolicy.test.ts`                    | 恢复阻断 OR                | 纯函数              | node       | 1    | 低价值（只测三个数的 OR），宿主层缺失            |
| 52  | `src/lib/workspaceTabLayout.test.ts`                        | 标签分区                   | 纯函数              | node       | 4    | 良好（组件测量未测）                             |
| 53  | `src/test/tauriMock.test.tsx`                               | 测试 mock 自检             | 基础设施            | jsdom      | 1    | ✗ 固化错误的事件语义（S1B-N10）                  |

按层级大致统计（部分文件跨层，有重叠）：纯函数/单元约 40、注册表/契约约 9、组件 5、hook 2、宿主集成 0。`PtyWorkspace.tsx`（5,490 行）、`App.tsx` 退出流程、`StandalonePtyWindow.tsx`、`StandaloneWorkspaceFileWindow.tsx`、`WindowTitlebar.tsx`、`PtyTerminal.tsx`、`useExecutionTasks.ts` 都没有渲染级测试。

#### 1.2 有问题的现有测试

| 编号 | 位置（文件::用例）                                                                                        | 类别               | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1   | `windowApiPermissions.test.ts::grants APIs used by $id`                                                   | 失效               | ① glob 从 `src/lib` 出发，同目录文件的键是 `./x.ts`，不是 `../lib/x.ts`（已实测，键为 `["../components/b.ts","./a.ts"]`）。所以 `appPreferencesMain.ts`、`appPreferencesChild.ts`、`workspaceContentWindowProtocol.ts` 从未被读取，`readSources` 拼进去的是字符串 `"undefined"`。② 子窗口唯一的 `emitTo` 在协议模块里，删掉 `core:event:allow-emit-to` 后测试仍是绿的。③ 源码清单靠手写，漏了传递依赖（`useExecutionTasks`、`WorkspaceDataRestoreListener` 的 `listen`、dialog/opener 插件、`WebviewWindow.getByLabel`）。④ 只要有 `core:default`，所有 `core:*` 都被跳过检查，`allow-close` 等并不在 default 里。 |
| Q2   | `contracts.test.ts::declares each current window kind and registered app command`（59–64 行）             | 同义反复           | 期望值 `getWorkspaceContentWindowLabelPrefix()` 内部读的就是同一份 `window-kinds.json`。`appCommands.length > 0` 也没有约束力，而且没有校验 `tauri.ts` 里的 invoke 是否属于契约命令集。                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q3   | `contracts.test.ts::matches the TypeScript workspace content kinds`                                       | 同义反复           | `adapterApiVersion` 和字面量 `2` 比较，没有关联注册表实际接受的版本，也没有关联内建 adapter 的 `apiVersion`、拖放白名单和协议前缀。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q4   | `WorkspaceDataRestoreListener.test.tsx::rehydrates the workspace after…`                                  | 只测 mock          | `rehydrateWorkspace` 是 mock，只证明了事件接线。审计报告把它当作 J1“恢复后 revision 一致”的证据，这个证据不成立。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Q5   | `WorkspaceContentView.test.tsx::contains render failures from registered adapters`                        | 名不副实           | 只断言关闭按钮存在，从未点击。宿主对已知 kind 的关闭回调是空操作（S1A-N04，原型已复现）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q6   | `workspaceContentWindowProtocol.test.ts::receives only events emitted to the current window`（84–124 行） | 同义反复/只测 mock | `emitToMock` 自己实现了“target 相等才投递”，断言“非目标收不到”是 mock 自身保证的。唯一有效的断言是 `getCurrentWebviewWindow` 被调用。                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q7   | `themes.test.mjs::keeps terminal theme tokens complete and the same in light and dark modes`              | 名不副实           | 只检查 CSS token 是否存在，没比较两套主题取值是否相同。B2-F10 要求的“token 块外没有裸色值”也未测。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q8   | `builtins.test.tsx::releases the editor model when a file content is disposed`                            | 只测直接调用       | 没有证明宿主在关闭、hydrate、rehydrate、应用布局时真的会调用 dispose（S1A-N12，原型已复现 rehydrate 不释放）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q9   | `workspaceContentHandoffRuntime.test.ts`（唯一一项）                                                      | 只测 happy path    | 未测缺 driver、attach 失败后回滚、file kind。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q10  | `installPlanConfirmation.test.ts::…`                                                                      | 只测 happy path    | 没覆盖后端真实返回形状 `{code:"plan_changed",message}`。刷新返回的计划和旧计划完全相同，没证明“新计划”被采用。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q11  | `useCliStatus.test.ts::refreshes and caches only the CLI…`                                                | 名不副实           | 文件名和 describe 暗示测的是 hook，实际只测注入式 helper，`useExecutionTaskEvents` 的事件接线没有测试。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q12  | `ptySessionLifecycle.test.ts::detached PTY start timeout reconciliation`                                  | 固化缺陷           | 把 `"ownedByAnotherWindow" + 窗口存在 → accept-detached-owner` 写成期望，但 `window_status` 不带 owner label（S1C-N05）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q13  | `workspaceContentListenerSetup.test.ts::cleans successful registrations when another listener fails`      | 固化缺陷           | 把“一项失败就全部注销”写成期望。主窗口 PTY 组里 `pty-session-owner-lost` 一失败，PTY 交接监听会全部消失（S1A-N10）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q14  | `tauriMock.test.tsx` + `src/test/tauriMock.ts` 57–76、168–172 行                                          | 固化错误语义       | 全局 `listen` 被模拟成按当前窗口过滤。真实 Tauri v2 全局 `listen` 的 target 是 `Any`，会收到发给任意 label 的 `emitTo`（S1B-N10）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q15  | `WorkspaceContentWindowShell.test.tsx::routes a pre-ready close…`                                         | 夹具问题           | label `workspace-content-test` 不符合 `windowKindOf` 规则。一旦启用 ACL 版 mock，这个测试会失败（应改用规范 UUID label）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q16  | `workspaceLayoutPersistence.test.ts::marks restored running sessions ended…`                              | 语境缺失           | “启动时 running→ended”作为单元规则是对的，但宿主在运行中途 rehydrate（包括切换语言）也套用了这条规则（FE-NEW-01）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 2. 前端需求追踪矩阵

图例：✓ 有有效证据；◐ 只有纯函数或部分覆盖；✗ 缺失。“缺口”列指向第 4 节的 FE-T 编号。

#### R1 契约一致性

| 要求                                                                 | 现有测试                                             | 缺口                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| ToolKey：TS 注册表=契约                                              | ✓ `contracts.test`、`tools.test`                     | 无                                            |
| 命令：`tauri.ts` 的 invoke ⊆ `app-commands.json`，且契约命令都有封装 | ✗（当前 68=68，但没有测试）                          | FE-T31                                        |
| 每类窗口实际调用的命令 ⊆ 该窗口 `appCommands`                        | ✗                                                    | FE-T31（静态闭包）、FE-T32（运行时 ACL mock） |
| 窗口类别/label                                                       | ✓ `windowKinds.test`；◐ `contracts.test`（同义反复） | FE-T33、FE-T55（App 路由）                    |
| 内容 kind：契约=内建 adapter=拖放白名单                              | ◐                                                    | FE-T33                                        |
| 错误码：前端映射=后端产出                                            | ✗（前端 19 个映射，后端只产出 10 个码）              | FE-T29、FE-T52                                |
| 窗口 API ⊆ capability                                                | ✗（Q1 失效）                                         | FE-T03、FE-T32                                |
| CSP 精确指令                                                         | ✗（Rust 侧只做包含断言）                             | FE-T30                                        |

#### R2 五出口

| 资源                | 正常结束                                    | 显式关闭                             | 异常中止                                  | 窗口销毁               | 应用退出                                     |
| ------------------- | ------------------------------------------- | ------------------------------------ | ----------------------------------------- | ---------------------- | -------------------------------------------- |
| PTY 会话（pane 内） | ◐ 只有布局纯函数 → FE-T38                   | ◐ → FE-T17                           | ✗ closeSession 抛错 → FE-T17              | 不适用（等同主窗退出） | ✗ → FE-T10                                   |
| 文件文档与 buffer   | ◐ → FE-T44                                  | ◐ → FE-T16、FE-T17                   | ◐ 冲突/失败/身份变更 → FE-T44             | 不适用                 | ◐ → FE-T10、FE-T12                           |
| 文件独立窗          | ✗ return（被 S1A-N01 阻塞）→ FE-T05、FE-T36 | ✗ 原生关闭 → FE-T36                  | ◐ attach-failed/超时 → FE-T18、FE-T40     | ✗ S1A-N02 → FE-T19     | ✗ flush → FE-T12、FE-T13                     |
| 终端独立窗          | ✗ return → FE-T04、FE-T35                   | ✗ → FE-T35                           | ✗ attach 失败/未就绪关闭 → FE-T35、FE-T41 | ✗ owner-lost → FE-T23  | ◐ ptyCount 来自 Rust → FE-T10                |
| 执行任务            | ✗ → FE-T49                                  | ✗（ExecutionsView 取消，本轮只记录） | ✗ failed/timed_out → FE-T49               | 不适用                 | ✗ 未定义（退出流程不计执行任务，需产品决策） |
| 应用退出流程        | ◐ 纯函数 → FE-T10                           | ✓ 取消 → FE-T10                      | ✗ 静默退出失败卡死 → FE-T11               | 不适用                 | 重入 → FE-T10                                |
| 备份恢复            | ✗ 只测 mock → FE-T46                        | ✗ 阻断 → FE-T46                      | ✗ 失败回滚 → FE-T46                       | 不适用                 | 不适用                                       |

#### R3 失败语义三级

| 级别             | 场景                                | 现有                                  | 缺口                   |
| ---------------- | ----------------------------------- | ------------------------------------- | ---------------------- |
| 拒绝             | 伪造/外来协议事件、错误 token/label | ✓ 协议解码；✗ 宿主处理                | FE-T39、FE-T40         |
| 单项降级         | 未知 kind、缺 adapter、渲染错误     | ✓ 组件；✗ 已知 kind 的关闭（S1A-N04） | FE-T22、FE-T42         |
| 单项降级         | 持久化快照非法时不能整窗崩溃        | ✗（S1A-N01 会让整棵树卸载）           | FE-T04、FE-T05、FE-T07 |
| 单项降级         | 单个监听注册失败                    | ✗（S1A-N10）                          | FE-T24、FE-T25         |
| 整体失败         | needsReset/loadFailed 恢复流程      | ✗                                     | FE-T47                 |
| 配置缺陷必须暴露 | setTheme/权限失败只打控制台         | ✗                                     | FE-T32、FE-T53         |

#### R4 交接状态机（宿主层）

| 场景                                        | 现有                        | 缺口                                          |
| ------------------------------------------- | --------------------------- | --------------------------------------------- |
| 全转移、失败回滚                            | ✓ reducer、coordinator 单测 | 宿主层 FE-T04、FE-T05、FE-T35、FE-T36、FE-T41 |
| 重复 ready、过期 ready、重复 return         | ◐ reducer 层                | FE-T40                                        |
| 乱序：attached 先于 ready/init（FE-NEW-03） | ✗                           | FE-T40                                        |
| 提交顺序：先确认归属再改树（S1A-N13）       | ✗                           | FE-T20                                        |
| 超时三分支与重试上限                        | ◐ 纯函数                    | FE-T41、FE-T28                                |

#### R5 身份可信

| 要求                        | 现有             | 缺口           |
| --------------------------- | ---------------- | -------------- |
| 协议 envelope 校验          | ✓                | 无             |
| 只收发给本窗的事件          | ◐ 同义反复（Q6） | FE-T34、FE-T02 |
| 宿主核对 token/label/epoch  | ✗                | FE-T39         |
| 子窗只用授权命令            | ✗                | FE-T32         |
| owner label 可信（S1C-N05） | ✗                | FE-T28         |
| 拖放来源窗口受管            | ✗                | FE-T39         |

#### R7 M6 门禁 1–10

| 门禁                  | 现有证据                                 | 缺口                                                    |
| --------------------- | ---------------------------------------- | ------------------------------------------------------- |
| 1 边界清单            | 契约测试                                 | FE-T33、FE-T56（kind 分支数只减不增）                   |
| 2 宿主与 adapter 职责 | `workspaceContentCommand`/`Close` 纯函数 | FE-T17、FE-T43（标签/菜单/堆叠走同一入口）、FE-T56      |
| 3 完整生命周期        | 纯函数                                   | FE-T04、FE-T05、FE-T16、FE-T17、FE-T21、FE-T38          |
| 4 独立窗口协议        | 协议单测、Shell                          | FE-T18、FE-T19、FE-T35、FE-T36、FE-T40、FE-T41          |
| 5 权限闭环            | Q1 失效                                  | FE-T03、FE-T31、FE-T32                                  |
| 6 注册表与消费端      | ✓                                        | FE-T33（kind 关联）                                     |
| 7 文档一致            | 不适用（文档项）                         | Q4、Q5 证据需要从追溯表中撤下或改写                     |
| 8 回归门禁            | CI                                       | 本规格全部入 CI                                         |
| 9 G3/G4 继承          | `windowChrome`、`useThemeSync`、Shell    | FE-T37（标题栏）、FE-T38（portal 稳定）、FE-T53、FE-T54 |
| 10 标题自适应         | `partitionVisibleTabs` 纯函数            | FE-T26、FE-T43                                          |

#### R8 并发

| 要求                         | 现有   | 缺口                                 |
| ---------------------------- | ------ | ------------------------------------ |
| 保存 single-flight           | ✓ 单测 | FE-T44                               |
| epoch/version                | ✓      | FE-T39（宿主拒收旧版本）             |
| flush 顺序/超时              | ✓ 单测 | FE-T12                               |
| 保存中 × 布局/关闭/重载/分离 | ◐      | FE-T16                               |
| 布局保存队列 rebase          | ✓      | FE-T48（拒绝且不推进时不能无限循环） |
| 恢复与自动保存竞态           | ✗      | FE-T46                               |

#### R9 布局 schema 迁移与 Unknown（前端侧）

| 要求                                       | 现有     | 缺口                     |
| ------------------------------------------ | -------- | ------------------------ |
| v3→v5、v4→v5                               | ✓        | 无                       |
| v1/v2/v6 明确拒绝；未来版本进入 needsReset | ✗        | FE-T47                   |
| Unknown 读入→保存→关闭（宿主）             | ◐ 纯函数 | FE-T42（原型已验证可行） |
| 重启时 detached 回到焦点 pane              | ✓ 纯函数 | FE-T15（宿主层）         |

#### R10 主题/偏好/i18n 跨窗口

| 要求                                      | 现有       | 缺口                            |
| ----------------------------------------- | ---------- | ------------------------------- |
| 子窗口初始偏好                            | ✓          | 无                              |
| 主窗广播主题，子窗不写 localStorage       | ◐          | FE-T53                          |
| 语言切换不能重建主窗口工作区（FE-NEW-01） | ✗          | FE-T08、FE-T09                  |
| 子窗切换语言不能重跑交接（FE-NEW-02）     | ✗          | FE-T36                          |
| setTheme 失败要暴露                       | ✗          | FE-T53                          |
| RTL                                       | ✓ 子窗 dir | 并入第 6 节平台说明，不单列规格 |

### 3. 宿主测试 harness 设计与 seam 清单（含原型验证结果）

#### 3.1 原型验证结果

原型位置：`docs/milestones/0.4.0/closure-prototypes/`（`.txt` 参考文件，用法见该目录 README）。`node_modules` 是指向仓库的 junction，用 `node node_modules/vitest/vitest.mjs run --config vitest.config.mjs` 运行。

| 原型                                                                                         | 结论                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PtyWorkspaceProvider`+`PtyWorkspaceRegion` 在 jsdom 挂载                                    | ✓ 能挂载；hydrate（missing）后 ready，调用了 `save_workspace_layout`，保存的布局能通过 `validateWorkspaceLayoutDocument`；卸载后 `tauriMock.state.eventListeners` 为空                                     |
| S1A-N01 文件 return                                                                          | 复现。`Error: Workspace layout contains unowned content or focus`，调用栈 `PtyWorkspace.tsx:668 → 516 → workspaceLayoutPersistence.ts:130/494`；卸载时 685 行再抛一次；整棵 Provider 被 ErrorBoundary 替换 |
| S1A-N01 PTY return（attach 挂起）                                                            | 复现，错误同上                                                                                                                                                                                             |
| S1A-N03（渲染完整 `<App/>`）                                                                 | 复现。静默退出路径中 `confirm_app_exit` 被拒绝后，对话框两个按钮都是 disabled（`common.cancel`、`appExit.terminating`）                                                                                    |
| FE-NEW-01（真实 i18n）                                                                       | 复现。`i18n.changeLanguage("zh")` 后 `get_workspace_layout` 被调用次数从 1 变 2；buffer 从 `"unsaved edit"` 变回磁盘内容 `"hello"`；slots 从 1 变 0                                                        |
| S1A-N05（fake timers）                                                                       | 30 秒内 reattach 41 次；卸载后仍残留 1 个定时器                                                                                                                                                            |
| flush 超时按脏处理                                                                           | ✓ 通过                                                                                                                                                                                                     |
| S1A-N12                                                                                      | rehydrate 后 `releaseDocument` 调用为 `[]`                                                                                                                                                                 |
| S1A-N04                                                                                      | 点击已知 kind 错误占位的关闭按钮后，文档仍在                                                                                                                                                               |
| 重启 rehome / 分离中应用命名布局 / 保存中应用布局 / Unknown 往返 / 双击保存只调用一次 invoke | 全部 ✓ 通过                                                                                                                                                                                                |

#### 3.2 需要新建的测试基础设施（HX，测试代码，不属于生产代码）

**HX-1：修正 `src/test/tauriMock.ts`（S1B-N10）**

1. `MockListener` 增加 `target: {kind:"any"} | {kind:"window"; label:string}`。`@tauri-apps/api/event.listen` 注册为 `any`；窗口对象上的 `listen`/`once`/`onResized`/`onMoved`/`onCloseRequested`/`onThemeChanged`/`onFocusChanged` 注册为 `{kind:"window", label}`。
2. `dispatchEvent(name, payload, targetLabel)`：`targetLabel === null`（即 `emit`）时投递给全部监听；否则投递给 `kind==="any"` 的监听，以及 `label===targetLabel` 的窗口监听。
3. `invokeCalls`、`emittedEvents`、`windowActions` 的每条记录增加 `windowLabel: mockState.currentWindowLabel`。
4. ACL 校验：新增 `setEnforceCapabilities(enabled)`，默认开启。规则如下：
   - 当前 label 用 `windowKindOf()` 判定。判不出类别时直接抛 `Error("tauriMock: unknown window label <x>")`。
   - `invoke(command)`：该 kind 的 `appCommands`（来自 `contracts/window-kinds.json`，`"all"` 表示全部放行）里没有这个命令时，抛 `{code:"acl.denied", message:"<command> not allowed for <label>"}`，并 push 到 `state.aclViolations`。
   - 窗口 API 和事件 API 按下表映射权限，与对应 capability 文件（`default.json`/`terminal-window.json`/`workspace-content-window.json` 的 `permissions`）比对。

   | API                        | 需要的权限                                 |
   | -------------------------- | ------------------------------------------ |
   | `setTheme`                 | `core:window:allow-set-theme`              |
   | `setFocus`                 | `allow-set-focus`                          |
   | `close`                    | `allow-close`                              |
   | `destroy`                  | `allow-destroy`                            |
   | `minimize`                 | `allow-minimize`                           |
   | `toggleMaximize`           | `allow-toggle-maximize`                    |
   | `startDragging`            | `allow-start-dragging`                     |
   | `startResizeDragging`      | `allow-start-resize-dragging`              |
   | `isMaximized`              | `allow-is-maximized`                       |
   | `listen`/`once`/`onX`      | `core:event:allow-listen`                  |
   | 返回的 unlisten            | `allow-unlisten`                           |
   | `emitTo`                   | `core:event:allow-emit-to`                 |
   | `emit`                     | `core:event:allow-emit`                    |
   | `new WebviewWindow`        | `core:webview:allow-create-webview-window` |
   | `WebviewWindow.getByLabel` | `core:webview:allow-get-all-webviews`      |
   - `core:default` 只按硬编码集合 `CORE_DEFAULT_IMPLIES` 展开：`core:event:allow-listen`、`allow-unlisten`、`allow-emit`、`allow-emit-to`、`core:window:allow-is-maximized`、`core:webview:allow-get-all-webviews`。理由：`src-tauri/gen/schemas/acl-manifests.json` 没有入库，CI 在 `pnpm test` 时拿不到这份文件。在常量上加注释，说明来源和人工同步要求。

5. 新增 `failNextListen(eventName, error)`：下一次针对该事件名的 `listen` 返回 rejected promise。
6. 新增 `destroyWindow(label)`：向该 label 的窗口监听投递 `tauri://destroyed`，并从 `windows` Map 删除。
7. `reset()` 清空新增的状态，并把 ACL 恢复为开启。

**HX-2：新建 `src/test/host/hostMocks.tsx`**

内容与原型 `host/mocks.tsx` 相同，包含：

- `reactI18nextMock`：模块级常量 `t`。t 的身份必须稳定，否则所有 `[t]` 依赖的 effect 每次渲染都会重跑。输出格式为 `key` 或 `key:JSON(options)`。
- `sonnerMock`：`toast` 是带 `.error/.info/.warning/.success/.dismiss` 的 `vi.fn`，`Toaster: () => null`。
- `ptyTerminalMock`：`FakePtyTerminal`（forwardRef）。每次挂载创建一个 handle，push 到导出的 `fakeTerminals`。handle 方法：
  - `startSession`：分配 `session-N`，调用 `props.onSessionChange` 传入 running 会话。
  - `closeSession`：默认 resolve `"closed"`。
  - `captureHandoff`：resolve `{token:"handoff-N"}`。
  - `cancelHandoff`、`attachHandoff`：resolve `{sessionId, state:"running"}`。
  - `reattachLostSession`：resolve `{sessionId, state:"running"}`。
  - `getSessionState`。
  - `emitSessionChange(session)`：直接调用最新的 `props.onSessionChange`，用 ref 保存最新 props。
- 导出 `onFakeTerminalCreated(cb)`：在 handle 创建时同步回调，用来在子窗 effect 运行前预设行为。
- 导出 `resetFakeTerminals()`。

**HX-3：新建 `src/test/host/workspaceHarness.tsx`**

骨架以原型 `host/harness.tsx` 为准，导出以下 API：

| API                                   | 说明                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DIRECTORY`                           | `{id:1,name:"Project",path:"C:/project",sortOrder:0,pinned:false,lastUsedAt:null,note:null}`                                                                                                                                                                                                                                                                                       |
| `createBackend(layout?)`              | 返回 `{layout: WorkspaceLayoutStateRead, saved: Array<{revision, layout}>, files: Map<relativePath,{content,revision}>, handlers: Map<command,(args)=>unknown>}`。默认 `layout.status={status:"missing"}`、`revision:0`、`slotStates:[]`；`files` 预置 `"a.txt"→{content:"hello",revision:"r1"}`、`"b.txt"→{content:"bee",revision:"r1"}`、`"c.txt"→{content:"sea",revision:"r1"}` |
| `installBackend(backend)`             | 默认处理见下表；`handlers` 中有同名命令时优先使用                                                                                                                                                                                                                                                                                                                                  |
| `mountWorkspace(opts?)`               | 见下文                                                                                                                                                                                                                                                                                                                                                                             |
| `mountApp(opts?)`                     | 见下文                                                                                                                                                                                                                                                                                                                                                                             |
| `mountFileWindow`、`mountPtyWindow`   | 见下文                                                                                                                                                                                                                                                                                                                                                                             |
| `flush(n=5)`                          | 循环 `await act(async()=>{await new Promise(r=>setTimeout(r,0))})`                                                                                                                                                                                                                                                                                                                 |
| `deferred<T>()`                       | 返回 `{promise, resolve, reject}`                                                                                                                                                                                                                                                                                                                                                  |
| `emitToMain(type,payload)`            | `tauriMock.emitEvent("workspace-content-window-event",{apiVersion:1,type,payload},"main")`，包在 `act` 里                                                                                                                                                                                                                                                                          |
| `emitToWindow(label,type,payload)`    | 同上，目标是指定 label                                                                                                                                                                                                                                                                                                                                                             |
| `emitBackendEvent(name,payload)`      | `tauriMock.emitEvent(name,payload,"main")`，包在 `act` 里                                                                                                                                                                                                                                                                                                                          |
| `openFile(host,path="a.txt")`         | 调用 `ctx.openProjectFile(1,"C:/project",path)`，然后 `flush()`，返回 document                                                                                                                                                                                                                                                                                                     |
| `launchPty(host,tool="claude")`       | 调用 `ctx.launchSession(1,tool)`，然后 `flush(10)`，返回 `{slot, terminal}`，其中 `terminal = ctx.terminalRefs.current.get(slot.instanceId)`                                                                                                                                                                                                                                       |
| `detachFileToWindow(host,documentId)` | 调用 detachFile，读取最后创建窗口的 URL 参数 `fileHandoffToken`，发送 ready，取出发往子窗的 init 载荷，再发送 attached。返回 `{token,windowLabel,initBuffer,detachPromise}`                                                                                                                                                                                                        |
| `detachPtyToWindow(host,instanceId)`  | 调用 detachSession，读取最后创建窗口的 label，发送 `pty-detached-ready`。返回 `{windowLabel,detachPromise}`                                                                                                                                                                                                                                                                        |
| `savedLayouts(host)`                  | 返回 `backend.saved`                                                                                                                                                                                                                                                                                                                                                               |
| `invokes(cmd)`                        | 从 `tauriMock.state.invokeCalls` 中按命令过滤                                                                                                                                                                                                                                                                                                                                      |

`installBackend` 的默认处理：

| 命令                                                                          | 默认返回                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `list_directories`                                                            | `[DIRECTORY]`                                                                              |
| `get_workspace_layout`                                                        | `backend.layout`                                                                           |
| `save_workspace_layout`                                                       | push 到 `saved`，返回 `{saved:true, revision: args.revision}`                              |
| `open_project_file`                                                           | `{kind:"text",...files.get(path)}`；找不到时抛 `{code:"file.not_found",message:"missing"}` |
| `save_project_text_file`                                                      | `{kind:"saved",content,revision:expectedRevision+"+",warning:null}`                        |
| `open_granted_file`                                                           | 同 `open_project_file`，固定读 `a.txt`                                                     |
| `save_granted_text_file`                                                      | 同 `save_project_text_file`                                                                |
| `grant_content_window_file`、`revoke_content_window_file`、`confirm_app_exit` | `undefined`                                                                                |
| `get_pty_session_window_status`                                               | `"running"`                                                                                |
| `list_workspace_layout_presets`、`detect_cli_status`、`list_execution_tasks`  | `[]`                                                                                       |

`mountWorkspace(opts?)` 的参数：

- `{backend?, adapters?: "builtin" | WorkspaceContentAdapter[], coordinator?, strict?: boolean}`。

挂载过程：

1. 安装 DOM polyfill（HX-5）。
2. 注册内容 adapter：默认调用 `registerBuiltinWorkspaceContentAdapters()`；传入数组时逐个 `registerWorkspaceContentAdapter`。
3. 注册假编辑器引擎：`id:"core.monaco"`（就是 `defaultEngineId`）、`apiVersion:1`、`releaseDocument: vi.fn()`；`View` 渲染 `<textarea aria-label="editor">`。模块变量 `throwOnRender` 为真时 View 抛 `Error("engine exploded")`。
4. `useAppStore.setState({view:"detail",selectedDirectoryId:1,ptySessionsById:{}})`，并清空 `localStorage`。
5. 渲染：`QueryClientProvider`（`retry:false`）› `CapturingBoundary`（`componentDidCatch` 写入 `errors`）› `PtyWorkspaceProvider coordinator={opts.coordinator}` › `Probe`（每次渲染把 `usePtyWorkspace()` 写入 ref）+ `PtyWorkspaceRegion`。`strict:true` 时外包 `React.StrictMode`。
6. 渲染完调用 `flush()`。

返回值：`{ctx(), errors, backend, editor:{releaseDocument, setThrowOnRender(b)}, coordinator, dispose()}`。`dispose` 会 unmount、注销 adapter 和引擎、清空 queryClient。

**`mountApp(opts?)`**：渲染完整 `<App/>`，外层包 `QueryClientProvider` 和 `CapturingBoundary`，store 设为 `view:"projects"`。只适用于主窗口退出类测试；文件编辑通过 `screen.getByLabelText("editor")` 驱动（`ByLabelText` 不过滤 hidden 元素）。

**`mountFileWindow` / `mountPtyWindow`**：

- 先调用 `tauriMock.setCurrentWindowLabel(label)`，label 默认用规范值：
  - 文件窗 `"workspace-content-8e783338-f464-4b10-b15e-b534748c6241"`
  - 终端窗 `"terminal-8e783338-f464-4b10-b15e-b534748c6241"`
- 再注册 adapter 和假引擎，然后渲染对应的 Standalone 组件。
- props 默认值：
  - 文件窗：`documentId:"doc-1"`、`token:"tok-1"`、`sourcePaneId:"pane-1"`。
  - 终端窗：`sessionId:"session-1"`、`handoffToken:"handoff-1"`、`instanceId:"slot-1"`、`sourcePaneId:"pane-1"`、`title:"Claude"`。

**HX-4：新建 `src/test/host/workspaceInvariants.ts`**

`assertWorkspaceInvariants(host, {allowPendingSaves=false} = {})` 依次检查：

1. `I1`：`host.errors` 为空。
2. `I2`：`host.backend.saved` 中每个布局都通过 `validateWorkspaceLayoutDocument`。
3. `I3`：树中每个非 unknown 内容最多出现一次。
4. `I4`（需要 FE-SEAM-1）：树与 coordinator 一致。
   - 树中每个 pty/file 内容都有 coordinator 状态，且 `phase ∈ {attached（owner.paneId=所在 pane）, detaching（source.paneId=所在 pane）, closing（owner.kind="pane"）}`。
   - coordinator 中 `detached`/`returning` 状态的内容不在树中。
5. `I5`：每个 slot、每个 document，要么在树中，要么在 `coordinator.listWindowOwned()` 中。
6. `I6`：`allowPendingSaves=false` 时，`ctx.fileBuffers` 中没有 `saving===true` 的 buffer。
7. `I7`：`ctx.detachedFileIds` 等于 `coordinator.listWindowOwned()` 中的 file id 集合；`ctx.detachedInstanceIds` 同理。

没有注入 FE-SEAM-1 时，跳过 I4 和 I7，并在断言消息里注明“未注入 coordinator”。

**HX-5：DOM polyfill 与几何桩**

- `FakeResizeObserver`：静态 `instances: Set`；实例有 `observed: Set<Element>`。实现 `observe`/`unobserve`/`disconnect`，以及 `trigger(targets?)`：只对仍在 `observed` 中的 target 回调，调用前包 `act`。
- `window.matchMedia`：返回 `matches:false`，空实现 `addEventListener`/`removeEventListener`/`addListener`/`removeListener`。
- `geometry.install({stripWidth, widthOf})`：
  - 用 `Object.defineProperty(HTMLElement.prototype,"clientWidth",{get(){return this.classList?.contains("pty-pane-tabs") ? stripWidth : 0}, configurable:true})`。
  - 对带 `data-workspace-content-key` 的元素，`getBoundingClientRect` 返回 `{width: widthOf(el.textContent)}`。
  - 返回 `{restore(), setStripWidth(n)}`：`setStripWidth` 修改闭包中的 `stripWidth`，供测试运行中改变窗格宽度（FE-T26 使用）。

**HX-6：使用规则**

每个宿主测试文件都必须遵守，写在 harness 文件头注释里：

1. 文件第一行写 `// @vitest-environment jsdom`。
2. `vi.mock` 必须写在测试文件里（会被提升）：

   ```ts
   vi.mock(
     "react-i18next",
     async () => (await import("../test/host/hostMocks")).reactI18nextMock,
   );
   vi.mock(
     "sonner",
     async () => (await import("../test/host/hostMocks")).sonnerMock,
   );
   vi.mock(
     "./PtyTerminal",
     async () => (await import("../test/host/hostMocks")).ptyTerminalMock,
   );
   ```

   - 路径相对于测试文件，宿主测试与 `PtyWorkspace.tsx` 同放在 `src/components/`。
   - FE-T08、FE-T09、FE-T36b 需要真实 i18n：不 mock `react-i18next`，改为 `import { i18n } from "../i18n"`。

3. `afterEach` 依次执行：`host.dispose()`、`cleanup()`、`resetFakeTerminals()`、`vi.useRealTimers()`，最后 `expect(tauriMock.state.eventListeners).toHaveLength(0)`（无监听泄漏）。vitest 2.1 的 `sequence.hooks` 默认值是 `stack`，所以测试文件里的 afterEach 先于 setup 文件里的 `tauriMock.reset()` 执行。
4. fake timers 只在挂载和 `launchPty` 之后开启：`vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","Date"]})`。不要 fake rAF、queueMicrotask、MessageChannel。推进时间用 `await act(async()=>{await vi.advanceTimersByTimeAsync(ms)})`。
5. 修改 tauriMock 的 vi.fn 实现时只用 `mockImplementationOnce`，或在 `finally` 中恢复原实现。原因是 `vi.clearAllMocks` 不会还原实现。
6. 断言文案时用 `expect.stringContaining("<i18n key>")`。
7. 主窗口和子窗口不能在同一个测试里同时渲染（当前 label 是全局状态）。跨窗协议的两端用 `src/test/host/handoffFixtures.ts` 中的金样载荷对齐：主窗口测试消费金样，子窗口测试断言自己发出的就是金样。

#### 3.3 生产代码 seam 与修复清单

| 编号       | 类型                | 位置                                                                                                                            | 修改                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 理由与对应测试                               |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| FE-SEAM-1  | 测试接缝            | `PtyWorkspace.tsx` 356、406 行                                                                                                  | `PtyWorkspaceProvider({children, coordinator}: {children:ReactNode; coordinator?: WorkspaceContentCoordinator})`；`useRef(coordinator ?? new WorkspaceContentCoordinator())`，加 JSDoc“仅测试注入”                                                                                                                                                                                                                                                                                                                                                       | 不变量 I4/I7，以及 FE-T13、FE-T20 的故障注入 |
| FE-SEAM-2  | 修复 + 纯函数       | `workspaceLayoutPersistence.ts` 新增导出；`PtyWorkspace.tsx` 505–531、727–754 行                                                | ① 新增 `export function listPersistedDetachedContents(windowOwned: WorkspacePaneContentRef[], tree: WorkspaceNode): WorkspacePaneContentRef[]`：返回不在树中的 windowOwned 内容（去重，保持顺序）。② `persistWorkspaceSnapshot` 和 `applyWorkspaceLayoutPreset` 改用 `listPersistedDetachedContents(coordinator.listWindowOwned(), tree)`。③ `persistWorkspaceSnapshot` 中用 try/catch 包住 `createWorkspaceLayoutDocument`：catch 时调用 `setLayoutSaveError(formatAppError(e,t))` 和 `console.error("[workspace.layout_snapshot_invalid]", e)`，不抛出 | S1A-N01；FE-T04、FE-T05、FE-T06、FE-T45      |
| FE-SEAM-3  | 修复                | 新建 `src/components/AppErrorBoundary.tsx`；`main.tsx` 用它包住 `<App/>`；10 个 locale 新增 `appCrash.title/description/reload` | 出错时渲染 `role="alert"` 区块和一个按钮（`t("appCrash.reload")`），点击调用 `window.location.reload()`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | “根无 ErrorBoundary”；FE-T07                 |
| FE-SEAM-4  | 修复 + 纯模块       | 新建 `src/lib/ptyInputWriter.ts`；`PtyTerminal.tsx` 253–265 行改用它                                                            | `createPtyInputWriter({getSessionId, write, maxChunkBytes=65536, retryDelaysMs=[16,32,64,128,256], onError})`，返回 `{push(data), dispose()}`                                                                                                                                                                                                                                                                                                                                                                                                            | S1C-N03；FE-T27                              |
| FE-SEAM-5  | 修复（含 Rust DTO） | `tauri.ts` 198 行类型；`ptySessionLifecycle.ts` 66–76 行；`PtyWorkspace.tsx` 1973–1978 行；Rust `get_pty_session_window_status` | 类型改为 `PtySessionWindowStatus = {state:"running"\|"ended"\|"ownedByAnotherWindow"; ownerLabel: string\|null}`；签名改为 `resolveDetachedStartTimeoutAction(status, {expectedChildLabel, childExists})`；新增返回值 `"reject-foreign-owner"`                                                                                                                                                                                                                                                                                                           | S1C-N05；FE-T28                              |
| FE-SEAM-6  | 修复（含 Rust）     | `src-tauri/src/lib.rs` 307–317 行 Destroyed 分支；`PtyWorkspace.tsx` 文件监听组                                                 | Rust 在撤销授权后执行 `emit_to("main","workspace-content-window-lost",{windowLabel})`；主窗口处理：把该窗口拥有的文件按重启规则放回焦点 pane，保留镜像 buffer，coordinator 用 ownerEnded+ensureAttached 重建，删除窗口句柄                                                                                                                                                                                                                                                                                                                               | S1A-N02；FE-T19                              |
| FE-SEAM-7  | 修复                | `PtyWorkspace.tsx` 2293–2368 行；新建 `src/lib/ptyOwnerLostRecovery.ts`                                                         | 导出 `PTY_OWNER_LOST_MAX_ATTEMPTS = 8`、`ptyOwnerLostRetryDelay(attempt)`（500·2^n，上限 4000ms）；重试循环接入 Provider 卸载用的 AbortController；用尽次数后 `toast.error(t("pty.ownerLostRecoveryFailed"))` 一次（新增 i18n 键）                                                                                                                                                                                                                                                                                                                       | S1A-N05；FE-T23                              |
| FE-SEAM-8  | 契约                | 新建 `contracts/error-codes.json`；`appErrors.ts` 导出 `APP_ERROR_TRANSLATION_KEYS`                                             | 契约内容为后端实际产出的 10 个码；前端映射键集合必须相等，删除 8 个死映射                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | S1B-N03；FE-T29、FE-T52                      |
| FE-SEAM-9  | 修复                | `PtyWorkspace.tsx` 537–621、623–665 行                                                                                          | `hydrateWorkspace` 不再依赖 `t`：用 `tRef.current` 读取最新 t；deps 改为 `[createSaveQueue]`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | FE-NEW-01；FE-T08、FE-T09                    |
| FE-SEAM-10 | 修复                | `PtyWorkspace.tsx` 2787–2841 行                                                                                                 | attached 处理器要求 `pending.handoffPayload !== undefined`（init 已发出），否则忽略                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | FE-NEW-03；FE-T40                            |
| FE-SEAM-11 | 修复                | `PtyWorkspace.tsx` 2565–2584、3148–3178 行                                                                                      | 先 `completeHandoff("returnReady")`，outcome 为 changed 后再 `commitTree`；不是 changed 就不改树，并发 return-failed                                                                                                                                                                                                                                                                                                                                                                                                                                     | S1A-N13；FE-T20                              |
| FE-SEAM-12 | 修复                | `App.tsx` 158–162 行                                                                                                            | 静默退出路径用 try/catch 包住 `confirmAppExit`：catch 时 `setExitPending(false)`，`setExitRequest(impacts)`，`setExitError(formatAppError(e,t))`                                                                                                                                                                                                                                                                                                                                                                                                         | S1A-N03；FE-T11                              |

以下修复只需要对应测试作为验收证据，不再单列 seam：

| 问题      | 修改要点                                                                                    | 对应测试       |
| --------- | ------------------------------------------------------------------------------------------- | -------------- |
| S1A-N04   | `onCloseUnsupported` 改为调用 `closeContents([pane.activeContent],"tab")`，不再只限 unknown | FE-T22         |
| S1A-N07   | 7 处 `.has` 归属判断全部改用 coordinator                                                    | FE-T13、FE-T56 |
| S1A-N10   | 拆分监听组，失败要可见                                                                      | FE-T24、FE-T25 |
| S1A-N11   | 每次 render 后重新登记标签元素                                                              | FE-T26         |
| S1A-N12   | hydrate、rehydrate、布局应用时，对被替换的 document 调用 dispose                            | FE-T21         |
| FE-NEW-02 | 子窗 setup effect 的 deps 去掉 t                                                            | FE-T36         |
| FE-NEW-04 | 恢复成功后保持“已恢复、禁止持久化”状态，直到 rehydrate 完成                                 | FE-T46         |
| FE-NEW-05 | 连续 3 次拒绝且 revision 不推进时调用 onError 并停止                                        | FE-T48         |

### 4. 测试补充规格

本节字段按“ID｜优先级｜对应问题”、文件与名称、层级/环境、前置、步骤、断言（含反向断言和不变量）、预期当前结果、seam 的顺序给出。凡写到 `host`，都指 `await mountWorkspace(...)` 的返回值。

#### P0

**FE-T01｜P0｜J3、R7-8**

- 文件：`src/components/PtyWorkspace.host.test.tsx`；`describe("PtyWorkspace host harness")`/`it("mounts, hydrates a missing layout and persists a valid snapshot without leaking listeners")`
- 层级/环境：host-integration / jsdom
- 前置：`createBackend()` 默认值；不开 fake timers。
- 步骤：① `host = await mountWorkspace()`；② `host.dispose()`；③ `await flush()`。
- 断言：
  - ①之后 `host.ctx().hydrationStatus === "ready"`。
  - `invokes("get_workspace_layout").length === 1`。
  - `host.backend.saved.length >= 1`，且每个 `layout.schemaVersion === 5`。
  - `assertWorkspaceInvariants(host)` 通过。
  - ③之后 `tauriMock.state.eventListeners` 为空。
- 反向断言：`host.errors` 为空；`toastSpy.error` 未被调用。
- 预期当前结果：通过（原型已验证）。
- seam：无。

**FE-T02｜P0｜S1B-N10**

- 文件：`src/test/tauriMock.test.tsx`（追加）；`describe("Tauri event target semantics")`，下设 3 个 it：
  - `it("delivers emitTo events to global Any listeners in every window")`
  - `it("delivers emitTo events only to window-scoped listeners of the target label")`
  - `it("broadcasts emit to every listener")`
- 层级/环境：infra / jsdom
- 前置：完成 HX-1。
- 步骤：
  - it1：`setCurrentWindowLabel("terminal-8e783338-f464-4b10-b15e-b534748c6241")`，`await listen("probe", spy)`（全局监听），然后 `await emitTo("main","probe",{n:1})`。
  - it2：`await getCurrentWebviewWindow().listen("probe", spy)`（同一个 terminal label），然后 `emitTo("main",…)` 一次，`emitTo(<terminal label>,…)` 一次。
  - it3：注册一个全局监听和一个窗口监听，然后 `await emit("probe",{})`。
- 断言：
  - it1：spy 被调用 1 次，参数里 payload 为 `{n:1}`。
  - it2：spy 只被调用 1 次，且对应第二次 emit。
  - it3：两个 spy 各被调用 1 次。
- 反向断言：it2 中发给 main 的那次不得投递给 terminal 的窗口级监听。
- 预期当前结果：it1 失败（当前 mock 会按 owner 过滤）；HX-1 完成后通过。
- seam：HX-1。

**FE-T03｜P0｜S1B-N01、门禁 5**

- 文件：重写 `src/lib/windowApiPermissions.test.ts`，保留 `describe("native API permissions by window kind")`/`it.each(kinds)("grants APIs used by $id")`，并新增：
  - `it("scans every module in each window kind's import closure")`
  - `it.each([["terminal","core:event:allow-emit-to"],["workspaceContent","core:event:allow-emit-to"],["main","core:window:allow-set-focus"]])("reports %s when %s is removed")`
- 层级/环境：contract / node
- 前置：
  - 键归一化：`./x` 映射为 `src/lib/x`，`../dir/x` 映射为 `src/dir/x`。
  - 读源码时找不到 key 就抛 `Error("unscanned source: …")`。
  - 入口：main 为 `src/main.tsx`；terminal 为 `src/components/StandalonePtyWindow.tsx`、`src/hooks/useThemeSync.ts`；workspaceContent 为 `src/components/StandaloneWorkspaceFileWindow.tsx`、`src/hooks/useThemeSync.ts`。
  - 闭包：解析 `from "./…"`、`from "../…"`、`import("…")`，按 `.ts`、`.tsx`、`/index.ts` 补后缀；排除 `*.test.*` 和 `src/test/**`。
  - 子窗口闭包排除 `MAIN_ONLY_MODULES = ["src/lib/appPreferencesMain.ts"]`，并加注释说明只在 label==="main" 时执行，运行时由 FE-T32 证明。
  - 规则表在原表基础上新增：`\.once\s*\(` 和 `\.on(Resized|Moved|CloseRequested|ThemeChanged|FocusChanged)\s*\(` 要求 listen+unlisten；`WebviewWindow\.getByLabel\(` 要求 `core:webview:allow-get-all-webviews`；导入 `@tauri-apps/plugin-dialog` 时 capability 中至少有一项以 `dialog:` 开头；导入 `@tauri-apps/plugin-opener` 时至少有一项以 `opener:` 开头。
  - 删除“有 core:default 就跳过所有 core:\*”的逻辑，改为只用 HX-1 的 `CORE_DEFAULT_IMPLIES` 集合判定隐含权限。
- 步骤：
  - 闭包用例：计算三类窗口的闭包。
  - 变异用例：复制 capability 对象，删除指定权限，然后运行检查函数 `findMissingPermissions(kind, capability)`（抽成测试内函数）。
- 断言：
  - 闭包用例：terminal 闭包包含 `src/lib/workspaceContentWindowProtocol.ts`、`src/lib/appPreferencesChild.ts`、`src/components/PtyTerminal.tsx`；workspaceContent 闭包包含 `src/lib/workspaceContentWindowProtocol.ts`；main 闭包包含 `src/hooks/useExecutionTasks.ts`。
  - 主用例：三类窗口的 `findMissingPermissions` 都返回 `[]`。
  - 变异用例：返回值包含被删除的权限。
- 反向断言：任何入口闭包都不能出现读不到源码的 key（检查函数应抛错，测试要断言不抛）。
- 预期当前结果：现文件的变异用例会失败（已证明它扫描不到协议模块）；按本规格重写后，三个用例都应通过。
- seam：无。

**FE-T04｜P0｜S1A-N01、R4、门禁 3/4**

- 文件：`src/components/PtyWorkspace.handoff.host.test.tsx`；`describe("PTY return to the workspace")`/`it("keeps the workspace mounted and persists a valid layout while a PTY is returning")`
- 层级/环境：host-integration / jsdom
- 前置：`mountWorkspace({coordinator: new WorkspaceContentCoordinator()})`；`{slot, terminal} = await launchPty(host)`；`{windowLabel} = await detachPtyToWindow(host, slot.instanceId)`；设置 `const attach = deferred(); terminal.attachHandoff.mockImplementationOnce(() => attach.promise)`。
- 步骤：
  1. `emitToMain("pty-return-requested",{instanceId:slot.instanceId,sessionId:slot.sessionId,windowLabel,token:"return-1"})`，然后 `flush()`。
  2. 在 `act` 中调用 `host.ctx().focusPane(listWorkspacePanes(host.ctx().tree)[0].id)` 和 `host.ctx().splitPane(<同一 pane id>,"horizontal")`，然后 `flush()`。
  3. `attach.resolve({sessionId:slot.sessionId,state:"running"})`，然后 `flush()`。
  4. `host.dispose()`。
- 断言：
  - 步骤 2 之后 `host.coordinator.get({kind:"pty",slotId})?.phase === "returning"`。
  - 步骤 2 之后最后一次保存布局的 `detachedContents` 包含 `{kind:"pty",slotId}`，`slots` 中有该 slot。
  - 步骤 3 之后：树中恰好有一个 pane 包含该 slot；`host.ctx().detachedInstanceIds.has(slotId)===false`；`tauriMock.state.windowActions` 中有 `{windowLabel, action:"destroy"}`。
  - 每一步之后都执行 `assertWorkspaceInvariants(host)`。
- 反向断言：`host.errors` 全程为空（包括步骤 4 之后，覆盖卸载时那次持久化）；`screen.queryByText("host crashed")` 为 null；不得向 windowLabel 发出 `pty-return-failed`。
- 预期当前结果：失败。步骤 1 之后 `host.errors` 就包含 `Workspace layout contains unowned content or focus`（原型已复现）。
- seam：FE-SEAM-1、FE-SEAM-2。

**FE-T05｜P0｜S1A-N01、B3F-F02（拖回非源 pane）**

- 文件：`src/components/PtyWorkspace.handoff.host.test.tsx`；`describe("file return to the workspace")`，下设 2 个 it：
  - `it("returns a detached file to a non-source pane exactly once")`
  - `it("keeps the returned buffer newer than the stale main mirror")`
- 层级/环境：host-integration / jsdom
- 前置：`mountWorkspace({coordinator})`；`doc = await openFile(host,"a.txt")`；`paneA = 当前唯一 pane id`；在 act 中 `host.ctx().splitPane(paneA,"horizontal")`；`paneB = listWorkspacePanes(tree).find(p=>p.id!==paneA).id`；`{token,windowLabel,initBuffer} = await detachFileToWindow(host, doc.id)`。
- 步骤：
  - it1：`emitToMain("workspace-file-window-return-requested",{documentId:doc.id,token,windowLabel,targetPaneId:paneB,fileDocument:doc,fileBuffer:{...initBuffer,content:"edited in window",version:initBuffer.version+1}})`，然后 `flush()`。
  - it2：使用同一载荷，然后读取 `host.ctx().fileBuffers[doc.id]`。
- 断言：
  - it1：paneB 的 contents 等于 `[{kind:"file",documentId:doc.id}]`；paneA 中不包含该文件；`host.ctx().detachedFileIds.has(doc.id)===false`；向 windowLabel 发出了 `workspace-file-window-return-complete`；`invokes("revoke_content_window_file")` 的长度为 1，且 `args.targetLabel===windowLabel`；`assertWorkspaceInvariants(host)` 通过。
  - it2：buffer 的 content 为 `"edited in window"`，version 为 `initBuffer.version+1`。
- 反向断言：errors 为空；没有发出 `workspace-file-window-return-failed`；最后一次保存的 `detachedContents` 中不包含 doc。
- 预期当前结果：失败（S1A-N01 会在 beginReturn 之后立刻崩溃，原型已复现）。
- seam：FE-SEAM-1、FE-SEAM-2。

**FE-T06｜P0｜S1A-N01**

- 文件：`src/lib/workspaceLayoutPersistence.test.ts`（追加）；`describe("persisted detached contents")`，下设 3 个 it：
  - `it("keeps returning and window-closing contents outside the tree as detached")`
  - `it("omits window-owned contents that are already in the tree")`
  - `it("lets createWorkspaceLayoutDocument accept a returning PTY snapshot")`
- 层级/环境：unit / node
- 前置：`c = new WorkspaceContentCoordinator()`；`pty={kind:"pty",slotId:"s1"}`；`c.beginDetach(pty,{kind:"pane",windowLabel:"main",paneId:"p1"},{kind:"window",windowLabel:"terminal-x"},"t1")`；`c.completeHandoff(pty,"detachReady","t1")`；`c.beginReturn(pty,"t2","main","p1")`；`tree = createWorkspacePane("p1")`。
- 步骤：调用 `listPersistedDetachedContents(c.listWindowOwned(), tree)`。it2 改用一棵已包含 pty 的树（`addSessionToWorkspacePane(tree,"p1","s1")`）。it3 用 it1 的结果加上 slot 夹具调用 `createWorkspaceLayoutDocument`。
- 断言：
  - it1 结果为 `[{kind:"pty",slotId:"s1"}]`。
  - it2 结果为 `[]`。
  - it3 不抛错，且返回文档的 `detachedContents` 长度为 1。
- 反向断言：结果中不能出现处于 detaching 阶段、仍在树中的内容。
- 预期当前结果：失败（函数尚不存在）。
- seam：FE-SEAM-2。

**FE-T07｜P0｜S1A-N01（根无 ErrorBoundary）**

- 文件：`src/components/AppErrorBoundary.test.tsx`，下设 2 个 it：
  - `describe("AppErrorBoundary")`/`it("renders a recoverable fallback instead of unmounting the window")`
  - `it("is mounted around App in the renderer entry")`
- 层级/环境：component / jsdom；第二个是 contract / node。
- 前置：使用 stable t mock；`Thrower` 组件在 useEffect 中 `throw new Error("boom")`；`vi.spyOn(window.location,"reload")`（jsdom 中改用 `Object.defineProperty(window,"location",{value:{...location,reload:vi.fn()}})`）。
- 步骤：
  - it1：`render(<AppErrorBoundary><Thrower/></AppErrorBoundary>)`，然后 `flush()`，再点击 `t("appCrash.reload")` 按钮。
  - it2：以 `?raw` 导入 `src/main.tsx`，用正则匹配 `<AppErrorBoundary>\s*<App\s*\/>\s*<\/AppErrorBoundary>`。
- 断言：
  - it1：`role="alert"` 存在且包含 `appCrash.title`；点击后 reload 被调用 1 次。
  - it2：正则匹配成功。
- 反向断言：it1 中 container 不能变成空节点。
- 预期当前结果：失败（组件不存在）。
- seam：FE-SEAM-3。

**FE-T08｜P0｜FE-NEW-01（新发现）**

- 文件：`src/components/PtyWorkspace.i18n.host.test.tsx`（不 mock react-i18next）；`describe("workspace across UI language changes")`/`it("does not rehydrate, drop buffers or remove running PTYs when the language changes")`
- 层级/环境：host-integration / jsdom
- 前置：`await i18n.changeLanguage("en")`；`host = await mountWorkspace()`；`doc = await openFile(host)`；`{slot} = await launchPty(host)`；在 act 中 `host.ctx().editFile(doc.id,"unsaved edit")`；把 `host.backend.layout` 设为 `{status:{status:"ready"}, revision: 最后一次保存的 revision, layout: 最后一次保存的布局, slotStates:[{instanceId:slot.instanceId,state:"running",currentProjectName:"Project"}], schemaVersion:5, updatedAtMs:null}`。
- 步骤：`await act(async()=>{await i18n.changeLanguage("zh")})`，然后 `flush(10)`。
- 断言：
  - `invokes("get_workspace_layout").length === 1`。
  - `host.ctx().fileBuffers[doc.id].content === "unsaved edit"`。
  - `host.ctx().slots.map(s=>s.instanceId)` 仍为 `[slot.instanceId]`。
  - `fakeTerminals.length === 1`，且 startSession 只被调用 1 次。
  - `assertWorkspaceInvariants(host)` 通过。
- 反向断言：不得出现 `hydrationStatus === "loading"` 的中间态（Probe 记录状态序列，序列中不得含 loading）；errors 为空。
- 预期当前结果：失败（原型：读取布局 1→2 次，buffer 变回 `"hello"`，slots 变为 0）。
- seam：FE-SEAM-9。

**FE-T09｜P0｜FE-NEW-01 + S1A-N07（分离窗口变成无主窗口）**

- 文件：`src/components/PtyWorkspace.i18n.host.test.tsx`；`it("keeps a detached file owned by its window and flush-protected after a language change")`
- 层级/环境：host-integration / jsdom
- 前置：`await i18n.changeLanguage("en")`；`host = await mountWorkspace({coordinator})`；`doc = await openFile(host)`；`{windowLabel} = await detachFileToWindow(host, doc.id)`；backend.layout 设为最后一次保存的布局，`status ready`。
- 步骤：
  1. `act(()=>i18n.changeLanguage("zh"))`，然后 `flush(10)`。
  2. `vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]})`。
  3. `impacts = host.ctx().collectExitImpacts(0)`。
  4. `act(()=>vi.advanceTimersByTimeAsync(600))`，然后 await impacts。
- 断言：
  - 步骤 1 之后 `host.ctx().detachedFileIds.has(doc.id)===true`，树中不包含该文件。
  - 步骤 4 结果中 `dirtyFiles.map(f=>f.documentId)` 等于 `[doc.id]`（子窗口没有应答 flush，按不确定处理）。
  - 向 windowLabel 发出过 `workspace-file-window-flush-requested`。
- 反向断言：不得向 windowLabel 调用 destroy；`invokes("revoke_content_window_file")` 为 0。
- 预期当前结果：失败（rehydrate 会把文件放回 pane、清空句柄，退出预检得到 `dirtyFiles=[]`）。
- seam：FE-SEAM-1、FE-SEAM-9。

**FE-T10｜P0｜B2-F01、M6-F07 自动化部分**

- 文件：`src/App.exit.host.test.tsx`；`describe("application exit precheck")`，用 `it.each` 覆盖 3 个状态 × 2 个动作，每行写全：
  1. `["dirty file only", {ptyCount:0, dirty:true}, "cancel"]`
  2. `["dirty file only", {ptyCount:0, dirty:true}, "confirm"]`
  3. `["running PTY only", {ptyCount:1, dirty:false}, "cancel"]`
  4. `["running PTY only", {ptyCount:1, dirty:false}, "confirm"]`
  5. `["PTY and dirty file", {ptyCount:2, dirty:true}, "cancel"]`
  6. `["PTY and dirty file", {ptyCount:2, dirty:true}, "confirm"]`
  7. `["execution tasks only", {ptyCount:0, executionTaskCount:2, dirty:false}, "cancel"]`（PD-01）
  8. `["execution tasks only", {ptyCount:0, executionTaskCount:2, dirty:false}, "confirm"]`（PD-01）
  9. `["everything at once", {ptyCount:1, executionTaskCount:2, dirty:true}, "confirm"]`（PD-01）

  另加 `it("exits immediately without a dialog when nothing would be lost")` 和 `it("replaces a pending dialog when exit is requested again")`。

- 层级/环境：host-integration（App）/ jsdom
- 前置：`mountApp()`。dirty 行的 backend.layout 为 `{status:{status:"ready"},revision:1,schemaVersion:5,slotStates:[],updatedAtMs:null,layout:{schemaVersion:5,tree:{kind:"pane",id:"p1",paneNumber:1,contents:[{kind:"file",documentId:"d1"}],activeContent:{kind:"file",documentId:"d1"}},focusedPaneId:"p1",slots:[],documents:[{id:"d1",directoryId:1,directoryPath:"C:/project",relativePath:"a.txt"}],detachedContents:[]}}`，挂载后用 `fireEvent.change(screen.getByLabelText("editor"),{target:{value:"dirty"}})`；非 dirty 行使用默认 backend。
- 步骤：
  1. `emitBackendEvent("app-exit-requested",{ptyCount})`，然后 `flush()`。
  2. 在 `role="dialog"` 内点击 `common.cancel` 或 `appExit.confirmDiscard`。
  3. `flush()`。
- 断言：
  - 对话框存在。ptyCount>0 时对话框文本包含 `appExit.description`；dirty 时包含 `a.txt`。
  - cancel：对话框消失；`invokes("confirm_app_exit")` 为 0；dirty 行 textarea 的值仍为 `"dirty"`。
  - confirm：`invokes("confirm_app_exit")` 为 1。
  - 无影响用例：没有 `role=dialog`，`confirm_app_exit` 为 1。
  - 重入用例：连发两次请求后只有一个 dialog，`confirm_app_exit` 为 0。
  - **PD-01 已确认（第 7 至 9 行，依赖 FE-T61 的载荷与 RS-T58 的 `executionTaskCount`）：** 对话框展示 `appExit.executionTasks` 文案（带 `count` 参数）；没有 PTY 与脏文件、只有执行任务时对话框仍然出现（不走静默退出）；cancel 不终止任务（`invokes("cancel_execution_task")` 为 0）；confirm 只调用 `confirm_app_exit`（终止由 Rust 执行）。这三行预期当前失败，用 `it.fails` 落地；10 个 locale 增加 `appExit.executionTasks`。
- 反向断言：cancel 不得调用 `terminate_pty_session`；errors 为空。
- 预期当前结果：通过（补证据）。
- seam：无。

**FE-T11｜P0｜S1A-N03**

- 文件：`src/App.exit.host.test.tsx`，下设 2 个 it：
  - `it("recovers the dialog when a silent exit is rejected by the backend")`
  - `it("re-enables actions when a confirmed exit fails")`
- 层级/环境：host-integration（App）/ jsdom
- 前置：`mountApp()`。
  - it1：`backend.handlers.set("confirm_app_exit",()=>{throw {code:"pty_sessions_active",message:"still running",params:{count:1}}})`。
  - it2：使用 FE-T10 的 dirty 夹具，并设置同样的拒绝处理。
- 步骤：
  - it1：`emitBackendEvent("app-exit-requested",{ptyCount:0})`，然后 `flush(10)`。
  - it2：发送请求，点击 `appExit.confirmDiscard`，然后 `flush()`。
- 断言：
  - it1：dialog 存在；包含 `errors.ptySessionsActive` 的文本可见（`.error`）；`common.cancel` 按钮 `disabled===false`；第二个按钮文本为 `appExit.confirmDiscard` 且 `disabled===false`；点击 cancel 后 dialog 消失。
  - it2：两个按钮均为 enabled，错误文本可见。
- 反向断言：it1 不能出现 `appExit.terminating`。
- 预期当前结果：it1 失败（原型已复现）；it2 通过。
- seam：FE-SEAM-12。

**FE-T12｜P0｜B2-F01（flush 超时按脏处理）、B3F-F08**

- 文件：`src/components/PtyWorkspace.exit.host.test.tsx`；`describe("exit impacts for detached files")`，下设 2 个 it：
  - `it("treats a detached file whose window never acknowledges flush as dirty")`
  - `it("uses the window's flushed buffer when it acknowledges in time")`
- 层级/环境：host-integration / jsdom
- 前置：`host = await mountWorkspace()`；`doc = await openFile(host)`；`{token,windowLabel,initBuffer} = await detachFileToWindow(host,doc.id)`；然后开启 fake timers。
- 步骤：
  - it1：`p = host.ctx().collectExitImpacts(0)`，`advanceTimersByTimeAsync(600)`，await p。
  - it2：`p = collectExitImpacts(0)`，`flush()`（仍在 fake 状态下用 `advanceTimersByTimeAsync(0)`）；从 `tauriMock.state.emittedEvents` 找到发往 windowLabel 的 flush-requested，取出其 requestId；发送 `emitToMain("workspace-file-window-flush-complete",{documentId:doc.id,token,windowLabel,requestId,fileDocument:doc,fileBuffer:{...initBuffer,content:"x",version:initBuffer.version+1}})`；然后 `advanceTimersByTimeAsync(10)`。
- 断言：
  - it1：`dirtyFiles` 为 `[{documentId:doc.id,relativePath:"a.txt"}]`。
  - it2：`dirtyFiles` 长度为 1，且 `host.ctx().fileBuffers[doc.id].content==="x"`。
- 反向断言：it2 不得等待满 500ms（结果在推进 10ms 内就 resolve）。
- 预期当前结果：通过（原型已验证 it1）。
- seam：无。

**FE-T13｜P0｜S1A-N07（PtyWorkspace.tsx:3370）**

- 文件：`src/components/PtyWorkspace.exit.host.test.tsx`；`it("asks to flush every window-owned file even when the window handle table is missing it")`
- 层级/环境：host-integration / jsdom
- 前置：`coordinator = new WorkspaceContentCoordinator()`；`host = await mountWorkspace({coordinator})`；`doc = await openFile(host)`；`pane = 唯一 pane`；在 act 中执行 `coordinator.reconcileDetached({kind:"file",documentId:doc.id},{kind:"pane",windowLabel:"main",paneId:pane.id},{kind:"window",windowLabel:"workspace-content-8e783338-f464-4b10-b15e-b534748c6241"},"tok-x")`；开启 fake timers。
- 步骤：`p = collectExitImpacts(0)`，`advanceTimersByTimeAsync(600)`，await p。
- 断言：`dirtyFiles.map(f=>f.documentId)` 等于 `[doc.id]`；emittedEvents 中有发往该 label 的 `workspace-file-window-flush-requested`。
- 反向断言：结果不能是 `dirtyFiles: []`。
- 预期当前结果：失败（第 3370 行要求句柄表中有该窗口）。
- seam：FE-SEAM-1。

**FE-T14｜P0｜B3F-F02（分离中应用命名布局）**

- 文件：`src/components/PtyWorkspace.layout.host.test.tsx`；`describe("named layouts with detached contents")`/`it("keeps a detached file out of the applied tree and in persisted detached contents")`
- 层级/环境：host-integration / jsdom
- 前置：`host = await mountWorkspace({coordinator})`；`doc = await openFile(host)`；`await detachFileToWindow(host,doc.id)`；`backend.handlers.set("plan_apply_workspace_layout_preset",()=>({slotStates:[],layout:{schemaVersion:5,focusedPaneId:"pa",slots:[],detachedContents:[],documents:[{id:"preset-doc",directoryId:1,directoryPath:"C:/project",relativePath:"a.txt"}],tree:{kind:"split",id:"s1",direction:"horizontal",ratio:0.5,first:{kind:"pane",id:"pa",paneNumber:1,contents:[{kind:"file",documentId:"preset-doc"}],activeContent:{kind:"file",documentId:"preset-doc"}},second:{kind:"pane",id:"pb",paneNumber:2,contents:[],activeContent:null}}}}))`。
- 步骤：`act(()=>host.ctx().applyWorkspaceLayoutPreset("preset-1"))`，然后 `flush()`。
- 断言：
  - `listWorkspacePanes(tree)` 有 2 个 pane，且两者 contents 都为空。
  - `host.ctx().detachedFileIds.has(doc.id)`。
  - 最后一次保存的 `detachedContents` 为 `[{kind:"file",documentId:doc.id}]`；`documents` 只有 1 个，且 id 为 doc.id。
  - 不变量通过。
- 反向断言：不能出现 id 为 `preset-doc` 的文档；不能对窗口调用 destroy。
- 预期当前结果：通过（原型已验证）。
- seam：FE-SEAM-1（不变量）。

**FE-T15｜P0｜B3F-F02（重启 hydration）**

- 文件：`src/components/PtyWorkspace.layout.host.test.tsx`；`it("rehomes persisted detached files into the focused pane on startup")`
- 层级/环境：host-integration / jsdom
- 前置：`createBackend({status:{status:"ready"},revision:3,schemaVersion:5,layout:{schemaVersion:5,tree:{kind:"pane",id:"pane-1",paneNumber:1,contents:[],activeContent:null},focusedPaneId:"pane-1",slots:[],documents:[{id:"doc-1",directoryId:1,directoryPath:"C:/project",relativePath:"a.txt"}],detachedContents:[{kind:"file",documentId:"doc-1"}]}})`。
- 步骤：`mountWorkspace({backend,coordinator})`，然后 `flush()`。
- 断言：
  - pane-1 的 contents 为 `[{kind:"file",documentId:"doc-1"}]`。
  - 首次保存的 `revision===4`，`detachedContents` 为 `[]`。
  - `coordinator.get({kind:"file",documentId:"doc-1"}).phase==="attached"`。
  - 不变量通过。
- 反向断言：不能创建任何窗口（`createdWindows` 为空）。
- 预期当前结果：通过（原型已验证）。
- seam：FE-SEAM-1。

**FE-T16｜P0｜B3F-F03、R8**

- 文件：`src/components/PtyWorkspace.save.host.test.tsx`；`describe("in-flight saves")`，下设 4 个 it。每个 it 的公共前置：`host = await mountWorkspace({coordinator})`；`doc = await openFile(host)`；`save = deferred()`；`backend.handlers.set("save_project_text_file",()=>save.promise)`；在 act 中 `editFile(doc.id,"edited")`；`saving = host.ctx().saveFile(doc.id)`；断言 `fileBuffers[doc.id].saving===true`。
  - **it1** `it("clears saving after a named layout applies during the save")`
    - 步骤：plan handler 返回单 pane `pa`，其中包含 `{kind:"file",documentId:"p-doc"}`，对应 documents 中 relativePath 为 `"a.txt"` 的文档；`applyWorkspaceLayoutPreset("p")`；`save.resolve({kind:"saved",content:"edited",revision:"r2",warning:null})`；await saving；`flush()`。
    - 断言：buffer `{saving:false,savedContent:"edited",revision:"r2"}`；`fileDocuments` 的 id 为 `[doc.id]`；不变量（`allowPendingSaves:false`）通过。
    - 预期：通过。
  - **it2** `it("does not resurrect a document closed while its save is in flight")`
    - 步骤：`closeContents([{kind:"file",documentId:doc.id}],"tab")`；`flush()`；在 `role="alertdialog"` 中点击 `common.confirm`；`flush()`；`save.resolve({kind:"saved",content:"edited",revision:"r2",warning:null})`；await saving；`flush()`。
    - 断言：`fileDocuments` 为 `[]`；`fileBuffers[doc.id]` 为 undefined；`editor.releaseDocument` 以 doc.id 被调用 1 次。
    - 反向断言：`toastSpy.error` 未被调用。
    - 预期：通过。
  - **it3** `it("reloads only after the in-flight save settles")`
    - 前置追加：本 it 的第一次保存返回冲突。把 `save_project_text_file` 的 handler 改为先返回 `{kind:"conflict"}`；完成第一次保存后，从 `toastSpy.error.mock.calls[0][1].action.onClick` 取出 `reload`。然后在 act 中 `editFile(doc.id,"second")`，`second = deferred()`，handler 改为返回 `second.promise`，执行 `saving2 = saveFile(doc.id)`；`backend.files.set("a.txt",{content:"disk-v2",revision:"r9"})`。
    - 步骤：在 act 中调用 `reload()`；`flush()`；断言此时 `invokes("open_project_file")` 只有初次打开那 1 次；`second.resolve({kind:"saved",content:"second",revision:"r3",warning:null})`；await saving2；`flush()`。
    - 断言：之后 `open_project_file` 共 2 次；buffer `{content:"disk-v2",savedContent:"disk-v2",saving:false}`；epoch 比冲突前大 1。
    - 预期：通过。
  - **it4** `it("starts a detach only after the in-flight save settles and transfers the saved buffer")`
    - 步骤：在 act 中 `void detachFile(doc.id)`；`flush()`；断言 `createdWindows.length===0` 且 `invokes("grant_content_window_file").length===0`；`save.resolve({kind:"saved",content:"edited",revision:"r2",warning:null})`；`flush()`；从 URL 取 token；发送 ready；`flush()`。
    - 断言：init 载荷的 fileBuffer 为 `{saving:false,savedContent:"edited",content:"edited"}`。
    - 预期：通过。
- 层级/环境：host-integration / jsdom
- seam：FE-SEAM-1。

**FE-T17｜P0｜B3F-F06、B3F-F05、R2**

- 文件：`src/components/PtyWorkspace.close.host.test.tsx`；`describe("mixed content close")`，下设 6 个 it。公共前置：`host = await mountWorkspace({coordinator})`；`doc = await openFile(host)`；在 act 中 `editFile(doc.id,"dirty")`；`{slot,terminal} = await launchPty(host)`（与文件在同一 pane）；`refs = [{kind:"pty",slotId:slot.instanceId},{kind:"file",documentId:doc.id}]`。
  - **it1** `it("asks once for running PTY and dirty file impacts and cancels both")`
    - 步骤：在 act 中 `void closeContents(refs,"menu")`；`flush()`；点击 `common.cancel`；`flush()`。
    - 断言：只出现过 1 个 alertdialog，文本包含 `pty.confirmCloseMany` 和 `a.txt`；关闭后文件和 slot 都在；`terminal.closeSession` 未被调用；`closingContentKeys.size===0`；两项的 coordinator phase 都是 attached。
    - 预期：通过。
  - **it2** `it("closes both after one confirmation and disposes the file once")`
    - 步骤：同 it1，但点击 `common.confirm`。
    - 断言：`terminal.closeSession` 以 `false` 被调用 1 次；slots 为 `[]`；`fileDocuments` 为 `[]`；`releaseDocument` 以 doc.id 被调用 1 次；不变量通过。
    - 预期：通过。
  - **it3** `it("vetoes the whole batch when one adapter's beforeClose returns false")`
    - 前置：`mountWorkspace({adapters:[ptyAdapterFromBuiltins, {...fileAdapterFromBuiltins,id:"test.file",lifecycle:{...fileAdapterFromBuiltins.lifecycle,beforeClose:()=>false}}]})`。内建 adapter 对象通过 `registerBuiltinWorkspaceContentAdapters()` 注册后，用 `getWorkspaceContentAdapter(kind)` 取出浅拷贝，再注销。
    - 步骤：`closeContents(refs,"menu")`；`flush()`。
    - 断言：没有 alertdialog；文件和 slot 都在；`closeSession` 未被调用。
    - 预期：通过。
  - **it4** `it("treats a throwing beforeClose as a veto")`
    - 前置：同 it3，但 `beforeClose` 改为 `()=>{throw new Error("x")}`。
    - 步骤与断言同 it3。
    - 预期：通过。
  - **it5** `it("keeps a PTY whose termination fails and reports it")`
    - 前置：`terminal.closeSession.mockRejectedValueOnce(new Error("kill failed"))`。
    - 步骤：`closeContents([refs[0]],"tab")`；确认；`flush()`。
    - 断言：slot 仍在；`toastSpy.error` 以包含 `pty.closeFailedMany` 的字符串被调用；`closingContentKeys.size===0`；coordinator phase 为 attached。
    - 预期：通过。
  - **it6** `it("keeps a terminating PTY in closing and rejects moves until it ends")`
    - 前置：`terminal.closeSession.mockResolvedValueOnce("terminating")`；先 `splitPane` 得到 paneB。
    - 步骤：关闭 PTY 并确认；`flush()`；`moveSession(paneA,paneB,slot.instanceId)`；`flush()`；`terminal.emitSessionChange({...running,state:"exited"})`；`flush()`。
    - 断言：在 `emitSessionChange` 之前 `closingContentKeys.has("pty:"+slot.instanceId)` 为真（键格式以 `workspaceContentKey` 为准），且 PTY 仍在 paneA；之后 slots 为 `[]`。
    - 预期：通过。
- 层级/环境：host-integration / jsdom
- seam：FE-SEAM-1。

**FE-T18｜P0｜B2-F07**

- 文件：`src/components/StandaloneWorkspaceFileWindow.test.tsx`；`describe("file window before ready")`，下设 3 个 it：
  - `it("reports closed-before-ready and destroys itself when closed before init")`
  - `it("does not send ready when unmounted during listener registration")`
  - `it("ignores a duplicate ready at the main window after the handoff completed")`（此 it 写在 `PtyWorkspace.handoff.host.test.tsx`）
- 层级/环境：it1/it2 为 component（子窗）/ jsdom；it3 为 host-integration / jsdom。
- 前置：`mountFileWindow()`。it2 让窗口 `listen` 用 `mockImplementationOnce` 返回挂起的 promise。
- 步骤：
  - it1：`flush()`；`tauriMock.emitEvent("tauri://close-requested",{},label)`；`flush()`。
  - it2：在注册挂起时 unmount，然后 resolve 注册。
  - it3：完成 `detachFileToWindow` 后，再发一次同样的 ready。
- 断言：
  - it1：emittedEvents 中有发往 `"main"` 的 envelope，`type:"workspace-file-window-attach-failed"`，`payload.reason:"closed-before-ready"`；`windowActions` 中有 `{windowLabel:label,action:"destroy"}`。
  - it2：没有任何 `workspace-file-window-ready` 被发出；卸载后 eventListeners 为 0。
  - it3：发往子窗的 init 只有 1 次；`createdWindows.length===1`；errors 为空。
- 反向断言：it1 中不得发出 `workspace-file-window-return-requested`。
- 预期当前结果：通过（补证据）。
- seam：无。

#### P1

**FE-T19｜P1｜S1A-N02**

- 文件：`src/components/PtyWorkspace.recovery.host.test.tsx`；`describe("detached window loss")`/`it("rehomes a file whose standalone window was destroyed and keeps its mirrored buffer dirty")`
- 层级/环境：host-integration / jsdom
- 前置：`host = await mountWorkspace({coordinator})`；`doc = await openFile(host)`；`{token,windowLabel,initBuffer} = await detachFileToWindow(host,doc.id)`；发送 `emitToMain("workspace-file-window-buffer-changed",{documentId:doc.id,token,windowLabel,fileDocument:doc,fileBuffer:{...initBuffer,content:"mirror",version:initBuffer.version+1}})`。
- 步骤：`tauriMock.destroyWindow(windowLabel)`；`emitBackendEvent("workspace-content-window-lost",{windowLabel})`；`flush()`。
- 断言：
  - 焦点 pane 的 contents 包含该文件。
  - `detachedFileIds.has(doc.id)===false`。
  - `fileBuffers[doc.id].content==="mirror"`，且 `content!==savedContent`。
  - 最后一次保存的 detachedContents 为 `[]`。
  - 不变量通过。
- 反向断言：不得重新从磁盘读取（`open_project_file` 只有 1 次）；不得发出 return-complete。
- 预期当前结果：失败（没有任何回收路径）。
- seam：FE-SEAM-1、FE-SEAM-6。

**FE-T20｜P1｜S1A-N13**

- 文件：`src/components/PtyWorkspace.handoff.host.test.tsx`；`it("does not commit the returned file into the tree when the ownership commit is rejected")`
- 层级/环境：host-integration / jsdom
- 前置：同 FE-T05 前置；`const original = coordinator.completeHandoff.bind(coordinator); vi.spyOn(coordinator,"completeHandoff").mockImplementation((c,type,id)=> type==="returnReady" ? {outcome:"ignored", state: coordinator.get(c)!} : original(c,type,id))`。
- 步骤：发送 return-requested（targetPaneId 为 paneB）；`flush()`。
- 断言：
  - 任何 pane 都不包含该文件。
  - 向 windowLabel 发出了 `workspace-file-window-return-failed`。
  - `detachedFileIds.has(doc.id)===true`。
  - 不变量 I3/I4/I5 通过。
- 反向断言：不得发出 return-complete；不得 revoke。
- 预期当前结果：失败（先提交树后 completeHandoff，并且依赖 FE-T05 的修复才能运行到这一步）。
- seam：FE-SEAM-1、FE-SEAM-2、FE-SEAM-11。

**FE-T21｜P1｜S1A-N12、B3F-F09**

- 文件：`src/components/PtyWorkspace.close.host.test.tsx`；`describe("editor model release")`，下设 3 个 it：
  - `it("releases models of documents dropped by rehydrateWorkspace")`
  - `it("releases models of documents replaced by retry hydration")`
  - `it("does not release a document kept across a named layout apply")`
- 层级/环境：host-integration / jsdom
- 前置：`doc = await openFile(host)`。
- 步骤：
  - it1：`act(()=>host.ctx().rehydrateWorkspace())`；`flush()`。
  - it2：设 `backend.layout.status={status:"ready"}`，layout 为 documents 为空、单 pane 的 v5 布局；先调用 `retryHydration()`（在 hydrationStatus 为 loadFailed 时可用：先用 `get_workspace_layout` 抛错让首次 hydrate 失败，再恢复 handler）。
  - it3：使用 FE-T14 的同路径 preset，但该文件未分离。
- 断言：
  - it1：`editor.releaseDocument` 以 doc.id 被调用 1 次。
  - it2：retry 后 hydrate 读入的布局不含 doc，`releaseDocument` 以 doc.id 被调用 1 次（若 doc 是在失败后打开的）。
  - it3：`releaseDocument` 未被调用。
- 反向断言：同一 id 不得被释放 2 次。
- 预期当前结果：it1 失败（原型已复现）；it2 失败；it3 通过。
- seam：无。

**FE-T22｜P1｜S1A-N04**

- 文件：`src/components/PtyWorkspace.close.host.test.tsx`；`it("closes a known-kind content from its render-error placeholder")`
- 层级/环境：host-integration / jsdom
- 前置：`doc = await openFile(host)`；`vi.spyOn(console,"error").mockImplementation(()=>{})`；`host.editor.setThrowOnRender(true)`；`flush()`。
- 步骤：找到文本包含 `engine exploded` 的 alert，点击其中的按钮；`flush()`。
- 断言：`fileDocuments` 为 `[]`；pane 中不包含该文件；`releaseDocument` 以 doc.id 被调用 1 次。
- 反向断言：errors 为空（错误被内容级 ErrorBoundary 吸收）。
- 预期当前结果：失败（原型已复现：文档仍在）。
- seam：无。

**FE-T23｜P1｜S1A-N05**

- 文件：`src/components/PtyWorkspace.recovery.host.test.tsx`；`describe("PTY owner-lost recovery")`，下设 3 个 it：
  - `it("retries reattach a bounded number of times and reports failure once")`
  - `it("stops scheduling retries after the workspace unmounts")`
  - `it("returns the reclaimed PTY to the focused pane after a successful reattach")`
- 层级/环境：host-integration / jsdom + fake timers
- 前置：`{slot,terminal} = await launchPty(host)`；`await detachPtyToWindow(host,slot.instanceId)`。it1/it2 设 `terminal.reattachLostSession.mockRejectedValue(new Error("not yet"))`，`get_pty_session_window_status` 返回 `"running"`；然后开启 fake timers。
- 步骤：
  - it1：`emitBackendEvent("pty-session-owner-lost",{sessionId:slot.sessionId})`；`advanceTimersByTimeAsync(60_000)`。
  - it2：发出事件；`advanceTimersByTimeAsync(1_000)`；`host.dispose()`；`advanceTimersByTimeAsync(10_000)`。
  - it3：不设置拒绝；发出事件；`flush()`。
- 断言：
  - it1：`terminal.reattachLostSession.mock.calls.length <= PTY_OWNER_LOST_MAX_ATTEMPTS`（8）；`toastSpy.error` 以包含 `pty.ownerLostRecoveryFailed` 的字符串恰好被调用 1 次。
  - it2：`vi.getTimerCount() === 0`。
  - it3：焦点 pane 包含该 slot；`detachedInstanceIds.has` 为 false；对子窗执行了 destroy；不变量通过。
- 反向断言：it1 中 60 秒内调用次数不得超过 8（当前为 41/30s）。
- 预期当前结果：it1、it2 失败（原型：41 次，卸载后残留 1 个定时器）；it3 通过。
- seam：FE-SEAM-7。

**FE-T24｜P1｜S1A-N10（主窗口）**

- 文件：`src/components/PtyWorkspace.recovery.host.test.tsx`；`it("keeps PTY handoff listeners when the owner-lost listener fails to register and surfaces the failure")`
- 层级/环境：host-integration / jsdom
- 前置：挂载前执行 `tauriMock.failNextListen("pty-session-owner-lost", new Error("event.listen not allowed"))`；`vi.spyOn(console,"error").mockImplementation(()=>{})`；`host = await mountWorkspace()`；`{slot} = await launchPty(host)`。
- 步骤：在 act 中 `void detachSession(slot.instanceId)`；`flush()`；发送 `pty-detached-ready`；`flush()`。
- 断言：`detachedInstanceIds.has(slot.instanceId)===true`；`toastSpy.error` 被调用 1 次，参数包含 `pty-session-owner-lost` 或对应 i18n 键（实现时选定键名，例如 `pty.listenerSetupFailed`，并在测试中写死）。
- 反向断言：不得只调用 console.error 而不给用户可见反馈。
- 预期当前结果：失败（当前会注销全部 PTY 交接监听，ready 被忽略）。
- seam：无（修复后同步更新 Q13 中的现有测试）。

**FE-T25｜P1｜S1A-N10（子窗口）**

- 文件：`src/components/StandaloneWorkspaceFileWindow.test.tsx`；`it("reports attach failure to the main window when listener registration fails")`
- 层级/环境：component（子窗）/ jsdom
- 前置：渲染前执行 `tauriMock.failNextListen("workspace-content-window-event", new Error("denied"))`；`mountFileWindow()`。
- 步骤：`flush()`。
- 断言：emittedEvents 中有发往 main 的 `workspace-file-window-attach-failed`，且 `payload.message` 非空；可见错误文本包含 `denied`。
- 反向断言：不得发出 `workspace-file-window-ready`；卸载后 eventListeners 为 0。
- 预期当前结果：失败（只调用 setError，主窗口要等 15 秒超时）。
- seam：无。

**FE-T26｜P1｜S1A-N11、门禁 10**

- 文件：`src/components/PtyWorkspace.tabs.host.test.tsx`；`describe("tab overflow measurement")`，下设 2 个 it：
  - `it("observes every rendered tab element after a partition change remounts it")`
  - `it("re-partitions when an observed tab's title width changes")`
- 层级/环境：host-integration / jsdom
- 前置：HX-5 `geometry.install({stripWidth:400, widthOf:t=>10*(t?.length??0)})`；`globalThis.ResizeObserver = FakeResizeObserver`；依次 `openFile` 打开 a.txt、b.txt、c.txt；每个 FakeResizeObserver 实例执行一次 `trigger()`。
- 步骤：
  - it1：`geometry.setStripWidth(60)`；所有实例 `trigger()`；`flush()`。
  - it2：再 `setStripWidth(400)`；`trigger()`；然后更改某个 PTY 标题（另起一个 PTY，并把 `queryClient` 中 directories 的 name 改为 `"Renamed project with a much longer name"`，通过 `queryClient.setQueryData(qk.directories(),…)`）；只对观察了该 PTY 标签元素的实例执行 `trigger([el])`。
- 断言：
  - it1：`document.querySelectorAll("[data-workspace-content-key]")` 中每个元素，都至少被一个存活实例 `observed`；stack trigger（aria-label 包含 `pty.overflowContents`）存在。
  - it2：PTY 标签进入堆叠（或活动项仍可见、其余被堆叠，具体按 `partitionVisibleTabs` 计算预期）。
- 反向断言：没有元素“已渲染但未被观察”。
- 预期当前结果：it1 失败；it2 失败（依赖 it1）。
- seam：无。

**FE-T27｜P1｜S1C-N03**

- 文件：`src/lib/ptyInputWriter.test.ts`；`describe("PTY input writer")`，下设 7 个 it：
  - `it("splits 70 KiB of ASCII into ordered chunks no larger than 64 KiB")`
  - `it("never splits a multi-byte character across chunks")`
  - `it("never splits a surrogate pair")`
  - `it("retries a backpressure rejection with backoff and preserves order")`
  - `it("stops and reports when retries are exhausted")`
  - `it("stops and reports on a non-backpressure failure")`
  - `it("cancels pending retries on dispose")`

  另加 contract：`it("is the only path PtyTerminal uses to write input")`

- 层级/环境：unit / node + fake timers；contract / node
- 前置：`write = vi.fn(async()=>{})`；`onError = vi.fn()`；`w = createPtyInputWriter({getSessionId:()=>"s1", write, onError})`。
- 步骤与断言：
  - it1：`push("a".repeat(71680))`，`await vi.runAllTimersAsync()`。write 被调用 2 次，第一段 `Buffer.byteLength(...)===65536`，第二段为 6144，两段拼接等于原文。
  - it2：`push("汉".repeat(30000))`。每段字节数 ≤65536，每段都能被 `new TextDecoder().decode(new TextEncoder().encode(seg))` 原样还原，拼接等于原文。
  - it3：`push("😀".repeat(20000))`。任何一段的首字符都不是低代理项（`\uDC00-\uDFFF`）。
  - it4：第一次 write 用 `mockRejectedValueOnce({code:"pty_input_backpressure"})`；`push("a")`、`push("b")`；`advanceTimersByTimeAsync(16)`。write 参数序列为 `["a","a","b"]`。
  - it5：write 一直拒绝 backpressure；`push("x")`；`advanceTimersByTimeAsync(1000)`。write 被调用 6 次（1 次 + 5 次重试），onError 被调用 1 次，参数 code 为 `pty_input_backpressure`；之后 `push("y")` 仍正常发送（队列恢复）。
  - it6：拒绝 `{code:"pty_input_unavailable"}`。onError 被调用 1 次，write 不重试。
  - it7：重试等待中执行 `dispose()`，推进 1 秒，write 不再被调用。
  - contract：`?raw` 读取 `PtyTerminal.tsx`，包含 `createPtyInputWriter(`，且 `terminal.onData` 回调体内不出现 `writePtySession(`。
- 反向断言：it4 中 `"b"` 不得先于重试的 `"a"`。
- 预期当前结果：全部失败（模块不存在）。
- seam：FE-SEAM-4。

**FE-T28｜P1｜S1C-N05**

- 文件：`src/lib/ptySessionLifecycle.test.ts`（替换 `detached PTY start timeout reconciliation` 的表）；`it.each` 写全 6 行：
  1. `[{state:"ownedByAnotherWindow",ownerLabel:"terminal-A"},"terminal-A",true,"accept-detached-owner"]`
  2. `[{state:"ownedByAnotherWindow",ownerLabel:"terminal-B"},"terminal-A",true,"reject-foreign-owner"]`
  3. `[{state:"ownedByAnotherWindow",ownerLabel:"terminal-A"},"terminal-A",false,"cancel-source-handoff"]`
  4. `[{state:"running",ownerLabel:"main"},"terminal-A",true,"cancel-source-handoff"]`
  5. `[{state:"ended",ownerLabel:null},"terminal-A",true,"remove-ended-session"]`
  6. `[null,"terminal-A",true,"retry-owner-query"]`

  另加宿主用例 `PtyWorkspace.recovery.host.test.tsx::it("does not accept a detach when Rust reports a foreign owner")`。

- 层级/环境：unit / node；host-integration / jsdom + fake timers
- 前置（宿主）：`launchPty`；`detachSession`（不发 ready）；开启 fake timers；`get_pty_session_window_status` 返回 `{state:"ownedByAnotherWindow",ownerLabel:"terminal-8e783338-f464-4b10-b15e-b534748c6241"}`（不同于新建的子窗 label）。
- 步骤（宿主）：`advanceTimersByTimeAsync(15_000)`；然后 `flush()`。
- 断言：单元表逐行相等。宿主侧：`detachedInstanceIds.has(slot)===false`；对 pending 子窗执行了 destroy；detachSession 被拒绝。
- 反向断言：不得出现 accept 分支的树变更。
- 预期当前结果：失败（类型与签名都不存在）。
- seam：FE-SEAM-5（同时需要 Rust 侧测试）。

**FE-T29｜P1｜S1B-N03**

- 文件：`src/lib/appErrors.test.ts`（追加）；`describe("error code contract")`，下设 2 个 it：
  - `it("maps exactly the codes produced by the backend")`
  - `it("accepts only dotted codes plus the aliases the contract lists")`
- 层级/环境：contract / node
- 前置：`import errorCodes from "../../contracts/error-codes.json"`，内容为 `["backup_restore_in_progress","directory.in_use","file.not_found","file.too_large","plan_changed","project_identity_changed","pty_input_backpressure","pty_input_unavailable","pty_session_starting","pty_sessions_active"]`。
- 步骤：比较 `Object.keys(APP_ERROR_TRANSLATION_KEYS).sort()` 与契约排序结果。
- 断言：两者完全相等。
- 反向断言：不能出现 `file.conflict`、`file.identity_changed`、`pty.owner_mismatch`、`pty.handoff_expired`、`exec.busy`、`layout.needs_reset`（当前映射了，但后端从不产出；PD-15 之后 `pty.input_backpressure` 与 `exec.plan_changed` 是后端产出码的点分新名，不再列入反向断言）。
- 预期当前结果：失败。
- seam：FE-SEAM-8（Rust 侧需加测试：所有 `AppError::coded("…"` 字面量 ⊆ 契约）。
- **PD-15 已确认：** 契约 JSON 改为 `{ codes, aliases }`（结构与旧码到新码映射见 RS-T36）。断言键集合 = `codes` ∪ `aliases` 的键；`aliases` 的每个值都在 `codes` 中；`codes` 全部匹配点分格式；对每个别名，`formatAppError` 对旧码与新码返回同一条本地化文案；前置里的 10 个旧码清单随之改为新码清单（`backup.restore_in_progress`、`directory.in_use`、`file.not_found`、`file.too_large`、`exec.plan_changed`、`project.identity_changed`、`pty.input_backpressure`、`pty.input_unavailable`、`pty.session_starting`、`pty.sessions_active`）。

**FE-T30｜P1｜S1B-N07**

- 文件：`src/lib/csp.contract.test.ts`；`describe("content security policy")`，下设 3 个 it：
  - `it("defines the production directives exactly")`
  - `it("extends development only with Vite eval and dev server origins")`
  - `it("never allows wildcards or unsafe-eval in production")`
- 层级/环境：contract / node
- 前置：`import conf from "../../src-tauri/tauri.conf.json"`；`parse = s => new Map(s.split(";").map(d=>d.trim()).filter(Boolean).map(d=>{const [k,...v]=d.split(/\s+/);return [k,v.sort()]}))`。
- 步骤与断言：
  - it1：production 解析结果深等于 `{ "default-src":["'self'"], "script-src":["'self'"], "style-src":["'self'","'unsafe-inline'"], "img-src":["'self'","blob:","data:"], "font-src":["'self'","data:"], "worker-src":["'self'","blob:"], "connect-src":["'self'","http://ipc.localhost","ipc:"] }`（数组均已排序）。
  - it2：dev 的 `script-src` 为 `["'self'","'unsafe-eval'"]`；dev 的 `connect-src` 为 production 的值加上 `http://localhost:1420` 和 `ws://localhost:1420`；其余指令与 production 相等。
  - it3：production 所有取值中不含 `*`、`'unsafe-eval'`、`http:`、`https:`。
- 反向断言：production 的指令集合不能多于 it1 中的 7 个指令。
- 预期当前结果：通过（把包含断言升级为精确断言）。
- seam：无。

**FE-T31｜P1｜R1（invoke ⊆ capability）**

- 文件：`src/lib/appCommands.contract.test.ts`；`describe("app command usage")`，下设 2 个 it：
  - `it("wraps exactly the registered app commands in tauri.ts")`
  - `it.each(["terminal","workspaceContent"])("only references wrappers allowed for %s windows")`
- 层级/环境：contract / node
- 前置：
  - 用 `?raw` 读取 `tauri.ts`，提取 `export function (\w+)` 到 `invoke<…>("(\w+)"` 的映射。
  - 复用 FE-T03 的闭包函数（把它抽到 `src/test/sourceClosure.ts`）。
  - `MAIN_ONLY_CALLS` 表写全并附理由：`{"src/components/PtyTerminal.tsx":["createPtySession","reattachPtySession"],"src/hooks/useThemeSync.ts":["setTrayMenuLabels"]}`。
- 步骤：
  - it1：对比 invoke 命令名集合与 `app-commands.json`。
  - it2：在子窗闭包源码中查找已导入并调用的封装名，减去 `MAIN_ONLY_CALLS`，再映射为命令名。
- 断言：
  - it1：两个集合相等（当前都是 68）。
  - it2：得到的命令集合 ⊆ 该类窗口的 `appCommands`。
- 反向断言：it2 的结果中不能出现 `create_pty_session`、`reattach_pty_session`、`open_project_file`、`save_project_text_file`。
- 预期当前结果：通过。
- seam：无。

**FE-T32｜P1｜R1、R5、门禁 5、P-2**

- 文件：在 `src/components/StandalonePtyWindow.test.tsx` 和 `src/components/StandaloneWorkspaceFileWindow.test.tsx` 各加一个用例：
  - `it("completes init, edit, save and return without ACL violations")`（文件窗）
  - `it("completes attach and return without ACL violations")`（终端窗）
- 层级/环境：component（子窗）/ jsdom
- 前置：HX-1 的 ACL 开启（默认）；同时调用 `renderHook(()=>useThemeSync())`（真实主题同步，覆盖 setTheme、emitTo 和窗口 listen）。
- 步骤：
  - 文件窗：发送 init（使用金样载荷）；在 textarea 中输入 `"x"`；点击保存按钮（文本为 `workspaceFiles.save`）；点击 `pty.returnToWorkspace`。
  - 终端窗：等待 `pty-detached-ready` 发出；点击 `pty.returnToWorkspace`。
- 断言：`tauriMock.state.aclViolations` 为 `[]`；`console.warn` 没有以 `[window.theme_sync_failed]` 开头的调用。
- 反向断言：子窗不得调用 `emit`（广播）。
- 预期当前结果：通过（ACL mock 落地之后）。
- seam：HX-1。

**FE-T33｜P1｜S1B-N12、Q2/Q3**

- 文件：修改 `src/lib/contracts.test.ts`，并新增 2 个 it：
  - `it("keeps built-in adapter kinds and API versions in the content-kind contract")`
  - `it("accepts drag payloads exactly for the contract kinds")`
- 层级/环境：contract / node
- 前置：`registerBuiltinContributions()`，在 afterEach 中注销。
- 步骤与断言：
  - it1：对 `contentKinds.kinds` 中每个 kind，`getWorkspaceContentAdapter(kind).apiVersion === contentKinds.adapterApiVersion`；用 `kind:"markdownPreview", apiVersion:contentKinds.adapterApiVersion+1` 注册时抛错。
  - it2：对每个 kind，`parseWorkspaceContentDrag(encodeWorkspaceContentDrag({kind,contentId:"x",sourcePaneId:"p",sourceWindowLabel:"main"}))?.kind===kind`；构造 kind `"markdownPreview"` 的载荷时，解析结果为 null。
  - 原 59–64 行改为字面量断言 `terminalWindow.labelPrefix==="terminal-"`、`workspaceContentWindow.labelPrefix==="workspace-content-"`。
- 反向断言：删掉对 `getWorkspaceContentWindowLabelPrefix` 的比较。
- 预期当前结果：通过。
- seam：无。

**FE-T34｜P1｜Q6、S1B-N10**

- 文件：重写 `workspaceContentWindowProtocol.test.ts::receives only events emitted to the current window`；`it("subscribes per window and ignores emits addressed to other windows")`
- 层级/环境：unit / jsdom
- 前置：删除本文件对 `@tauri-apps/api/event` 和 `webviewWindow` 的局部 mock，改用全局 tauriMock（HX-1 语义）；`setCurrentWindowLabel(terminal 规范 label)`。
- 步骤：执行 `listenWorkspaceContentWindowEvent("pty-detached-ready",ready)`；`emitTo("terminal-other",…)`；再 `emitTo(当前 label,…)`。
- 断言：ready 被调用 1 次；`vi.mocked(listen)`（全局）未被调用；`getWindow(label).listen` 被调用 1 次。
- 反向断言：发往其它 label 的事件不能触发 ready。
- 预期当前结果：通过（重写后）。
- seam：HX-1。

**FE-T35｜P1｜门禁 4、R2（终端独立窗）**

- 文件：`src/components/StandalonePtyWindow.test.tsx`；`describe("StandalonePtyWindow")`，下设 6 个 it。前置：`onFakeTerminalCreated(h=>{…})` 预设行为；`mountPtyWindow()`。
  - **it1** `it("attaches the handoff and reports ready once")`
    - 断言：`attachHandoff` 以 `("session-1","handoff-1")` 被调用 1 次；发往 main 的 `pty-detached-ready` 只有 1 次，payload 为 `{instanceId:"slot-1",sessionId:"session-1",windowLabel:label}`。
    - 预期：通过。
  - **it2** `it("reports detached-failed and destroys itself when attach fails while main still owns the PTY")`
    - 前置：`attachHandoff` 拒绝；status 返回 `"running"`。
    - 断言：发出 `pty-detached-failed`；执行了 destroy。
    - 预期：通过。
  - **it3** `it("closes as transferred when Rust reports another owner after attach failure")`
    - 前置：status 返回 `"ownedByAnotherWindow"`（FE-SEAM-5 之后为 `{state:"ownedByAnotherWindow",ownerLabel:"main"}`）。
    - 断言：执行了 destroy；不发 `pty-detached-exited`。
    - 预期：通过。
  - **it4** `it("sends a return request and destroys itself on the matching return-complete")`
    - 步骤：点击 `pty.returnToWorkspace`；从发出的 `pty-return-requested` 中取 token；`emitToWindow(label,"pty-return-complete",{instanceId:"slot-1",token})`。
    - 断言：执行了 destroy。
    - 预期：通过。
  - **it5** `it("ignores a return-failed for a stale token")`
    - 步骤：发出 `pty-return-failed`，token 为 `"old"`。
    - 断言：仍处于 returning（按钮 disabled），`cancelHandoff` 未被调用。
    - 预期：通过。
  - **it6** `it("reports exited when the session ends")`
    - 步骤：`emitSessionChange({state:"exited"})`。
    - 断言：发出 `pty-detached-exited`，并执行了 destroy。
    - 预期：通过。
- 层级/环境：component（子窗）/ jsdom
- seam：无。

**FE-T36｜P1｜门禁 4、R2、FE-NEW-02**

- 文件：`src/components/StandaloneWorkspaceFileWindow.test.tsx`（a 系列）+ `StandaloneWorkspaceFileWindow.i18n.test.tsx`（b，真实 i18n）；`describe("StandaloneWorkspaceFileWindow")`。
  - **a1** `it("attaches the init payload and acknowledges attached")`
    - 步骤：`emitToWindow(label,"workspace-file-window-init",{documentId:"doc-1",token:"tok-1",windowLabel:label,fileDocument:{id:"doc-1",directoryId:1,directoryPath:"C:/project",relativePath:"a.txt"},fileBuffer:{kind:"text",epoch:0,version:0,content:"hello",savedContent:"hello",revision:"r1",saving:false}})`。
    - 断言：textarea 的值为 `"hello"`；发出 attached。
    - 预期：通过。
  - **a2** `it("ignores init with a foreign token or label")`
    - 断言：textarea 不存在；不发 attached。
    - 预期：通过。
  - **a3** `it("answers flush requests with the current buffer")`
    - 断言：发出 flush-complete，requestId 一致，content 为编辑后的值。
    - 预期：通过。
  - **a4** `it("routes a native close after ready to a return request")`
    - 步骤：发出 close-requested。
    - 断言：发出 return-requested，fileBuffer 为最新值（publisher 先 flush）。
    - 预期：通过。
  - **a5** `it("resets returning on return-failed and destroys on return-complete")`
    - 断言：return-failed 之后按钮恢复可用；return-complete 之后执行 destroy。
    - 预期：通过。
  - **b** `it("does not restart the handoff setup when the UI language changes")`
    - 前置：完成 a1。
    - 步骤：`act(()=>applyRemoteAppLanguage("zh"))`；`flush()`。
    - 断言：`workspace-file-window-ready` 共发出 1 次；随后编辑 `"y"` 并推进 150ms 后，发出 buffer-changed。
    - 预期：失败（deps 中有 t，会重跑 setup）。
- 层级/环境：component（子窗）/ jsdom
- seam：无。

**FE-T37｜P1｜门禁 9（G3 标题栏）**

- 文件：`src/components/WindowTitlebar.test.tsx`；`describe("WindowTitlebar")`，下设 5 个 it：
  - `it("starts dragging on primary mousedown in the drag region")`
  - `it("toggles maximize on double click and ignores the second mousedown of a double click")`
  - `it("invokes minimize, maximize and close from the non-macOS controls")`
  - `it("shows a toast when a window action is rejected")`
  - `it("unlistens resize on unmount")`
- 层级/环境：component / jsdom
- 前置：stable t mock；sonner mock；label 为 main。
- 步骤：
  - 对 `.window-titlebar-drag-region` 触发 `fireEvent.mouseDown({button:0,detail:1})`。
  - 双击：`fireEvent.doubleClick`；以及 `mouseDown({detail:2})`。
  - 依次点击 `windowChrome.minimize`、`windowChrome.maximize`、`windowChrome.close`。
  - 拒绝用例：`getWindow("main").minimize.mockRejectedValueOnce({code:"x",message:"denied"})`。
  - unmount。
- 断言：
  - `windowActions` 中依次出现 `startDragging`、`toggleMaximize`（双击只出现 1 次，`detail:2` 时不出现 startDragging）、`minimize`、`toggleMaximize`、`close`。
  - 拒绝用例：`toastSpy.error` 以 `"denied"` 被调用。
  - 卸载后 eventListeners 为 0。
- 反向断言：右键（`button:2`）不触发 startDragging。
- 预期当前结果：通过。
- seam：无。

**FE-T38｜P1｜门禁 9（G4 portal 稳定）、R2**

- 文件：`src/components/PtyWorkspace.pty.host.test.tsx`；`describe("PTY portal ownership")`，下设 2 个 it：
  - `it("keeps one terminal instance across move, split and tab switches")`
  - `it("removes a naturally exited PTY and keeps the layout valid")`
- 层级/环境：host-integration / jsdom
- 步骤：
  - it1：`launchPty`；`openFile`；`splitPane(paneA,"horizontal")`；`moveSession(paneA,paneB,slot)`；`activateFile`，再 `activateSession`；`flush()`。
  - it2：`terminal.emitSessionChange({...session,state:"exited"})`；`flush()`。
- 断言：
  - it1：`fakeTerminals.length===1`；`startSession` 被调用 1 次；不变量通过。
  - it2：slots 为 `[]`；树中没有 pty；`useAppStore.getState().ptySessionsById[sessionId]` 为 undefined；最后一次保存通过校验。
- 反向断言：it1 不能出现第二个 `[data-testid=fake-pty-terminal]`。
- 预期当前结果：通过。
- seam：FE-SEAM-1。

**FE-T39｜P1｜R5**

- 文件：`src/components/PtyWorkspace.protocol.host.test.tsx`；`describe("untrusted window events")`，下设 6 个 it。前置：完成文件分离（`doc,token,windowLabel,initBuffer`）。
  - **it1** `it("ignores buffer changes with a foreign token")`
    - 步骤：发 buffer-changed，`token:"forged"`，content 为 `"evil"`。
    - 断言：mirror 不变。
  - **it2** `it("ignores buffer changes from another window label")`
    - 步骤：`windowLabel:"workspace-content-11111111-1111-4111-8111-111111111111"`。
    - 断言：mirror 不变。
  - **it3** `it("ignores older buffer epochs and versions")`
    - 步骤：发 `version:initBuffer.version-1`。
    - 断言：mirror 不变。
  - **it4** `it("rejects a PTY return requested by a non-owner terminal")`
    - 前置：分离一个 PTY。
    - 步骤：用另一个规范 terminal label 发 return-requested。
    - 断言：向该 label 发出 `pty-return-failed`，message 包含 `pty.detachedSessionMissing`；PTY 仍是 detached。
  - **it5** `it("rejects a file return whose document identity changed")`
    - 步骤：fileDocument 的 relativePath 改为 `"other.txt"`。
    - 断言：发出 return-failed；文件仍是 detached。
  - **it6** `it("ignores drops claiming an unmanaged source window")`
    - 步骤：在 pane 上 `fireEvent.drop`，`dataTransfer` 中 `getData(WORKSPACE_CONTENT_DRAG_TYPE)` 返回 `encodeWorkspaceContentDrag({kind:"file",contentId:doc.id,sourceWindowLabel:"workspace-content-11111111-1111-4111-8111-111111111111"})`，`types` 包含该类型。
    - 断言：不发出 return-drop-requested。
- 公共反向断言：errors 为空；不变量通过。
- 层级/环境：host-integration / jsdom
- 预期当前结果：全部通过。
- seam：FE-SEAM-1。

**FE-T40｜P1｜R4、FE-NEW-03**

- 文件：`src/components/PtyWorkspace.protocol.host.test.tsx`；`describe("duplicate and out-of-order handoff events")`，下设 5 个 it：
  - **it1** `it("ignores a second pty-detached-ready")`
    - 断言：树只提交一次；窗口只建了 1 个；errors 为空。
    - 预期：通过。
  - **it2** `it("ignores a file attached event that arrives before ready/init")`
    - 步骤：detachFile 之后直接发 attached（跳过 ready）。
    - 断言：文件仍在树中；coordinator phase 为 detaching；发 ready 之后仍可完成分离。
    - 预期：失败（FE-NEW-03）。
  - **it3** `it("ignores a ready that arrives after the detach timed out")`
    - 步骤：开 fake timers，推进 15 秒；然后发 ready。
    - 断言：文件在树中；detachFile 被拒绝，错误包含 `pty.detachedStartTimedOut`；`revoke_content_window_file` 被调用 1 次。
    - 预期：通过。
  - **it4** `it("ignores a late attach-failed after attached")`
    - 断言：仍为 detached。
    - 预期：通过。
  - **it5** `it("handles a duplicate return request for the same token once")`
    - 断言：attach 只调用 1 次；return-complete 只发 1 次。
    - 预期：失败（被 S1A-N01 阻塞）。
- 层级/环境：host-integration / jsdom
- seam：FE-SEAM-1、FE-SEAM-10。

**FE-T41｜P1｜B3F-F04**

- 文件：`src/components/PtyWorkspace.recovery.host.test.tsx`；`describe("PTY detach timeout reconciliation")`，用 `it.each` 写全 4 行：
  1. status `"ownedByAnotherWindow"`，子窗存在。期望：`detachedInstanceIds.has(slot)`；slot 不在树中；detachSession 成功 resolve。
  2. status `"running"`。期望：`terminal.cancelHandoff` 以 handoff token 被调用；slot 仍在原 pane；子窗被 destroy；detachSession 被拒绝，错误包含 `pty.detachedStartTimedOut`。
  3. status `"ended"`。期望：slots 为 `[]`；子窗被 destroy；拒绝错误包含 `pty.detachedStartFailed`。
  4. status 始终 reject。期望：推进 25 秒后（15 秒超时 + 10 次 1 秒重试），子窗被 destroy、执行回滚、detachSession 被拒绝。

  另加 `it("stops reconciling after unmount")`：卸载后 `vi.getTimerCount()===0`。

- 层级/环境：host-integration / jsdom + fake timers
- 前置：`launchPty`；开启 fake timers 后调用 `detachSession`（不发 ready）；按行设置 status handler；第 1 行保留 `tauriMock.state.windows` 中的子窗。
- 步骤：`advanceTimersByTimeAsync(15_000)`（第 4 行推进 25_000）；`flush()`。
- 反向断言：第 2 行不得出现“窗口被接受为 detached”。
- 预期当前结果：第 1–3 行通过；第 4 行失败（无限重试）；卸载用例通过。
- seam：FE-SEAM-1。

**FE-T42｜P1｜B3F-F11、R9**

- 文件：`src/components/PtyWorkspace.layout.host.test.tsx`；`it("keeps unknown content byte-for-byte until the user closes it")`
- 层级/环境：host-integration / jsdom
- 前置：layout 中 pane p1 的 contents 和 activeContent 都是 `{kind:"unknown",originalKind:"markdownPreview",raw:{kind:"markdownPreview",source:"README.md",extra:{a:1}}}`，status ready，revision 2。
- 步骤：mount；读取保存结果；点击文本为 `workspaceContent.closeUnsupported` 的按钮；`flush()`。
- 断言：
  - mount 后 alert 文本包含 `workspaceContent.unsupportedTitle`。
  - 首次保存的 tree 中 unknown 与输入深等。
  - 关闭后最新保存的 p1 为 `contents:[]`、`activeContent:null`。
- 反向断言：unknown 标签不可拖动（`draggable` 属性为 false）；errors 为空。
- 预期当前结果：通过（原型已验证）。
- seam：无。

**FE-T43｜P1｜门禁 10、门禁 2**

- 文件：`src/components/PtyWorkspace.tabs.host.test.tsx`；`describe("overflow stack")`/`it("activates, closes and opens menus for PTY and file entries from the keyboard")`
- 层级/环境：host-integration / jsdom
- 前置：默认几何（jsdom 中只有活动项可见）；在同一 pane 依次打开 a.txt、b.txt，再启动 PTY（PTY 为活动项）。
- 步骤：
  1. 点击 aria-label 包含 `pty.overflowContents` 的按钮。
  2. 在列表上 `keyDown ArrowDown`，焦点移到第二项。
  3. 点击当前焦点项（模拟 Enter 激活）。
  4. 重新打开列表，对第一项 `keyDown Delete`。
  5. 对某一项触发 `contextMenu`。
- 断言：
  - 步骤 2 后 `document.activeElement` 的 `data-stack-index` 为 `"1"`。
  - 步骤 3 后 pane 的 activeContent 为对应文件。
  - 步骤 4 后 a.txt 被关闭（a.txt 干净，不弹对话框）。
  - 步骤 5 后出现菜单，菜单标题为该项标题。
- 反向断言：Delete 不得关闭未聚焦的项。
- 预期当前结果：通过。
- seam：无。

**FE-T44｜P1｜R8、R2（文件异常中止）**

- 文件：`src/components/PtyWorkspace.save.host.test.tsx`；`describe("save outcomes")`，下设 4 个 it：
  - `it("coalesces concurrent save requests into one backend write")`
    - 断言：`save_project_text_file` 被调用 1 次。
    - 预期：通过（原型已验证）。
  - `it("marks a conflict, keeps the draft and offers reload")`
    - 前置：handler 返回 `{kind:"conflict"}`。
    - 断言：buffer 中 `conflict===true`、`content` 为草稿；`toastSpy.error` 的第二个参数有 `action.label` 包含 `workspaceFiles.reload`。
    - 预期：通过。
  - `it("marks a project identity change and blocks further saves")`
    - 前置：handler 抛 `{code:"project_identity_changed",message:"x"}`。
    - 断言：`identityChanged===true`；再次 saveFile 不调用 invoke。
    - 预期：通过。
  - `it("restores the draft after a generic failure")`
    - 前置：handler 抛 `new Error("disk full")`。
    - 断言：`saving===false`，content 为草稿；toast 内容包含 `"disk full"`。
    - 预期：通过。
- 层级/环境：host-integration / jsdom
- 前置：`openFile`；`editFile("x")`。
- 公共反向断言：任何结果之后都满足不变量 I6（无残留 saving）。
- seam：无。

**FE-T45｜P1｜S1A-N01 变体**

- 文件：`src/components/PtyWorkspace.handoff.host.test.tsx`；`it("applies a named layout and captures a preset while a PTY is returning")`
- 层级/环境：host-integration / jsdom
- 前置：沿用 FE-T04 前置，attach 挂起，返回流程停在 returning；plan handler 返回单 pane 空布局；`backend.handlers.set("create_workspace_layout_preset", ({layout})=>({id:"n",name:"n",schemaVersion:5,createdAtMs:0,updatedAtMs:0}))`。
- 步骤：`await host.ctx().applyWorkspaceLayoutPreset("p")`；`host.ctx().getCurrentPresetLayout()`。
- 断言：apply 的 promise 为 fulfilled；`getCurrentPresetLayout()` 不抛错，且返回的 slots 中不含该 slot；errors 为空。
- 反向断言：plan 请求参数中 `activeLayout.detachedContents` 必须包含该 PTY。
- 预期当前结果：失败（apply 会因 unowned 而 reject；而且在此之前就会被 FE-T04 的崩溃阻断）。
- seam：FE-SEAM-1、FE-SEAM-2。

**FE-T46｜P1｜J1、FE-NEW-04**

- 文件：`src/components/PtyWorkspace.restore.host.test.tsx`；`describe("backup restore coordination")`，下设 4 个 it：
  - **it1** `it("reports blockers for running PTYs, dirty files and detached windows")`
    - 用 it.each 写 3 行：PTY（`useAppStore.upsertPtySession` 设为 running）、脏文件（`editFile`）、分离窗口（`detachFileToWindow`）。
    - 断言：`getBackupRestoreBlockers()` 返回值中对应计数为 1，其它计数为 0；之后 `editFile` 和 `launchSession` 仍然可用（守卫已解除）。
    - 预期：通过。
  - **it2** `it("blocks edits and launches while a restore is being confirmed")`
    - 步骤：无阻断时调用 `getBackupRestoreBlockers()`，然后 `editFile`、`launchSession`。
    - 断言：buffer 不变；slots 不增加。
    - 预期：通过。
  - **it3** `it("does not persist the pre-restore layout between restore success and the restored event")`
    - 步骤：`getBackupRestoreBlockers()`；把 `backend.layout` 设为恢复后的布局（revision 2，单 pane 空）；清空 `backend.saved`；调用 `cancelBackupRestore()`（模拟 SettingsView onSuccess）；`splitPane(当前 pane,"horizontal")`；`flush()`；`emitBackendEvent("workspace-data-restored",{})`（会触发 rehydrate；harness 需同时渲染 `WorkspaceDataRestoreListener`）；`flush()`。
    - 断言：在 restored 事件之前 `backend.saved.length===0`；rehydrate 之后树与恢复布局一致（单 pane、无内容）。
    - 预期：失败（FE-NEW-04）。
  - **it4** `it("rehydrates to the restored revision and continues saving above it")`
    - 步骤：restored 事件后执行一次 split。
    - 断言：下一次保存的 `revision===3`。
    - 预期：通过。
- 层级/环境：host-integration / jsdom
- seam：无。

#### P2

**FE-T47｜P2｜R3、R9**

- 文件：`src/components/PtyWorkspace.layout.host.test.tsx`；`describe("hydration failure modes")`，下设 3 个 it：
  - **it1** `it("shows needsReset and resets on confirmation")`
    - 前置：status 为 `{status:"needsReset",reason:"bad"}`；`reset_workspace_layout` 返回 7；`vi.spyOn(window,"confirm").mockReturnValue(true)`。
    - 步骤：点击 `pty.resetLayout`。
    - 断言：之后 hydrationStatus 为 ready；下一次保存 revision 为 8。
    - 预期：通过。
  - **it2** `it("shows loadFailed with retry when reading fails")`
    - 前置：`get_workspace_layout` 先抛错，随后恢复。
    - 断言：出现 `pty.retryLayoutRead` 按钮，点击后进入 ready。
    - 预期：通过。
  - **it3** `it("routes a future schema returned as ready to needsReset instead of loadFailed")`
    - 前置：layout 的 `schemaVersion` 为 6。
    - 断言：hydrationStatus 为 needsReset。
    - 预期：失败。
  - 另在 `workspaceLayoutPersistence.test.ts` 追加单元 it：`it.each([1,2,6])("rejects schema version %s with an explicit error")`，断言 `migrateWorkspaceLayoutDocument({...v5Doc,schemaVersion:v})` 抛出 `/Unsupported workspace layout version/`。
- 层级/环境：host-integration / jsdom；unit / node
- 反向断言：needsReset 状态下不得调用 `save_workspace_layout`。
- seam：无（it3 需要在 hydrate 的 catch 中区分版本错误）。

**FE-T48｜P2｜R8、FE-NEW-05**

- 文件：`src/lib/workspaceLayoutPersistence.test.ts`（追加）；`it("stops retrying when the backend keeps rejecting without advancing the revision")`
- 层级/环境：unit / node
- 前置：`calls=0`；`save=vi.fn(async(rev)=>{calls++; if(calls>20) throw new Error("spin guard"); return {saved:false,revision:5}})`；`onError=vi.fn()`；`q=new WorkspaceLayoutSaveQueue(5,save,onError)`。
- 步骤：`q.enqueue(doc)`；`await q.flush()`。
- 断言：`save.mock.calls.length <= 3`；onError 被调用 1 次，参数为非 `"spin guard"` 的拒绝错误（实现选定 code `layout.save_rejected`，测试中写死）。
- 反向断言：`calls` 不得达到 21。
- 预期当前结果：失败（会一直跑到 spin guard，即第 21 次调用）。
- seam：无。

**FE-T49｜P2｜R2（执行任务）**

- 文件：`src/hooks/useExecutionTasks.test.tsx`；`describe("useExecutionTaskEvents")`，下设 4 个 it：
  - **it1** `it("upserts task updates and shows one completion toast")`
    - 断言：tasks 查询数据中有该任务；`toastSpy.success` 被调用 1 次。
    - 预期：通过。
  - **it2** `it("refreshes only the completed tool's status")`
    - 断言：`detect_cli_status` 以 `{toolKey:"codex",force:true}` 被调用 1 次。
    - 预期：通过。
  - **it3** `it("does not regress a terminal task to running on a stale update")`
    - 步骤：先发 succeeded，再发 running。
    - 断言：状态仍为 succeeded。
    - 预期：失败。
  - **it4** `it("dedupes log chunks by sequence and keeps them ordered")`
    - 步骤：顺序为 2、1、2。
    - 断言：logs 的 sequence 为 `[1,2]`。
    - 预期：通过。
- 层级/环境：hook / jsdom
- 前置：`renderHook(()=>useExecutionTaskEvents(),{wrapper:QueryClientProvider})`；`queryClient.setQueryData(qk.executionTasks(),[])`；`setQueryData(qk.executionTask("t1"),{task,logs:[]})`；用 `emitBackendEvent("execution-task-updated",{id:"t1",toolKey:"codex",kind:"update",status:"succeeded",startedAtMs:1,…})` 发事件。
- 反向断言：it2 不得探测其它工具。
- seam：无。

**FE-T50｜P2｜R3、Q9**

- 文件：`src/components/workspaceContentHandoffRuntime.test.ts`（追加），下设 3 个 it：
  - **it1** `it("rejects a handoff when the adapter lacks a driver")`
    - 断言：调用 prepare 时 rejects，错误匹配 `/缺少 handoff driver/`。
  - **it2** `it("passes the attach failure to rollback with the prepared payload")`
    - 断言：attach 拒绝后，`rollback` 以 `(payload, error)` 被调用。
  - **it3** `it("routes file kind capabilities without touching PTY capabilities")`
    - 断言：file prepare 返回 `{document,buffer}`，transferId 等于传入值。
- 层级/环境：unit / node
- 反向断言：缺 driver 时不调用任何 capability。
- 预期当前结果：通过。
- seam：无。

**FE-T51｜P2｜Q10**

- 文件：`src/lib/installPlanConfirmation.test.ts`（追加），下设 2 个 it：
  - `it("recognizes the coded IPC rejection shape")`：断言 `isInstallPlanChangedError({code:"plan_changed",message:"安装计划已变化"})===true`。
  - `it("reopens confirmation with the refreshed plan")`：getPlan 返回 `{...plan,fingerprint:"fp-2"}`；断言 `setPending` 收到的 `plan.fingerprint==="fp-2"`。
- 层级/环境：unit / node
- 反向断言：`{code:"other"}` 返回 false。
- 预期当前结果：通过。
- seam：无。

**FE-T52｜P2｜R1、R10**

- 文件：`src/lib/appErrors.test.ts`；`it.each(APP_LANGUAGES)("has a translation for every mapped error code in %s")`
- 层级/环境：contract / node
- 前置：从 `src/i18n/locales/*` 直接导入 10 个 locale 对象（es 为 json）。
- 步骤：对 `Object.values(APP_ERROR_TRANSLATION_KEYS)` 中的每个 key（形如 `errors.xxx`），在对应 locale 中按路径取值。
- 断言：取到的值是非空字符串。
- 反向断言：值不能等于 key 本身。
- 预期当前结果：通过（en 已核对齐全）。
- seam：FE-SEAM-8（导出常量）。

**FE-T53｜P2｜R10、P-2**

- 文件：`src/hooks/useThemeSync.test.tsx`（追加），下设 3 个 it：
  - **it1** `it("broadcasts theme changes from the main window")`
    - 步骤：在 main 中 `useAppStore.getState().setThemeMode("dark")`。
    - 断言：emittedEvents 中有 `target:null`、`eventName:"app-preferences"`、`payload.theme:"dark"` 的记录。
  - **it2** `it("applies a broadcast in a child without writing local storage")`
    - 步骤：在子窗中，main 广播 `{apiVersion:1,theme:"light",language:"en"}`。
    - 断言：`themeMode==="light"`；`setItem` 未被调用。
  - **it3** `it("surfaces a native theme sync failure in development")`
    - 前置：`getWindow(label).setTheme.mockRejectedValueOnce({code:"acl.denied",message:"x"})`。
    - 断言：`toastSpy.error` 被调用（不能只有 console.warn）。
- 层级/环境：hook / jsdom
- 反向断言：it2 中子窗不得调用 emit。
- 预期当前结果：it1、it2 通过；it3 失败。
- seam：无（修复 it3 时改 `reportWindowSyncFailure`，在 `import.meta.env.DEV` 下 toast）。

**FE-T54｜P2｜平台参数化**

- 文件：`src/components/workspaceContentHandoffRuntime.platform.test.ts`；`it.each` 写全 3 行：
  1. `["Windows NT 10.0; Win64; x64", {decorations:false}]`
  2. `["Macintosh; Intel Mac OS X 14_0", {decorations:true,titleBarStyle:"overlay",hiddenTitle:true}]`
  3. `["X11; Linux x86_64", {decorations:false}]`

  另加 `WindowTitlebar.platform.test.tsx`：`it.each(同 3 种 UA)("renders native-control policy for %s")`。

- 层级/环境：unit / jsdom
- 前置：`Object.defineProperty(navigator,"userAgent",{value:\`Mozilla/5.0 (${ua})\`,configurable:true})`；`vi.resetModules()`之后再动态`import("./WindowTitlebar")`（该模块在加载时就读取 UA）。
- 步骤：`createWorkspaceContentWindow({label:"terminal-…",url:"/",title:"t"})`；读取 `tauriMock.state.createdWindows[0].options`。
- 断言：
  - 窗口选项包含对应字段，且 `dragDropEnabled:false`、`width:1100`。
  - 标题栏：macOS 不渲染 `windowChrome.minimize`，`header` 的 class 含 `window-titlebar-macos`；其它平台渲染 3 个控制按钮。
- 反向断言：Windows/Linux 不能出现 `titleBarStyle`。
- 预期当前结果：通过。
- seam：无。

**FE-T55｜P2｜R1、平台**

- 文件：`src/App.routing.test.tsx`（3 个 it）+ `PtyWorkspace.tabs.host.test.tsx`（1 个 it）：
  - **it1** `it("renders the file window only for a workspace-content label with file params")`
    - 前置：label 为规范的 workspace-content；`window.history.replaceState({}, "", "/?detachedFileId=doc-1&fileHandoffToken=tok-1&sourcePaneId=p1")`。
    - 断言：等待 Suspense 后，文本 `workspaceFiles.loadingFile` 出现。
  - **it2** `it("renders nothing for a terminal label without handoff params")`
    - 断言：container 为空。
  - **it3** `it("does not render the PTY window for a workspace-content label with PTY params")`
    - 断言：不出现 `pty.starting`。
  - **it4** `it("shows the basename for backslash and slash relative paths")`
    - 前置：`backend.files` 增加 `"dir\\win.txt"` 和 `"dir/unix.txt"`。
    - 步骤：先后打开这两个文件。
    - 断言：活动标签文本分别为 `win.txt`、`unix.txt`。
- 层级/环境：component / jsdom
- 反向断言：it2 不调用任何 invoke。
- 预期当前结果：通过。
- seam：无。

**FE-T56｜P2｜B3F-F07、S1A-N07**

- 文件：`src/components/PtyWorkspace.ratchet.test.ts`，下设 2 个 it：
  - `it("does not grow kind branches in the host")`：用 `?raw` 读 `PtyWorkspace.tsx`，统计 `/kind === "|"slot" in/g` 的匹配数，断言 `<= 58`（当前基线）。
  - `it("never uses window handle tables as ownership predicates")`：统计 `/detached(?:Files|ByInstance)Ref\.current\.has\(/g`，断言 `=== 0`。
- 层级/环境：contract / node
- 前置：在注释中写明基线来源（2026-10-06 统计值）和只减不增的规则。
- 反向断言：无。
- 预期当前结果：it1 通过；it2 失败（当前 7 处）。
- seam：无。

**FE-T57｜P2｜R4（StrictMode）**

- 文件：`src/components/PtyWorkspace.host.test.tsx`；`it("hydrates once and detaches a file correctly under StrictMode")`
- 层级/环境：host-integration / jsdom
- 前置：`mountWorkspace({strict:true})`。
- 步骤：`openFile`；`detachFileToWindow`。
- 断言：已提交的 hydration 结果只有 1 次（第二次 `get_workspace_layout` 允许发生，但第一次结果必须被 requestId 丢弃）；`createdWindows.length===1`；`workspace-file-window-init` 只发 1 次；不变量通过。
- 反向断言：errors 为空。
- 预期当前结果：通过。
- seam：无。

**FE-T58｜P2｜Q7、B2-F10**

- 文件：`src/lib/themes.test.mjs`。重命名第二项为 `it("keeps terminal theme tokens complete in every theme and the ANSI palette shared")`，并新增 `it("declares no raw colour literals outside theme token blocks")`。
- 层级/环境：contract / node
- 步骤：从 `styles.css` 中剔除所有主题 token 块（`:root{…}` 及 `:root[data-theme=…]{…}`），在剩余文本中查找 `/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i`。
- 断言：匹配数为 0；或与显式白名单数组相等，白名单逐项写明选择器和理由（Sonner/Allotment 第三方变量、品牌图标等 G4 记录的例外）。
- 反向断言：无。
- 预期当前结果：未知，取决于当前 CSS。若失败，按白名单补录；不得放宽正则。
- **PD-07 已确认（终端始终深色，登记为例外）：** `themes.test.mjs` 中终端 token 的断言保持“每个主题块都定义完整的终端 token，且两套主题取值相同”，并在断言消息里注明这是 PD-07 登记的例外；新增 `it("terminal runtime does not follow theme changes")`：以 `?raw` 读取 `PtyTerminal.tsx` 与 `ptyTerminalRuntime.ts`，断言不含 `MutationObserver`、`dataset.theme`；若 `PtyTerminal.tsx` 仍订阅 `useResolvedTheme`，按 PD-07 删除该订阅后让此条转绿（预期当前结果需先核对该订阅是否存在）。若将来改选 PD-07 的 B（提供浅色终端），此条随决策一并删除。
- seam：无。

### 5. 修正现有错误测试的清单

| #   | 文件::用例                                                                                           | 怎么改                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `windowApiPermissions.test.ts`（全文件）                                                             | 按 FE-T03 重写：归一化 glob 键；读不到源码就抛错；改用 import 闭包；补充 once/onX/getByLabel/插件规则；删除 core:default 一刀切的跳过；加变异元测试 |
| 2   | `contracts.test.ts::declares each current window kind…` 59–64 行                                     | 改成字面量断言（FE-T33）；`appCommands.length>0` 改由 FE-T31 的集合相等承担                                                                         |
| 3   | `contracts.test.ts::matches the TypeScript workspace content kinds`                                  | `toBe(2)` 改为与内建 adapter 的 `apiVersion` 逐个比较，并加拖放白名单关联（FE-T33）                                                                 |
| 4   | `workspaceContentWindowProtocol.test.ts::receives only events emitted to the current window`         | 删除局部 emitTo 过滤 mock，改用 HX-1 的全局 mock（FE-T34）；本文件其余用例保留局部 mock                                                             |
| 5   | `WorkspaceDataRestoreListener.test.tsx::rehydrates…`                                                 | 改名为 `subscribes to workspace-data-restored and requests rehydration`；从 M6 审计 J1 追溯表中撤下“恢复后 revision 一致”的证据，改为指向 FE-T46    |
| 6   | `WorkspaceContentView.test.tsx::contains render failures…`                                           | 增加 `fireEvent.click(button)` 和 `expect(onCloseUnsupported).toHaveBeenCalledOnce()`；宿主层语义由 FE-T22 证明                                     |
| 7   | `ptySessionLifecycle.test.ts::detached PTY start timeout reconciliation`                             | 用 FE-T28 的 6 行表替换                                                                                                                             |
| 8   | `workspaceContentListenerSetup.test.ts::cleans successful registrations when another listener fails` | S1A-N10 修复后改为“只注销同组、报告失败、其它组保持”，与 FE-T24 一致                                                                                |
| 9   | `tauriMock.test.tsx`                                                                                 | 保留现有用例，新增 FE-T02 三项                                                                                                                      |
| 10  | `WorkspaceContentWindowShell.test.tsx::routes a pre-ready close…`                                    | label 改为 `workspace-content-8e783338-f464-4b10-b15e-b534748c6241`，以兼容 ACL mock                                                                |
| 11  | `themes.test.mjs` 第二项                                                                             | 改名并补裸色值扫描（FE-T58）                                                                                                                        |
| 12  | `installPlanConfirmation.test.ts`                                                                    | 追加 FE-T51 两项                                                                                                                                    |
| 13  | `useCliStatus.test.ts`                                                                               | describe 保持 `refreshCliStatusForTool`；文件内加注释说明 hook 接线由 FE-T49 覆盖                                                                   |
| 14  | `workspaceLayoutPersistence.test.ts::marks restored running sessions ended…`                         | 改名为 `…at application startup`，并加注释：宿主不得在运行期 rehydrate 中套用此规则（FE-T08）                                                       |
| 15  | `workspaceContentHandoffRuntime.test.ts`                                                             | 追加 FE-T50                                                                                                                                         |
| 16  | `appErrors.test.ts`                                                                                  | 追加 FE-T29、FE-T52                                                                                                                                 |

### 6. 平台说明

前端测试在三个平台的 CI 上都会运行，下面的差异需要注意。

1. **jsdom 的 userAgent 是 `Mozilla/5.0 (<process.platform>) … jsdom/x`。** 三个平台上都匹配不到 Windows 或 Mac 的正则，`getWindowChromePolicy` 恒为 `"linux"`。这让 DOM 测试在三平台上结果一致，但 Windows 和 macOS 分支从未在组件层被执行。凡是涉及 `WindowTitlebar`（模块加载时就读取 UA）、`createWorkspaceContentWindow`、`getTerminalKeyIntent`、`SettingsView` 的测试，都必须按 FE-T54 的方式显式参数化 UA；对 `WindowTitlebar` 这类在加载时读取 UA 的模块，要用 `vi.resetModules()` 后再动态导入。
2. **路径分隔符。** 标签标题用 `/[\\/]/` 取 basename，FE-T55 已覆盖。文档身份 `${directoryId}:${relativePath}` 区分大小写；在 Windows 和 macOS 的默认文件系统上，`A.txt` 与 `a.txt` 会被当作两个文档。这需要产品决定是否按平台做大小写折叠，本轮不纳入规格，只作为记录。
3. **RTL。** 子窗口 `dir` 已有测试。堆叠列表用上下键导航，不受 RTL 影响。右键菜单定位用的是物理坐标；RTL 下的显示位置属于实机检查项（M6-F10、F11），不在 jsdom 中断言。
4. **换行符。** Windows 上 CRLF 文件经过 Monaco 后可能被归一化，导致 buffer 一打开就是“脏”的。假编辑器测不到这一点，应补充为 M6-F02、F03 的实机检查项。
5. **时序与 CI 稳定性。** 宿主测试一律用 fake timers 推进 15s/500ms/150ms 这类时间窗口，不要真实等待。`waitFor` 只用于等待微任务，超时设为 3000ms，避免较慢的 runner 偶发失败。
6. **ACL 期望表要随平台同步。** `CORE_DEFAULT_IMPLIES`（HX-1）依赖本地生成的 `acl-manifests.json`，CI 跑 `pnpm test` 时拿不到这份文件。硬编码的这张表需要由 Rust 侧的 `window_kind_contract_matches_capabilities` 测试同步校验。

### 7. 总评

- **现状。** 282 项测试几乎都在纯函数层。宿主层（5,490 行）、App 退出流程和两个独立窗口都没有渲染级证据。权限对照测试实际上什么都没扫描，测试 mock 的事件语义与真实 Tauri 相反，另有约 6 项测试是同义反复或只测 mock。M6 门禁 3、4、5、9、10 引用的自动化证据，有一部分不能证明它所声称的内容。
- **可行性已证实。** 不需要先拆分 `PtyWorkspace`。按第 3 节的 harness（稳定 t、假 PtyTerminal、假编辑器引擎、QueryClient、Probe 上下文、ErrorBoundary 收集错误）就能在 jsdom 中驱动完整的分离、返回、关闭、退出流程。只需要一个测试 seam（FE-SEAM-1，注入 coordinator）就能断言“树与 coordinator 一致”。
- **最高风险。**
  - S1A-N01：任何一次 return 都会让主窗口工作区整体卸载。
  - FE-NEW-01：切换语言会静默丢弃未保存的编辑，运行中的 PTY 从界面消失，分离出去的文件窗口变成无主状态，退出时可能不再提示。
  - S1A-N03：退出对话框卡死。

  这三项都应列为 P0 并优先修复。B3F-F02 的“拖回非源 pane”和 FE-T40 的部分用例都被 S1A-N01 阻塞，修好 S1A-N01 才能拿到它们的证据。

- **建议顺序。**
  1. 搭建测试基础设施：HX-1 至 HX-6，以及 FE-T01、FE-T02、FE-T03。
  2. 编写 P0 测试，配合 FE-SEAM-1、2、3、9、12 和对应修复，跑绿后作为 A 层门禁证据。
  3. P1 测试配合 FE-SEAM-4 至 FE-SEAM-8、FE-SEAM-10、FE-SEAM-11。其中 FE-SEAM-5、FE-SEAM-6 需要和 Rust 侧同步。
  4. 最后补 P2 测试。
- **追溯表要同步更新。** 每一批测试跑绿后，都要更新 `M6-abstraction-baseline-audit.md` 的追溯表，删除第 5 节第 1、5 条所列的无效证据（`windowApiPermissions.test.ts` 与 `WorkspaceDataRestoreListener.test.tsx`）。

原型与验证代码已入库为参考文件（`docs/milestones/0.4.0/closure-prototypes/`（`.txt` 参考文件，用法见该目录 README））：

- `host\mocks.tsx`、`host\harness.tsx`
- `ptyWorkspace.proto.test.tsx`、`appExit.proto.test.tsx`、`language.proto.test.tsx`、`timers.proto.test.tsx`、`misc.proto.test.tsx`、`calib.proto.test.tsx`
- `globcase\`

### 终稿相对初稿的更正

1. 文首摘要原写“5 个缺陷中 3 个前端可以直接复现”，与事实不符：原型只复现了 FE-NEW-01，其余 4 项来自代码阅读，对应测试的“预期失败”尚未实际运行。已改写为准确表述。
2. 第 1.1 节层级统计原为精确数字（纯函数/单元 40、注册表/契约 9 等），实际文件跨层存在重叠，合计超过 53。已改为“大致统计（部分文件跨层，有重叠）”并加“约”字。
3. 第 7 节“追溯表要同步更新”原写“第 5 节第 5、6 条”，应为第 1、5 条：审计追溯表实际引用的无效证据是 `windowApiPermissions.test.ts`（第 1 条）和 `WorkspaceDataRestoreListener.test.tsx`（第 5 条）；第 6 条（`WorkspaceContentView.test.tsx`）只是名不副实，并非追溯表引用的证据。已更正。
4. HX-5 的 `geometry.install` 原只写“返回 `restore()`”，但 FE-T26 调用了 `geometry.setStripWidth(...)`。已把返回值补全为 `{restore(), setStripWidth(n)}`。
5. 第 2 节 R10 表中 RTL 一行原写“FE-T59 不单列”，而 FE-T59 并不存在（规格只到 FE-T58）。已改为“并入第 6 节平台说明，不单列规格”。
6. 前端 seam 全文由 `SEAM-n` 改名为 `FE-SEAM-n`（含 HX-4、第 3.3 节表、第 4 节各条目 seam 字段、FE-T35 内的参考说明以及第 7 节），以避免与 Rust 侧 SEAM-\* 冲突。
7. FE-T32 原把两个用例的名称写在同一行，容易误解为同一文件内的同名用例；已标注“（文件窗）”“（终端窗）”以区分。
8. 标题层级整体下降一级：原一级标题降为 `###`，原二级标题降为 `####`，文首不再有总标题。

## 第二部分：跨语言补充规格

本部分补充第二轮复核后期才核实的三条缺陷对应的前端侧规格；其 Rust 侧规格是 RS-T56、RS-T57、RS-T58（见第三部分）。三条缺陷均已由汇总人回到代码核实：

- S3J-A01：0.3.0 升级用户的 `workspace_state` 行 `schema_version` 列为 1，读取时在内存迁移到 v5，保存时 `workspace_layout_repo::save_current`（`db/workspace_layout_repo.rs:54-57`）因列值不等于 5 返回 `saved:false`，前端 `WorkspaceLayoutSaveQueue`（`workspaceLayoutPersistence.ts:551-558`）对 `saved:false` 立即重新入队，形成无限循环。
- S3J-A02/A03：`ProjectFileOpenResult::Image`（`file_service.rs:70-86`）与 `ManagedUpdateStatus::Denied`（`models/install.rs:68-73`）只声明了 `rename_all = "camelCase"`、缺少 `rename_all_fields`，序列化为 `mime_type`/`base64_data`/`reason_key`，前端 `createWorkspaceFileBuffer`（`workspaceFileBuffer.ts:52-63`）与 `SettingsView.tsx:702-708` 读取的却是 `mimeType`/`base64Data`/`reasonKey`。
- S3H-A02：`app-exit-requested` 载荷里的 `ptyCount` 被直接采信，`confirm_app_exit` 不核对待决请求。

### FE-T59｜P0｜S3J-A02、S3J-A03、B1-F10、S3J-A05

- **文件与用例名**：`src/lib/dtoFixtures.contract.test.ts`；`describe("IPC DTO golden fixtures")`，下设：
  - `it("builds an image preview data URL from the Rust-serialized image result")`
  - `it("exposes the managed update denial reason key from the Rust-serialized status")`
  - `it("covers every variant fixture exported by the Rust golden fixture generator")`
- **层级/环境**：contract / node
- **前置**：
  - 依赖 RS-T57 生成的 `contracts/fixtures/*.json`（文件名建议 `project-file-open-result.json`、`managed-update-status.json`，每个文件是 `{ "variants": { "<variantName>": <Rust 序列化输出> } }`）；
  - 测试**只**从该目录导入 fixture，禁止在测试里手写这些对象；
  - 在 fixtures 目录缺失时，用例直接失败并提示“先运行 Rust 测试生成 fixture”，不得静默跳过。
- **步骤**：
  1. 取 `project-file-open-result.json` 的 `variants.image`，传给 `createWorkspaceFileBuffer(file, 0)`；
  2. 取 `managed-update-status.json` 的 `variants.denied`，赋值给 `LatestVersion["managedUpdate"]` 类型变量（使用 `satisfies` 做编译期检查），再按 `SettingsView.tsx:702-708` 相同的方式读取 `reasonKey`；
  3. 遍历每个 fixture 文件的 `variants`，断言键集合等于该 DTO 在 `src/lib/tauri.ts` 中声明的判别联合分支集合（分支名在测试里以字面量数组独立声明）。
- **断言**：
  - 步骤 1：`buffer.kind === "image"`，且 `previewDataUrl` 以 `"data:image/"` 开头，`not.toContain("undefined")`；
  - 步骤 2：`reasonKey` 是非空字符串，且在 `src/i18n/locales/en.ts` 的对应键路径下能取到非空文案（用 `reasonKey.split(".")` 逐层取值）；
  - 步骤 3：每个 DTO 的变体名集合相等。
- **反向断言**：不得出现 `mime_type`、`base64_data`、`reason_key` 这类 snake_case 键（用正则扫描 fixture 原文，除 `content`/`revision` 等单词字段外，任何带下划线的对象键都视为违规）。
- **预期当前结果**：失败（Rust 当前输出 snake_case 键，步骤 1 的 `previewDataUrl` 含 `undefined`，步骤 2 的 `reasonKey` 为 `undefined`）；Rust 侧补上 `rename_all_fields = "camelCase"` 并重新生成 fixture 后转绿。
- **现有测试的处置**：`src/lib/tools.test.ts:58-70`、`src/lib/workspaceFileBuffer.test.ts:243-244` 里手写的 camelCase fixture 改为从 `contracts/fixtures/` 导入，不再手写。
- **seam**：无（依赖 RS-T57）。

### FE-T60｜P0｜S3J-A01、FE-NEW-05

- **文件与用例名**：`src/lib/workspaceLayoutPersistence.test.ts`（追加）；`describe("layout save results")`，下设：
  - `it("rebases once on a stale rejection and then succeeds")`
  - `it("stops without retrying and reports once on an incompatible schema rejection")`
  - `it("does not spin when the backend keeps rejecting without a reason")`
- **层级/环境**：unit / node + fake timers
- **前置**：
  - 依赖保存结果类型扩展（生产代码 seam，见 FE-SEAM-13）：`WorkspaceLayoutSaveResult = { saved: true; revision: number } | { saved: false; reason: "stale" | "incompatible"; revision: number }`；`reason` 缺省视为 `"stale"` 以兼容旧后端；
  - `save = vi.fn()`、`onError = vi.fn()`、`q = new WorkspaceLayoutSaveQueue(5, save, onError)`、`doc = <最小合法 v5 布局>`。
- **步骤与断言**：
  - it1（stale）：第一次返回 `{ saved:false, reason:"stale", revision:7 }`，第二次返回 `{ saved:true, revision:8 }`；`q.enqueue(doc)`，`await q.flush()`。`save` 被调用 2 次，第二次的 `revision` 参数为 8（rebase 到返回修订号 + 1）；`onError` 未被调用。
  - it2（incompatible）：返回 `{ saved:false, reason:"incompatible", revision:3 }`；`save` 只被调用 1 次；`onError` 被调用 1 次，参数的错误码为 `layout.schema_incompatible`；之后再 `enqueue` 新文档，队列恢复可用（会再调用 `save`），并且仍只在每次拒绝时上报一次。
  - it3（无原因）：`save` 永远返回 `{ saved:false, revision:5 }`（无 reason，修订号不推进）；`flush` 在 3 次尝试内结束；`onError` 被调用 1 次，错误码为 `layout.save_rejected`；`save` 调用次数 ≤ 3。
- **反向断言**：任何用例里 `save` 的调用次数都不得达到 10（防止无限循环被测试掩盖）；it2 中不得出现退避定时器遗留（`vi.getTimerCount() === 0`）。
- **预期当前结果**：it1 失败（当前不区分原因，修订号推进方式不同于预期）；it2 失败（会无限重试，直到被测试的 spin guard 触发）；it3 失败（同 FE-T48，会一直重试）。修复后转绿。
- **与 FE-T48 的关系**：FE-T48 只覆盖“拒绝且不推进 revision”的停止条件；本条增加原因分类。两条规格实现时合并为同一 `describe`，不要重复断言。
- **seam**：FE-SEAM-13（见下）。

### FE-T61｜P1｜S3H-A02、B2-F01

- **文件与用例名**：`src/App.exit.host.test.tsx`（追加）；`describe("application exit requests")`，下设：
  - `it("confirms exit with the pending request id")`
  - `it("ignores an exit request without a request id")`
  - `it("ignores a confirm result for a stale request id")`
- **层级/环境**：host-integration（App）/ jsdom
- **前置**：
  - 依赖退出请求关联设计（主报告 3A.9 与 RW5）：Rust 发出 `app-exit-requested` 的载荷为 `{ requestId: string, ptyCount: number, executionTaskCount: number }`；前端 `confirmAppExit(requestId)` 带上该 id；
  - 在 HX-1 的 ACL 开启状态下，`mountApp()`；`backend.handlers.set("confirm_app_exit", ({ requestId }) => …)` 记录入参。
- **步骤与断言**：
  - it1：`emitBackendEvent("app-exit-requested", { requestId: "req-1", ptyCount: 0, executionTaskCount: 0 })`；`flush()`。`invokes("confirm_app_exit")` 恰好 1 次，且 `args.requestId === "req-1"`。
  - it2：发送不含 `requestId` 的载荷（`{ ptyCount: 0 }`）；`flush()`。`invokes("confirm_app_exit")` 为 0 次；没有对话框；`console.warn` 以 `app.exit_request_invalid` 被调用 1 次。
  - it3：先发送 `req-1`（有脏文件，使对话框停留），再发送 `req-2`；用户点击确认。`confirm_app_exit` 的入参为 `req-2`（后到的请求替换先到的），且 `req-1` 从未被确认。
- **反向断言**：it2、it3 中不得调用 `terminate_pty_session`；errors 为空。
- **预期当前结果**：失败（当前载荷没有 `requestId`，`confirmAppExit()` 无参数）；Rust 侧 RS-T58 修复并改签名后转绿。
- **seam**：FE-SEAM-14（见下）。

### FE-T62｜P1｜PD-12、S1C-N01

- **文件与用例名**：`src/components/StartupNotices.test.tsx`；`describe("startup notices")`，下设：
  - `it("shows the abnormal exit notice once and lets the user dismiss it")`
  - `it("shows nothing after a clean start")`
  - `it("never claims that anything was restored")`
  - `it("fetches notices once per window lifetime even under StrictMode")`
  - `it("is not requested from detached windows")`
- **层级/环境**：component（主窗口）/ jsdom
- **前置**：
  - 依赖 RS-T59 的 `take_startup_notices` 命令：返回 `[{ kind: "abnormal_exit_detected", startedAtMs: number | null }]`，取走即清空；通知类型 `abnormal_exit_detected` 是启动提示的种类，不属于错误码，不进入 `contracts/error-codes.json`；
  - 使用 stable `t` mock 与 sonner mock；`backend.handlers.set("take_startup_notices", …)`；
  - 提示在主窗口 hydrate 完成之后请求一次（避免与布局恢复的提示叠加）；展示方式为一个可关闭的非阻断提示（toast 或横幅，实现者选定，测试按 `role="status"` 或 toast 调用断言）。
- **步骤与断言**：
  - it1：`take_startup_notices` 返回一条异常退出提示 → 提示出现一次，文本使用 `startupNotice.abnormalExit`；关闭后不再出现；`invokes("take_startup_notices")` 为 1 次。
  - it2：返回空数组 → 没有任何提示；没有 console 错误。
  - it3：对 `en` 与 `zh` 两个 locale 的 `startupNotice.abnormalExit` 文案断言：中文包含“可能丢失”，英文包含 “may be lost”；两种文案都**不得**包含“恢复”“已恢复”“restored”“recovered”（本版本不保存文件正文，也没有恢复功能，PD-12b 未采用）。
  - it4：用 `React.StrictMode` 挂载主窗口，`invokes("take_startup_notices")` 仍只有 1 次，提示只出现一次。
  - it5：以 `mountPtyWindow()` 与 `mountFileWindow()` 挂载子窗口，`take_startup_notices` 调用次数为 0（也由 capability 契约保证子窗口无该命令）。
- **反向断言**：提示不得阻塞界面交互；`startedAtMs` 为 null 时文案不显示时间；提示不得依赖 `t` 进入业务 effect（遵守 R-FE-1，用 latest-ref 或渲染期翻译）。
- **预期当前结果**：失败（命令与组件不存在）；RS-T59 与 FE-SEAM-15 落地后转绿。
- **seam**：FE-SEAM-15。

### FE-T63｜P1｜PD-10、S3I-A14（实现被平台调研阻塞的骨架）

- **状态**：**全部用例 `it.skip` 并注明 PD-10；设计草案已评审通过（主报告 4.7.2、4.7.4），但在 4.7.2.12 的平台实现调研完成并经用户确认调研结论前不实现。**
- **备注（平台实现细则，均为待调研核实）**：前端只消费探测结果，不判断平台；探测结果是 `PathSemantics { case, normalizationInsensitive }` 两根轴；探测以项目根所在位置为准；`unknown` 一律不折叠；文件身份兜底是安全网，探测只是先验、不能保证。
- **文件与用例名**：
  - `src/lib/pathKey.test.ts`：`describe("pathKeyOf")`
    - `it.each(<向量>)("matches the shared vector %s")`
    - `it("never folds when the case axis is sensitive or unknown")`
    - `it("normalizes to NFC only when the normalization axis is yes")`
  - `src/components/PtyWorkspace.pathkey.host.test.tsx`：`describe("document identity with path semantics")`
    - `it("opens the same file in two cases according to the flag and identity check")`（`it.each` 矩阵，见下）
    - `it("keeps exact dedupe at hydrate and merges case variants after the semantics arrive")`
    - `it("retries once and then degrades a single item on layout.case_duplicate")`
    - `it("has no template-string document identity left in source")`
- **层级/环境**：unit / node；host-integration / jsdom
- **前置**：
  - 向量来自 `contracts/fixtures/path-key-vectors.json`，与 RS-T62 测试一共用，文件由 Rust 侧生成或手写后双端导入，禁止在测试里重复手写；
  - 宿主测试用 `backend.handlers.set("get_project_path_semantics", …)` 注入探测结果，用 `backend.handlers.set("check_project_files_same_identity", …)` 注入文件身份检查（返回 `true`、`false` 或抛出 `{ code: "file.identity_unavailable" }` 表示无法取得）；
  - 使用 HX-3 的 `mountWorkspace`、`openFile`。
- **打开矩阵（`it.each`，先 `openFile("a.txt")`，再 `openFile("A.txt")`，写全）**：

  | 探测结果               | 身份检查                                 | 期望                                         |
  | ---------------------- | ---------------------------------------- | -------------------------------------------- |
  | `{case:"sensitive"}`   | `false`                                  | 两个文档                                     |
  | `{case:"unknown"}`     | `true`（同一文件）                       | 一个文档，聚焦已有文档，字面路径保持 `a.txt` |
  | `{case:"unknown"}`     | `false`                                  | 两个文档                                     |
  | `{case:"insensitive"}` | 不可用（抛 `file.identity_unavailable`） | 一个文档（按 flag 判定）                     |
  | `{case:"insensitive"}` | `false`（误探测防护）                    | 两个文档                                     |
  | `{case:"insensitive"}` | `true`                                   | 一个文档                                     |

- **hydrate 时序用例**：布局含 `a.txt` 与 `A.txt` 两个文档（分布在不同窗格）；hydrate 完成后两者都在（只做精确去重）；随后 `get_project_path_semantics` 返回 `insensitive` 且身份相同 → 合并一次：引用重写、同一文档只在一个窗格、规范文档是先出现者；合并期间不触发持久化抖动，最后一次保存的布局通过 `validateWorkspaceLayoutDocument`；探测返回 `unknown` → 不变；用户在探测结果到达前打开 `A.txt`，合并后仍然只有一个文档（由打开路径自己的键与身份兜底保证一致）。
- **保存拒绝用例**：`save_workspace_layout` 第一次返回 `layout.case_duplicate`（含 documentId 列表）→ 前端按合并规则修复后重试一次；第二次仍拒绝 → 单项降级并提示，保存调用总数不超过 2，不得进入无限重试。
- **源码扫描用例**：`src` 下非测试源码中不再存在 `${…directoryId}:${…relativePath}` 形态的模板字符串，文档身份只经 `documentIdentityKey` 构造。
- **预期当前结果**：骨架，评审与实现前不运行；实现后矩阵、时序、保存拒绝与扫描用例均应通过。
- **seam**：FE-SEAM-16、FE-SEAM-17。

### 补充的前端 seam

| 编号       | 位置                                                                                                                                                                              | 修改                                                                                                                                                                                                                                                                          | 关联规格与缺陷                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| FE-SEAM-13 | `src/lib/tauri.ts` 的 `WorkspaceLayoutSaveResult`；`workspaceLayoutPersistence.ts` 的 `WorkspaceLayoutSaveQueue`（约 551-558 行）                                                 | 结果类型改为带 `reason` 的判别联合；队列按原因处理：`stale` 用返回的修订号 + 1 重试一次，`incompatible` 立即停止并回调 `onError`，缺省原因最多尝试 3 次后停止；错误码使用 `layout.schema_incompatible` 与 `layout.save_rejected`（需同步登记到 `contracts/error-codes.json`） | FE-T60、FE-T48；S3J-A01、FE-NEW-05；需 Rust 侧 RS-T56 一并修改保存结果 |
| FE-SEAM-14 | `src/lib/tauri.ts` 的 `confirmAppExit`；`src/App.tsx` 约 151-186 行的退出监听                                                                                                     | `confirmAppExit(requestId: string)`；监听载荷校验 `requestId` 为非空字符串，不合法时只记录告警，不弹对话框也不确认；新请求替换待决请求                                                                                                                                        | FE-T61；S3H-A02；需 Rust 侧 RS-T58 提供 requestId                      |
| FE-SEAM-15 | `src/lib/tauri.ts` 新增 `takeStartupNotices()`；`src/App.tsx` 或新增 `StartupNotices` 组件                                                                                        | 主窗口 hydrate 完成后调用一次 `take_startup_notices`，展示可关闭的非阻断提示；子窗口不调用；文案键 `startupNotice.abnormalExit` 登记到 10 个 locale                                                                                                                           | FE-T62；PD-12；需 RS-T59                                               |
| FE-SEAM-16 | 新增 `src/lib/pathKey.ts`；`PtyWorkspace.tsx` 约 775、786、873 行与 `workspaceLayoutPersistence.ts` 约 224、229、237 行的模板字符串                                               | 全部改为 `documentIdentityKey(directoryId, relativePath, semantics)`；类型 `PathSemantics` 与 Rust 同名同义                                                                                                                                                                   | FE-T63；PD-10（设计已评审通过，平台调研结论确认前不实现）              |
| FE-SEAM-17 | `src/lib/tauri.ts` 新增 `getProjectPathSemantics()` 与 `checkProjectFilesSameIdentity()`；宿主新增按目录保存探测结果的状态与 `mergeCaseVariantDocuments` 动作（经命令执行器提交） | hydrate 之后并行获取每个目录的探测结果；探测失败按 `unknown`；打开文件时先按键查找，再按身份兜底                                                                                                                                                                              | FE-T63；PD-10（设计已评审通过，平台调研结论确认前不实现）；需 RS-T62   |

---

## 第三部分：Rust、CI 与实机验收专项

本专项为只读审查，依据：`cargo test -- --list`（Windows 本机）、CI run 37436033117 三个平台的 job 日志、失败 run 37437040753、37431150994、37410191944、37409182236、37399404615 的日志、`src-tauri/src` 相关源码，以及本地 cargo registry 中 `cap-primitives-4.0.3`、`tao-0.35.3`、`tauri-2.11.2` 的源码。中间文件（测试清单、各平台执行清单、CI 日志）未入库，可用 `cargo test -- --list` 与 `gh run view --log` 重新生成。

**编号约定：** 本专项新增的 Rust seam 为 SEAM-01~SEAM-27（前端侧使用 FE-SEAM-\* 前缀，不冲突）；测试规格为 RS-T01~RS-T63。「关联审查编号」沿用本轮审查的编号体系（S1B/S1C/S1D、B1/B2/B3F/B3R、J1/J4、X-F）；本专项自身新发现的问题记为 N1~N18（见第 8 节），尚无正式审查编号。

**最重要的结论：** Ubuntu 上 `separate_processes_using_same_revision_allow_only_one_winner` 间歇失败，根因已定位到产品代码，不在测试夹具。`compare_and_swap_with_adapter` 每次都调用 cap-std 的 `Dir::canonicalize`。它在 Linux 上的实现是 `open(O_PATH)` 加 `readlink(/proc/self/fd/N)`，而 `cap-primitives-4.0.3/src/rustix/linux/fs/canonicalize_impl.rs` 没有像同目录的 `file_path.rs` 那样处理 `" (deleted)"` 后缀。另一进程恰好在两次系统调用之间原子替换了目标时，解析结果会变成 `note.txt (deleted)`，随后 `lock_current` 连续 2 秒得到 ENOENT 才放弃。详细分析见第 2 节。

### 1. Rust 测试盘点与平台执行实况

#### 1.1 口径与总数

| 项目                    | 数值                                                                                                                                                           | 来源                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 源码测试函数            | 313 个 `#[test]` 加 12 个 `#[tokio::test]`，共 325 个；按名称去重后 324 个（`hermes_version_probe_passes_isolated_home_to_cli` 有 unix、windows 两个同名版本） | `grep` 统计                          |
| Windows 本机 `--list`   | 297                                                                                                                                                            | `cargo test -- --list`               |
| CI 37436033117 实际执行 | Windows 297、Ubuntu 298、macOS 296；ignored 都是 0；三平台共有 272 个                                                                                          | 解析 job 日志中的 `test … ... ok` 行 |
| 三平台并集              | 324 个，和源码去重数一致                                                                                                                                       | —                                    |

**没有一个测试在三平台都没执行。** 但下面这些“执行了却没有断言任何东西”的测试也被计入了总数：4 个 `if let Ok` 安装测试、Windows 下可能提前 `return` 的符号链接测试、`cross_process_cas_worker`。

#### 1.2 按模块分布（W / U / M = Windows / Ubuntu / macOS 执行数）

| 模块                          | W   | U   | M   | 模块                                  | W   | U   | M   |
| ----------------------------- | --- | --- | --- | ------------------------------------- | --- | --- | --- |
| commands::cli_status          | 2   | 2   | 2   | services::app_lifecycle               | 1   | 1   | 1   |
| commands::directory           | 1   | 1   | 1   | services::backup_service              | 8   | 8   | 8   |
| commands::files               | 1   | 1   | 1   | services::cache_service               | 4   | 4   | 4   |
| commands::install             | 3   | 3   | 3   | services::cli_adapters                | 5   | 5   | 5   |
| contracts                     | 6   | 6   | 6   | cli_adapters::antigravity::common     | 1   | 1   | 1   |
| db::app_setting_repo          | 3   | 3   | 3   | cli_adapters::claude::common          | 2   | 4   | 4   |
| db::cache_connection          | 1   | 1   | 1   | cli_adapters::claude::history         | 1   | 1   | 1   |
| db::connection                | 18  | 18  | 18  | cli_adapters::claude::platform        | 0   | 2   | 2   |
| db::directory_repo            | 2   | 2   | 2   | cli_adapters::codex::app_server       | 2   | 2   | 2   |
| db::execution_task_repo       | 5   | 5   | 5   | cli_adapters::codex::common           | 1   | 1   | 1   |
| db::launch_history_repo       | 2   | 2   | 2   | cli_adapters::grok::common / platform | 1/1 | 1/1 | 1/1 |
| db::session_alias_repo        | 2   | 2   | 2   | cli_adapters::hermes::common          | 1   | 1   | 1   |
| db::session_search_repo       | 8   | 8   | 8   | cli_adapters::hermes::history         | 6   | 6   | 6   |
| db::workspace_layout_repo     | 2   | 2   | 2   | cli_adapters::hermes::platform        | 2   | 3   | 3   |
| error                         | 3   | 3   | 3   | services::config_service              | 8   | 8   | 8   |
| models::app_setting           | 1   | 1   | 1   | services::content_window_grants       | 2   | 2   | 2   |
| models::execution             | 2   | 2   | 2   | services::diagnostics_service         | 2   | 2   | 2   |
| models::install               | 3   | 3   | 3   | services::directory_service           | 8   | 8   | 8   |
| models::tool                  | 1   | 1   | 1   | services::execution_service           | 8   | 8   | 8   |
| models::window_kind           | 2   | 2   | 2   | services::file_service                | 15  | 21  | 19  |
| models::workspace_layout      | 23  | 23  | 23  | services::install_service             | 11  | 7   | 7   |
| platform::detect              | 6   | 6   | 6   | services::launch_service              | 2   | 2   | 2   |
| platform::execution_process   | 3   | 2   | 2   | services::project_directory           | 1   | 1   | 1   |
| platform::file_cas            | 14  | 12  | 12  | services::pty_session_service         | 18  | 18  | 18  |
| platform::path_identity       | 2   | 2   | 2   | services::session_service             | 27  | 26  | 26  |
| platform::path_rules          | 2   | 2   | 2   | services::storage_service             | 4   | 4   | 4   |
| platform::process             | 4   | 4   | 4   | services::version_service             | 12  | 12  | 12  |
| platform::window_geometry     | 6   | 6   | 6   | services::workspace_layout_service    | 13  | 13  | 13  |
| platform::windows_environment | 2   | 0   | 0   |                                       |     |     |     |

**完全没有测试的编排模块**（行数）：`lib.rs`（451，含 `run`、`handle_run_event`、`on_window_event`、`setup_tray`）、`commands::pty_session`（222，15 个命令）、`commands::session`（126）、`services::cli_detect_service`（120）、`commands::workspace_layout`（102）、`db::pty_session_repo`（87）、`commands::backup`（77，恢复编排）、`db::cache_repo`（73）、`commands::execution`（70）、`commands::config`、`commands::app_setting`、`platform::opener`。各 `*/history.rs` 没有自己的测试模块，但 `session_service::tests` 通过 `#[cfg(test)] use` 覆盖了它们，不算空白。

#### 1.3 条件编译测试的实际执行情况（逐条对照三平台日志）

**只在 Windows 执行（25 项，U、M 都不出现）：**
`commands::cli_status::tests::preserves_version_only_when_resolved_path_is_unchanged`；`models::workspace_layout::tests::workspace_layout_rejects_windows_ads_and_reserved_file_names`；`platform::detect::tests::known_windows_install_dirs_include_user_local_bin`；`platform::execution_process::windows::tests::{failed_job_attachment_terminates_pty_process, job_object_terminates_attached_process, job_object_terminates_pty_process}`；`platform::file_cas::tests::{replacement_preserves_protected_target_acl, temporary_acl_is_private_and_replacement_preserves_inherited_target_acl, unconditional_replacement_preserves_readonly_attribute, windows_network_rename_paths_are_classified_and_built_without_root_handle}`；`platform::path_identity::tests::windows_paths_ignore_case_and_separator_style`；`platform::path_rules::tests::windows_rejects_ads_reserved_names_and_trailing_dots`；`platform::process::tests::windows_script_extensions_select_native_hosts`；`platform::windows_environment::tests::{appends_registered_entries_missing_from_isolated_path, deduplicates_case_and_trailing_separators}`；`services::cli_adapters::hermes::platform::windows_managed_install_tests::managed_source_update_requires_default_bin_and_git_checkout`；`services::file_service::tests::retained_project_handle_prevents_root_directory_replacement`；`services::install_service::tests::{antigravity_uses_official_installer, claude_install_uses_winget_official_package, codex_install_uses_official_windows_installer, codex_update_uses_builtin_command_under_windows_powershell_5_1, grok_install_uses_fixed_official_windows_script_and_preview, powershell_argument_escapes_single_quotes}`；`services::session_service::tests::{file_uri_matches_windows_path_and_decodes_spaces, paths_match_ignores_separators_and_case}`。

**Ubuntu 和 macOS 都执行（`cfg(unix)`，23 项）：**
`commands::cli_status::tests::preserves_version_with_unix_path_semantics`；`models::workspace_layout::tests::workspace_layout_uses_unix_file_name_rules`；`platform::detect::tests::known_directory_requires_executable_permission`；`platform::execution_process::unix::tests::{process_group_terminates_pty_process, process_group_terminates_shell_and_descendant}`；`platform::file_cas::tests::{permission_restore_failure_after_rename_is_a_warning_not_a_save_error, replacement_preserves_mode_and_starts_with_private_temporary_mode}`；`platform::path_identity::tests::unix_paths_preserve_case_and_ignore_trailing_separator`；`platform::path_rules::tests::unix_allows_colon_and_backslash_as_filename_characters`；`platform::process::tests::timeout_kills_descendants_that_ignore_terminate_after_root_exits`；`services::cli_adapters::claude::common::tests::{native_update_command_uses_install_home_not_isolated_app_home, version_probe_disables_automatic_updates_and_uses_native_home}`；`services::cli_adapters::claude::platform::tests::{ignores_non_native_claude_binary_layouts, resolves_home_from_native_versioned_binary}`；`services::cli_adapters::hermes::platform::posix_managed_install_tests::managed_source_install_requires_default_launcher_and_checkout`；`services::cli_adapters::hermes::platform::tests::posix_install_uses_official_non_interactive_source_installer`；`services::file_service::tests::{atomically_replaces_write_only_destination, opening_a_fifo_returns_without_waiting_for_a_writer, retained_project_capability_survives_root_path_replacement, text_file_save_preserves_existing_permissions, unix_lists_and_opens_colon_backslash_and_unicode_file_names}`；`services::install_service::tests::codex_update_uses_builtin_command`；`services::session_service::tests::file_uri_matches_unix_path_and_preserves_case`。

**只在 Ubuntu 执行（3 项）：** `services::file_service::tests::{listing_scan_budget_covers_entries_skipped_for_unreadable_names, listing_skips_non_utf8_names_and_reports_the_count}`、`services::install_service::tests::linux_installs_use_fixed_official_scripts`。

**只在 macOS 执行（1 项）：** `services::install_service::tests::macos_installs_use_fixed_official_scripts`。

**macOS 的缺口：** 没有任何测试证明“macOS 拒绝创建非 UTF-8 文件名”。这条平台假设目前只写在 M6 文档里（见 RS-T41）。

**近期 CI 失败史：** Windows 的 `bounded_*_truncated` 输出截断测试失败两次，已在 d7d329f/d88d38e 修复；macOS 的非 UTF-8 测试失败一次，已在 312e01d 改为只在 Linux 运行；Ubuntu 的 CAS 跨进程测试在最近 5 次 Ubuntu job 中失败 2 次（37437040753、37431150994），仍未修复。

#### 1.4 弱测试清单（同义反复、只测辅助函数却声称覆盖编排、静默通过）

| #   | 测试                                                                                                                                                                                           | 问题                                                                                                                                                      | 处置                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | `services::cli_adapters::tests::adapter_resume_errors_fail_closed`                                                                                                                             | 只断言测试里自建的 `MissingHistoryAdapter` 自己 `bail!`，是同义反复                                                                                       | RS-T24/RS-T25 替代                          |
| 2   | `services::execution_service::tests::execution_events_are_scoped_to_the_main_window`                                                                                                           | `assert_eq!(EXECUTION_EVENT_TARGET, "main")`，常量等于字面量，同义反复                                                                                    | 可删，或改成断言 `emit_task` 实际使用该常量 |
| 3   | `pty_session_service::tests::finalized_handoff_rejects_source_cancel_and_reports_child_owner`                                                                                                  | 只构造 `EventRoute` 调用 `ensure_route_owner`，没有执行 finalize 和 cancel（B3F-F04）                                                                     | RS-T15                                      |
| 4   | `destroying_the_current_owner_reclaims_an_open_session_for_main`、`destroying_a_non_owner_does_not_reclaim_the_session`、`destroying_a_window_clears_handoffs_that_use_it_as_source_or_target` | 只测 `reclaim_event_route` 和 `handoff_references_window` 两个辅助函数，`reclaim_window` 的暂停、恢复、返回值都没测（B3R-F05）                            | RS-T10/T11                                  |
| 5   | `window_status_distinguishes_ended_owned_and_transferred_sessions`                                                                                                                             | 只测 `session_window_status` 纯函数，没测 manager                                                                                                         | RS-T17                                      |
| 6   | `backup_restore_is_blocked_while_pty_sessions_are_registered`                                                                                                                                  | 只测 `ensure_no_active_sessions(n)`，没有真正登记会话                                                                                                     | RS-T20                                      |
| 7   | `install_service::tests::{claude_install_uses_winget_official_package, claude_update_uses_builtin_command, codex_update_uses_builtin_command, antigravity_update_uses_builtin_command}`        | `if let Ok(plan) = …`；CI 机器上没装这些 CLI 时整条测试不断言任何东西                                                                                     | RS-T42                                      |
| 8   | `launch_service::tests::normal_payload_ignores_legacy_project_arguments`                                                                                                                       | 测的是 `#[cfg(test)] fn resolve_payload_with`，这是生产逻辑的测试专用副本，生产函数 `resolve_payload_at_directory` 根本没被测                             | RS-T24                                      |
| 9   | `file_service::tests::refuses_symbolic_link_escape`（Windows）                                                                                                                                 | `symlink_dir` 失败时直接 `return`，静默通过                                                                                                               | RS-T44                                      |
| 10  | `file_cas::tests::cross_process_cas_worker`                                                                                                                                                    | 只是子进程入口，正常运行时 `let Ok(..) else { return }` 永远通过，三平台各多计 1 项                                                                       | RS-T45                                      |
| 11  | `session_service::tests::stalled_search_adapter_is_marked_incomplete_within_budget`                                                                                                            | 只测 `bounded_search_index_source`；编排层 `context_for_tool` 在预算之外同步调用 `where.exe`（S1C-N02、B1-F07）                                           | RS-T22/T23                                  |
| 12  | `cli_adapters::tests::adapter_panics_become_scoped_errors`、`execution_service::tests::active_task_guard_releases_slots_after_early_return_and_panic`                                          | 只测 `catch_adapter` 和 guard 本身；`run_task` 里 JoinError 走到 `finish_failed` 的路径没有断言（B1-F12）                                                 | RS-T21                                      |
| 13  | `platform::process::tests::timeout_terminates_the_child_process_tree`（Windows 分支）                                                                                                          | 只断言耗时小于 3 秒，不验证子孙进程被结束（B1-F08）                                                                                                       | RS-T27                                      |
| 14  | `contracts::tauri_csp_defines_production_and_development_policies`                                                                                                                             | 只用 `contains` 检查，生产策略混入 `'unsafe-eval'` 或 `*` 仍会通过（S1B-N07）                                                                             | RS-T35                                      |
| 15  | `contracts::window_kind_contract_matches_capabilities`                                                                                                                                         | 只比较 `core:` 和 `allow-` 开头的字符串，插件权限和对象权限被跳过（S1B-N02）                                                                              | RS-T34                                      |
| 16  | `contracts::app_command_contract_matches_the_registered_handler`                                                                                                                               | 用文本切分解析 `generate_handler!`，被注释掉的条目也会算作已注册（S1D-N07）                                                                               | RS-T31                                      |
| 17  | `contracts::tool_key_contract_matches_the_rust_registry`、`content_kind_contract_matches_rust_serialization`                                                                                   | 前者和手写的 `ALL` 比较，后者硬编码两个变体；新增枚举变体检测不到（S1D-N07）                                                                              | RS-T32/T33                                  |
| 18  | `db::connection::tests::tool_key_enum_and_database_constraints_accept_the_same_values`                                                                                                         | 只断言 `.is_err()`，不区分外键错误和其他错误；只在新库上测，没覆盖 0.2.4 升级路径，也没覆盖 launch_history、execution_tasks 两张表（B1-F09）              | RS-T26                                      |
| 19  | `services::app_lifecycle::tests::exit_authorization_is_consumed_exactly_once`                                                                                                                  | 只测 gate；`handle_run_event` 和 `on_window_event` 完全没有测试                                                                                           | RS-T05~T10、RS-T58                          |
| 20  | `workspace_layout_repo` 的 2 项测试与 `workspace_layout_service::tests`                                                                                                                        | 没有一条从 schema_version 为 1~4 的持久化行出发走完 read_current 到 save_current；v1 行读取时内存迁移到 v5，保存却因列值 != 5 永远返回 saved=false（N16） | RS-T56                                      |
| 21  | 全部 IPC DTO 的序列化                                                                                                                                                                          | 没有任何测试序列化 DTO 并核对 JSON 字段名；`ProjectFileOpenResult::Image`、`ManagedUpdateStatus::Denied` 序列化为 snake_case，前端读 camelCase（N17）     | RS-T57                                      |

### 2. Ubuntu CAS 失败的根因分析与复现、修复验证设计

#### 2.1 观测证据

- 两次失败都出在 worker 的 `lock_current`，位置是 `file_cas.rs:363` 的 `.context("无法打开待保存文件")`，底层原因是 `No such file or directory (os error 2)`。两次 worker 的用时都是 **2.27 s**，`LOCK_TIMEOUT` 是 2 秒。
- `lock_current` 遇到 `NotFound` 会每 10 ms 重试一次，直到截止时间。所以报错说明**大约 200 次 open 全部返回 ENOENT，并且持续了整整 2 秒**。这不是 rename 的瞬间窗口，而是请求的路径名本身就是错的。
- 失败只出现在 Ubuntu。macOS 和 Windows 在同一提交上都通过。
- 失败方是 process-b，也就是后到、本应得到 `Conflict` 的一方。

#### 2.2 假设与判定

| 假设                                      | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 判定与依据                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1（产品缺陷，确认）**                  | `compare_and_swap_with_adapter`（`file_cas.rs:259`）每次都调用 `root.canonicalize(relative)`。在 Linux 上，cap-primitives 的 `canonicalize_impl` 先 `open_beneath(O_PATH)` 打开旧 inode X，再 `readlink(/proc/self/fd/N)`。若 A 恰好在这两步之间把临时文件 rename 覆盖到 `note.txt`，X 的链接数变为 0，readlink 返回 `/tmp/.tmpXXXX/note.txt (deleted)`，`strip_prefix` 后得到 `note.txt (deleted)`。`parent_and_name` 把它当作目标名，`lock_current` 打开一个不存在的文件，ENOENT 持续 2 秒 | **成立。** 已核对 `cap-primitives-4.0.3/src/rustix/linux/fs/canonicalize_impl.rs`：没有 nlink 或 `" (deleted)"` 处理；而同目录 `file_path.rs` 明确做了 `nlink()==0` 检查。macOS、Windows 走的是各自平台的实现（见文末更正：本专项未逐行核实这两个实现，只依据 CI 结果推断它们不产生这个后缀），所以只有 Linux 出问题。2 秒的持续时间、只出现在 Ubuntu、输方是后到者，三点都吻合 |
| H2（夹具）                                | 临时目录被提前删除，或被并行测试干扰                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 不成立。父测试在 `wait_with_output` 之后才 drop `TempDir`；全仓库测试中没有 `set_var`、`set_current_dir`，也没有对 `/tmp` 的批量清理；目录名随机                                                                                                                                                                                                                                |
| H3（rename 非原子，或 openat2 的 EAGAIN） | 替换时目标短暂消失                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 不成立。Linux 的 `rename(2)` 保证新路径始终可见；cap-primitives 遇到 EAGAIN 会重试 4 次后回退到 `manually::open`，不会产生 ENOENT；而且现象持续 2 秒，不是瞬态                                                                                                                                                                                                                  |
| H4（锁文件路径竞态）                      | 独立锁文件和 rename 之间的竞态                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 不成立。实现不使用独立锁文件，flock 加在目标句柄上；ENOENT 发生在 open 阶段，不在 lock 阶段                                                                                                                                                                                                                                                                                     |

**生产影响（P1，本专项新发现 N1）：** 在 Linux 上，如果用户保存的同时有外部工具原子替换同一文件（`git checkout`、格式化器、`sed -i`、VS Code 原子写），用户会在 2 秒后看到误导性的“无法打开待保存文件”，而不是“外部修改冲突”。更极端的情况：目录中如果恰好存在名为 `<name> (deleted)` 的文件，CAS 会针对**错误的文件**做修订比较。由于内容摘要通常不同，结果多半是 Conflict，但目标确实错了。

#### 2.3 修复方向

- **A（推荐）：在协调器里校验解析结果（SEAM-12）。** 新增 `resolve_cas_destination(root, relative)`，逻辑为：
  1. canonicalize 后比较最后一个组件；
  2. 如果和请求的最后组件不同，且请求的最后组件（`symlink_metadata`）不是符号链接，视为陈旧解析，重新解析，最多 `MAX_IDENTITY_RETRIES` 次；
  3. 如果请求的最后组件是符号链接，就用 `read_link` 得到的文件名比对；
  4. 解析结果 `symlink_metadata` 不存在时同样重试；
  5. 在 Unix 上，`lock_current` 遇到 NotFound 时不要再原地自旋 2 秒，应立即返回，让外层重新解析。2 秒自旋只保留给 Windows。
- **B：** 只 canonicalize 父目录，最后一个组件直接使用请求名，再用 `symlink_metadata` 加 `read_link` 维持“通过符号链接保存到目标”的现有语义。父目录被替换时同样需要按 A 的方式校验。
- 另外建议向 bytecodealliance/cap-std 报告 `canonicalize_impl` 缺少 nlink 检查的问题。

#### 2.4 复现与修复验证步骤（Codex 依次执行）

1. **先加诊断（SEAM-17）。** `lock_current` 的错误上下文带上相对路径：`.with_context(|| format!("无法打开待保存文件：{}", path.display()))`。worker 遇到错误时把 `format!("Error: {error:#}")` 写入结果文件，不再 `unwrap` panic（见 RS-T04）。
2. **用 flaky 探针确认 H1。** 在 Ubuntu 上运行第 6 节 CI-05 的探针，设 `CLI_LAUNCHPAD_CAS_ROUNDS=50`。期望失败信息中出现 `note.txt (deleted)`。如果出现的是不带后缀的 `note.txt`，说明 H1 被证伪，停止修复，回报日志。
3. **本地 Linux 复现（WSL2 或 Ubuntu 24.04，需要 Tauri Linux 依赖）：**

```bash
[ -f dist/index.html ] || { mkdir -p dist; echo '<!doctype html><title>t</title>' > dist/index.html; }
cargo test --manifest-path src-tauri/Cargo.toml --no-run
fails=0; for i in $(seq 1 200); do
  cargo test --manifest-path src-tauri/Cargo.toml -q \
    platform::file_cas::tests::separate_processes_using_same_revision_allow_only_one_winner -- --exact \
    > "/tmp/cas-$i.log" 2>&1 || { fails=$((fails+1)); echo "fail $i"; }
done; echo "failures=$fails/200"
```

4. **确定性复现：** RS-T01（注入 `(deleted)` 别名），三平台都能跑，不依赖时序。
5. **上游行为刻画：** RS-T02 中的刻画测试（`#[ignore]`，Linux），直接调用 cap-std 的 `canonicalize` 并紧密循环 rename，证明上游竞态存在。
6. **修复后的门禁：** RS-T01 通过；RS-T02、RS-T03 在 Linux 上每次通过；探针连续 3 次运行（每次 50 轮跨进程）失败数为 0；常规 CI 三平台通过。

### 3. Rust/平台需求追踪矩阵

级别说明：**A** 表示编排层有真实组件测试；**B** 表示只测辅助函数或纯函数；**C** 表示没有测试；**M** 表示只能实机验证。

| 需求              | 子项                                                           | 现有证据（测试名，平台）                                                              | 级别        | 缺口                                                                                                | 补充                                                        |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| R1 契约           | 命令 ↔ contract ↔ capability                                   | `app_command_contract_matches_the_registered_handler`（三平台）、build.rs AppManifest | B           | 注释被算作已注册；没校验命令函数是否存在                                                            | RS-T31                                                      |
|                   | 窗口类别与 label                                               | `window_kind_contract_matches_rust_registry`、`resolves_registered_window_labels`     | A           | Rust 与 TS 没有共用测试向量                                                                         | RS-T40                                                      |
|                   | capability（核心、应用、插件、对象权限）                       | `window_kind_contract_matches_capabilities`                                           | B           | 插件和对象权限被跳过                                                                                | RS-T34                                                      |
|                   | 错误码                                                         | `coded_errors_*`（只测序列化）                                                        | C           | 没有清单；TS 有 8 个码后端从不产出                                                                  | RS-T36                                                      |
|                   | tool key                                                       | `tool_key_contract_matches_the_rust_registry`、`migrations_seed_default_tools`        | B           | `ALL` 是手写的                                                                                      | RS-T32、RS-T26                                              |
|                   | 内容 kind                                                      | `content_kind_contract_matches_rust_serialization`                                    | B           | 变体硬编码                                                                                          | RS-T33                                                      |
|                   | CSP                                                            | `tauri_csp_defines_production_and_development_policies`                               | B           | 只做包含检查；offline 配置可能覆盖                                                                  | RS-T35、实机 W-15/M-15/L-15                                 |
|                   | IPC DTO 字段名（serde）                                        | 无（仅 `error.rs` 三项测试）                                                          | C           | `ProjectFileOpenResult::Image`、`ManagedUpdateStatus::Denied` 序列化为 snake_case，前端读 camelCase | RS-T57                                                      |
| R2 五出口         | PTY：正常结束、显式关闭、异常、窗口销毁、应用退出              | 只有辅助函数级测试                                                                    | B/C         | `terminate_all`、`reclaim_window`、退出决策都没测                                                   | RS-T07、T10、T11、T52，实机 W-07~W-11、M-07~M-10、L-07~L-10 |
|                   | 执行任务                                                       | 槽位 guard、`release_before`                                                          | B           | panic 时 JoinError 到 finish_failed 的路径                                                          | RS-T21                                                      |
|                   | 文件授权                                                       | `content_window_grants` 2 项                                                          | A（服务层） | 窗口销毁时撤销授权（S1B-N06）                                                                       | RS-T09                                                      |
|                   | 终端窗                                                         | 辅助函数                                                                              | B           | Destroyed 编排                                                                                      | RS-T10、RS-T11、实机 W-10/M-10/L-10                         |
|                   | 文件窗                                                         | 前端测试                                                                              | C（Rust）   | Destroyed 编排                                                                                      | RS-T09、实机 W-10/M-10/L-10                                 |
|                   | 应用退出                                                       | `exit_authorization_is_consumed_exactly_once`                                         | B           | `handle_run_event`、Cmd+Q（S1C-N01）；`confirm_app_exit` 不核对待决请求                             | RS-T05~T08、T46、T58，实机 W-07、M-07、M-08、L-07           |
|                   | 备份恢复                                                       | backup_service 8 项（数据库层）                                                       | A（数据库） | 编排失败失步（S1D-N05）、索引清空（J1）、与刷新的竞态                                               | RS-T29、T30、T47，实机 W-12/M-12/L-12                       |
| R3 失败语义       | 目录列项                                                       | `listing_skips_non_utf8_*`（只在 Linux）                                              | A           | 控制字符文件名与布局规则不一致（S1D-N08）                                                           | RS-T37                                                      |
|                   | 布局逐项降级                                                   | `round_trips_a_future_content_kind_as_raw_json`                                       | A           | 分离区的 Unknown 被丢弃（S1D-N09）；平台非法文件名导致整份布局重置                                  | RS-T38、RS-T51                                              |
|                   | 适配器隔离与超时                                               | `catch_adapter`、`bounded_search_index_source`                                        | B           | `where.exe` 在预算之外运行（S1C-N02）；Codex app-server 孤儿进程（S1C-N04）；归属校验没有超时       | RS-T22、T23、T28、T55                                       |
|                   | 索引来源                                                       | `index_source`、`stalled_search_adapter_*`                                            | B           | 编排层隔离                                                                                          | RS-T23                                                      |
| R4 PTY 交接状态机 | begin、stage、complete、finalize、cancel、owner_lost、reattach | 只有 Flow 与辅助函数                                                                  | B           | 全转移与非法转移都没在 manager 层测                                                                 | RS-T11~T19                                                  |
| R5 身份可信       | 计划指纹                                                       | `verify_expected_fingerprint` 相关测试                                                | A           | —                                                                                                   | —                                                           |
|                   | WebviewWindow label                                            | `only_main_window_can_manage_file_grants`（辅助函数）                                 | B           | 命令参数是否自报 label 没有静态检查                                                                 | RS-T54                                                      |
|                   | 路径快照                                                       | `open_for_rejects_a_stale_directory_path_snapshot`                                    | A           | —                                                                                                   | —                                                           |
|                   | 授权表                                                         | grants 2 项                                                                           | A           | 销毁时撤销                                                                                          | RS-T09                                                      |
|                   | 退出请求关联                                                   | 无                                                                                    | C           | 子窗口持有 `core:event:allow-emit-to`，可伪造 `app-exit-requested`；`confirm_app_exit` 不校验       | RS-T58                                                      |
| R6 平台差异       | Windows ACL、替换、重命名                                      | file_cas 4 项（W）                                                                    | A           | 真实 SMB 共享                                                                                       | 实机 W-17                                                   |
|                   | Windows 保留名                                                 | `windows_rejects_ads_reserved_names_and_trailing_dots`                                | A           | COM0、LPT0（S1D-N13）                                                                               | RS-T39                                                      |
|                   | Windows Job 进程树                                             | 3 项（W）                                                                             | A           | 孙进程（B1-F08）                                                                                    | RS-T27                                                      |
|                   | `where.exe`                                                    | 无                                                                                    | C           | 同步阻塞                                                                                            | RS-T22                                                      |
|                   | Unix 权限、FIFO、文件名、进程组                                | 23 项（U、M）                                                                         | A           | —                                                                                                   | —                                                           |
|                   | Linux 非 UTF-8                                                 | 2 项（只在 U）                                                                        | A           | —                                                                                                   | —                                                           |
|                   | macOS 拒绝非 UTF-8                                             | 无                                                                                    | C           | —                                                                                                   | RS-T41                                                      |
|                   | macOS 菜单与 Cmd+Q                                             | 无                                                                                    | C           | P0                                                                                                  | RS-T05、T06，实机 M-08                                      |
|                   | Linux CAS 竞态                                                 | 跨进程测试（间歇失败）                                                                | A（不稳定） | 根因见第 2 节                                                                                       | RS-T01~T04                                                  |
| R8 并发           | 写队列顺序与背压                                               | `queued_pty_input_*`、`full_pty_input_queue_*`                                        | B           | 真实容量常量、断开通道                                                                              | RS-T19                                                      |
|                   | CAS 并发                                                       | `concurrent_text_file_saves_with_same_revision_have_one_winner`、跨进程测试           | A           | 外部原子替换压力                                                                                    | RS-T03                                                      |
|                   | 协调器超时                                                     | 辅助函数                                                                              | B           | —                                                                                                   | RS-T22、RS-T23                                              |
|                   | async 与 blocking                                              | 无                                                                                    | C           | 执行器饥饿                                                                                          | RS-T22、T23 的 ticker 断言                                  |
|                   | 恢复与刷新并发                                                 | 无                                                                                    | C           | —                                                                                                   | RS-T47                                                      |
| R9 迁移           | 数据库 0001..0014                                              | db::connection 18 项                                                                  | A           | 升级路径上的外键负向测试                                                                            | RS-T26                                                      |
|                   | 布局 v1..v5 读取迁移                                           | `migrates_*` 4 项                                                                     | A           | 旧版本命名布局的 apply                                                                              | RS-T48                                                      |
|                   | 布局 schema 单一版本源（读迁移与写回）                         | 无                                                                                    | C           | v1~v4 行读取迁移到 v5 后保存永远 saved=false（N16）                                                 | RS-T56                                                      |
|                   | 旧备份恢复、0.2.4 schema 8                                     | `restoring_a_024_schema_eight_backup_*`、`failed_old_backup_migration_*`              | A           | —                                                                                                   | —                                                           |

### 4. 可测性 seam 清单

每项都要求行为不变，只做抽取或注入。标注“需产品确认”的项会改变对外 DTO 或行为。SEAM-01~SEAM-20 编号与初稿一致；SEAM-21~SEAM-23 为随 RS-T56~RS-T58 追加的 seam；SEAM-24~SEAM-27 为随产品决策（PD-12、PD-13、PD-10）追加的 seam。

#### SEAM-01 退出请求与主窗关闭的决策函数

- **文件：** `src-tauri/src/services/app_lifecycle.rs`
- **签名：**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitRequestDecision {
    AllowExit,
    PreventAndAskMain { pty_count: usize },
    PreventWithoutMain,
}
pub fn decide_exit_request(
    gate: &AppExitGate,
    active_pty_count: usize,
    main_window_present: bool,
) -> ExitRequestDecision;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainCloseDecision {
    NotMainWindow,
    HideToTray,
    RequestAppExit,
}
pub fn decide_close_request(
    window_label: &str,
    close_behavior: CloseBehavior,
) -> MainCloseDecision;
```

- **理由：** `lib.rs` 306-378 的闭包依赖 AppHandle，无法测试。改造后 `handle_run_event` 只负责 `match decision { AllowExit => {}, PreventAndAskMain{pty_count} => { api.prevent_exit(); show_main_window; emit_to("main","app-exit-requested",{ptyCount}) }, PreventWithoutMain => api.prevent_exit() }`。SEAM-23 会给 `PreventAndAskMain` 追加 `execution_task_count` 与 `request_id`。
- **关联审查编号：** B2-F01、S1C-N01

#### SEAM-02 窗口销毁清理函数

- **文件：** `src-tauri/src/services/app_lifecycle.rs`
- **签名：**

```rust
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DestroyedWindowCleanup {
    pub file_grant_revoked: bool,
    pub owner_lost_session_ids: Vec<String>,
}
pub fn cleanup_destroyed_window(
    label: &str,
    grants: &ContentWindowGrantRegistry,
    sessions: &PtySessionManager,
) -> Result<DestroyedWindowCleanup, String>;
```

- **理由：** `on_window_event` 收到 Destroyed 时调用它，再对每个 id `emit_to("main","pty-session-owner-lost",…)`，覆盖文件窗销毁撤销授权与终端窗销毁回收会话。
- **关联审查编号：** S1B-N06、B3R-F05

#### SEAM-03 自定义应用菜单与 Quit 路由

- **文件：** 新建 `src-tauri/src/app_menu.rs`，并在 `lib.rs` 加 `mod app_menu;`
- **签名：**

```rust
pub const APP_QUIT_MENU_ID: &str = "app.quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMenuCommand { RequestExit, Unhandled }
pub fn route_app_menu_event(menu_id: &str) -> AppMenuCommand;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppMenuEntry {
    Predefined(&'static str),
    Custom { id: &'static str, accelerator: &'static str },
    Separator,
}
pub fn macos_app_submenu_entries() -> Vec<AppMenuEntry>; // 纯数据，三平台都能编译
pub fn macos_edit_submenu_entries() -> Vec<AppMenuEntry>;

#[cfg(target_os = "macos")]
pub fn build_macos_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>>;

// 保存窗口状态后 app.exit(0)；托盘 quit 也改为调用它
pub fn request_app_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>);
```

- **理由：** 修复 Cmd+Q 绕过退出门：tao 0.35.3 的 macOS 委托只实现 `applicationWillTerminate`，默认菜单的 Quit 项不会产生可阻止的 `ExitRequested`。用自定义 Quit 项（`CmdOrCtrl+Q`）替换 `PredefinedMenuItem::quit`，经 `app.exit(0)` 产生可阻止的 `ExitRequested`。保留默认菜单的 Edit、Window、View 子菜单，否则 WebView 的复制粘贴快捷键会失效。
- **关联审查编号：** S1C-N01

#### SEAM-04 PTY 测试会话构造与通道替身

- **文件：** `src-tauri/src/services/pty_session_service.rs`
- **签名：**

```rust
// 生产代码：create_inner 改为调用它
fn pty_input_channel() -> (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) {
    mpsc::sync_channel(PTY_INPUT_QUEUE_CAPACITY)
}

// 测试代码
#[cfg(test)]
pub(crate) struct TestSession {
    pub session: Arc<ManagedSession>,
    pub input: Receiver<Vec<u8>>,
    pub kills: Arc<AtomicUsize>,
}
#[cfg(test)]
impl PtySessionManager {
    pub(crate) fn insert_test_session(
        &self,
        owner_label: &str,
        channel: Option<Channel<PtyEvent>>,
    ) -> TestSession;
}
#[cfg(test)]
struct FakeKiller(Arc<AtomicUsize>); // 实现 ChildKiller：kill 计数后返回 Ok(())，clone_killer 复制计数
#[cfg(test)]
fn recording_channel() -> (Channel<PtyEvent>, Arc<Mutex<Vec<serde_json::Value>>>);
#[cfg(test)]
fn failing_channel() -> Channel<PtyEvent>;
```

- `recording_channel` 用 `Channel::new(move |body| { if let InvokeResponseBody::Json(s) = body { sink.lock().unwrap().push(serde_json::from_str(&s).unwrap()) } Ok(()) })`；`failing_channel` 的回调返回 `Err(tauri::Error::Anyhow(anyhow!("closed")))`。
- **理由：** `ManagedSession` 需要 `MasterPty`，测试用 `native_pty_system().openpty(PtySize{rows:24,cols:80,pixel_width:0,pixel_height:0})` 取 `pair.master`，丢弃 slave，不启动子进程。ConPTY 在 Windows CI 上已被现有测试证明可用。`Channel::new` 在 tauri 2.11.2 中是公开 API（已核实 `ipc/channel.rs:213`）。
- **关联审查编号：** B3R-F05、B3F-F04、S1C-N03、S1C-N05、S1C-N06

#### SEAM-05 窗口状态报告携带所有者标签（需产品确认）

- **文件：** `pty_session_service.rs`、`models/pty_session.rs`、`commands/pty_session.rs`
- **签名：**

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionWindowStatusReport {
    pub status: PtySessionWindowStatus,
    pub owner_window_label: Option<String>,
}
pub fn window_status_report(
    &self,
    session_id: &str,
    window_label: &str,
) -> Result<PtySessionWindowStatusReport, AppError>;
```

- 命令改为返回 Report，TS 同步修改。
- **关联审查编号：** S1C-N05

#### SEAM-06 任务监督函数

- **文件：** `src-tauri/src/services/execution_service.rs`
- **签名：**

```rust
pub(crate) async fn supervise_task<F, E>(task: F, on_abnormal_exit: E)
where
    F: Future<Output = ()> + Send + 'static,
    E: FnOnce(String) + Send,
{
    if let Err(error) = tokio::spawn(task).await {
        on_abnormal_exit(format!("执行任务异常退出：{error}"));
    }
}
```

- `run_task` 改为 `supervise_task(run_task_inner(..), |m| finish_failed(&task_app,&task_id,m)).await`。
- **关联审查编号：** B1-F12

#### SEAM-07 可执行文件解析器注入

- **文件：** `src-tauri/src/services/cli_adapters/mod.rs`
- **签名：**

```rust
pub trait ExecutableResolver: Send + Sync + 'static {
    fn resolve(&self, adapter: &'static dyn CliAdapter) -> Option<PathBuf>;
}
pub struct NativeExecutableResolver; // 内部调用 installed_path

pub async fn context_within_budget(
    adapter: &'static dyn CliAdapter,
    budget: Duration,
    home: PathBuf,
    resolver: Arc<dyn ExecutableResolver>,
) -> (AdapterContext, Duration);
```

- 实现为 `tokio::time::timeout(budget, spawn_blocking(..))`，超时或 panic 时 `resolved_path=None`，第二个返回值是剩余预算（饱和减法）。
- **理由：** `where.exe` 解析必须计入预算，且不阻塞 async 线程。
- **关联审查编号：** S1C-N02、B1-F07

#### SEAM-08 会话服务的可注入入口

- **文件：** `src-tauri/src/services/session_service.rs`
- **签名：**

```rust
pub(crate) async fn list_sessions_with(
    adapter: &'static dyn CliAdapter,
    directory_path: String,
    cursor: Option<String>,
    limit: usize,
    resolver: Arc<dyn ExecutableResolver>,
    home: PathBuf,
    budget: Duration,
) -> Result<SessionPage>;

pub(crate) async fn refresh_search_index_with(
    directory_path: &str,
    adapters: Vec<&'static dyn CliAdapter>,
    resolver: Arc<dyn ExecutableResolver>,
    home: PathBuf,
    budget: Duration,
) -> Vec<SessionSearchIndexSource>;

pub(crate) async fn session_belongs_to_directory_with(
    adapter: &'static dyn CliAdapter,
    directory_path: String,
    session_id: String,
    budget: Duration,
) -> Result<bool>;
```

- 生产入口传 `cli_adapters::all()`、`NativeExecutableResolver`、`home_dir()?`、现有常量。
- **理由：** B1-F07、S1C-N02，以及本专项新发现 N15：归属校验没有超时。
- **关联审查编号：** B1-F07、S1C-N02、N15

#### SEAM-09 备份恢复的运行态失效编排（需产品确认 DTO）

- **文件：** `src-tauri/src/services/backup_service.rs`、`commands/backup.rs`
- **签名：**

```rust
pub trait RestoreNotifier {
    fn workspace_data_restored(&self) -> Result<(), String>;
}
pub struct RestoreOutcome {
    pub manifest: BackupManifest,
    pub close_behavior: CloseBehavior,
    pub cache_warning: Option<String>,
}
pub fn restore_with_runtime_invalidation(
    db: &Db,
    cache: &CacheDb,
    sessions: &PtySessionManager,
    paths: &StoragePaths,
    backup_id: &str,
    notifier: &dyn RestoreNotifier,
) -> Result<RestoreOutcome, AppError>;
```

- **不变量：** 数据库恢复成功后**必须**通知前端并返回 close_behavior；按前缀清理缓存失败时降级为 `cache_service::clear` 全量清空，仍失败则写入 `cache_warning`。
- **关联审查编号：** S1D-N05、J1

#### SEAM-10 契约测试解析器（仅测试编译）

- **文件：** `src-tauri/src/contracts.rs`
- **签名：**

```rust
fn parse_handler_commands(source: &str) -> Result<Vec<String>, String>;
fn capability_contract_violations(
    kind: &Value,
    capability: &Value,
    app_commands: &[String],
) -> Vec<String>;
fn parse_csp(policy: &str) -> Result<BTreeMap<String, BTreeSet<String>>, String>;
```

- **关联审查编号：** S1D-N07、S1B-N02、S1B-N07

#### SEAM-11 错误码注册表与契约

- **文件：** 新建 `src-tauri/src/error_codes.rs`、`contracts/error-codes.json`
- **签名：** `pub const FILE_NOT_FOUND: &str = "file.not_found";` 等（覆盖现有 9 个产出码：`backup_restore_in_progress`、`directory.in_use`、`file.not_found`、`plan_changed`、`project_identity_changed`、`pty_input_backpressure`、`pty_input_unavailable`、`pty_session_starting`、`pty_sessions_active`）；`pub const ALL: &[&str]`。JSON 结构：`{"version":1,"codes":[{"code":"…","producedBy":"rust"|"reserved"}]}`。
- **关联审查编号：** S1B-N03

#### SEAM-12 文件 CAS 的目的地解析与校验

- **文件：** `src-tauri/src/platform/file_cas.rs`
- **签名：**

```rust
// FileCasAdapter 新增默认方法
fn resolve_destination(&self, root: &Dir, relative: &Path) -> Result<PathBuf> {
    Ok(root.canonicalize(relative)?)
}

pub(crate) fn validate_resolved_destination(
    root: &Dir,
    requested: &Path,
    resolved: &Path,
) -> Result<bool>;
pub(crate) fn resolve_cas_destination(root: &Dir, relative: &Path) -> Result<PathBuf>; // 内部最多重试 MAX_IDENTITY_RETRIES 次
```

- 协调器改为 adapter 解析加校验；Unix 上 `lock_current` 遇 NotFound 立即返回，由外层重新解析。
- **理由：** 第 2 节根因。
- **关联审查编号：** N1（本专项新发现，Ubuntu CI run 37437040753 与 37431150994）

#### SEAM-13 Windows 文件名规则的跨平台入口

- **文件：** `src-tauri/src/platform/path_rules.rs`
- **签名：** 新增不带 cfg 的 `pub(crate) fn windows_component_violation(component: &str) -> Option<&'static str>`，`validate_windows_component` 改为调用它。
- **理由：** 让 Windows 文件名规则在三平台都能测试。
- **关联审查编号：** S1D-N13

#### SEAM-14 启动载荷解析器注入

- **文件：** `src-tauri/src/services/launch_service.rs`
- **签名：**

```rust
pub(crate) async fn resolve_payload_with_resolver<F, Fut>(
    directory: String,
    tool_key: ToolKey,
    resume_session_id: Option<&str>,
    resolve: F,
) -> Result<CliLaunchPayload>
where
    F: FnOnce(&'static dyn CliAdapter) -> Fut,
    Fut: Future<Output = Option<PathBuf>>;
```

- 先校验 `resume_args`（快速失败）再解析可执行文件；删除 `#[cfg(test)] resolve_payload_with` 副本。
- **关联审查编号：** B1-F04

#### SEAM-15 窗口 label 共用测试向量

- **文件：** 新建 `contracts/window-label-fixtures.json`
- **结构：** `{"accept":{"main":[…],"terminal":[…],"workspaceContent":[…]},"reject":[…]}`
- **理由：** Rust 与 TS 共用的测试向量。
- **关联审查编号：** X-F04（命令注册与窗口 label 多份来源）

#### SEAM-16 安装与更新计划的纯函数入口

- **文件：** `services/cli_adapters/{claude,antigravity,codex}/platform.rs`
- **签名：** `pub(crate) fn update_plan_for(resolved: &Path) -> Result<InstallPlan>`（Codex Windows 已有 `codex_update_plan_for`，参照它）；Claude Windows 安装计划若依赖 winget 探测，抽成 `install_plan_for(winget: &Path)`。
- **理由：** 去掉 `if let Ok` 弱测试。
- **关联审查编号：** 本专项新发现 N3

#### SEAM-17 CAS 打开失败时携带路径的诊断

- **文件：** `src-tauri/src/platform/file_cas.rs`
- **改动：** `lock_current` 的 context 改为 `format!("无法打开待保存文件：{}", path.display())`。
- **理由：** 诊断。
- **关联审查编号：** N1

#### SEAM-18 验收构建专用的强制销毁钩子（PD-14 已采纳）

- **文件：** `src-tauri/Cargo.toml` 的 `[features] acceptance-hooks = []`，`lib.rs`
- **改动：** `#[cfg(feature="acceptance-hooks")]` 时托盘增加“验收：强制销毁全部独立窗口”，对所有 `is_detached_window_label` 的窗口调用 `WebviewWindow::destroy()`。菜单项 id 固定为 `acceptance.force_destroy_windows`（RS-T63 与 CI-10 用它识别）；`Cargo.toml` 中 `[features] acceptance-hooks = []`，不加入 `default`；验收构建命令为 `pnpm tauri build --features acceptance-hooks`（Tauri CLI 的 `--features` 选项，执行前以 `pnpm tauri build --help` 核对，待核实），产物文件名带 `acceptance` 标识，禁止进入 GitHub Release。
- **理由：** B3R-F05 实机强制销毁的唯一确定性手段（`destroy` 跳过 CloseRequested 与 JS 拦截，直接触发 Destroyed）。
- **关联审查编号：** B3R-F05

#### SEAM-19 退出授权的时钟注入

- **文件：** `src-tauri/src/services/app_lifecycle.rs`
- **签名：** `pub fn authorize_at(&self, now: Instant)`；`pub fn consume_authorization_at(&self, now: Instant) -> bool`（授权 5 秒后失效）；无参版本调用 `Instant::now()`。
- **理由：** RS-T46。
- **关联审查编号：** B2-F01（残留风险）

#### SEAM-20 恢复代次（索引刷新与恢复的竞态）

- **文件：** `src-tauri/src/services/session_service.rs` 和 restore 编排
- **改动：** 托管状态 `pub struct RestoreGeneration(AtomicU64)`；restore 成功后递增；索引刷新开始时记录 generation，写缓存前如果已变化就丢弃结果。
- **关联审查编号：** J1、N7

#### SEAM-21 布局保存的结果类型（随 RS-T56 追加，需产品确认 DTO）

- **文件：** `src-tauri/src/db/workspace_layout_repo.rs`、`services/workspace_layout_service.rs`、`models/workspace_layout.rs`、`commands/workspace_layout.rs`
- **签名：**

```rust
// repo 层
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveCurrentOutcome {
    Saved { revision: i64 },
    Stale { current_revision: i64 },
    Incompatible { stored_schema_version: i64 },
}
pub fn save_current(
    connection: &mut Connection,
    schema_version: i64,
    revision: i64,
    payload_json: &str,
    updated_at_ms: i64,
) -> rusqlite::Result<SaveCurrentOutcome>;

// DTO（camelCase）
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutSaveResult {
    pub saved: bool,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<WorkspaceLayoutSaveRejection>, // "stale" | "incompatible"
}
```

- **行为：** 仓库层 CAS 只比较 revision（`where id = 1 and revision < ?2`），成功时把 `schema_version` 列和 payload 一并改为当前版本 5；`Incompatible` 仅在存储列值大于当前支持版本（或其他无法由本进程迁移的值）时返回。前端对 `incompatible` 必须停止重试并转入恢复流程，对 `stale` 才按新 revision 重试。
- **理由：** 0.3.0 升级用户的 `workspace_state` 行 `schema_version` 为 1，`read_current` 在内存迁移到 v5，`save_current` 却因列值不等于 5 返回 `saved=false`，前端保存队列无限重试（N16）。
- **关联审查编号：** N16；与 R9 迁移矩阵相关

#### SEAM-22 serde 字段名 lint 与 golden fixture 模块（随 RS-T57 追加）

- **文件：** 新建 `src-tauri/src/contracts/serde_lint.rs`（`#[cfg(test)]`，如 `contracts.rs` 仍是单文件则改成 `contracts/mod.rs` 目录结构）；新建 `src-tauri/src/contracts/fixtures.rs`；新建目录 `contracts/fixtures/`
- **签名：**

```rust
#[cfg(test)]
pub(crate) struct SerdeLintViolation {
    pub file: String,
    pub item: String,
    pub detail: String,
}
#[cfg(test)]
pub(crate) fn scan_serialize_items(source: &str, file: &str) -> Vec<SerdeLintViolation>;
#[cfg(test)]
pub(crate) fn assert_camel_case_keys(value: &serde_json::Value, path: &str, allow: &[&str]);
#[cfg(test)]
pub(crate) fn golden_fixture(name: &str, cases: Vec<(&str, serde_json::Value)>) -> serde_json::Value;
```

- **理由：** 让“序列化字段名不符合前端约定”在 Rust 测试阶段暴露，并产出前端可导入的 golden fixture。
- **关联审查编号：** N17

#### SEAM-23 退出请求协调器（随 RS-T58 追加）

- **文件：** `src-tauri/src/services/app_lifecycle.rs`、`commands/pty_session.rs`（`confirm_app_exit`）、`services/execution_service.rs`（新增 `active_count`）、`lib.rs`
- **签名：**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitRequest {
    pub id: String, // Uuid v4
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitConfirmError { NoPendingRequest, RequestMismatch }

#[derive(Default)]
pub struct AppExitGate { /* authorized + pending_request: Mutex<Option<String>> */ }
impl AppExitGate {
    pub fn begin_request(&self) -> ExitRequest;            // 覆盖旧待决请求，最新者生效
    pub fn confirm(&self, request_id: &str) -> Result<(), ExitConfirmError>; // 校验成功才置 authorized 并清除待决
    pub fn pending_request_id(&self) -> Option<String>;
}

pub(crate) fn confirm_exit_with<T>(
    gate: &AppExitGate,
    request_id: &str,
    terminate: impl FnOnce() -> Result<T, AppError>,
) -> Result<(), AppError>; // 先校验 id，再 terminate，再 authorize

pub(crate) fn exit_requested_payload(
    request: &ExitRequest,
    pty_count: usize,
    execution_task_count: usize,
) -> serde_json::Value; // {"requestId","ptyCount","executionTaskCount"}

// ExecutionTaskManager
pub fn active_count(&self) -> usize;
```

- `ExitRequestDecision::PreventAndAskMain` 增加 `execution_task_count: usize`；`handle_run_event` 在该分支调用 `begin_request()` 并用 `exit_requested_payload` 发事件。`confirm_app_exit` 增加 `request_id: String` 参数；`contracts/app-commands.json` 与前端调用同步。
- **理由：** `confirm_app_exit` 目前无条件终止全部 PTY 并退出；子窗口持有 `core:event:allow-emit-to`，可向主窗口伪造 `app-exit-requested`。
- **关联审查编号：** N18；B2-F01、B3F-F08（跨窗协议实际是广播）

#### SEAM-24 退出事件的尽力清理（PD-12，随 RS-T60 追加）

- **文件：** 新增 `src-tauri/src/services/exit_cleanup.rs`；`lib.rs` 的 `handle_run_event` 增加 `RunEvent::Exit` 分支
- **签名：**

```rust
pub trait ExitCleanupTarget: Send + Sync {
    fn name(&self) -> &'static str;
    fn terminate_all(&self, budget: Duration) -> Result<usize, AppError>;
}
pub struct ExitCleanupReport {
    pub terminated: Vec<(&'static str, usize)>,
    pub failed: Vec<(&'static str, String)>,
    pub timed_out: bool,
}
pub fn run_exit_cleanup(targets: &[&dyn ExitCleanupTarget], total_budget: Duration) -> ExitCleanupReport; // 幂等；单个目标失败或超时不影响其余目标
pub fn on_run_event_exit(paths: &StoragePaths, targets: &[&dyn ExitCleanupTarget], budget: Duration);    // 先清理，后 end_session_cleanly；超时与 panic 也要清除标记
```

- **实现者：** `PtySessionManager`（复用 `terminate_all`）与 `ExecutionTaskManager`（取消全部活动任务并复用 `execution_task_repo::mark_unfinished_interrupted(&connection, now_ms)` 把状态标为 `interrupted`，释放槽位）。
- **理由：** PD-12 的兜底之二：系统级退出入口绕过退出门时，仍保证无孤儿进程且数据库状态一致；目前 `lib.rs` 没有处理 `RunEvent::Exit`。
- **关联审查编号：** S1C-N01、T2-N06、S3I-A05

#### SEAM-25 托盘降级（PD-13，随 RS-T61 追加）

- **文件：** `src-tauri/src/services/app_lifecycle.rs`；`lib.rs` 的 `setup_tray` 调用处（现为 `setup_tray(app.handle())?`）
- **签名：**

```rust
pub enum TrayAvailability { Available, Unavailable { reason: String } }
pub fn setup_tray_or_degrade(create: impl FnOnce() -> tauri::Result<()>) -> TrayAvailability; // 失败只记 warn 日志，不向上传播
pub fn effective_close_behavior(stored: CloseBehavior, tray: &TrayAvailability) -> CloseBehavior; // 托盘不可用则为 Quit；不修改 stored
pub fn decide_close_request(window_label: &str, stored: CloseBehavior, tray: &TrayAvailability) -> MainCloseDecision; // 在 SEAM-01 的签名上增加 tray 参数
```

- **理由：** 默认关闭行为是“最小化到托盘”，无托盘宿主时窗口隐藏后无法找回；降级保证应用始终可退出。托盘状态作为托管状态保存，不写入数据库。
- **关联审查编号：** S3H-A15

#### SEAM-26 干净退出标记模块（PD-12，随 RS-T59 追加）

- **文件：** 新增 `src-tauri/src/services/clean_exit_marker.rs` 与 `services/startup_notices.rs`；`lib.rs` 的 `setup` 与 `RunEvent::Exit` 分支；新命令 `take_startup_notices`（登记到 `contracts/app-commands.json`，只授予 main）
- **签名：** 见 RS-T59（`MARKER_FILE_NAME`、`PreviousExit`、`begin_session`、`end_session_cleanly`；`StartupNotices` 托管状态与 `take_startup_notices`）。
- **理由：** PD-12 的兜底之一：用下次启动的提示缓解系统级退出入口的未保存编辑丢失；标记只含时间戳与 pid，不保存文件正文。
- **关联审查编号：** S1C-N01、T2-N06

#### SEAM-27 大小写敏感探测 trait 与路径身份键（PD-10，设计已评审通过，调研结论确认前不实现）

- **文件：** 新增 `src-tauri/src/platform/case_sensitivity.rs` 与 `platform/path_key.rs`；`services/project_directory.rs` 的 `open_for`；托管状态 `CaseSensitivityCache`
- **签名（设计见主报告 4.7.2.2，细节待平台调研）：**

```rust
pub struct PathSemantics { pub case: CaseSensitivity, pub normalization_insensitive: Tri }
pub trait CaseSensitivityProbe: Send + Sync { fn probe(&self, root: &cap_std::fs::Dir) -> PathSemantics; }
pub struct NativeCaseSensitivityProbe;                                   // 分平台实现探测链
#[cfg(test)] pub struct FixedCaseSensitivityProbe(pub PathSemantics);    // 测试用假实现
pub struct ProbeSteps { /* platform_api、existing_entry_flip、temp_file 三个可替换步骤 */ }
pub fn probe_with_steps(root: &cap_std::fs::Dir, steps: &ProbeSteps) -> PathSemantics; // RS-T62 测试三的接缝
pub struct PathKey(String);
impl PathKey { pub fn of(relative: &str, semantics: &PathSemantics) -> PathKey; }
```

- **理由：** 把“按平台判断大小写”收敛为一个可注入的探测钩子加一个 flag，并让 Rust 的布局去重、文件服务去重与前端文档身份键都只经过 `PathKey`（P-1 的落地）。
- **注意：** 探测链各步所用的平台 API、标志位与文件系统类型表均待调研核实（主报告 4.7.2.3 与 4.7.2.12），**不得在调研完成前写死**。
- **关联审查编号：** S3I-A14；PD-10

### 5. 测试补充规格（按优先级）

通用约定：

- 测试命名沿用现有的 `snake_case` 描述句。
- 临时目录统一用 `tempfile::tempdir()`。
- 时间相关断言给出至少 2 倍余量。
- “预期当前结果”说明在缺陷修复前跑这条测试会怎样。标为“揭示缺陷”的测试，先以“保持现行为”的方式引入 seam，确认它失败，再修复使其通过。
- RS-T56~RS-T58 是初稿完成后追加的条目，分别放在各自优先级的末尾。

#### P0

##### RS-T01（P0）CAS 解析到 `(deleted)` 别名时必须重新解析，不能报错

- **对应：** Ubuntu CI 失败、R8、R6 Linux
- **关联审查编号：** N1（本专项新发现）
- **位置：** `src-tauri/src/platform/file_cas.rs` → `tests::cas_retries_when_resolved_destination_is_a_deleted_alias`，三平台（无 cfg）
- **前置：** SEAM-12。在 tempdir 写 `note.txt`，内容 `"before"`。定义 `DeletedAliasOnceAdapter { native: NativeFileCasAdapter, resolutions: AtomicUsize }`：`resolve_destination` 第 1 次返回 `PathBuf::from("note.txt (deleted)")`，之后委托 native；其他方法全部委托 native。
- **步骤：** 记录 `Instant`，调用 `compare_and_swap_with_adapter(&adapter, &dir, Path::new("note.txt"), b"after", &revision(b"before"), 1024, revision)`。
- **断言：**
  - 返回 `Ok(CompareAndSwapOutcome::Written)`；
  - `resolutions == 2`；
  - `note.txt` 的内容为 `"after"`；
  - `read_dir` 中没有以 `.writing` 结尾的残留，也没有 `note.txt (deleted)`；
  - 耗时小于 1 秒（反向断言：不能走 2 秒锁超时）。
  - **诱饵子用例** `cas_never_targets_a_real_file_named_like_a_deleted_alias`：tempdir 里另建 `note.txt (deleted)`，内容 `"decoy"`，adapter 同样首次返回该别名。结果仍写入 `note.txt`，诱饵内容保持 `"decoy"`。
- **预期当前：** seam 以“默认实现等于现行 canonicalize、协调器不校验”的方式引入后，本测试失败（约 2 秒后报“无法打开待保存文件”），揭示缺陷。按修复方向 A 实现后通过。
- **稳定性：** 纯确定性，不需要重复运行。

##### RS-T02（P0）并发替换下解析结果绝不是 `(deleted)` 别名

- **对应：** 同 RS-T01
- **关联审查编号：** N1（本专项新发现）
- **位置：** `file_cas.rs` → `tests::resolve_cas_destination_never_returns_a_deleted_alias_under_concurrent_replacement`，`#[cfg(target_os = "linux")]`；另有刻画测试 `tests::cap_std_canonicalize_can_return_deleted_suffix_under_concurrent_replacement`，`#[cfg(target_os="linux")] #[ignore = "刻画上游 cap-primitives 竞态，仅在 flaky 探针中运行"]`
- **前置：** tempdir 中有 `note.txt`；用 `Arc<AtomicBool>` 作停止标志；替换线程循环执行：`fs::write(root/".r.tmp","x")` 然后 `fs::rename(root/".r.tmp", root/"note.txt")`，不 sleep。
- **步骤：** 主线程在 2 秒内（或最多 200,000 次）循环调用 `resolve_cas_destination(&dir, Path::new("note.txt"))`；结束后设置停止标志并 join 替换线程。
- **断言：**
  - 所有 `Ok(p)` 都满足 `p == Path::new("note.txt")`；
  - 不出现任何 `Err`（重试耗尽也算失败）；
  - 记录重试次数，用 `eprintln!` 打印供观察。
  - 刻画测试改为直接调用 `dir.canonicalize("note.txt")`，在 5 秒内至少观察到一次以 `" (deleted)"` 结尾的结果（`assert!(seen_deleted_suffix)`）。
- **预期当前：** 主测试在 seam 引入前无法编译，修复后通过。刻画测试大概率通过，这正是上游缺陷的证据；如果 5 秒内从未复现，说明 H1 的证据减弱，需在报告中注明。
- **稳定性：** 每次运行都要求 0 失败；主测试时间上限 2 秒，刻画测试 5 秒，都带迭代上限，不会挂起。

##### RS-T03（P0）外部紧密原子替换时 CAS 不出现“找不到文件”

- **对应：** Ubuntu CI 失败、R8
- **关联审查编号：** N1（本专项新发现）
- **位置：** `file_cas.rs` → `tests::cas_survives_tight_external_atomic_replacement_loop`，`#[cfg(unix)]`
- **前置：** `note.txt` 内容为 `"same"`。替换线程循环：写 `.r.tmp`（内容 `"same"`）、rename 覆盖 `note.txt`、`thread::sleep(1ms)`。
- **步骤：** 主线程循环 300 次，调用 `compare_and_swap_in_directory(&dir, Path::new("note.txt"), b"same", &revision(b"same"), 1024, revision)`。
- **断言：**
  - 每次结果是 `Ok(Written)`，或错误文本包含“持续变化”（允许重试耗尽）；
  - 任何错误文本都**不得**包含“无法打开待保存文件”；
  - 结束后目录中没有 `.writing` 残留（替换线程自己的 `.r.tmp` 除外）；
  - 总耗时小于 20 秒。
- **预期当前：** Linux 上大概率失败，揭示缺陷；macOS 应通过。修复后两者都通过。
- **稳定性：** 由 CI-05 探针连续 20 次 0 失败才认可。

##### RS-T04（P0）加固跨进程 CAS 测试

- **对应：** Ubuntu CI 失败、R8
- **关联审查编号：** N1（本专项新发现）
- **位置：** 修改 `file_cas.rs` 中现有的 `tests::separate_processes_using_same_revision_allow_only_one_winner` 和 `tests::cross_process_cas_worker`
- **前置：** SEAM-17。
- **改造步骤：**
  1. worker 不再 `unwrap`：`Ok(o)` 时写入 `format!("{o:?}")`，`Err(e)` 时写入 `format!("Error: {e:#}")`。
  2. 父进程读取环境变量 `CLI_LAUNCHPAD_CAS_ROUNDS`（默认 1），每轮使用新的 tempdir。
  3. 父进程等待 worker 最多 30 秒，超时则 `kill` 两个子进程并 panic，信息包含两个子进程的输出。
  4. 失败信息中包含两个结果文件的原文（以便看到 `note.txt (deleted)`）。
- **断言（每轮）：** 恰好一个 `"Written"`、一个 `"Conflict"`；`note.txt` 的内容属于 `{"process-a","process-b"}`；没有 `.writing` 残留。
- **预期当前：** Ubuntu 约 40% 概率失败，失败信息应显示 `(deleted)`；修复后 50 轮 × 3 次运行都通过。
- **稳定性：** 常规 CI 跑 1 轮；探针跑 50 轮。

##### RS-T05（P0）自定义 Quit 菜单项必须走退出门

- **对应：** S1C-N01、R2 应用退出、R6 macOS
- **关联审查编号：** S1C-N01
- **位置：** `src-tauri/src/app_menu.rs` → `tests::custom_quit_menu_item_requests_gated_exit`，三平台
- **前置：** SEAM-03。
- **步骤与断言：**
  - `route_app_menu_event(APP_QUIT_MENU_ID) == AppMenuCommand::RequestExit`；
  - `route_app_menu_event("quit")`、`route_app_menu_event("show")`、`route_app_menu_event("")`、`route_app_menu_event("APP.QUIT")` 都返回 `Unhandled`（反向断言：大小写敏感，不吞掉托盘自己的 id）；
  - 对 `lib.rs` 源码（`include_str!("lib.rs")`）做静态断言：包含 `.on_menu_event(` 并调用 `app_menu::route_app_menu_event`；包含 `#[cfg(target_os = "macos")]` 分支调用 `app_menu::build_macos_menu`；不包含 `PredefinedMenuItem::quit`。
- **预期当前：** 模块不存在，编译失败；实现后通过。
- **稳定性：** 确定性。

##### RS-T06（P0）macOS 应用菜单规格不含系统 Quit

- **对应：** S1C-N01、R6 macOS
- **关联审查编号：** S1C-N01
- **位置：** `app_menu.rs` → `tests::macos_app_menu_entries_replace_predefined_quit`，三平台（纯数据）
- **断言：**
  - `macos_app_submenu_entries()` 中不存在 `AppMenuEntry::Predefined("quit")`；
  - 恰好有一个 `Custom { id: APP_QUIT_MENU_ID, accelerator: "CmdOrCtrl+Q" }`，并且是最后一项；
  - 包含 `Predefined("hide")`、`Predefined("hide_others")`、`Predefined("show_all")`、`Predefined("about")`；
  - 另一个函数 `macos_edit_submenu_entries()` 包含 `undo`、`redo`、`cut`、`copy`、`paste`、`select_all`（防止回归丢失编辑快捷键）。
- **预期当前：** 编译失败，实现后通过。
- **稳定性：** 确定性。补充一个 `#[cfg(target_os="macos")] build_macos_menu` 的运行期测试需要 MockRuntime（要开启 `tauri` 的 `test` feature），列为可选；实机 M-08 是最终证据。

##### RS-T07（P0）退出请求决策矩阵

- **对应：** B2-F01、`handle_run_event`、主窗缺失回退、PTY 计数
- **关联审查编号：** B2-F01；N5（主窗缺失时不检查文件窗脏状态）
- **位置：** `services/app_lifecycle.rs` → `tests::exit_request_decision_matrix`，三平台
- **前置：** SEAM-01。每行使用新的 `AppExitGate::default()`。
- **步骤与断言（逐行）：**

  | 已授权 | 活动 PTY 数 | 主窗存在 | 期望                                                                          |
  | ------ | ----------- | -------- | ----------------------------------------------------------------------------- |
  | 是     | 3           | 是       | `AllowExit`                                                                   |
  | 否     | 0           | 是       | `PreventAndAskMain{pty_count:0}`                                              |
  | 否     | 3           | 是       | `PreventAndAskMain{pty_count:3}`                                              |
  | 否     | 2           | 否       | `PreventWithoutMain`                                                          |
  | 否     | 0           | 否       | `AllowExit`（现行行为，在测试注释中标注“主窗缺失时不检查文件窗脏状态（N5）”） |
  - **一次性：** 授权后第 1 次调用返回 `AllowExit`，同一 gate 第 2 次调用（参数 3、是）返回 `PreventAndAskMain{3}`。
  - **PD-01 已确认（提示并显示数量，确认后终止任务）追加：** `decide_exit_request` 增加参数 `execution_task_count: usize`，`PreventAndAskMain` 携带 `execution_task_count`（与 RS-T58 测试五的载荷字段 `executionTaskCount` 对应）。追加行：
    - 否 / PTY 0 / 执行任务 2 / 主窗存在 → `PreventAndAskMain{pty_count:0, execution_task_count:2}`（只有执行任务时也必须弹出确认，不得走静默退出）；
    - 否 / PTY 1 / 执行任务 2 / 主窗存在 → `PreventAndAskMain{pty_count:1, execution_task_count:2}`；
    - 已授权 / PTY 0 / 执行任务 2 → `AllowExit`（授权后不再重复询问，终止由 `confirm_app_exit` 在授权前完成）；
    - 反向断言：任何一行都不得在决策函数内终止任务或 PTY（决策必须是纯函数）。

- **预期当前：** 抽取后应通过，作为补证据。SEAM-23 落地后，`PreventAndAskMain` 增加字段，本测试同步更新期望值。
- **稳定性：** 确定性。

##### RS-T08（P0）主窗关闭请求决策

- **对应：** B2-F01、R2 应用退出
- **关联审查编号：** B2-F01
- **位置：** `app_lifecycle.rs` → `tests::main_close_request_decisions`，三平台
- **断言：**
  - `("main", MinimizeToTray)` → `HideToTray`；
  - `("main", Quit)` → `RequestAppExit`；
  - `("terminal-8e783338-f464-4b10-b15e-b534748c6241", Quit)` → `NotMainWindow`；
  - `("workspace-content-8e783338-f464-4b10-b15e-b534748c6241", MinimizeToTray)` → `NotMainWindow`；
  - `("MAIN", Quit)` → `NotMainWindow`（大小写敏感）；
  - `("", Quit)` → `NotMainWindow`。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性。

##### RS-T09（P0）文件窗销毁只撤销它自己的授权

- **对应：** S1B-N06、R2 文件授权
- **关联审查编号：** S1B-N06
- **位置：** `app_lifecycle.rs` → `tests::destroyed_file_window_revokes_only_its_grant`，三平台
- **前置：** SEAM-02。`ContentWindowGrantRegistry::default()`，给标签 L1、L2（两个合法的 `workspace-content-<uuid>`）各授予一个文件；`PtySessionManager::default()`。
- **步骤与断言：**
  1. `cleanup_destroyed_window(L1, …)` 返回 `file_grant_revoked == true`、`owner_lost_session_ids` 为空；
  2. `registry.get(L1)` 返回 Err，`registry.get(L2)` 仍为 Ok；
  3. 再次对 L1 调用，`file_grant_revoked == false`（幂等）；
  4. 对 `"main"` 和 `"terminal-<uuid>"` 调用，L2 的授权不受影响；
  5. 撤销后 `registry.grant(L1, …)` 可以重新授予（窗口复用场景）。
- **预期当前：** 抽取后通过。
- **稳定性：** 确定性。

##### RS-T10（P0）终端窗销毁时返回失主会话列表

- **对应：** B3R-F05、R2 终端窗
- **关联审查编号：** B3R-F05
- **位置：** `app_lifecycle.rs` → `tests::destroyed_terminal_owner_window_returns_owner_lost_sessions`，三平台
- **前置：** SEAM-02、SEAM-04。T1、T2 是两个合法的 `terminal-<uuid>`。会话 S1 的所有者是 T1，S2 的所有者是 T2，S3 的所有者是 `"main"`，各带一个 `recording_channel()`。
- **步骤与断言：**
  1. `cleanup_destroyed_window(T1, …)` 返回 `owner_lost_session_ids == [S1.id]`、`file_grant_revoked == false`；
  2. S1 的路由 `window_label == "main"`、`owner_lost == true`、`channel.is_none()`；
  3. S2、S3 的路由不变；
  4. 对 `"main"` 调用返回空列表；
  5. 对非法标签 `"terminal-invalid"` 调用返回空列表，且不 panic。
- **预期当前：** 抽取后通过。
- **稳定性：** 确定性。

##### RS-T56（P0）布局 schema 单一版本源：v1~v4 持久化行读取迁移后必须能保存

- **对应：** R9 迁移、R3 失败语义；0.3.0 升级用户（`workspace_state` 行 `schema_version` 列为 1）
- **关联审查编号：** N16（本专项新发现，已由协调人核实）
- **位置：**
  - `src-tauri/src/services/workspace_layout_service.rs` → `tests::legacy_schema_rows_are_saved_after_in_memory_migration_to_current_version`
  - `src-tauri/src/db/workspace_layout_repo.rs`（该模块已有 2 项测试，新测试加入同一 `tests` 模块）→ `tests::save_current_distinguishes_stale_from_incompatible_schema`
  - 三平台（无 cfg）
- **前置：**
  - SEAM-21。内存库用 `Connection::open_in_memory()` 加 `PRAGMA foreign_keys=ON` 加 `connection::apply_migrations`（与 `models` 层现有迁移测试一致）。
  - 把 `models::workspace_layout::tests` 里 v1~v4 迁移夹具抽成 `pub(crate) fn legacy_payload_json(version: u32) -> String`（`#[cfg(test)]`），v1 即 `workspace_layout_migrates_legacy_pty_active_content` 使用的旧 PTY-only 载荷，v2、v3、v4 对应 `migrates_v2_mixed_content_and_preserves_active_file`、`migrates_v3_detached_slots_to_v5_content_refs`、`migrates_v4_and_preserves_unknown_content_payloads` 的输入，每份载荷内的 `schemaVersion` 必须等于该版本号（`source_layout_version(payload) == Some(column)` 是服务层前置检查）。
- **步骤与断言（服务层，对 `version in 1..=4` 各循环一次，每次新建库）：**
  1. 直接插入 `workspace_state(id=1, schema_version=version, revision=3, payload_json=legacy_payload_json(version), updated_at_ms=0)`；
  2. `read_current` 返回 `status == Ready`、`schema_version == Some(5)`、`revision == Some(3)`、`layout.is_some()`；
  3. `save_current(&mut conn, 4, &layout)` 返回 `saved == true`、`revision == 4`；
  4. 直接查询行：`schema_version == 5`、`revision == 4`，且 `payload_json` 解析后 `schemaVersion == 5`；
  5. 再次 `read_current` 的 layout 与保存前相等；
  6. 紧接着再 `save_current(&mut conn, 4, &layout)`（revision 相同）返回 `saved == false`、`reason == Some(Stale)`，行不变；
  7. **并发不变量：** 同一旧行上用两个线程（各自持有同一 `Db` 的锁串行，或两个独立连接指向同一临时文件库）同时保存 revision 4，恰好一个 `saved == true`。
- **步骤与断言（仓库层）：**
  1. 行 `(schema_version=1, revision=3)`，调用 `save_current(&mut conn, 5, 4, payload, 0)` 返回 `Saved{revision:4}`，列值变为 5；
  2. 行 `(5, 4)`，调用 `save_current(.., 5, 4, ..)` 与 `save_current(.., 5, 2, ..)` 都返回 `Stale{current_revision:4}`；
  3. 行 `(schema_version=99, revision=3)`，调用 `save_current(.., 5, 4, ..)` 返回 `Incompatible{stored_schema_version:99}`，且行保持不变（反向不变量：不覆盖未来版本数据）；
  4. 无行且 `revision <= 0` 返回 `Stale{current_revision:0}`，`revision >= 1` 返回 `Saved`；
  5. `Stale` 与 `Incompatible` 序列化到 DTO 后 `reason` 分别为 `"stale"`、`"incompatible"`，且 `saved:true` 时不出现 `reason` 键。
- **预期当前：** 服务层第 3 步失败（`saved == false`，列值仍为 1），揭示缺陷；仓库层第 3 步在当前实现里与 `Stale` 无法区分（同样返回 `(false, stored_revision)`），揭示缺陷。修复方向：仓库层 CAS 只比较 revision，同时写入列值 5；返回值区分 Stale 与 Incompatible。
- **稳定性：** 确定性；并发子用例使用文件库加两个连接，设置 `busy_timeout`，不依赖 sleep。
- **前端配合：** 前端保存队列对 `reason == "incompatible"` 不得再重试（FE 规格另行覆盖），Rust 侧只保证 DTO 与行为。
- **PD-16 已确认（payload 为唯一权威）：** 版本以布局 payload 内的 `schemaVersion` 为准，迁移只保留 Rust 一处实现，CAS 只比较 revision。上面的步骤按“列保留为只读镜像并随保存同步更新为 5”断言；若实现选择“删除数据库列”，则服务层第 4 步改为断言 `payload_json` 的 `schemaVersion == 5` 且 `workspace_state` 不再有 `schema_version` 列，仓库层第 3 步改为“payload 版本高于当前时返回 `Incompatible` 且行不变”，其余断言（revision 单调、`Stale` 与 `Incompatible` 区分、并发单胜者）不变。TS 侧的 v3 与 v4 迁移逻辑随之删除，只断言版本等于当前值（FE-T60、FE-SEAM-13 配套）。

##### RS-T57（P0）IPC DTO 序列化字段名：逐变体断言、源码扫描 lint 与 golden fixture

- **对应：** R1 契约；DTO serde 字段名
- **关联审查编号：** N17（本专项新发现，已由协调人核实）
- **事实：** `ProjectFileOpenResult::Image`（`services/file_service.rs:77`）与 `ManagedUpdateStatus::Denied`（`models/install.rs:72`）所在枚举只有 `rename_all = "camelCase"`，缺少 `rename_all_fields = "camelCase"`，实际序列化为 `mime_type`、`base64_data`、`reason_key`；前端读 `mimeType`、`base64Data`、`reasonKey`。
- **位置：**
  - `src-tauri/src/contracts.rs`（或 SEAM-22 的 `contracts/` 目录模块）→ `tests::ipc_dto_variants_serialize_with_camel_case_field_names`
  - 同位置 → `tests::serialize_items_with_multiword_fields_declare_camel_case_renaming`
  - 同位置 → `tests::golden_fixtures_match_serialized_dtos`
  - 三平台（无 cfg）
- **A. 逐变体序列化断言：**
  - 对下列每个 IPC DTO 的**每一个变体**构造样本值并 `serde_json::to_value`；样本必须让所有字段（含 `Option` 的 `Some` 与 `None` 两种）都出现：
    `ProjectFileOpenResult{Text,Image,Unsupported}`、`ProjectTextFileSaveResult{Saved(warning:Some/None),Conflict}`、`ProjectFileUnsupportedReason` 全部变体、`ProjectDirectoryListing` 及条目、`ManagedUpdateStatus{Allowed,Denied,NotApplicable}`、`PtyEvent{Output,Snapshot,Exited,Failed}`、`PtySession`、`PtyHandoff`、`PtySessionWindowStatus` 全部变体、`WorkspaceLayoutStateRead` 各 status、`WorkspaceLayoutSaveResult`、`WorkspaceLayoutApplyPlan`、`WorkspacePaneContentRef{Pty,File,Unknown}`、`ExecutionTask`、`ExecutionLogChunk`、`InstallPlan`、`LatestVersion`、`CliStatus`、`AppError`（含 params）、`BackupManifest`、`CacheStats`。
  - 通用断言函数 `assert_camel_case_keys(value, path, allow)`：递归遍历所有对象键，任何键含 `_` 或以大写字母开头即失败，失败信息给出 JSON 路径。允许列表只放确实透传的不透明载荷：`WorkspacePaneContentRef::Unknown` 的 `raw`（透传未知 kind 原始 JSON）。
  - 针对两个已知缺陷的显式键集：`Image` 序列化键集合必须等于 `{"kind","mimeType","base64Data"}`；`Denied` 必须等于 `{"status","reasonKey"}`；并断言它们**不含** `mime_type`、`base64_data`、`reason_key`。
  - 反序列化往返：每个样本 `serde_json::from_value` 后与原值相等（对实现了 `PartialEq` 的类型），保证前端回传同名键能被解析。
- **B. 源码扫描 lint：**
  - 对 `src-tauri/src/**/*.rs`（用 `read_dir` 递归，`include_str!` 不适合文件集合），去掉 `#[cfg(test)] mod tests { … }` 块，扫描所有带 `Serialize` derive 的 `enum` 与 `struct`：
    1. **enum 规则：** 枚举体含结构体变体（`Name { field: Type, … }`），且任一字段名含 `_`，则该枚举的 `#[serde(...)]` 属性中必须出现 `rename_all_fields = "camelCase"`；或该字段上方紧邻的属性含 `#[serde(rename = …)]`。不分是否带 `tag`：外部标签枚举同样适用，因为 `rename_all` 只改变体名。
    2. **struct 规则：** 含 `_` 字段名的 `struct` 必须声明 `rename_all = "camelCase"`，或字段逐个 `rename`。
    3. 例外清单放在 `contracts/serde-lint-allowlist.json`（非 IPC 持久化格式，如配置导入导出包），每项必须附 `reason`；允许列表里不得出现已被修复的条目（反向检查，防止列表腐烂）。
  - 解析实现：括号配对计数提取枚举/结构体体；字段名用 `^\s*(?:pub\s+)?([a-z][a-z0-9_]*)\s*:` 匹配；属性跨行拼接后再判断。实现放在 SEAM-22 的 `scan_serialize_items`。
  - 负向夹具（字符串）：
    - `#[derive(Serialize)] #[serde(tag="kind", rename_all="camelCase")] enum E { A { mime_type: String } }` 必须被报；
    - 同枚举加上 `rename_all_fields = "camelCase"` 不被报；
    - `enum E { A { mime_type: String } }` 无 `Serialize` 不被报；
    - `struct S { mime_type: String }` 被报，加 `rename_all` 后不被报；
    - 字段上有 `#[serde(rename = "mimeType")]` 不被报。
  - 首次运行前先让 lint 输出当前全部违规并交给人确认；预期至少包含 `ProjectFileOpenResult::Image` 与 `ManagedUpdateStatus::Denied`。
- **C. golden fixture 方案：**
  - 目录 `contracts/fixtures/`，文件格式统一为：`{"schema":1,"type":"ProjectFileOpenResult","cases":[{"name":"image","value":{…}}]}`。
  - 首批文件：`project-file-open-result.json`、`project-text-file-save-result.json`、`managed-update-status.json`、`pty-event.json`、`pty-session-window-status.json`、`workspace-layout-state-read.json`、`workspace-layout-apply-plan.json`、`workspace-layout-save-result.json`、`execution-task.json`、`install-plan.json`、`cli-status.json`、`app-error.json`、`exit-requested-payload.json`（RS-T58）。
  - Rust 测试 `golden_fixtures_match_serialized_dtos`：用 SEAM-22 的 `golden_fixture` 生成 JSON（键按 serde_json 默认的 `BTreeMap` 顺序，缩进 2 空格，结尾换行），与仓库文件逐字节比较；不一致则失败，并在失败信息中提示 `UPDATE_CONTRACT_FIXTURES=1 cargo test golden_fixtures` 重新生成。该环境变量只在本地使用，CI 中不设置；CI 增加一步 `git diff --exit-code -- contracts/fixtures` 防止测试在 CI 里悄悄改写文件。
  - 前端 vitest 导入同一批 JSON（`resolveJsonModule` 已被 `windowKinds.ts` 使用）：对每个 case 用现有的类型守卫或解析函数断言前端实际读取的键（`mimeType`、`base64Data`、`reasonKey` 等）存在且类型正确，并用 `satisfies` 把 fixture 的 `value` 约束到 `src/lib/tauri.ts` 的 TS 类型，使 `tsc` 在类型漂移时失败。
- **预期当前：** 断言 A 的 `Image` 与 `Denied` 子用例失败；lint B 报告至少这两处；golden fixture 在补上 `rename_all_fields` 之前生成的内容会固化错误键名，所以**顺序必须是先修 serde 属性，再生成 fixture**。
- **稳定性：** 确定性；lint 不依赖时间与平台，避免路径分隔符差异（统一把路径转成 `/` 再比较）。

#### P1

##### RS-T11（P1）`reclaim_window` 在 manager 层的完整行为

- **对应：** B3R-F05、R4
- **关联审查编号：** B3R-F05
- **位置：** `pty_session_service.rs` → `tests::reclaim_window_pauses_output_and_clears_pending_handoffs`，三平台
- **前置：** SEAM-04。
- **步骤与断言：**
  1. **失主路径：** S1 的所有者是 T1，先 `session.flow.reserve(10)`。调用 `manager.reclaim_window(T1)` 返回 `[S1]`；`flow.state.paused == true` 且 `pause_deadline.is_none()`（无限期暂停）。
  2. **交接目标窗被销毁：** S2 的所有者是 `"main"`。依次 `begin_handoff(S2,"main")`、`stage_handoff_snapshot(...)`、`complete_handoff(S2, T2, token, recording)`。调用 `reclaim_window(T2)` 返回 `[]`；`pending_handoff` 为 None；`!flow.is_paused_at(seq)`（已恢复）；S2 的路由仍属于 `"main"`。
  3. **镜像窗被销毁：** S3 的所有者是 T3，`mirror == Some(("main", ch))`。调用 `reclaim_window("main")` 返回 `[]`，镜像不变（main 不会被回收）；再以 S4（所有者 T4，镜像标签 T5）调用 `reclaim_window(T5)`，S4 的镜像变为 None，所有者不变。
  4. **无关标签：** 所有会话都不变。
- **预期当前：** 应通过（补证据）。
- **稳定性：** 确定性。

##### RS-T12（P1）reattach 只重放快照序号之后的缓冲事件

- **对应：** B3R-F05、R4 reattach
- **关联审查编号：** B3R-F05
- **位置：** `tests::reattach_replays_only_buffered_events_after_snapshot_sequence`
- **前置：** S1 的所有者是 T1（recording A）。调用 `flow.reserve(1)` 4 次得到序号 1..4，然后 `reclaim_window(T1)`。对 `session.send_event` 依次发送 Output 序号 2、3、4，以及 `Failed{message:"x"}`。
- **步骤：** `manager.reattach(S1, "main", recording B, PtyTerminalSnapshot{data:"screen",cols:80,rows:24}, 3, PtySizeUpdate{cols:80,rows:24,pixel_width:0,pixel_height:0})`。
- **断言：**
  - B 依次收到 `type=="snapshot"`（sequence 3）、`type=="output"`（sequence 4）、`type=="failed"`；
  - 序号 2、3 的输出**不**重放；
  - 路由的 `channel.is_some()`、`owner_lost == false`、`buffered_events` 为空、`buffered_bytes == 0`、`mirror` 为 None；
  - `flow.state.paused == false`；
  - 返回值 `PtySession.session_id == S1`。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性。

##### RS-T13（P1）重复 reattach 被拒，且不替换现有通道

- **对应：** S1C-N06
- **关联审查编号：** S1C-N06
- **位置：** `tests::repeated_reattach_is_rejected_without_replacing_the_live_channel`
- **前置：** 先按 RS-T12 完成一次 reattach（通道 B）。
- **步骤：** 用 recording C 再次调用 `reattach(S1,"main",C,…,4,…)`。
- **断言：**
  - 返回 Err，消息包含“不处于可重新接管状态”；
  - C 没有收到任何事件；
  - 之后通过 `send_event(Output 5)`，B 收到该事件，C 仍为空；
  - `flow.state.paused == false`。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性。

##### RS-T14（P1）reattach 的前置条件

- **对应：** B3R-F05、R4
- **关联审查编号：** B3R-F05、S1C-N06
- **位置：** `tests::reattach_requires_main_window_and_owner_lost_state`
- **断言：**
  1. 窗口为 T1 → Err“只有主窗口可以重新接管终端”；
  2. 会话未失主（所有者 T1、`owner_lost=false`），以 `"main"` reattach → Err；
  3. 快照尺寸为 0 列 → Err，且失主状态保持不变；
  4. 序号超过已预留的最大值（例如 99）→ Err（acknowledge 拒绝），并且 `owner_lost` 仍为 true、`buffered_events` 没有被清空（反向不变量）。
- **预期当前：** 第 4 条需要核实：`flow.acknowledge` 在发送快照之前执行，失败时路由不变，应通过；如果失败即揭示缺陷。
- **稳定性：** 确定性。

##### RS-T15（P1）交接完成后，源窗口取消被拒

- **对应：** B3F-F04（替换 1.4 节弱测试 #3）
- **关联审查编号：** B3F-F04
- **位置：** `tests::finalized_handoff_rejects_source_cancel_in_manager`
- **前置：** S1 的所有者是 `"main"`（recording A），先 `reserve(10)`。
- **步骤：** `begin_handoff(S1,"main")` → `stage_handoff_snapshot(S1,"main",token,seq,snap)` → `complete_handoff(S1,T1,token,B)` → `finalize_handoff(S1,T1,token,80×24)` → `cancel_handoff(S1,"main",token)`。
- **断言：**
  - finalize 返回 Ok；路由的 `window_label == T1`；`mirror` 的标签是 `"main"`（主窗变为镜像）；`pending_handoff` 为 None；`!flow.state.paused`；
  - 源窗口 cancel 返回 Err，消息包含“另一个窗口控制”；
  - `window_status(S1,"main") == OwnedByAnotherWindow`，`window_status(S1,T1) == Running`；
  - 新所有者 `cancel_handoff(S1,T1,token)` 返回 `Ok(())` 且路由不变（无交接时是空操作）；
  - B 收到过 snapshot。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性。删除原来的辅助函数测试，或改名为 `ensure_route_owner_rejects_non_owner`。

##### RS-T16（P1）交接状态机拒绝非法转移（表驱动，每个子用例使用新会话）

- **对应：** R4
- **关联审查编号：** B3F-F04、B3R-F05；第 14 条涉及本专项新发现 N13
- **位置：** `tests::handoff_state_machine_rejects_illegal_transitions`
- **子用例与断言**（每条都附带不变量：路由的 `window_label` 和 `channel` 不变）：
  1. stage 使用错误 token → “交接已过期”；
  2. stage 使用错误序号 → “交接已过期”；
  3. 非所有者（T9）stage → “另一个窗口控制”；
  4. 未 stage 就 complete → “画面尚未准备好”；
  5. complete 的目标是 `workspace-content-<uuid>` → “目标窗口不允许接管终端”；
  6. 重复 complete → 第二次报“已经准备接管”；
  7. 未 complete 就 finalize → “交接状态已失效”；
  8. finalize 的目标标签与 complete 不一致 → “交接状态已失效”；
  9. 交接进行中且仍处于暂停时再次 begin → “正在进行窗口交接”；
  10. 暂停过期（用 `flow.state.lock().pause_deadline = Some(Instant::now() - 1ms)`）后 complete → “交接超时”；
  11. 过期后再次 begin → 得到新 token，旧 token 的 stage 报“过期”；
  12. 使用错误 token cancel → “令牌无效”，之后用正确 token stage 仍为 Ok（pending 保留）；
  13. **返回进行中且源窗被销毁：** 所有者 T1，依次 begin、stage、`complete(target="main")`，然后 `reclaim_window(T1)` → `finalize(S,"main",…)` 报“交接状态已失效”，路由为 `"main"`、`owner_lost == true`（可以由 reattach 恢复）；
  14. **PD-09 已确认（拒绝）：** complete 的目标等于源（`"main"` 交接给 `"main"`）必须被拒，错误码使用点分命名 `pty.handoff_target_is_source`（PD-15，登记到 `contracts/error-codes.json`），拒绝发生在 begin 或 complete 且不改变路由、不暂停输出。
- **预期当前：** 1~13 应通过；第 14 条当前返回 Ok，揭示缺陷（T2-N13）；PD-09 已确认，不再需要等待产品决定：按通用约定第 1 条先以失败状态落地，再随修复转绿并去掉标注。
- **稳定性：** 确定性。第 10 条通过直接写截止时间来避免 sleep。

##### RS-T17（P1）窗口状态报告包含所有者标签

- **对应：** S1C-N05
- **关联审查编号：** S1C-N05
- **位置：** `tests::window_status_report_includes_owner_label`
- **前置：** SEAM-05、SEAM-04。
- **断言：**
  - 所有者为 T1 时：以 T1 查询得到 `{status: Running, owner_window_label: Some(T1)}`；以 `"main"` 查询得到 `{OwnedByAnotherWindow, Some(T1)}`；
  - `flow.close()` 后得到 `{Ended, None}`；
  - 不存在的会话得到 `{Ended, None}`；
  - 失主后（reclaim）以 `"main"` 查询得到 `{Running, Some("main")}`；
  - 序列化后的 JSON 键为 `status`、`ownerWindowLabel`。
- **预期当前：** 编译失败（缺少 DTO），揭示 S1C-N05。
- **稳定性：** 确定性。

##### RS-T18（P1）所有者通道失效时缓冲输出直到 reattach，并有内存上限

- **对应：** B3R-F05、R4、R8
- **关联审查编号：** B3R-F05
- **位置：** `tests::owner_channel_failure_buffers_until_reattach_and_bounds_memory`
- **步骤与断言：**
  1. 所有者为 T1、通道是 `failing_channel()`：`send_event(Output 1, data_base64 = "a"×10)` 返回 Ok；路由的 `channel` 为 None、`owner_lost == true`、`buffered_events.len() == 1`、flow 无限期暂停。
  2. 继续发送单条 `MAX_OWNER_LOST_BUFFER_BYTES` 字节的 Output → Err，消息含“输出缓冲区已满”；`buffered_bytes` 不超过上限。
  3. 此后发送 `Exited` 事件 → Ok（非 Output 不受上限约束），`buffered_events` 末尾是 Exited。
  4. 所有者为 `"main"` 且通道失效时 → Err“输出通道不可用”，`owner_lost` 仍为 false。
  5. 所有者为 T1（recording A），镜像为 `("main", recording M)`：一次 send 后 A 和 M 各收到 1 条。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性。

##### RS-T19（P1）PTY 输入的所有权、大小与背压边界

- **对应：** S1C-N03、R8
- **关联审查编号：** S1C-N03
- **位置：** `tests::pty_input_ownership_size_and_backpressure_boundaries`
- **前置：** SEAM-04，会话所有者为 T1，`input` receiver 暂不读取。
- **步骤与断言：**
  1. `write(S,"main",b"x")` → Err“另一个窗口控制”，receiver 为空；
  2. 恰好 `MAX_PTY_INPUT_BYTES`（65536）字节 → Ok，receiver 收到长度 65536；
  3. 65537 字节 → 返回码 `pty_input_backpressure`，receiver 没有新增内容；
  4. `"你".repeat(21846)`（65538 字节）→ 拒绝（按字节计数，注释说明前端必须按字节分片）；
  5. 清空 receiver 后连续写 `PTY_INPUT_QUEUE_CAPACITY`（32）次 → 都是 Ok，第 33 次 → `pty_input_backpressure`；
  6. drop receiver 后写入 → `pty_input_unavailable`。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性：不启动写线程，直接使用 `pty_input_channel()` 的容量。

##### RS-T20（P1）有登记会话时禁止恢复备份

- **对应：** J1、R2 备份恢复
- **关联审查编号：** J1
- **位置：** `tests::backup_restore_guard_rejects_registered_session`
- **断言：**
  - 插入 1 个测试会话后 `begin_backup_restore()` 报 Err，code 为 `pty_sessions_active`，`params.count == 1`；
  - `sessions.lock().remove(id)` 后返回 Ok；guard 存活期间 `begin_session_start()` 报 `backup_restore_in_progress`；drop guard 后返回 Ok。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性。

##### RS-T21（P1）任务 panic 时结束为失败并释放槽位

- **对应：** B1-F12
- **关联审查编号：** B1-F12
- **位置：** `execution_service.rs` → `tests::supervised_task_panic_finishes_failed_and_releases_slot`，`#[tokio::test]`
- **前置：** SEAM-06。`manager.active` 中插入 `(ToolKey::Claude, active_task("t1"))`；`let guard = manager.guard("t1")`；`let calls = Arc<Mutex<Vec<String>>>`。
- **步骤：** `supervise_task(async move { let _g = guard; panic!("injected panic") }, move |m| calls.lock().unwrap().push(m)).await`。
- **断言：**
  - `calls.len() == 1`，内容包含“执行任务异常退出”和 `"panicked"`；
  - `!manager.active.lock().unwrap().contains_tool(ToolKey::Claude)`。
  - **反向：** 正常完成的 future 调用后 `calls` 为空。
- **预期当前：** 编译失败；抽取后通过。
- **稳定性：** 确定性。

##### RS-T22（P1）`list_sessions` 的预算包含可执行文件解析，且不阻塞执行器

- **对应：** S1C-N02（`cli_adapters/mod.rs:27-35, 154-164`；`session_service.rs:103`）
- **关联审查编号：** S1C-N02、B1-F07
- **位置：** `session_service.rs` → `tests::list_sessions_budget_includes_executable_resolution`，`#[tokio::test(flavor = "current_thread")]`
- **前置：** SEAM-07、SEAM-08。`static FAST_HISTORY: FastHistoryAdapter`（tool Hermes，`list_sessions` 立即返回空页，并把 `context.resolved_path.is_none()` 记入一个 static AtomicBool）。`SleepingResolver(Duration::from_secs(5))` 在 resolve 内 `std::thread::sleep`。启动一个 ticker 任务，每 10 ms 给 `AtomicUsize` 加 1。
- **步骤：** `list_sessions_with(&FAST_HISTORY, "project".into(), None, 10, resolver, tempdir, Duration::from_millis(300))`，并计时。
- **断言：**
  - 耗时小于 1.5 秒；
  - 结果是 `Err` 且包含“超时”，或者是 `Ok` 并且 `resolved_path` 为 None（二者都可接受，但必须在预算内）；
  - ticker 计数不少于 10（执行器没被同步解析饿死）。
- **预期当前：** 现有代码路径无法注入；seam 以“同步在 async 线程上解析”的方式实现时，ticker 断言和耗时断言失败，揭示缺陷。
- **稳定性：** 阈值留有 5 倍余量。

##### RS-T23（P1）索引刷新时，慢解析、panic、标识不符都只影响该工具

- **对应：** B1-F07、R3
- **关联审查编号：** B1-F07、S1C-N02；N12（`refresh_search_index` 因某工具 context 构造失败整体失败）
- **位置：** `tests::refresh_search_index_isolates_slow_resolution_and_panicking_adapter`，`#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`
- **前置：** 定义 5 个 static 测试 adapter：
  - Claude：正常，返回 `documents: Some(vec![])`，`incomplete: false`；
  - Codex：正常，但 resolver 对 Codex 会 sleep 5 秒；
  - Antigravity：正常；
  - Grok：`search_index_source` 的 future 内 `panic!`；
  - Hermes：返回 `tool_key: Claude`（标识不符）。

  预算 300 ms，同时运行 ticker。

- **断言：**
  - 耗时小于 2 秒；
  - 返回 5 项，顺序等于 `ToolKey::ALL`；
  - Claude 完整；Codex、Grok、Hermes 都是 `documents: None, incomplete: true`；Antigravity 完整；
  - ticker 计数不少于 10。
- **预期当前：** seam 实现之前无法编译；若按现行行为实现（解析在预算外同步执行），耗时断言失败。
- **稳定性：** 余量充足。

##### RS-T24（P1）恢复会话校验失败时不生成启动载荷

- **对应：** B1-F04、弱测试 #8
- **关联审查编号：** B1-F04；N2（测试对象是生产逻辑的副本）
- **位置：** `launch_service.rs` → `tests::resume_validation_failure_produces_no_launch_payload`（`#[tokio::test]`），以及改写后的 `tests::normal_payload_ignores_legacy_project_arguments`
- **前置：** SEAM-14。计数解析器 `resolve = |_| { calls += 1; async { Some(PathBuf::from("/opt/cli")) } }`。
- **断言：**
  1. Claude 加 `Some("../evil")` → Err，消息含“会话 ID 格式无效”，`calls == 0`（快速失败）；
  2. `Some("-x")` → Err，`calls == 0`；
  3. 合法 UUID 但解析器返回 None → Err，消息含“未检测到”；
  4. 合法 UUID 且解析成功 → `tool_args == ["--resume", uuid]`；
  5. （PD-05 已确认：`directory_tool_args` 表在 `0015_legacy_cleanup` 中删除）改写后的旧测试不再向内存库写入遗留的 `directory_tool_args`：直接用真实的 `resolve_launch_directory` 与 `resolve_payload_with_resolver(dir, Claude, None, …)`，断言 `tool_args` 为空；原先“遗留项目参数被忽略”的断言改为“该表已不存在”（见 RS-T26）。
  - 同时删除 `#[cfg(test)] fn resolve_payload_with`。
- **预期当前：** 第 1、2 条揭示顺序问题（现在先解析可执行文件再校验参数），其余在抽取后通过。
- **稳定性：** 确定性。

##### RS-T25（P1）Claude 与 Codex 只接受规范 UUID 会话 ID

- **对应：** B1-F05
- **关联审查编号：** B1-F05
- **位置：** `services/cli_adapters/mod.rs` → `tests::claude_and_codex_require_canonical_uuid_session_ids`，三平台
- **步骤与断言（对 Claude 和 Codex 调用 `valid_session_id`）：**
  - 接受：`8e783338-f464-4b10-b15e-b534748c6241`、v7 格式 `01890a5d-ac96-774b-bcce-b302099a8057`；
  - 拒绝：`session-1`、`8e783338f4644b10b15eb534748c6241`、`{8e783338-f464-4b10-b15e-b534748c6241}`、`8E783338-F464-4B10-B15E-B534748C6241`（PD-08 已确认：Claude 与 Codex 一律拒绝大写 UUID）、带 `-extra` 后缀、空串、`-8e783338-…`；
  - Antigravity、Grok 仍接受 `session-1`；Hermes 仍接受 `a.b:c`。
  - 同时更新 `launch_service::tests::resume_keeps_only_the_selected_cli_internal_arguments`：Claude 和 Codex 的用例改用 UUID。
- **预期当前：** 失败（`session-1` 被接受），揭示缺陷。
- **稳定性：** 确定性。

##### RS-T26（P1）新库与 0.2.4 升级库都用外键拒绝未知 tool_key

- **对应：** B1-F09、R9
- **关联审查编号：** B1-F09
- **位置：** `db/connection.rs` → `tests::unknown_tool_keys_are_rejected_by_foreign_keys_on_fresh_and_upgraded_databases`
- **前置：** 把 `upgrades_a_representative_024_schema_eight_database_to_current_schema` 中构造 schema 8 数据库的代码抽成 `fn legacy_schema_eight_database() -> Connection`，然后 `apply_migrations`。新库用 `memory_db()`。
- **步骤：** 两个库各插入一个目录；对 `session_aliases`、`pty_sessions`、`launch_history`、`execution_tasks` 四张表各插入一行 `tool_key='unknown'`，其他 NOT NULL 列按 migration 0004、0006、0013、0014 填写合法值；再用 `'claude'` 插入一行作为对照。
- **断言：**
  - 每个 `'unknown'` 插入都匹配 `Err(rusqlite::Error::SqliteFailure(e, _))`，且 `e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY`；
  - 对照插入为 Ok；
  - 升级库的 `PRAGMA foreign_key_check` 为空；
  - `open_database(tempdir/"t.db")` 之后 `PRAGMA foreign_keys == 1`（生产连接确实开启了外键）。
  - **PD-05 已确认（0015 清理）：** 新库与升级库（含从 schema 8、schema 14 的备份恢复后）执行 `0015_legacy_cleanup` 之后，`sqlite_master` 中不存在 `directory_tool_args` 与 `shell_profiles`；`application_settings` 中没有 `launch_target` 行；`tools` 表没有 `display_name`、`executable` 列；`directories` 没有 `last_used_at` 列；
  - 配置导入容忍旧字段：v1 至 v3 的配置包含 `directory_tool_args` 或 `shell_profiles` 字段时导入成功，旧字段被忽略且不写入任何表；
  - 同步调整 `config_service.rs:241-268` 与 `launch_service.rs:81-110` 的“旧参数隔离”测试：改为断言表已不存在与导入忽略旧字段，并在 M4 旧参数隔离的验收记录中标注“因 PD-05 改为表删除”；
  - 0015 在事务中执行，失败时数据库保持升级前状态（沿用迁移前保护备份）；
  - 以上 PD-05 断言预期当前失败（表仍存在）。
- **预期当前：** 应通过（补证据）；如果升级路径失败，即揭示缺陷。
- **稳定性：** 确定性。

##### RS-T27（P1）Windows 超时与 Job 结束都必须清掉孙进程

- **对应：** B1-F08、R6
- **关联审查编号：** B1-F08；N8（`run_bounded` 先 spawn 后 attach 的逃逸窗口，P3）
- **位置：** `platform/process.rs` → `tests::windows_timeout_kills_grandchild_processes`，以及 `platform/execution_process.rs` → `windows::tests::job_object_terminate_kills_grandchild_processes`，都是 `#[cfg(windows)]`
- **前置：** tempdir 中准备 `pid.txt` 路径。脚本（PowerShell，用于 `shell_command`）：
  `$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '<pid>' -Value $p.Id; Start-Sleep -Seconds 60`
- **步骤：** 调用 `run_bounded(command, Duration::from_secs(5), 64)`；第二个测试则 spawn 后 `tree.attach`，轮询 `pid.txt` 最多 10 秒，然后 `tree.terminate()`。
- **断言：**
  - 超时错误的 `kind == TimedOut`；
  - `pid.txt` 存在（不存在时 panic，提示“孙进程未在超时前启动，提高超时值”）；
  - 3 秒内轮询（每 100 ms）`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)` 加 `GetExitCodeProcess`，直到不等于 `STILL_ACTIVE(259)` 或句柄打开失败，最终断言进程不再存活；
  - 测试结束前如果仍存活，用 `taskkill /PID <pid> /T /F` 兜底，避免泄漏。
- **预期当前：** 应通过（补证据）。注释说明 `run_bounded` 是 spawn 之后才 attach，理论上存在逃逸窗口（N8，P3）。
- **稳定性：** 约 6 秒；仅 Windows；在探针中重复 10 次。

##### RS-T28（P1）Codex app-server 超时后不留孤儿进程

- **对应：** S1C-N04
- **关联审查编号：** S1C-N04
- **位置：** `services/cli_adapters/codex/app_server.rs` → `tests::timed_out_request_terminates_the_whole_server_process_tree`，`#[cfg(any(unix, windows))] #[tokio::test]`
- **前置：**
  - Unix：在 tempdir 写可执行文件 `fake-codex`（chmod 755），内容为
    `#!/bin/sh\nsh -c 'echo $$ > "<pidfile 绝对路径>"; exec sleep 60' &\nwait\n`
    （pid 文件路径直接写进脚本，**不使用** `set_var`）。
  - Windows：写 `fake-codex.cmd`，内容为
    `@echo off\r\npowershell -NoProfile -Command "$p = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '<pidfile>' $p.Id; Start-Sleep 60"\r\n`
- **步骤：** `request(Some(&script), "thread/list", json!({}), Duration::from_millis(1500 /* Windows 用 6000 */))`。
- **断言：**
  - 返回 Err，消息包含“响应超时”；
  - pid 文件存在（返回后再等最多 1 秒）；
  - 3 秒内轮询，孙进程不再存活（Unix 用 `libc::kill(pid, 0) == -1 && errno == ESRCH`，或 `ps -o stat= -p` 为空或以 `Z` 开头；Windows 同 RS-T27）；
  - 兜底清理同 RS-T27（Unix 用 `kill -9`）。
- **预期当前：** 失败（`kill_on_drop` 只杀直接子进程），揭示缺陷。修复方向：`request_inner` 改用 `ProcessTree`，并加 `struct AppServerTreeGuard`，其 `Drop` 中执行 terminate 加 force_kill，覆盖 timeout 丢弃 future 的路径。
- **稳定性：** Unix 约 2 秒，Windows 约 8 秒。

##### RS-T29（P1）恢复后缓存清理失败时，前后端仍保持一致

- **对应：** S1D-N05
- **关联审查编号：** S1D-N05、J1
- **位置：** `backup_service.rs` → `tests::restore_cache_cleanup_failure_keeps_frontend_and_backend_in_sync`
- **前置：** SEAM-09。复用 `setup()` 得到 paths 和 connection，`Db(Arc<Mutex<_>>)`；用 `cache_connection::init_cache(tempdir/"cache.db")` 建 `CacheDb`。业务库中把关闭行为设为 `Quit`，添加目录 A，然后创建备份；再把关闭行为改为 `MinimizeToTray`，添加目录 B。对缓存连接执行 `drop table cache_entries`，使 `remove_prefix` 失败（缓存库共有 `cache_entries`、`session_search_documents`、`session_search_sources`、`session_search_fts` 四张表）。`RecordingNotifier` 记录调用次数。
- **步骤：** 调用 `restore_with_runtime_invalidation(&db,&cache,&PtySessionManager::default(),&paths,&backup.id,&notifier)`。
- **断言：**
  - 返回 Ok；`cache_warning.is_some()`；
  - `notifier` 被调用 1 次；
  - `close_behavior == Quit`；
  - 业务库中只有目录 A；
  - **反向：** 备份 id 不存在时返回 Err，notifier 调用 0 次，缓存表不受影响（在另一个未 drop 表的缓存上验证）。
- **预期当前：** 按现行行为抽取后返回 Err 且未通知，揭示缺陷。
- **稳定性：** 确定性。

##### RS-T30（P1）恢复后清空会话、索引和文件索引缓存

- **对应：** J1
- **关联审查编号：** J1
- **位置：** `tests::restore_invalidates_session_index_and_file_index_caches`
- **前置：** 同 RS-T29，但不 drop 表。缓存中 `put("sessions:1:claude", …)`、`put("workspace-file-index:1", …)`，并用 `session_search_repo::refresh` 给目录 1 写入一条文档。
- **断言：**
  - 恢复后 `get_any("sessions:1:claude")` 为 None；`get_any("workspace-file-index:1")` 为 None；
  - `session_search_repo::search(cache, 1, "q", &HashMap::new())` 返回空结果；
  - notifier 被调用 1 次。
- **预期当前：** 抽取后通过（补证据）。
- **稳定性：** 确定性。

##### RS-T31（P1）handler 解析忽略注释并拒绝畸形条目

- **对应：** S1D-N07
- **关联审查编号：** S1D-N07、X-F04
- **位置：** `contracts.rs` → `handler_parser_ignores_comments_and_rejects_malformed_entries`，以及改写后的 `app_command_contract_matches_the_registered_handler`
- **前置：** SEAM-10。
- **断言（夹具字符串）：**
  1. `"generate_handler![\n commands::a::one,\n // commands::a::secret,\n /* commands::a::two, */ commands::b::three,\n]"` 解析为 `["one","three"]`；
  2. 含 `#[cfg(debug_assertions)] commands::x::y` → Err；
  3. 末尾逗号可以接受；
  4. `crate::other::f` → Err（必须在 `commands::` 下）；
  5. 真实 `LIB_RS` 解析结果排序后等于 contract；
  6. contract 中每个命令在 `src/commands/*.rs`（用 `read_dir(CARGO_MANIFEST_DIR/src/commands)`）里恰好出现一次 `#[tauri::command]` 后紧随的 `pub fn <name>(` 或 `pub async fn <name>(`。
- **预期当前：** 夹具 1 用旧解析会得到 3 项，揭示缺陷；新解析通过。
- **稳定性：** 确定性。

##### RS-T32（P1）`ToolKey::ALL` 列出每个变体且只列一次

- **对应：** S1D-N07、R1 tool key
- **关联审查编号：** S1D-N07
- **位置：** `models/tool.rs` → `tests::all_lists_every_variant_exactly_once`
- **前置：** 测试内定义穷尽式 `fn ordinal(k: ToolKey) -> usize { match k { Claude=>0, Codex=>1, Antigravity=>2, Grok=>3, Hermes=>4 } }`，以及 `const VARIANT_COUNT: usize = 5;`，并加注释“新增变体会编译失败，必须同步 ALL、contract、SQL”。
- **断言：**
  - `ALL.len() == VARIANT_COUNT`；`ordinal` 两两不同，且都小于 `VARIANT_COUNT`；
  - contract 中的每个字符串经 `from_key` 得到 Some，且 `as_str` 往返一致；`serde_json::from_str::<ToolKey>(&format!("\"{s}\""))` 成功；
  - `from_key("unknown")` 为 None，serde 解析 `"unknown"` 为 Err。
- **预期当前：** 通过（防回归）。
- **稳定性：** 确定性。

##### RS-T33（P1）内容 kind 契约覆盖每个已知变体

- **对应：** S1D-N07、R1 内容 kind
- **关联审查编号：** S1D-N07
- **位置：** `contracts.rs` → `content_kind_contract_covers_every_known_variant`
- **前置：** 穷尽式 `fn sample(kind_variant: &WorkspacePaneContentRef) -> Option<(&'static str, Value)>`：Pty 对应 `("pty", {"kind":"pty","slotId":"s"})`，File 对应 `("file", {"kind":"file","documentId":"d"})`，Unknown 返回 None。
- **断言：**
  - 已知 kind 的集合等于 contract 的 `kinds`；
  - 每个 sample 反序列化后不是 `Unknown`；
  - `{"kind":"markdownPreview","x":1}` 反序列化为 `Unknown { original_kind: "markdownPreview", .. }`，序列化往返后 raw 保留 `x == 1`。
- **预期当前：** 通过（防回归）。
- **稳定性：** 确定性。

##### RS-T34（P1）capability 契约逐项比较插件权限和对象权限

- **对应：** S1B-N02
- **关联审查编号：** S1B-N02
- **位置：** `contracts.rs` → 改写 `window_kind_contract_matches_capabilities`，并新增 `capability_comparator_rejects_extra_plugin_and_object_permissions`
- **前置：** `contracts/window-kinds.json` 每个 kind 增加 `pluginPermissions`：
  - main：`["dialog:allow-open","dialog:allow-save","clipboard-manager:allow-read-text","clipboard-manager:allow-write-text",{"identifier":"opener:allow-open-url","allow":[{"url":"https://github.com/SkyJourney/cli-launchpad"}]}]`
  - terminal：`["clipboard-manager:allow-read-text","clipboard-manager:allow-write-text"]`
  - workspaceContent：`[]`

  SEAM-10 的比较器分三类：字符串以 `allow-` 开头为应用命令，以 `core:` 开头为核心权限，其余字符串和对象为插件权限（对象按完整 JSON 等值比较，按 identifier 排序）。

- **断言：**
  - 真实的三个 capability 文件违规为 0；
  - 任何权限 identifier 不得以 `fs:`、`shell:`、`http:` 开头；
  - `*:default` 只允许 main 的 `core:default`。
  - **负向夹具：** 复制 terminal 的 JSON 并分别做以下修改，比较器都必须报违规，且信息包含对应 identifier：加入 `"fs:default"`；加入 `{"identifier":"shell:allow-execute","allow":[{"name":"x"}]}`；删除 `"allow-write-pty-session"`；给 workspace-content 加入 `"core:window:allow-set-focus"`；把 opener 对象的 url 改为 `"https://example.com"`。
- **预期当前：** 加入 `fs:default` 的负向夹具在旧比较器下不报违规，揭示缺陷；新比较器通过。TS 侧 `windowApiPermissions.test.ts` 需要同步读取 `pluginPermissions`。
- **稳定性：** 确定性。

##### RS-T35（P1）生产 CSP 的指令精确等于契约

- **对应：** S1B-N07
- **关联审查编号：** S1B-N07、X-F05；N9（离线配置可能覆盖 CSP）
- **位置：** `contracts.rs` → `production_csp_matches_exact_directive_contract`
- **断言：**
  - `parse_csp(prod)` 精确等于：`default-src{'self'}`、`script-src{'self'}`、`style-src{'self','unsafe-inline'}`、`img-src{'self',data:,blob:}`、`font-src{'self',data:}`、`worker-src{'self',blob:}`、`connect-src{'self',ipc:,http://ipc.localhost}`；
  - dev 策略等于生产策略，仅多出 `script-src` 中的 `'unsafe-eval'`，以及 `connect-src` 中的 `http://localhost:1420` 和 `ws://localhost:1420`；
  - 解析器遇到重复指令返回 Err；
  - 生产策略中没有 `*`、`http:`、`https:` 这种只写协议的源，没有 `'unsafe-eval'`，也没有 `localhost:1420`；
  - `app.security` 中不存在 `dangerousDisableAssetCspModification`；
  - 读取 `src-tauri/tauri.offline.conf.json`，断言其中没有 `app.security`（防止离线包覆盖 CSP，N9）。
- **预期当前：** 通过（防回归）。
- **稳定性：** 确定性。

##### RS-T36（P1）错误码契约与 Rust 注册表一致

- **对应：** S1B-N03
- **关联审查编号：** S1B-N03、X-F02
- **位置：** `contracts.rs` → `error_code_contract_matches_rust_registry` 和 `app_errors_use_registered_code_constants`
- **前置：** SEAM-11。TS 中现有但后端不产出的 8 个码（`file.conflict`、`file.identity_changed`、`pty.owner_mismatch`、`pty.handoff_expired`、`pty.input_backpressure`、`exec.plan_changed`、`exec.busy`、`layout.needs_reset`）在 JSON 中标为 `"reserved"`，或者删除。
- **断言：**
  - JSON 中 `producedBy=="rust"` 的码集合等于 `error_codes::ALL`；
  - 递归扫描 `src/**/*.rs`（跳过 `error.rs` 的 tests 模块）：`AppError::coded(` 或 `AppError::coded_with_params(` 之后（可跨空白和换行）的第一个非空字符不能是 `"`，即必须使用常量；
  - `ALL` 中每个常量在 `error_codes.rs` 之外至少被引用一次；
  - TS 的 `appErrors.test.ts` 新增：`Object.keys(errorTranslationKeys)` 排序后等于 JSON 全部码，且每个翻译 key 在所有 locale 文件中都存在。
  - **PD-15 已确认（点分命名 + 一个版本的别名）：** `contracts/error-codes.json` 的结构改为 `{ "codes": [点分新码…], "aliases": { "<旧码>": "<新码>" } }`：
    - `codes` 全部匹配 `^[a-z]+(\.[a-z0-9_]+)+$`；旧下划线码只出现在 `aliases` 的键里，每个值都必须在 `codes` 中；
    - 旧码到新码的映射：`plan_changed` → `exec.plan_changed`、`project_identity_changed` → `project.identity_changed`、`pty_input_backpressure` → `pty.input_backpressure`、`pty_input_unavailable` → `pty.input_unavailable`、`pty_sessions_active` → `pty.sessions_active`、`pty_session_starting` → `pty.session_starting`、`backup_restore_in_progress` → `backup.restore_in_progress`（别名保留一个版本）；
    - Rust 新产出的错误码必须是点分码，源码扫描禁止新增下划线码；前端 `formatAppError` 对旧码与新码给出同一条翻译；
    - 命名迁移后，上面“TS 中现有但后端不产出的 8 个码”减少两个：`pty.input_backpressure` 与 `exec.plan_changed` 现在是后端产出码的新名字，不再是死映射；`file.identity_changed` 并入 `project.identity_changed`；其余仍为未产出码（`file.conflict`、`pty.owner_mismatch`、`pty.handoff_expired`、`exec.busy`、`layout.needs_reset`）。
- **预期当前：** 失败（没有契约，TS 有多余码），揭示缺陷。
- **稳定性：** 确定性。

##### RS-T37（P1）Unix 控制字符文件名在文件服务与布局之间行为一致

- **对应：** S1D-N08
- **关联审查编号：** S1D-N08
- **位置：** `file_service.rs` → `tests::control_character_file_names_are_handled_consistently_by_listing_and_layout`，`#[cfg(unix)]`
- **前置：** tempdir 中创建 `"line\nbreak.txt"`、`"tab\tname.txt"` 和 `"ok.txt"`。
- **步骤与断言（PD-02 已确认方案 A：`path_rules::validate_component` 在所有平台拒绝控制字符）：**
  - 列目录结果只有 `ok.txt`，跳过计数不少于 2（使用列表结构中现有的跳过计数字段）；
  - `open_file_in(root,"line\nbreak.txt")` 返回 Err；
  - 以该相对路径构造 `WorkspaceFileDocument`，`validate()` 返回 Err（这一点现已成立）。
- **预期当前：** 列表中包含控制字符文件名，揭示缺陷（PD-02 已确认采用方案 A，无需再等待决策）。
- **稳定性：** 确定性。

##### RS-T38（P1）应用命名布局时保留分离区的 Unknown 内容

- **对应：** S1D-N09
- **关联审查编号：** S1D-N09
- **位置：** `workspace_layout_service.rs` → `tests::applying_preset_preserves_detached_unknown_contents`
- **前置：** active 布局用 `layout_with_slot` 构造，再在 `detached_contents` 中加入 `Unknown{original_kind:"markdownPreview", raw: json!({"kind":"markdownPreview","documentId":"8e783338-f464-4b10-b15e-b534748c6241"})}`。raw 的形状要满足 `validate_unknown` 的要求（参照 `workspace_layout_round_trips_a_future_content_kind_as_raw_json`）。preset 由另一个合法布局通过 `create_preset` 创建。
- **断言：**
  - `plan.layout.detached_contents` 恰好包含该 Unknown 一次，且 raw 与原值逐字段相等；
  - `plan.layout.validate()` 为 Ok；
  - 原有 Pty 和 File 分离项的语义不变（复用现有断言）。
- **预期当前：** Unknown 被丢弃，揭示缺陷。
- **稳定性：** 确定性。

##### RS-T39（P1）Windows 保留设备名包含 COM0 与 LPT0

- **对应：** S1D-N13
- **关联审查编号：** S1D-N13
- **位置：** `platform/path_rules.rs` → `tests::windows_reserved_device_names_cover_com0_lpt0_and_superscripts`，三平台
- **前置：** SEAM-13。
- **断言：**
  - 对 `CON PRN AUX NUL CONIN$ CONOUT$ COM0..COM9 LPT0..LPT9 COM¹ COM² COM³ LPT¹ LPT² LPT³` 中的每个名字，以及它们的小写、`<n>.txt`、`<n>.tar.gz`、`"<n> .txt"` 变体，`windows_component_violation` 都返回 Some；
  - `COM10`、`LPT10`、`CONSOLE`、`AUXILIARY.txt`、`COM`、`com1x`、`nul_file` 返回 None。
  - Windows 上另外断言 `validate_entry_name("COM0.txt").is_err()`。
- **预期当前：** COM0 和 LPT0 失败，揭示缺陷。
- **稳定性：** 确定性。

##### RS-T40（P1）窗口 label 共用测试向量

- **对应：** R1 窗口类别与 label
- **关联审查编号：** X-F04
- **位置：** `models/window_kind.rs` → `tests::window_label_fixture_vectors_match_rust_registry`；TS 侧 `windowKinds.test.ts` 对同一 JSON 镜像断言
- **前置：** SEAM-15。
  - accept：`main`；`terminal-8e783338-f464-4b10-b15e-b534748c6241`；`terminal-8E783338-F464-4B10-B15E-B534748C6241`（两侧都接受大写，保持一致）；`workspace-content-11111111-2222-4333-8444-555555555555`。
  - reject：`Main`；`terminal-`；`terminal-invalid!`；`terminal-8e783338f4644b10b15eb534748c6241`；`terminal-8e783338-f464-0b10-b15e-b534748c6241`；`terminal-8e783338-f464-4b10-c15e-b534748c6241`；末尾带空格的合法 label；`terminal-{8e783338-f464-4b10-b15e-b534748c6241}`；`settings`；`workspace-content-`。
- **断言：** 每个 accept 项经 `window_kind_of` 得到对应 kind，每个 reject 项为 None。
- **预期当前：** 通过（补证据）。
- **稳定性：** 确定性。

##### RS-T52（P1）`terminate_all` 结束真实的 PTY 进程树

- **对应：** R2 应用退出
- **关联审查编号：** B2-F01
- **位置：** `pty_session_service.rs` → `tests::terminate_all_terminates_real_pty_process_trees`，三平台
- **前置：** 扩展 SEAM-04 为 `insert_test_session_with_child(owner, command)`：在 slave 上 spawn（Unix 用 `/bin/sh -c "sleep 60"`；Windows 用 `powershell -NoProfile -Command "Start-Sleep 60"`），创建 `ProcessTree::new()` 并 `attach_pty`，使用真实 killer。测试再起一个线程模拟监控：`child.wait()` 返回后 `sessions.lock().remove(id)`。
- **断言：**
  - `terminate_all()` 返回 Ok；`active_count() == 0`；
  - 总耗时小于 3 秒；
  - 子进程已退出（`try_wait` 为 Some）。
- **预期当前：** 通过（补证据）。
- **稳定性：** 在探针中重复 10 次。

##### RS-T54（P1）命令参数不接受调用方自报的 label

- **对应：** R5、P-4
- **关联审查编号：** B3F-F08、B2-F03
- **位置：** `contracts.rs` → `commands_do_not_accept_caller_reported_window_labels`
- **断言：** 扫描 `src/commands/*.rs` 中 `#[tauri::command]` 函数的参数列表，不得出现名为 `window_label`、`label`、`source_label` 的 `String` 参数。白名单只有 `grant_content_window_file` 和 `revoke_content_window_file` 的 `target_label`，并且这两个函数体内必须调用 `ensure_main_window(caller.label())`。
- **预期当前：** 通过（防回归）。
- **稳定性：** 确定性。

##### RS-T58（P1）退出请求关联：`confirm_app_exit` 必须匹配待决请求，请求携带活动执行任务数

- **对应：** R2 应用退出、R5 身份可信；`confirm_app_exit`（`commands/pty_session.rs`）无条件调用 `terminate_all` 并 `app.exit(0)`；终端窗与文件窗的 capability 含 `core:event:allow-emit-to`，可向主窗口伪造 `app-exit-requested`
- **关联审查编号：** N18（本专项新发现，已由协调人核实）；B2-F01、B3F-F08
- **位置：** `src-tauri/src/services/app_lifecycle.rs` → 下列测试，三平台（无 cfg）
- **前置：** SEAM-23。`confirm_exit_with` 的 `terminate` 参数用计数闭包（`Cell<usize>` 或 `AtomicUsize`）代替真实 `terminate_all`，不启动任何进程。
- **测试一 `tests::confirm_exit_without_a_pending_request_is_rejected_and_terminates_nothing`：**
  1. 新建 `AppExitGate`，不调用 `begin_request`；
  2. `confirm_exit_with(&gate, "any-id", terminate)` 返回 Err，错误码为 `exit.no_pending_request`（需同步登记到 `contracts/error-codes.json`）；
  3. 计数器为 0（反向断言：没有终止任何 PTY）；
  4. `gate.consume_authorization()` 为 false。
- **测试二 `tests::confirm_exit_with_a_mismatched_id_is_rejected_and_keeps_the_pending_request`：**
  1. `let request = gate.begin_request()`；
  2. 用 `"forged-id"`、空串、`request.id` 的大写形式、`request.id + " "` 分别确认，每次都返回 Err，错误码为 `exit.request_mismatch`；
  3. 计数器仍为 0，`consume_authorization()` 为 false；
  4. `gate.pending_request_id() == Some(request.id)`（待决请求未被消耗）；
  5. 随后用正确 id 确认返回 Ok，计数器为 1，`consume_authorization()` 为 true，再次调用为 false。
- **测试三 `tests::exit_request_ids_are_single_use_unique_and_superseded_by_newer_requests`：**
  1. 连续 `begin_request` 100 次得到的 id 全部不同，且每个都是合法 UUID v4；
  2. 取 r1、再取 r2：用 r1.id 确认返回 `exit.request_mismatch`，用 r2.id 确认返回 Ok（最新请求生效）；
  3. r2 确认成功后，再用 r2.id 确认返回 `exit.no_pending_request`（单次使用，不可重放）。
- **测试四 `tests::failed_termination_keeps_the_request_pending_and_does_not_authorize_exit`：**
  1. `begin_request` 后调用 `confirm_exit_with(&gate, id, || Err(AppError::msg("pty busy")))`；
  2. 返回该错误，`consume_authorization()` 为 false；
  3. `pending_request_id()` 仍是该 id，可以再次用同一 id 重试且重试成功时授权。
- **测试五 `tests::exit_requested_payload_reports_pty_and_execution_task_counts`：**
  1. `exit_requested_payload(&ExitRequest{id:"r1"}, 2, 3)` 的 JSON 恰好等于 `{"requestId":"r1","ptyCount":2,"executionTaskCount":3}`，键集合不多不少，且全部为 camelCase；
  2. 该值同时写入 `contracts/fixtures/exit-requested-payload.json`（RS-T57 的 golden fixture 机制），前端 vitest 对其解码；
  3. `ExecutionTaskManager::active_count()` 在插入 2 个 `ActiveTask` 后为 2，`remove_by_id` 后为 1（直接构造 `manager.active` 中的任务，沿用现有测试风格）。
- **测试六 `tests::exit_requested_decision_issues_a_fresh_request_for_every_exit_attempt`（扩展 RS-T07）：**
  1. 连续两次 `ExitRequested`（无授权，主窗存在）：`decide_exit_request` 都返回 `PreventAndAskMain{..}`，两次产生的 `request_id` 不同；
  2. 第二次发出之前，第一次的 id 已不能确认。
- **静态扫描 `contracts.rs` → `tests::confirm_app_exit_takes_a_request_id_and_frontend_reads_the_payload_field`：**
  1. 读 `src/commands/pty_session.rs` 源码，`confirm_app_exit` 的参数列表包含 `request_id: String`；
  2. `contracts/app-commands.json` 仍包含 `confirm_app_exit`，且 `capabilities/default.json` 之外的两个 capability 都不含 `allow-confirm-app-exit`（反向断言，防止子窗口获得该命令）；
  3. 读 `src/App.tsx`（第 154 行监听 `app-exit-requested`，当前事件类型只有 `{ ptyCount: number }`），断言监听处理中引用 `requestId`；读 `src/lib/tauri.ts`（第 737 行，当前为 `invoke<void>("confirm_app_exit")`，不带任何参数），断言该函数签名接收 `requestId` 并以 `{ requestId }` 传给 `invoke`（用正则；失败信息指向前端 FE 规格）。
- **预期当前：** 测试一至六无法编译，实现 SEAM-23 之前没有 `begin_request`；以“保持现行为”的方式先引入 seam（不校验 id）时，测试一和二失败（计数器为 1），揭示缺陷。
- **稳定性：** 确定性；不使用 sleep，不依赖真实应用句柄。

##### RS-T59（P1）PD-12 干净退出标记：异常退出检测与启动提示

- **对应：** PD-12（增强版兜底之一）、R2 应用退出；系统级退出入口（Dock 退出、AppleScript quit、系统注销、Windows 注销与关机、Linux SIGTERM）绕过退出门时，用下次启动的提示缓解
- **关联审查编号：** S1C-N01、T2-N06；PD-12
- **位置：** 新增 `src-tauri/src/services/clean_exit_marker.rs`（SEAM-26）的 `tests` 模块；`services/startup_notices.rs` 的 `tests` 模块；三平台（无 cfg）
- **模块契约（SEAM-26，实现者按此签名，测试以此为准）：**

```rust
pub const MARKER_FILE_NAME: &str = "session-running.marker";           // 位于 paths.data_dir，不放 cache_dir（用户“清除缓存”会误删标记）
pub enum PreviousExit { FirstRun, Clean, Abnormal { started_at_ms: Option<i64> }, Unreadable }
pub fn begin_session(paths: &StoragePaths, now_ms: i64) -> PreviousExit;  // 读取上一次残留，再原子写入本次标记；任何失败只记日志，不 panic、不返回 Err
pub fn end_session_cleanly(paths: &StoragePaths);                          // 删除标记；幂等；缺失不报错
```

- **测试一 `first_run_has_no_marker_and_writes_one`：** 空 tempdir → `begin_session` 返回 `FirstRun`；之后标记文件存在且内容是合法 JSON `{ "startedAtMs": <n>, "pid": <n> }`。
- **测试二 `clean_exit_removes_the_marker`：** `begin_session` → `end_session_cleanly` → 再次 `begin_session` 返回 `Clean`。
- **测试三 `leftover_marker_reports_abnormal_with_the_previous_start_time`：** `begin_session(now=1000)` 后不调用 `end_session_cleanly`，再 `begin_session(now=2000)` 返回 `Abnormal { started_at_ms: Some(1000) }`，且标记内容更新为 2000。
- **测试四 `corrupt_marker_is_still_abnormal_not_an_error`：** 标记内容为 `{broken`、空文件、非 UTF-8 字节三种 → 都返回 `Abnormal { started_at_ms: None }`（文件存在本身就是异常退出的信号）；不 panic。
- **测试五 `unwritable_data_dir_never_blocks_startup`：** 把标记路径预先建成目录（无法按文件写入）→ `begin_session` 返回 `Unreadable`，不 panic、不返回 Err；`end_session_cleanly` 同样不 panic。
- **测试六 `end_session_is_idempotent`：** 连续调用 `end_session_cleanly` 三次，每次都成功；标记不存在时也成功。
- **测试七 `startup_notice_is_taken_exactly_once`：** `StartupNotices` 托管状态：`Abnormal` 产生一条 `{ kind: "abnormal_exit_detected", startedAtMs }`；`take_startup_notices` 第一次返回该条，第二次返回空；`FirstRun`、`Clean`、`Unreadable` 不产生任何提示（`Unreadable` 只记日志）。`take_startup_notices` 作为命令登记到 `contracts/app-commands.json`，只授予 main 窗口，不授予子窗口（`window_kind_contract_matches_capabilities` 覆盖）。
- **测试八 `marker_is_started_only_from_setup_and_cleared_only_on_graceful_exit`（静态扫描）：** 读 `lib.rs`：`begin_session(` 恰好出现一次且位于 `setup` 闭包内；`end_session_cleanly(` 恰好出现在 `RunEvent::Exit` 的处理中（不在 `ExitRequested` 中，因为它可能被阻止）。第二实例启动时 setup 不会执行、因此不会改写标记，这一点由实机 X-23 验证，不由静态扫描证明。
- **反向断言：** 单例唤起、托盘显示主窗口、`Reopen` 都不得调用 `begin_session` 或 `end_session_cleanly`；标记中不得包含任何文件路径、文件正文或项目名（只有时间戳与 pid）。
- **预期当前：** 模块不存在，编译失败；实现后通过。
- **稳定性：** 确定性；全部使用 `tempfile::tempdir()` 构造 `StoragePaths`。
- **不在本规格范围：** 不保存未保存文件的正文，不提供恢复（PD-12b 未采用，见主报告 4.7.3）。

##### RS-T60（P1）PD-12 退出事件的尽力清理：终止 PTY 与执行任务并标记意外中断

- **对应：** PD-12（增强版兜底之二）、R2 应用退出；目前 `handle_run_event` 只处理 `ExitRequested` 与 `Reopen`，没有处理 `RunEvent::Exit`
- **关联审查编号：** S1C-N01、T2-N06、S3I-A05；PD-12
- **位置：** 新增 `src-tauri/src/services/exit_cleanup.rs`（SEAM-24）的 `tests` 模块；`services/pty_session_service.rs`、`services/execution_service.rs` 中对应 trait 实现的测试；三平台
- **前置：** SEAM-24、SEAM-04（可构造的测试会话）。
- **测试一 `cleanup_terminates_every_target_in_order`：** 两个计数用的假目标（PTY、执行任务），`run_exit_cleanup(&[&pty, &tasks], 3s)` 依次调用；报告里 `terminated` 为两项计数，`failed` 为空，`timed_out == false`。
- **测试二 `cleanup_is_idempotent`：** 同样的目标连续调用两次；第二次报告的终止数为 0、没有错误。
- **测试三 `cleanup_respects_the_total_budget`：** 一个假目标在线程里阻塞 5 秒；预算 300ms；`run_exit_cleanup` 在 2 秒内返回，`timed_out == true`；其余目标仍被调用过（不因一个阻塞而跳过）。
- **测试四 `a_failed_target_does_not_skip_the_others`：** 第一个目标返回 Err，第二个仍被调用；报告 `failed` 含第一个目标的名字与错误文本。
- **测试五 `real_pty_sessions_are_gone_after_cleanup`：** 插入真实 PTY 会话（沿用 RS-T52 的构造），清理后 `active_count() == 0`，子进程已退出（`try_wait` 为 Some）；Unix 断言进程组、Windows 断言 Job 内无存活进程。
- **测试六 `running_execution_tasks_are_marked_interrupted_and_slots_released`：** 临时数据库中两个 `running` 状态的执行任务，清理后状态为 `interrupted`、`finished_at_ms` 非空（复用 `execution_task_repo::mark_unfinished_interrupted`），`ActiveTaskGuard` 的槽位全部释放；下次启动不再把它们当作未完成任务重复标记（`startup_marks_unfinished_tasks_interrupted` 返回 0）。
- **测试七 `exit_event_runs_cleanup_then_clears_the_marker_even_if_cleanup_times_out`：** 组合函数 `on_run_event_exit(paths, targets, budget)`：先清理、后 `end_session_cleanly`；清理超时也必须清除标记（超时说明应用仍在优雅退出，不应让下次启动误报异常退出）；清理 panic 被捕获，仍清除标记。
- **测试八 `exit_requested_does_not_run_cleanup_or_clear_the_marker`：** `decide_exit_request` 返回 `PreventAndAskMain` 时，清理与标记清除都没有被调用（`ExitRequested` 可能被阻止，不能在那里清理）。
- **反向断言：** 清理不得删除或改写用户项目中的任何文件；不得在清理里弹出任何交互；总耗时不得超过预算的两倍。
- **预期当前：** 失败（`RunEvent::Exit` 无处理，模块不存在）；实现后转绿。
- **稳定性：** 假目标用线程与通道控制时序，不依赖 sleep 时长判断正确性；真实 PTY 测试沿用 RS-T52 的稳定性约定（探针中重复 10 次）。

##### RS-T61（P1）PD-13 托盘降级：创建失败或无托盘宿主时应用仍可退出

- **对应：** PD-13、R2 应用退出；当前 `setup_tray(app.handle())?` 失败会让整个应用启动失败（`lib.rs`），而默认关闭行为是“最小化到托盘”，无托盘宿主时窗口隐藏后无法找回
- **关联审查编号：** S3H-A15；PD-13
- **位置：** `src-tauri/src/services/app_lifecycle.rs`（SEAM-25）的 `tests` 模块；`models/app_setting.rs`；三平台
- **前置：** SEAM-25（`TrayAvailability`、`effective_close_behavior`、带 `tray` 参数的 `decide_close_request`、可注入失败的 `setup_tray_or_degrade`）。
- **测试一 `close_decision_matrix_with_tray_availability`：** 表驱动，每行新建上下文：

  | 窗口 label                      | 已保存的关闭行为 | 托盘        | 期望             |
  | ------------------------------- | ---------------- | ----------- | ---------------- |
  | `main`                          | MinimizeToTray   | Available   | `HideToTray`     |
  | `main`                          | MinimizeToTray   | Unavailable | `RequestAppExit` |
  | `main`                          | Quit             | Available   | `RequestAppExit` |
  | `main`                          | Quit             | Unavailable | `RequestAppExit` |
  | `terminal-<规范 UUID>`          | MinimizeToTray   | Unavailable | `NotMainWindow`  |
  | `workspace-content-<规范 UUID>` | Quit             | Unavailable | `NotMainWindow`  |
  | `MAIN`（大小写不同）            | Quit             | Unavailable | `NotMainWindow`  |

- **测试二 `degradation_never_rewrites_the_saved_close_behavior`：** 数据库里保存 `MinimizeToTray`，托盘降级为 `Unavailable` 后 `effective_close_behavior` 返回 `Quit`，但 `app_setting_repo::get_close_behavior` 仍返回 `MinimizeToTray`（用户设置不被改写）；托盘恢复可用后（例如重启）行为恢复为已保存的值。
- **测试三 `tray_creation_failure_is_logged_and_does_not_abort_startup`：** `setup_tray_or_degrade(|| Err(tauri::Error::Anyhow(anyhow!("no tray host"))))` 返回 `Unavailable { reason }`，`reason` 包含原错误文本，并产生一条 `warn` 级日志（用测试 logger 或返回值断言，二选一，须写进实现）；`setup` 的后续步骤继续执行（用计数闭包证明）。创建成功时返回 `Available`。
- **测试四 `exit_request_still_goes_through_the_exit_gate_when_tray_is_unavailable`：** `Unavailable` 下主窗口关闭得到 `RequestAppExit`，之后 `decide_exit_request` 对有脏文件或运行中 PTY 的状态仍返回 `PreventAndAskMain`（关闭不会绕过退出确认）。
- **反向断言：** 降级期间不得再创建托盘事件监听；`Unavailable` 不得被缓存为永久状态写入数据库。
- **预期当前：** 失败或编译失败（没有 `TrayAvailability`，创建失败即启动失败）。
- **稳定性：** 确定性；不创建真实托盘，纯函数加注入的失败闭包。
- **UX 备注：** 设置页对“托盘不可用”给出说明属于后续体验项，不在本规格范围。

##### RS-T62（P1）PD-10 折叠大小写：探测钩子、flag 与 PathKey（实现被平台调研阻塞的骨架）

- **对应：** PD-10、S3I-A14；主报告 4.7.2（探测前置钩子 + flag + 统一 PathKey；设计由用户提出）
- **关联审查编号：** S3I-A14；PD-10
- **状态：** **全部用例 `#[ignore = "待 PD-10 平台调研结论确认"]`。** 设计草案已评审通过（主报告 4.7.4）；实现前必须完成主报告 4.7.2.12 的调研任务（RW6 步骤 8），调研结论回写并经用户确认后本规格再细化并解除 ignore。
- **备注（平台实现细则，均为待调研核实）：** 本骨架只固定“抽象与行为”，**不固定任何平台 API 常量与文件系统类型表**。flag 是 `PathSemantics { case: Sensitive | Insensitive | Unknown, normalization_insensitive: Yes | No | Unknown }` 两根轴；探测以“项目根所在位置”为准，不以操作系统为准；行为探测首选只读的“已有条目换大小写 + 文件身份比较”，创建临时文件仅作最后手段；`Unknown` 一律不折叠；文件身份兜底是安全网，探测只是先验、不能保证。
- **前置：** SEAM-27（`CaseSensitivityProbe`、`PathSemantics`、`FixedCaseSensitivityProbe`、`probe_with_steps`、`PathKey::of`、`CaseSensitivityCache`、可注入时钟）。
- **测试一 `path_key_behaves_per_flag`（`platform/path_key.rs`，纯函数，三平台）：** 向量来自 `contracts/fixtures/path-key-vectors.json`（与 FE-T63 共用）。flag 矩阵与期望：

  | case        | normalization_insensitive | `A.txt` 与 `a.txt` | NFC `é` 与 NFD `e` + U+0301       |
  | ----------- | ------------------------- | ------------------ | --------------------------------- |
  | Sensitive   | No                        | 键不同             | 键不同                            |
  | Sensitive   | Yes                       | 键不同             | 键相同                            |
  | Insensitive | No                        | 键相同             | 键不同                            |
  | Insensitive | Yes                       | 键相同             | 键相同                            |
  | Unknown     | Unknown                   | 键不同             | 键不同                            |
  | Insensitive | Unknown                   | 键相同             | 键不同（规范化轴 Unknown 不处理） |

  反向断言：`Unknown` 与 `Sensitive` 在任何输入上都不折叠；键保留路径分隔符，不裁剪、不改写非字母字符；折叠函数的近似性（例如 NTFS 的 upcase 表与标准折叠的差异）只在向量文件里以“待调研核实”注释，不进断言。

- **测试二 `open_for_probes_once_per_project_and_caches_by_id_and_path_snapshot`（`services/project_directory.rs`）：** `FixedCaseSensitivityProbe` 带调用计数；同一 `directory_id` 与路径快照连续 `open_for` 两次 → 探测 1 次；更新项目路径后再次 `open_for` → 重新探测；移除项目后缓存失效；`Unknown` 结果在注入时钟前进 59 秒时不重探、前进 61 秒后重探；`Sensitive` 与 `Insensitive` 不随时间过期；备份恢复完成后缓存整体失效。
- **测试三 `probe_chain_short_circuits_in_order`（`platform/case_sensitivity.rs`，经 `probe_with_steps`）：** ① 平台 API 步骤返回 `Some` → 其余步骤不被调用，项目目录列表前后一致；② 平台 API 返回 `None` 且项目根有含字母的条目 → 使用“已有条目换大小写”，不创建任何文件（目录列表前后一致）；③ 项目根为空或只有无字母的条目 → 使用临时文件步骤，探测后临时文件已删除；④ 项目根只读（Unix 用 `0555`，Windows 跳过该子用例）且没有含字母的条目 → `Unknown`，且没有创建任何文件；⑤ 所有步骤失败 → `Unknown`。
- **测试四 `existing_entry_flip_uses_file_identity`（`cfg(unix)`）：** 在 tmpfs 或普通 Linux 文件系统上：只有 `Readme.md` → 翻转为 `rEADME.MD` 找不到 → `Sensitive`；同时存在 `a.txt` 与 `A.txt` 两个独立文件 → 翻转后找到但文件身份不同 → `Sensitive`；**硬链接盲区**：`A.txt` 是 `a.txt` 的硬链接（同一 inode）时，单看身份会误判为 `Insensitive`，因此探测选取条目时必须要求普通文件且链接数为 1，唯一候选的链接数大于 1 时退到下一步（临时文件）。这条盲区写入主报告 4.7.2.11 的风险。
- **测试五 `temp_probe_leaves_no_file_on_any_path`、`probe_residue_is_hidden_and_cleaned`：** 成功、失败、超时三条路径之后项目根里都没有以 `.clp-case-probe-` 开头的文件；人为遗留一个带该前缀的文件 → 文件树列表不显示它，并在下一次探测或残留清理入口中被删除（沿用 B3R-F10 的 `.writing` 残留识别方式）。
- **测试六 `layout_dedupe_goes_through_path_key`（`models/workspace_layout.rs`、`workspace_layout_service.rs`）：** `WorkspaceLayoutDocument::validate()` 保持纯函数与字面去重（`A.txt` 与 `a.txt` 同时存在时通过）；服务层保存前用缓存 flag 计算 `PathKey`：`Insensitive` 时发现仅大小写不同的重复项返回 `layout.case_duplicate`（含 documentId 列表，登记到错误码契约）；`Sensitive`、`Unknown` 与缓存未命中时不拒绝；连续两次同一重复项被拒绝时不得进入无限重试（与 FE-T60 一致）。
- **测试七 `hydrate_merge_applies_the_documented_rules`（纯函数 `merge_case_variant_documents(layout, semantics_by_directory, identity_check)`）：** 夹具含同一目录下仅大小写不同的文档分布在两个窗格与 `detachedContents` 中：`Insensitive` 且身份相同 → 保留布局树遍历顺序中先出现者为规范文档（保留其 `id` 与字面路径），其余引用重写到规范文档，同一文档只在一个窗格出现，`detachedContents` 同理；`Unknown` → 不合并；`Insensitive` 但身份检查返回“不同文件” → **不合并**（防止误探测造成误折叠）；任一路径无法取得身份（文件已被删除）→ 按 flag 判定；合并结果通过 `validate()`。
- **测试八 `unknown_flag_falls_back_to_file_identity_on_open`（`cfg(unix)`）：** `check_project_files_same_identity(directory_id, directory_path, a, b)` 命令：同一文件的两个路径返回 true，不同文件返回 false，任一路径不存在返回 `unavailable`（不是 false）；路径需通过 `open_for` 的快照校验；越界相对路径被拒绝。
- **测试九 `no_platform_branching_for_relative_path_identity`（源码扫描）：** 除 `platform/path_key.rs` 与各平台探测实现外，`models/workspace_layout.rs`、`services/file_service.rs`、`services/workspace_layout_service.rs` 中不得出现对 `relative_path` 的 `to_lowercase()`、`eq_ignore_ascii_case(`，也不得出现 `cfg(windows)` 或 `cfg(target_os = "macos")`；TS 侧由 FE-T63 扫描。
- **测试十（真实探测，`#[ignore = "需特殊卷，转实机 W-20/M-19/L-19"]`）：** 每个平台各一个用例，在测试环境可构造的位置上调用 `NativeCaseSensitivityProbe`，期望值写在实机清单里并标“待调研核实”：Linux tmpfs → `Sensitive`；macOS 默认 APFS 卷 → `Insensitive`；Windows 默认 NTFS 目录 → `Insensitive`，用 `fsutil file setCaseSensitiveInfo` 启用后 → `Sensitive`（部分系统需要先启用相关可选组件，不可用时转实机并记录）。vfat 回环挂载、ext4 casefold 目录、区分大小写的 APFS 磁盘映像需要特权或手工创建，只放实机清单。
- **预期当前：** 全部编译失败（模块与类型不存在）；评审通过并实现后再启用。
- **稳定性：** 假探测器与可注入时钟保证确定性；涉及真实文件系统的用例各自用 `tempfile::tempdir()`。

#### P2

##### RS-T41（P2）macOS 拒绝创建非 UTF-8 文件名

- **对应：** R6 macOS
- **关联审查编号：** 本专项新发现（M6 文档“macOS 拒绝非 UTF-8”的平台假设没有测试）
- **位置：** `file_service.rs` → `tests::macos_rejects_creating_non_utf8_file_names`，`#[cfg(target_os = "macos")]`
- **步骤：** 用 `OsStr::from_bytes(b"bad-\xff.txt")` 作为文件名调用 `fs::write`。
- **断言：** 返回 Err，且 `raw_os_error() == Some(libc::EILSEQ)`；之后列目录结果为空、跳过计数为 0。
- **预期当前：** 通过（补齐“macOS 非 UTF-8 拒绝”的证据）。
- **稳定性：** 确定性。

##### RS-T42（P2）安装计划测试改为确定性

- **对应：** R1、弱测试 #7
- **关联审查编号：** N3（4 个安装测试在 CI 上不断言任何东西）
- **位置：** `install_service.rs` 中的 4 个 `if let Ok` 测试，以及新增的 `claude_update_plan_for_uses_builtin_command`、`antigravity_update_plan_for_uses_builtin_command`、`codex_unix_update_plan_for_uses_builtin_command`
- **前置：** SEAM-16。
- **断言：** 用固定路径（Windows `C:\tools\claude.exe`，Unix `/opt/claude/bin/claude`）调用 `update_plan_for`，断言 `args == ["update"]`、`program` 等于该路径、`preview` 非空、`fingerprint` 非空。删除所有 `if let Ok`。
- **预期当前：** 抽取后通过。
- **稳定性：** 确定性。

##### RS-T44（P2）Windows 符号链接越界测试不再静默通过

- **对应：** R2 文件授权、R3、弱测试 #9
- **关联审查编号：** 本专项新发现（弱测试 #9）
- **位置：** 改写 `file_service.rs::tests::refuses_symbolic_link_escape`
- **断言：** `symlink_dir` 失败时，如果设置了环境变量 `CI` 就 `panic!("CI 必须能创建符号链接: {err}")`；否则 `eprintln!("SKIPPED: …")` 后返回。
- **预期当前：** GitHub Windows runner 以管理员运行，应通过。
- **稳定性：** 确定性。

##### RS-T45（P2）跨进程 worker 不再计入测试总数

- **对应：** R8、弱测试 #10
- **关联审查编号：** N1（相关测试夹具）
- **位置：** `file_cas.rs::tests::cross_process_cas_worker` 加 `#[ignore = "仅由 separate_processes_* 以子进程调用"]`；父测试 spawn 参数改为 `["--ignored","--exact",…,"--nocapture"]`
- **断言：** 父测试行为不变；三平台执行数各减 1；CI-02 清单中加入 `allowedIgnored`，`minimumPassed` 同步下调 1。
- **预期当前：** 通过。
- **稳定性：** 同 RS-T04。

##### RS-T46（P2）退出授权会过期

- **对应：** R2 应用退出
- **关联审查编号：** B2-F01（残留风险）
- **位置：** `app_lifecycle.rs` → `tests::exit_authorization_expires_and_cannot_be_reused`
- **前置：** SEAM-19。
- **断言：** `authorize_at(t0)` 后，`consume_authorization_at(t0+6s)` 为 false；`authorize_at(t0)` 后，`consume_authorization_at(t0+1s)` 为 true，再次调用为 false。
- **预期当前：** 失败（尚未实现），揭示残留风险。
- **稳定性：** 注入时钟，确定性。

##### RS-T47（P2）恢复前开始的索引刷新在恢复后被丢弃

- **对应：** J1、R8
- **关联审查编号：** J1、N7
- **位置：** `session_service.rs` → `tests::index_refresh_started_before_restore_is_discarded_after_restore`
- **前置：** SEAM-20。
- **步骤：** 记录 generation g0 → 模拟恢复把 generation 加 1 → 刷新流程用 g0 尝试写缓存。
- **断言：** 写入被拒绝（返回 `Discarded`），缓存中没有目录 1 的文档。
- **预期当前：** 失败（尚未实现）。
- **稳定性：** 确定性。

##### RS-T48（P2）旧版本命名布局都能正确应用

- **对应：** R9 布局 v1..v5
- **关联审查编号：** 与 N16 同属布局版本兼容性问题（R9）
- **位置：** `workspace_layout_service.rs` → `tests::applying_presets_saved_by_every_supported_layout_version`
- **步骤：** 复用 `models::workspace_layout` 中 v1~v4 的迁移夹具 JSON（可与 RS-T56 共用 `legacy_payload_json`），按对应 `schema_version` 直接插入 preset 行，然后 `plan_apply_preset`。
- **断言：** 每个版本都返回 Ok，`layout.validate()` 为 Ok，文件文档与 slot 数量和夹具一致。
- **预期当前：** 应通过（补 R9 证据）。
- **稳定性：** 确定性。

##### RS-T51（P2）平台非法文件名只降级该项，不导致整份布局重置

- **对应：** R3 布局逐项降级
- **关联审查编号：** S1D-N08、S1D-N13 相关；S2（失败处理只有两个极端）
- **位置：** `workspace_layout_service.rs` → `tests::current_layout_with_platform_invalid_file_name_degrades_the_item`，`#[cfg(windows)]`
- **步骤：** 当前布局 JSON 中含 `relative_path: "notes:final.txt"`（在 Unix 上合法），调用 `read_current`。
- **断言：** 返回的布局可用：该文档被替换为占位或 Unknown，并标记 `incomplete`；**不是** needs_reset。
- **预期当前：** 返回 needs_reset，揭示缺陷（PD-11 已确认：单项降级为占位，其余布局保持）。
- **PD-11 已确认：** 降级项显示占位并带可读原因；其余窗格、比例、焦点保持不变；该布局仍可保存且不进入 needsReset，也不触发保存队列的重试循环（与 FE-T60 的停止条件一致）。
- **稳定性：** 确定性。

##### RS-T55（P2）会话归属校验受预算约束

- **对应：** R3 适配器隔离与超时
- **关联审查编号：** N15（本专项新发现）、B1-F07
- **位置：** `session_service.rs` → `tests::session_ownership_check_is_bounded_by_budget`，`#[tokio::test]`
- **前置：** SEAM-08；static adapter 的 `session_belongs_to_directory` 内部 `tokio::time::sleep(5s)`。
- **断言：** 在 300 ms 预算下 1.5 秒内返回 Err，消息含“超时”。
- **预期当前：** 现有函数没有超时，揭示缺陷（N15）。
- **稳定性：** 余量充足。

##### RS-T63（P2）PD-14 验收构建：`acceptance-hooks` 仅为可选 feature，且不进入发布包

- **对应：** PD-14、SEAM-18、CI-10；`WebviewWindow::destroy()` 是 B3R-F05 与 S1A-N02 实机强制销毁验证的确定手段，不能进入发布产物
- **关联审查编号：** B3R-F05、S1A-N02；PD-14
- **位置：** `src-tauri/src/contracts.rs` → `tests::acceptance_hooks_feature_is_opt_in_and_gated`，三平台（无 cfg）
- **步骤与断言：**
  1. 读 `src-tauri/Cargo.toml`：`[features]` 中存在 `acceptance-hooks = []`，且 `default` 列表不含它；
  2. 扫描 `src-tauri/src/**/*.rs`：凡出现标记字符串 `acceptance.force_destroy_windows` 的位置，其所在项（函数、闭包或块）必须带 `#[cfg(feature = "acceptance-hooks")]`（实现可以是“向上查找最近的属性行，12 行内必须出现该 cfg”的保守扫描）；
  3. `release.yml`、`package.json`、`src-tauri/tauri*.conf.json` 与 `src-tauri/capabilities/*.json` 中都不出现 `acceptance-hooks`；
  4. 菜单文案“验收：强制销毁全部独立窗口”只出现在带该 cfg 的代码里。
- **反向断言：** 不得把该 feature 加进 `default`、`tauri.conf.json` 的 `build.features`，也不得通过环境变量在发布流程里启用。
- **预期当前：** 失败（feature 不存在）；实现 SEAM-18 后转绿。
- **配合：** CI-10 对发布产物做二进制字符串检查，RS-T63 守住源码与配置侧；两者缺一不可。
- **稳定性：** 确定性；纯文本扫描。

### 6. CI 改进规格（含 YAML 片段）

所有 `run` 步骤统一 `shell: bash`（Windows runner 自带 Git Bash）。`actions/upload-artifact` 的大版本先用 `gh api repos/actions/upload-artifact/releases/latest --jq .tag_name` 确认，与仓库现用的 `checkout@v7` 保持同代；下文以 `@v4` 占位。

#### CI-01（P0）输出测试清单与执行清单作为 artifact，失败时上传日志

```yaml
- name: Prepare report directory
  run: mkdir -p test-reports
- name: List Rust tests
  if: ${{ !cancelled() && steps.rust_check.outcome == 'success' }}
  run: |
    set -o pipefail
    cargo test --manifest-path src-tauri/Cargo.toml --locked -- --list \
      | sed -n 's/: test$//p' | sort > "test-reports/rust-listed-${RUNNER_OS}.txt"
    echo "listed=$(wc -l < "test-reports/rust-listed-${RUNNER_OS}.txt")"
- name: Run Rust tests
  id: rust_tests
  if: ${{ !cancelled() && steps.rust_check.outcome == 'success' }}
  run: |
    set -o pipefail
    cargo test --manifest-path src-tauri/Cargo.toml --locked 2>&1 | tee "test-reports/rust-test-${RUNNER_OS}.log"
- name: Extract executed Rust tests
  if: ${{ !cancelled() && steps.rust_check.outcome == 'success' }}
  run: |
    grep -E '^test [^ ]+ \.\.\. (ok|FAILED|ignored)$' "test-reports/rust-test-${RUNNER_OS}.log" \
      | awk '{print $2, $4}' | sort -u > "test-reports/rust-executed-${RUNNER_OS}.txt"
- name: Upload test reports
  if: ${{ always() }}
  uses: actions/upload-artifact@v4
  with:
    name: test-reports-${{ matrix.os }}
    path: test-reports/
    if-no-files-found: warn
    retention-days: 14
```

#### CI-02（P0）平台专属测试必须真正执行，并设总数下限

新增 `contracts/rust-platform-tests.json`：

```json
{
  "version": 1,
  "minimumPassed": { "Windows": 297, "Linux": 298, "macOS": 296 },
  "allowedIgnored": [],
  "required": {
    "all": [
      "contracts::app_command_contract_matches_the_registered_handler",
      "contracts::content_kind_contract_matches_rust_serialization",
      "contracts::tauri_csp_defines_production_and_development_policies",
      "contracts::tool_key_contract_matches_the_rust_registry",
      "contracts::window_kind_contract_matches_capabilities",
      "contracts::window_kind_contract_matches_rust_registry",
      "platform::file_cas::tests::separate_processes_using_same_revision_allow_only_one_winner"
    ],
    "Windows": [
      "commands::cli_status::tests::preserves_version_only_when_resolved_path_is_unchanged",
      "models::workspace_layout::tests::workspace_layout_rejects_windows_ads_and_reserved_file_names",
      "platform::detect::tests::known_windows_install_dirs_include_user_local_bin",
      "platform::execution_process::windows::tests::failed_job_attachment_terminates_pty_process",
      "platform::execution_process::windows::tests::job_object_terminates_attached_process",
      "platform::execution_process::windows::tests::job_object_terminates_pty_process",
      "platform::file_cas::tests::replacement_preserves_protected_target_acl",
      "platform::file_cas::tests::temporary_acl_is_private_and_replacement_preserves_inherited_target_acl",
      "platform::file_cas::tests::unconditional_replacement_preserves_readonly_attribute",
      "platform::file_cas::tests::windows_network_rename_paths_are_classified_and_built_without_root_handle",
      "platform::path_identity::tests::windows_paths_ignore_case_and_separator_style",
      "platform::path_rules::tests::windows_rejects_ads_reserved_names_and_trailing_dots",
      "platform::process::tests::windows_script_extensions_select_native_hosts",
      "platform::windows_environment::tests::appends_registered_entries_missing_from_isolated_path",
      "platform::windows_environment::tests::deduplicates_case_and_trailing_separators",
      "services::cli_adapters::hermes::platform::windows_managed_install_tests::managed_source_update_requires_default_bin_and_git_checkout",
      "services::file_service::tests::retained_project_handle_prevents_root_directory_replacement",
      "services::install_service::tests::antigravity_uses_official_installer",
      "services::install_service::tests::claude_install_uses_winget_official_package",
      "services::install_service::tests::codex_install_uses_official_windows_installer",
      "services::install_service::tests::codex_update_uses_builtin_command_under_windows_powershell_5_1",
      "services::install_service::tests::grok_install_uses_fixed_official_windows_script_and_preview",
      "services::install_service::tests::powershell_argument_escapes_single_quotes",
      "services::session_service::tests::file_uri_matches_windows_path_and_decodes_spaces",
      "services::session_service::tests::paths_match_ignores_separators_and_case"
    ],
    "unix": [
      "commands::cli_status::tests::preserves_version_with_unix_path_semantics",
      "models::workspace_layout::tests::workspace_layout_uses_unix_file_name_rules",
      "platform::detect::tests::known_directory_requires_executable_permission",
      "platform::execution_process::unix::tests::process_group_terminates_pty_process",
      "platform::execution_process::unix::tests::process_group_terminates_shell_and_descendant",
      "platform::file_cas::tests::permission_restore_failure_after_rename_is_a_warning_not_a_save_error",
      "platform::file_cas::tests::replacement_preserves_mode_and_starts_with_private_temporary_mode",
      "platform::path_identity::tests::unix_paths_preserve_case_and_ignore_trailing_separator",
      "platform::path_rules::tests::unix_allows_colon_and_backslash_as_filename_characters",
      "platform::process::tests::timeout_kills_descendants_that_ignore_terminate_after_root_exits",
      "services::cli_adapters::claude::common::tests::native_update_command_uses_install_home_not_isolated_app_home",
      "services::cli_adapters::claude::common::tests::version_probe_disables_automatic_updates_and_uses_native_home",
      "services::cli_adapters::claude::platform::tests::ignores_non_native_claude_binary_layouts",
      "services::cli_adapters::claude::platform::tests::resolves_home_from_native_versioned_binary",
      "services::cli_adapters::hermes::platform::posix_managed_install_tests::managed_source_install_requires_default_launcher_and_checkout",
      "services::cli_adapters::hermes::platform::tests::posix_install_uses_official_non_interactive_source_installer",
      "services::file_service::tests::atomically_replaces_write_only_destination",
      "services::file_service::tests::opening_a_fifo_returns_without_waiting_for_a_writer",
      "services::file_service::tests::retained_project_capability_survives_root_path_replacement",
      "services::file_service::tests::text_file_save_preserves_existing_permissions",
      "services::file_service::tests::unix_lists_and_opens_colon_backslash_and_unicode_file_names",
      "services::install_service::tests::codex_update_uses_builtin_command",
      "services::session_service::tests::file_uri_matches_unix_path_and_preserves_case"
    ],
    "Linux": [
      "services::file_service::tests::listing_scan_budget_covers_entries_skipped_for_unreadable_names",
      "services::file_service::tests::listing_skips_non_utf8_names_and_reports_the_count",
      "services::install_service::tests::linux_installs_use_fixed_official_scripts"
    ],
    "macOS": [
      "services::install_service::tests::macos_installs_use_fixed_official_scripts"
    ]
  }
}
```

新增 `scripts/ci/assert-rust-test-inventory.mjs`：

```js
import { readFileSync } from "node:fs";

const [platform, listedPath, executedPath] = process.argv.slice(2);
const manifest = JSON.parse(
  readFileSync("contracts/rust-platform-tests.json", "utf8"),
);
const lines = (path) =>
  readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
const listed = new Set(lines(listedPath));
const executed = new Map(lines(executedPath).map((line) => line.split(" ")));
const errors = [];

const floor = manifest.minimumPassed[platform];
if (floor === undefined) errors.push(`unknown platform ${platform}`);
const passed = [...executed.values()].filter(
  (status) => status === "ok",
).length;
if (passed < floor)
  errors.push(`${platform}: only ${passed} passed, floor ${floor}`);

const groups = [
  "all",
  platform,
  ...(platform === "Linux" || platform === "macOS" ? ["unix"] : []),
];
for (const name of groups.flatMap((group) => manifest.required[group] ?? [])) {
  if (!listed.has(name))
    errors.push(`required test not compiled on ${platform}: ${name}`);
  else if (executed.get(name) !== "ok")
    errors.push(
      `required test did not pass: ${name} (${executed.get(name) ?? "not executed"})`,
    );
}
for (const [name, status] of executed) {
  if (status === "ignored" && !manifest.allowedIgnored.includes(name))
    errors.push(`unexpected ignored: ${name}`);
}
for (const name of listed) {
  if (!executed.has(name)) errors.push(`listed but not executed: ${name}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`${platform}: ${passed} passed / ${listed.size} listed`);
```

```yaml
- name: Assert Rust test inventory
  if: ${{ !cancelled() && steps.rust_tests.outcome != 'skipped' }}
  run: node scripts/ci/assert-rust-test-inventory.mjs "${RUNNER_OS}" "test-reports/rust-listed-${RUNNER_OS}.txt" "test-reports/rust-executed-${RUNNER_OS}.txt"
```

规则：每次增删测试时，同步更新 `minimumPassed` 和 `required`。RS-T45 落地后（worker 改为 `#[ignore]`），三平台 `minimumPassed` 各下调 1，并把 `cross_process_cas_worker` 放进 `allowedIgnored`；RS-T56~RS-T58 的新测试落地后，把 `contracts::ipc_dto_variants_serialize_with_camel_case_field_names`、`contracts::serialize_items_with_multiword_fields_declare_camel_case_renaming`、`contracts::golden_fixtures_match_serialized_dtos`、`contracts::confirm_app_exit_takes_a_request_id_and_frontend_reads_the_payload_field` 加入 `required.all`，并按实际函数名与模块路径为准。

#### CI-03（P1）前端测试失败时 Rust 步骤仍然执行，并输出 vitest junit

```yaml
- name: Install dependencies
  id: install
  run: pnpm install --frozen-lockfile
- name: Run frontend tests
  id: frontend_tests
  if: ${{ !cancelled() && steps.install.outcome == 'success' }}
  run: pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=test-reports/vitest-junit.xml
- name: Build frontend
  id: frontend_build
  if: ${{ !cancelled() && steps.install.outcome == 'success' }}
  env:
    NODE_OPTIONS: --max-old-space-size=4096
  run: pnpm run build
- name: Check Rust formatting
  if: ${{ !cancelled() && steps.frontend_build.outcome == 'success' }}
  run: cargo fmt --manifest-path src-tauri/Cargo.toml --check
- name: Check Rust compilation
  id: rust_check
  if: ${{ !cancelled() && steps.frontend_build.outcome == 'success' }}
  run: cargo check --manifest-path src-tauri/Cargo.toml --locked
```

只要任一步失败，job 仍会是 failure，但 Rust 测试的证据不会丢失。

#### CI-04（P0）修正并发组（S1D-N10）

问题：被 `release.yml` 通过 workflow_call 调用时，`github.ref` 用的是调用方的 ref。如果在 main 上手动触发 Release，组名就是 `ci-refs/heads/main`，和普通 push CI 冲突，`cancel-in-progress: true` 会互相取消。

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: ${{ github.workflow == 'CI' }}
```

在被调用的 workflow 里，`github.workflow` 是调用方名称“Release”，因此组名会是 `ci-Release-…`，不再与 CI 冲突，且 Release 调用不会被取消。

**验证步骤：** 先 push 一个 docs 提交到 main（触发 CI）；在其运行期间执行 `gh workflow run release.yml --ref main`；用 `gh run list --workflow ci.yml` 和 `gh run list --workflow release.yml` 确认两边都没有 `cancelled`。

#### CI-05（P1）flaky 探针工作流

新增 `.github/workflows/flaky-probe.yml`：

```yaml
name: Flaky probe

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:
    inputs:
      repeat:
        default: "20"
      filter:
        default: "platform::file_cas"
      cas_rounds:
        default: "50"

permissions:
  contents: read

concurrency:
  group: flaky-probe-${{ github.ref }}
  cancel-in-progress: true

jobs:
  probe:
    name: Probe (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 90
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-latest, windows-latest]
    defaults:
      run:
        shell: bash
    env:
      REPEAT: ${{ inputs.repeat || '20' }}
      FILTER: ${{ inputs.filter || 'platform::file_cas' }}
      CLI_LAUNCHPAD_CAS_ROUNDS: ${{ inputs.cas_rounds || '50' }}
      RUST_BACKTRACE: "1"
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable
      - name: Install Linux build dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev xdg-utils
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri -> target
      - name: Placeholder frontend dist
        run: mkdir -p dist && echo '<!doctype html><title>probe</title>' > dist/index.html
      - name: Build tests
        run: cargo test --manifest-path src-tauri/Cargo.toml --locked --no-run
      - name: Repeat filtered tests
        run: |
          mkdir -p probe
          fails=0
          for i in $(seq 1 "$REPEAT"); do
            if ! cargo test --manifest-path src-tauri/Cargo.toml --locked -- "$FILTER" --include-ignored > "probe/run-$i.log" 2>&1; then
              fails=$((fails+1))
              cp "probe/run-$i.log" "probe/failed-$i.log"
            fi
          done
          echo "failures=$fails/$REPEAT" | tee probe/summary.txt
          test "$fails" -eq 0
      - name: Upload probe logs
        if: ${{ always() }}
        uses: actions/upload-artifact@v4
        with:
          name: flaky-probe-${{ matrix.os }}
          path: probe/
          retention-days: 14
```

`--include-ignored` 会把 RS-T02 的刻画测试也跑起来；它预期能复现上游行为，所以失败数统计中需要单独处理：建议把刻画测试的名字排除在 `FILTER` 之外（`--skip cap_std_canonicalize_can_return_deleted_suffix`），单独跑一步。

#### CI-06（P1）扩展架构矩阵

发布产物包含 Windows ARM64、Linux ARM64、macOS x64，但 CI 从未在这些架构上运行测试。

ci.yml 增加 workflow_call 输入：

```yaml
on:
  workflow_call:
    inputs:
      extended_matrix:
        type: boolean
        default: false
```

```yaml
strategy:
  fail-fast: false
  matrix:
    os: ${{ fromJSON((inputs.extended_matrix || github.event_name == 'schedule') && '["windows-latest","macos-latest","ubuntu-24.04","windows-11-arm","ubuntu-24.04-arm","macos-15-intel"]' || '["windows-latest","macos-latest","ubuntu-24.04"]') }}
```

并在 `on:` 下增加 `schedule: [{ cron: "41 2 * * *" }]`。

release.yml：

```yaml
ci:
  name: Cross-platform test suite
  needs: validate
  uses: ./.github/workflows/ci.yml
  with:
    extended_matrix: true
```

注意：`macos-15-intel` 标签在执行前要查 GitHub runner 文档确认仍然可用。CI-02 的 `runner.os` 在 ARM 上仍是 Windows、Linux、macOS，下限值共用即可。

#### CI-07（P1）超时、锁文件与回溯

job 级加 `timeout-minutes: 60`；所有 `cargo` 命令加 `--locked`；`env.RUST_BACKTRACE` 改为 `"1"`（失败日志带完整调用栈，现在是 `short`）。

#### CI-08（P2）测试反模式检查

新增 `scripts/ci/check-rust-test-antipatterns.sh`，在 Linux job 中执行：

```bash
#!/usr/bin/env bash
set -euo pipefail
hits=$(awk '/#\[cfg\(test\)\]/{t=1} t && /if let Ok\(/{print FILENAME":"FNR": "$0}' $(git ls-files 'src-tauri/src/**/*.rs') || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo "测试中禁止 if let Ok 静默通过"
  exit 1
fi
```

```yaml
- name: Check Rust test anti-patterns
  if: runner.os == 'Linux'
  run: bash scripts/ci/check-rust-test-antipatterns.sh
```

#### CI-09（P1）golden fixture 不得在 CI 中被改写（随 RS-T57 追加）

`golden_fixtures_match_serialized_dtos` 默认只比较，不写文件；仍用一步 diff 防止有人误设 `UPDATE_CONTRACT_FIXTURES=1`：

```yaml
- name: Assert contract fixtures are unchanged
  if: ${{ !cancelled() && steps.rust_tests.outcome != 'skipped' }}
  run: git diff --exit-code -- contracts/fixtures
```

#### CI-10（P1）acceptance-hooks 验收构建的构建检查与不进入发布包检查（PD-14）

- **目的：** PD-14 已确认采用 `acceptance-hooks` cargo feature，用于实机验收时强制销毁子窗口（SEAM-18）。该 feature 只能出现在验收构建中，**不得进入发布包与默认构建**。
- **一、验收构建（手动触发，不属于发布流程）：** 新增 `.github/workflows/acceptance-build.yml`，`workflow_dispatch`，三平台各构建一次，产物名带 `acceptance` 标识并设置较短保留期：

```yaml
name: Acceptance build

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    name: Acceptance build (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 60
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest, ubuntu-24.04]
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v7
      # pnpm、Node、Rust 与 Linux 依赖的准备步骤与 ci.yml 完全相同，此处省略，实现时复制
      - name: Build with acceptance hooks
        run: pnpm tauri build --features acceptance-hooks # 执行前以 `pnpm tauri build --help` 核对 --features 选项（待核实）
      - name: Upload acceptance artifacts
        uses: actions/upload-artifact@v4
        with:
          name: acceptance-${{ matrix.os }}
          path: src-tauri/target/release/bundle/
          retention-days: 7
```

- **二、发布流程守卫：** 在 `release.yml` 的每个平台构建完成之后增加一步，对**发布产物的二进制**做字符串检查：二进制中不得包含菜单项标记 `acceptance.force_destroy_windows`（该字符串只会出现在带 `#[cfg(feature = "acceptance-hooks")]` 的代码里，见 RS-T63）：

```bash
# release.yml 构建完成后（二进制路径以 `cargo metadata` 得到的实际二进制名为准，下面以 cli-launchpad 为占位，待核实）
BIN="src-tauri/target/release/cli-launchpad"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
if grep -a -q "acceptance.force_destroy_windows" "$BIN"; then
  echo "发布产物包含 acceptance-hooks 标记，禁止发布" >&2
  exit 1
fi
```

- **三、默认构建的编译检查：** 在 `ci.yml` 的 Linux 作业里增加一步 `cargo check --manifest-path src-tauri/Cargo.toml --features acceptance-hooks --locked`，保证该 feature 不会因长期无人编译而腐烂；同时默认构建（不带 feature）的检查步骤保持不变。
- **四、配合：** RS-T63 守住源码与配置侧（feature 不在 `default`、标记只在 cfg 内、发布配置不引用该 feature）；本项守住产物侧；实机验收见 X-25。
- **验收：** 手动触发 acceptance-build 三平台成功；故意在 `release.yml` 里加上 `--features acceptance-hooks` 时 RS-T63 与发布守卫都会失败（在专用分支上验证后还原）。

#### 合并后的 ci.yml 完整版（供 Codex 直接替换）

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
  schedule:
    - cron: "41 2 * * *"
  workflow_call:
    inputs:
      extended_matrix:
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: ${{ github.workflow == 'CI' }}

env:
  CARGO_INCREMENTAL: "0"
  RUST_BACKTRACE: "1"

jobs:
  test:
    name: Test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 60
    strategy:
      fail-fast: false
      matrix:
        os: ${{ fromJSON((inputs.extended_matrix || github.event_name == 'schedule') && '["windows-latest","macos-latest","ubuntu-24.04","windows-11-arm","ubuntu-24.04-arm","macos-15-intel"]' || '["windows-latest","macos-latest","ubuntu-24.04"]') }}
    defaults:
      run:
        shell: bash
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
      - name: Install pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 11.21.0
          run_install: false
      - name: Install Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
      - name: Install Linux build dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential curl wget file libxdo-dev libssl-dev \
            libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev xdg-utils
      - name: Restore Rust cache
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri -> target
      - name: Prepare report directory
        run: mkdir -p test-reports
      - name: Install dependencies
        id: install
        run: pnpm install --frozen-lockfile
      - name: Run frontend tests
        id: frontend_tests
        if: ${{ !cancelled() && steps.install.outcome == 'success' }}
        run: pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit=test-reports/vitest-junit.xml
      - name: Build frontend
        id: frontend_build
        if: ${{ !cancelled() && steps.install.outcome == 'success' }}
        env:
          NODE_OPTIONS: --max-old-space-size=4096
        run: pnpm run build
      - name: Check Rust formatting
        if: ${{ !cancelled() && steps.frontend_build.outcome == 'success' }}
        run: cargo fmt --manifest-path src-tauri/Cargo.toml --check
      - name: Check Rust compilation
        id: rust_check
        if: ${{ !cancelled() && steps.frontend_build.outcome == 'success' }}
        run: cargo check --manifest-path src-tauri/Cargo.toml --locked
      - name: Check Rust test anti-patterns
        if: ${{ !cancelled() && runner.os == 'Linux' }}
        run: bash scripts/ci/check-rust-test-antipatterns.sh
      - name: List Rust tests
        if: ${{ !cancelled() && steps.rust_check.outcome == 'success' }}
        run: |
          set -o pipefail
          cargo test --manifest-path src-tauri/Cargo.toml --locked -- --list \
            | sed -n 's/: test$//p' | sort > "test-reports/rust-listed-${RUNNER_OS}.txt"
      - name: Run Rust tests
        id: rust_tests
        if: ${{ !cancelled() && steps.rust_check.outcome == 'success' }}
        run: |
          set -o pipefail
          cargo test --manifest-path src-tauri/Cargo.toml --locked 2>&1 | tee "test-reports/rust-test-${RUNNER_OS}.log"
      - name: Extract executed Rust tests
        if: ${{ !cancelled() && steps.rust_check.outcome == 'success' }}
        run: |
          grep -E '^test [^ ]+ \.\.\. (ok|FAILED|ignored)$' "test-reports/rust-test-${RUNNER_OS}.log" \
            | awk '{print $2, $4}' | sort -u > "test-reports/rust-executed-${RUNNER_OS}.txt"
      - name: Assert Rust test inventory
        if: ${{ !cancelled() && steps.rust_tests.outcome != 'skipped' }}
        run: node scripts/ci/assert-rust-test-inventory.mjs "${RUNNER_OS}" "test-reports/rust-listed-${RUNNER_OS}.txt" "test-reports/rust-executed-${RUNNER_OS}.txt"
      - name: Assert contract fixtures are unchanged
        if: ${{ !cancelled() && steps.rust_tests.outcome != 'skipped' }}
        run: git diff --exit-code -- contracts/fixtures
      - name: Upload test reports
        if: ${{ always() }}
        uses: actions/upload-artifact@v4
        with:
          name: test-reports-${{ matrix.os }}
          path: test-reports/
          if-no-files-found: warn
          retention-days: 14
```

### 7. 三平台实机验收清单

#### 7.0 适用三平台的记录规则

- **构建：** 使用 M6 候选提交的正式安装包。CSP 和 Monaco 检查（W-15、M-15、L-15）另外使用 `pnpm tauri build --debug` 生成的构建。debug 构建使用生产 `csp`，并开启 devtools；`devCsp` 只在 `tauri dev` 下生效。
- **证据目录：** 在仓库外建 `acceptance-evidence/M6/<平台>-<YYYYMMDD>/`。截图命名 `<条目ID>-<步骤号>.png`。日志在 `<HOME>/.cli-launchpad/logs/` 下的 `cli-launchpad*.log`，每项摘录对应时间段。
- **结果：** 只填“通过 / 失败 / 阻塞 / 跳过”；失败、阻塞、跳过必须附最短复现步骤。
- **单实例：** 应用启用了 single-instance 插件。启动测试实例前，必须先从托盘退出所有已运行的实例。
- **条目与 M6 清单的对应：** 各平台的 xx-01 至 xx-06 对应 M6-F01 至 M6-F06，xx-07 对应 M6-F07，xx-09 同时覆盖 M6-F08 与重复 reattach，xx-10 对应 B3R-F05，xx-12 对应 M6-F09 与 J1，xx-13 对应 M6-F10，xx-14 对应 M6-F11。

#### 7.1 Windows 清单（W-xx）

**W-00 环境准备**

- 前置：Windows 11，记录版本号（`winver` 截图）、显示缩放和分辨率、WebView2 版本（`Get-AppxPackage *WebView2*` 或“应用和功能”中的 WebView2 Runtime 版本）、安装包文件名及其 SHA256（`Get-FileHash`）、提交 SHA。
- 步骤：
  1. 新建本地测试账户 `clp-test`（设置 → 账户 → 其他用户），之后都在该账户下操作。原因：应用数据根目录取自系统 Profile 已知文件夹（`%USERPROFILE%\.cli-launchpad`），改环境变量无法重定向。
  2. 没有测试账户时，先退出应用，执行 `Rename-Item "$env:USERPROFILE\.cli-launchpad" ".cli-launchpad.bak-<日期>"`，并备份 `%APPDATA%\app.cli-launchpad.desktop\`；全部测试结束后再还原。
  3. 创建 `C:\clp\proj`，包含：UTF-8 文本 `a.txt`；嵌套目录 `dir 一\子 目录\`；长文件名（200 字符）；有效 PNG；二进制文件 `bin.dat`（`fsutil file createnew bin.dat 4096`）。
  4. 准备两个能启动的 CLI。
- 期望：应用首次启动，生成新的 `.cli-launchpad`。
- 证据：环境信息截图、`Get-FileHash` 输出、`dir C:\clp\proj /s` 输出。

**W-01（M6-F01）文件树**

- 前置：W-00 完成，并已添加项目 `C:\clp\proj`。
- 步骤：逐层展开嵌套目录；打开含空格、中文、长名的目录；折叠后再展开；切换到其他项目再切回；按 F5（或应用内刷新）；重启应用后再查看。
- 期望：名称可辨认；不同项目的路径不串；刷新后没有陈旧内容。
- 证据：`W-01-1..4.png`。

**W-02（M6-F02）打开与保存**

- 前置：W-01 完成。
- 步骤：打开 `a.txt`，改为 `W02-<时间>` 并保存；在文件树中再次打开同一文件；关闭标签后重新打开；独立窗口打开后再返回。
- 期望：保存成功；`Get-Content -Encoding UTF8 a.txt` 与界面一致；重复打开会聚焦已有文档。
- 证据：截图，以及 `Get-Content` 和 `Get-FileHash` 的输出。

**W-03（M6-F03 加 CAS）外部修改冲突**

- 前置：`a.txt` 已在应用中打开，并有未保存修改。
- 步骤：
  1. 用记事本修改 `a.txt` 并保存；回到应用点保存；然后选择“重新载入”。
  2. 原子替换并发测试：在 PowerShell 中运行以下循环，运行期间在应用里连续保存 5 次，然后停止循环：
     `1..200 | % { Set-Content C:\clp\proj\tmp.w03 "ext $_"; Move-Item -Force C:\clp\proj\tmp.w03 C:\clp\proj\a.txt; Start-Sleep -Milliseconds 20 }`
- 期望：第 1 步出现冲突提示，不静默覆盖，重新载入后显示磁盘内容。第 2 步每次保存都表现为“冲突”或“成功”，**不出现**“无法打开待保存文件”；目录中没有 `.writing` 残留（`Get-ChildItem -Force C:\clp\proj -Filter *.writing` 为空）。
- 证据：截图、日志摘录、`Get-ChildItem` 输出。

**W-04（M6-F04）窗格操作**

- 前置：两个窗格，并同时存在文件与 PTY 内容。
- 步骤：按 M6 文档执行关闭按钮、右键关闭当前、关闭其他、关闭全部、拖动移动和拆分；在有脏文件和运行中 PTY 的情况下再执行“关闭范围”并点取消。
- 期望：关闭范围准确；取消时不会部分关闭；内容无重复、无丢失。
- 证据：录屏 `W-04.mp4`。

**W-05（M6-F05）独立窗口交接**

- 前置：存在文件和 PTY 内容。
- 步骤：分别把文件和 PTY 打开为独立窗口 → 在独立窗口内返回窗格 → 用原生关闭按钮关闭；在脏文件和运行中 PTY 的情况下再做一遍。
- 期望：归属唯一，缓冲区不丢，PTY 持续运行。
- 证据：录屏。

**W-06（M6-F06）二进制、图片与主题**

- 前置：W-00 的测试项目包含 `bin.dat` 与有效 PNG。
- 步骤：打开 `bin.dat`、有效 PNG、把 `bin.dat` 复制为 `fake.png` 后打开；缩窄窗格；切换应用的浅色和深色主题。
- 期望：二进制和伪造图片显示“不支持”；有效 PNG 显示预览（图片预览依赖 `mimeType`、`base64Data` 字段，见 RS-T57）；长标题不遮挡操作按钮。
- 证据：截图。

**W-07（M6-F07）退出矩阵**

- 前置：设置“关闭行为”为“退出”。
- 退出路径：
  - 路径 1：主窗口标题栏的关闭按钮；
  - 路径 2：托盘菜单“退出”；
  - 路径 3：任务栏图标右键“关闭窗口”。路径 3 向主窗发送 WM_CLOSE，与路径 1 走同一条 CloseRequested，按规则记为“与路径 1 同源”。另外记录 Alt+F4 的表现。
- 步骤：对每条路径分别在四种状态下执行：无脏文件且无 PTY；只有脏文件；只有 PTY；脏文件加 PTY。先点“取消”，检查窗口、文件缓冲和 PTY；再在新一轮数据下“确认”退出，检查结果。最后把关闭行为改为“最小化到托盘”，点关闭，再从托盘恢复。
- 期望：符合 M6-F07 矩阵；最小化模式下不弹退出确认，PTY 继续运行。
- 证据：每格一张截图，以及日志中的 `app-exit` 相关行。

**W-08 Windows 注销与关机时的退出（新增观测项）**

- 前置：有一个脏文件和一个 PTY，使用临时数据。
- 步骤：开始菜单 → 注销。
- 期望：只记录观察到的现象（系统是否显示“此应用阻止注销”，或者应用直接被结束），不判定通过或失败，列为风险备注。
- 证据：照片或截图，以及重新登录后的日志。

**W-09（M6-F08 与重复 reattach）PTY 独立窗口关闭后回收**

- 前置：一个可安全停止的 PTY 会话在主窗口运行。
- 步骤：
  1. 运行一个 PTY 并独立打开；用应用的关闭和返回流程关闭独立窗口；在主窗口重新聚焦该会话并输入 `echo w09`；
  2. 再快速连续双击“重新接管”（如果 UI 提供）或重复返回操作。
- 期望：会话唯一；输入有回显；不产生重复会话；重复接管的操作不报错，或给出明确提示。
- 证据：录屏，以及日志中的 `pty-session-owner-lost`、reattach 相关行。

**W-10（B3R-F05）子窗口强制销毁**

- 前置：一个 PTY 独立窗口与一个含脏缓冲区的文件独立窗口，使用临时数据。
- 方法 A（PD-14 已确认，主方法：使用 `acceptance-hooks` 验收构建，构建方式见 CI-10）：PTY 独立窗口正在运行时，在托盘点“验收：强制销毁全部独立窗口”。
- 方法 B（备选：验收构建不可用时）：
  1. 打开独立窗口之前，在 PowerShell 记录渲染进程列表：
     `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ? CommandLine -match '--type=renderer' | Select ProcessId,ParentProcessId | Out-File before.txt`
  2. 打开独立窗口后再执行一次，得到 `after.txt`；用 `Compare-Object` 找出新增的 PID。
  3. 如果恰好新增一个 PID，执行 `Stop-Process -Id <pid> -Force`。如果没有新增，或新增多个，本方法记为“阻塞：无法单独定位”。
  4. 观察独立窗口；尝试点它的原生关闭按钮。
  5. 对文件独立窗口（含脏缓冲区）重复以上步骤。
- 期望：
  - 方法 A：窗口立即消失，主窗口收到失主通知，PTY 进程存活，主窗口可以重新接管（同 W-09）；文件窗的授权被撤销，文件内容回到主窗口时没有丢失。
  - 方法 B：记录崩溃页面的表现，以及关闭是否能完成。如果渲染进程崩溃后窗口无法关闭（JS 的关闭处理随渲染进程一起消失了），记为“失败：渲染崩溃后不可关闭”。
- 证据：录屏、`before.txt`、`after.txt`、日志。

**W-11 返回进行中时关闭独立窗口**

- 前置：PTY 独立窗口正在运行。
- 步骤：点“返回主窗口”后立即（1 秒内）点该窗口的原生关闭按钮；重复 5 次。
- 期望：每次会话都只在主窗口出现一次，可以输入；没有“会话不存在”或卡死；日志中没有 panic。
- 证据：录屏、日志。

**W-12（M6-F09 与 J1）备份恢复**

- 前置：使用临时 profile（W-00），已有两个项目与若干会话历史。
- 步骤：
  1. 建立两种布局，其中包括一个命名布局；
  2. 执行会话搜索，确认能搜到结果；
  3. 执行备份，记录备份 ID；
  4. 新增一个项目并修改布局；
  5. 在有运行中 PTY、脏文件、独立窗口的情况下分别尝试恢复（应被阻断）；
  6. 清除这些阻断条件后再恢复；
  7. 恢复后再次搜索同一关键词。
- 期望：第 5 步每种情况都给出明确的阻断提示；恢复后当前布局和命名布局与备份时一致；关闭行为与备份时一致；搜索结果与恢复后的项目对应，没有旧项目的结果（索引已清空并重建）。
- 证据：截图、日志、`%USERPROFILE%\.cli-launchpad\backups\manifests` 目录列表。

**W-13（M6-F10）标题与 DPI**

- 前置：窗口中有多个文件与 PTY 标签。
- 步骤：在 100%、125%、150%、200% 缩放下（设置 → 系统 → 屏幕 → 缩放），分别在宽窗口和窄窗口（最小 960 宽）里放多个文件和 PTY 标签；只用键盘打开溢出列表并激活、关闭项目；有双屏且缩放不同时，把窗口拖到另一屏。
- 期望：单个标题最宽 200 CSS px，单行省略；当前活动项始终可见；跨屏后布局没有错位。
- 证据：每个缩放比例两张截图，并记录窗口尺寸。

**W-14（M6-F11）原生主题**

- 前置：主窗、文件独立窗、PTY 独立窗各开一个。
- 步骤：记录系统模式（设置 → 个性化 → 颜色）；把应用主题设为与系统相反；观察主窗、文件独立窗和 PTY 独立窗；再切换应用主题一次；重启应用；恢复系统设置。
- 期望：自绘标题栏与应用主题一致，跨窗口同步；重启后偏好保持。
- 证据：截图。

**W-15 CSP 下的 Monaco worker**

- 前置：使用 debug 构建（devtools 可用）。
- 步骤：
  1. 新建 `bad.json`，内容 `{"a": }`，打开；
  2. 新建 `t.ts`，内容 `const x: number = "s";`，打开；
  3. 按 Ctrl+Shift+I 打开 devtools 的 Console，筛选 `Refused`、`Content Security Policy`；
  4. 用正式安装包重复第 1 步。
- 期望：JSON 出现语法错误波浪线（说明 worker 已加载）；Console 中没有 CSP 拒绝；正式包中波浪线同样出现。
- 证据：截图和 Console 截图。

**W-16 粘贴超过 64 KiB**

- 前置：Claude 或 Codex 的 PTY 会话在运行，停在输入提示处。
- 步骤：执行 `Set-Clipboard ('x' * 102400)`；在输入提示处粘贴，**不要回车**；然后清空输入。
- 期望：CLI 显示的粘贴占位（例如 `[Pasted text …]`）或字符数对应 100 KiB；应用没有“终端输入片段超过安全上限”报错；日志中没有 `pty_input_backpressure`。如果出现背压提示，记录界面上是否引导用户分段粘贴。
- 证据：截图、日志。

**W-17 SMB 和 UNC 路径的 ACL**

- 前置：管理员 PowerShell。
- 步骤：
  1. 建共享：`New-Item C:\clp-share\proj -ItemType Directory -Force; New-SmbShare -Name clpshare -Path C:\clp-share -FullAccess "$env:USERDOMAIN\$env:USERNAME"`；
  2. 创建文件：`Set-Content C:\clp-share\proj\acl.txt one`，再执行 `icacls C:\clp-share\proj\acl.txt /grant "Users:(R)"`；用 `icacls` 记录 ACL；
  3. 在应用中添加项目 `\\localhost\clpshare\proj`，修改并保存 `acl.txt`；
  4. 执行 `net use Z: \\localhost\clpshare`，添加项目 `Z:\proj`，再保存一次；
  5. 对第二个文件执行 `icacls … /inheritance:r`（受保护 ACL），重复保存；
  6. 每次保存后用 `icacls` 比较 ACL；
  7. 清理：`net use Z: /delete`、`Remove-SmbShare clpshare -Force`。
- 期望：每次保存后 ACL（显式项、继承项、保护标志）与保存前完全一致；没有 `.writing` 残留；UNC 路径和映射盘都能保存。
- 证据：每次 `icacls` 的输出与截图。

**W-18 保留设备名（S1D-N13）**

- 前置：W-00 的测试项目。
- 步骤：执行 `Set-Content -LiteralPath "\\?\C:\clp\proj\COM0.txt" x`，记录是否创建成功；在应用中刷新文件树。
- 期望：如果文件创建成功，应用不应列出它，或应把它标为不支持；不能打开后保存到设备。修复前把观察结果作为基线记录。
- 证据：`Get-ChildItem` 输出和截图。

**W-19 托盘行为**

- 前置：关闭行为设为“最小化到托盘”，有一个运行中的 PTY。
- 步骤：关闭主窗后双击托盘图标恢复；在托盘菜单点“显示主界面”。
- 期望：PTY 持续运行，窗口状态正确。
- 证据：截图。

**W-20 路径语义探测的真实卷矩阵（PD-10，RS-T62 测试十；平台调研完成并经用户确认前仅为预备清单）**

- **说明：** 下面所有“期望”都是**待调研核实**的假设，以 RW6 步骤 8 的决策记录为准；评审通过并实现探测钩子前不执行。观察方式：使用 debug 构建（devtools 可用）或验收构建，把对应目录添加为项目，在主窗口 devtools Console 调用 `invoke("get_project_path_semantics", { directoryId, directoryPath })`，并摘录日志里的探测结果行。
- **前置条件与创建方式：**
  1. NTFS 默认目录：`New-Item C:\clp\case-ntfs -ItemType Directory`。期望（待核实）：大小写 `Insensitive`。
  2. 按目录启用区分大小写：`New-Item C:\clp\case-cs -ItemType Directory`，执行 `fsutil file setCaseSensitiveInfo C:\clp\case-cs enable` 与 `fsutil file queryCaseSensitiveInfo C:\clp\case-cs`（部分系统需要先启用 WSL 相关可选组件，不可用时记“阻塞”）；再在其中新建子目录 `sub` 并查询标志（待核实是否继承）。期望（待核实）：`case-cs` 为 `Sensitive`，`sub` 继承。
  3. ReFS 或 Dev Drive：设置 → 系统 → 存储 → 磁盘和卷 → 创建开发驱动器；或用 VHDX 格式化为 ReFS（`New-VHD`、`Mount-VHD`、`Initialize-Disk`、`New-Partition`、`Format-Volume -FileSystem ReFS`；Home 版 Windows 可能不支持 ReFS，记“阻塞”）。期望（待核实）：`Insensitive`。
  4. `\\wsl$\<发行版>\home\<用户>\proj`（需要已安装 WSL；经 9P 访问 ext4）。期望（待核实）：`Sensitive` 或 `Unknown`；若得到 `Insensitive` 即为误判，必须记录。
  5. SMB 共享：沿用 W-17 的 `New-SmbShare` 共享，添加 `\\localhost\clpshare\proj`。期望（待核实）：`Insensitive` 或 `Unknown`（服务端可能是区分大小写的 Samba）。
- **每个位置的步骤：** 添加项目 → 调用 `get_project_path_semantics` → 记录结果 → 分别用 `a.txt` 与 `A.txt` 两个名字各创建一个文件（在 `Sensitive` 位置会得到两个文件，在 `Insensitive` 位置第二次创建会指向同一文件）→ 在应用里依次打开这两个名字，记录得到几个文档、文件树显示几个条目。
- **期望与证据：** 探测结果与实际行为一致；不一致（误判）必须单独记录为缺陷并附证据。证据：Console 输出、目录列表（`dir`）、截图、`fsutil` 输出、日志摘录。
- **清理：** 取消目录大小写标志（`fsutil file setCaseSensitiveInfo <目录> disable`，需目录为空）、卸载 VHDX、删除测试共享。

#### 7.2 macOS 清单（M-xx）

**M-00 环境准备**

- 前置：记录 macOS 版本（`sw_vers`）、芯片（`uname -m`）、显示器缩放（系统设置 → 显示器）、DMG 文件名及 `shasum -a 256` 结果、提交 SHA。
- 步骤：
  1. 安装 DMG 后执行 `ls "/Applications/CLI Launchpad.app/Contents/MacOS/"`，确认可执行文件名 `<bin>`；
  2. 从托盘或 Dock 退出所有正在运行的实例；
  3. 用隔离 HOME 启动：`mkdir -p /tmp/clp-home && HOME=/tmp/clp-home "/Applications/CLI Launchpad.app/Contents/MacOS/<bin>"`；
  4. 在 `/tmp/clp-home/proj` 下创建与 W-00 同样的测试项目：UTF-8 文本 `a.txt`；嵌套目录 `dir 一/子 目录/`；200 字符长文件名；有效 PNG；二进制文件 `mkfile 4k bin.dat`。
- 期望：数据写入 `/tmp/clp-home/.cli-launchpad`。
- 证据：终端输出和截图。

**M-01（M6-F01）文件树**

- 前置：M-00 完成，并已添加项目 `/tmp/clp-home/proj`。
- 步骤：逐层展开嵌套目录；打开含空格、中文、长名的目录；折叠后再展开；切换到其他项目再切回；使用应用内刷新；重启应用后再查看。
- 期望：名称可辨认；不同项目的路径不串；刷新后没有陈旧内容。
- 证据：`M-01-1..4.png`。

**M-02（M6-F02）打开与保存**

- 前置：M-01 完成。
- 步骤：打开 `a.txt`，改为 `M02-<时间>` 并保存；在文件树中再次打开同一文件；关闭标签后重新打开；独立窗口打开后再返回。
- 期望：保存成功；`cat /tmp/clp-home/proj/a.txt` 与界面一致，`shasum -a 256 a.txt` 与保存前后的预期一致；重复打开会聚焦已有文档。
- 证据：截图，以及 `cat` 和 `shasum` 的输出。

**M-03（M6-F03 加 CAS）外部修改冲突**

- 前置：`a.txt` 已在应用中打开，并有未保存修改。
- 步骤：
  1. 用终端执行 `echo external >> /tmp/clp-home/proj/a.txt`（或用 TextEdit 修改保存）；回到应用点保存；然后选择“重新载入”。
  2. 原子替换并发测试：执行 `for i in $(seq 1 200); do echo "ext $i" > /tmp/clp-home/proj/tmp.m03 && mv -f /tmp/clp-home/proj/tmp.m03 /tmp/clp-home/proj/a.txt; sleep 0.02; done`，运行期间在应用里连续保存 5 次。
  3. 用 `sed -i '' 's/ext/ext2/' /tmp/clp-home/proj/a.txt` 再制造一次冲突。
- 期望：第 1、3 步出现冲突提示，不静默覆盖，重新载入后显示磁盘内容。第 2 步每次保存都表现为“冲突”或“成功”，**不出现**“无法打开待保存文件”；`ls -la /tmp/clp-home/proj | grep writing` 为空。
- 证据：截图、日志摘录、`ls` 输出。

**M-04（M6-F04）窗格操作**

- 前置：两个窗格，并同时存在文件与 PTY 内容。
- 步骤：按 M6 文档执行关闭按钮、右键关闭当前、关闭其他、关闭全部、拖动移动和拆分；在有脏文件和运行中 PTY 的情况下再执行“关闭范围”并点取消。
- 期望：关闭范围准确；取消时不会部分关闭；内容无重复、无丢失。右键菜单为 macOS 的双指点按或 Ctrl+点按。
- 证据：录屏 `M-04.mov`。

**M-05（M6-F05）独立窗口交接**

- 前置：存在文件和 PTY 内容。
- 步骤：分别把文件和 PTY 打开为独立窗口 → 在独立窗口内返回窗格 → 用左上角红点关闭按钮关闭；在脏文件和运行中 PTY 的情况下再做一遍。
- 期望：归属唯一，缓冲区不丢，PTY 持续运行。
- 证据：录屏。

**M-06（M6-F06）二进制、图片与主题**

- 前置：M-00 的测试项目包含 `bin.dat` 与有效 PNG。
- 步骤：打开 `bin.dat`、有效 PNG、`cp bin.dat fake.png` 后打开 `fake.png`；缩窄窗格；切换应用的浅色和深色主题。
- 期望：二进制和伪造图片显示“不支持”；有效 PNG 显示预览；长标题不遮挡操作按钮。
- 证据：截图。

**M-07（M6-F07）退出矩阵**

- 前置：设置“关闭行为”为“退出”。
- 退出路径：
  - 路径 1：主窗口标题栏关闭（红点）；
  - 路径 2：托盘菜单“退出”；
  - 路径 3：**Cmd+Q**，以及应用菜单中的“退出 CLI Launchpad”。
- 步骤与期望：同 M6-F07 的四种状态矩阵：无脏文件且无 PTY；只有脏文件；只有 PTY；脏文件加 PTY。每条路径每种状态先点“取消”检查状态保留，再在新一轮数据下“确认”退出。最后把关闭行为改为“最小化到托盘”，点红点，再从托盘或 Dock 恢复。**修复 S1C-N01 之前，路径 3 预期直接退出、不弹任何确认，记为失败（P0）。**
- 证据：每格录屏。

**M-08 Cmd+Q 与系统退出入口（S1C-N01 专项）**

- 前置：S1C-N01 修复构建；存在一个脏文件和一个运行中的 PTY。
- 步骤：
  1. 按 Cmd+Q → 取消；
  2. 应用菜单 → 退出 → 取消；
  3. Dock 图标右键 → 退出；
  4. 在终端执行 `osascript -e 'quit app "CLI Launchpad"'`；
  5. 苹果菜单 → 注销（使用临时数据）。
- 期望：第 1、2 步出现与托盘退出一致的影响确认，取消后状态保留。第 3~5 步记录实际行为：tao 0.35.3 只实现了 `applicationWillTerminate`，没有 `applicationShouldTerminate:`，这三种入口很可能仍然绕过退出门。如果确实绕过，记为“已知限制（N6）”并保存证据，不判为通过。
- 证据：录屏，以及终端里 `osascript` 的输出。

**M-09（M6-F08 与重复 reattach）PTY 独立窗口关闭后回收**

- 前置：一个可安全停止的 PTY 会话在主窗口运行。
- 步骤：
  1. 运行一个 PTY 并独立打开；用应用的关闭和返回流程关闭独立窗口；在主窗口重新聚焦该会话并输入 `echo m09`；
  2. 再快速连续点击“重新接管”（如果 UI 提供）或重复返回操作。
- 期望：会话唯一；输入有回显；不产生重复会话；重复接管的操作不报错，或给出明确提示。
- 证据：录屏，以及日志中的 `pty-session-owner-lost`、reattach 相关行。

**M-10（B3R-F05）子窗口强制销毁**

- 前置：一个 PTY 独立窗口与一个含脏缓冲区的文件独立窗口，使用临时数据。
- 方法 A（PD-14 已确认，主方法：使用 `acceptance-hooks` 验收构建，构建方式见 CI-10）：PTY 独立窗口正在运行时，在托盘点“验收：强制销毁全部独立窗口”。
- 方法 B（备选：验收构建不可用时）：
  1. 打开独立窗口之前执行 `ps -axo pid,command | grep -i 'com.apple.WebKit.WebContent' | grep -v grep > before.txt`；
  2. 打开独立窗口后再执行一次，存为 `after.txt`，然后 `diff before.txt after.txt` 找出新增 PID；
  3. 如果恰好新增一个 PID，执行 `kill -9 <pid>`；没有新增或新增多个，记为“阻塞：无法单独定位”；
  4. WKWebView 会变为空白；尝试 Cmd+W 和红点关闭；
  5. 对文件独立窗口（含脏缓冲区）重复。
- 期望与证据：同 W-10 的期望：方法 A 窗口立即消失、会话回到主窗口且 PTY 存活、文件窗授权被撤销且内容没有丢失；方法 B 记录空白页表现及关闭是否能完成，渲染进程崩溃后窗口无法关闭记为“失败”。证据为录屏、`before.txt`、`after.txt`、日志。

**M-11 返回进行中时关闭独立窗口**

- 前置：PTY 独立窗口正在运行。
- 步骤：点“返回主窗口”后立即（1 秒内）点红点关闭；重复 5 次。
- 期望：每次会话都只在主窗口出现一次，可以输入；没有“会话不存在”或卡死；日志中没有 panic。
- 证据：录屏、日志。

**M-12（M6-F09 与 J1）备份恢复**

- 前置：使用隔离 HOME（M-00），已有两个项目与若干会话历史。
- 步骤：
  1. 建立两种布局，其中包括一个命名布局；
  2. 执行会话搜索，确认能搜到结果；
  3. 执行备份，记录备份 ID；
  4. 新增一个项目并修改布局；
  5. 在有运行中 PTY、脏文件、独立窗口的情况下分别尝试恢复（应被阻断）；
  6. 清除这些阻断条件后再恢复；
  7. 恢复后再次搜索同一关键词。
- 期望：第 5 步每种情况都给出明确的阻断提示；恢复后当前布局和命名布局与备份时一致；关闭行为与备份时一致；搜索结果与恢复后的项目对应，没有旧项目的结果。
- 证据：截图、日志、`ls /tmp/clp-home/.cli-launchpad/backups/manifests` 输出。

**M-13（M6-F10）标题与 DPI**

- 前置：窗口中有多个文件与 PTY 标签。
- 步骤：在系统设置 → 显示器中切换“默认”和“更多空间”；在宽窗口和窄窗口（最小 960 宽）里放多个文件和 PTY 标签；只用键盘打开溢出列表并激活、关闭项目；如有外接屏，在 Retina 屏与非 Retina 屏之间拖动窗口。
- 期望：单个标题最宽 200 CSS px，单行省略；当前活动项始终可见；跨屏后布局没有错位。
- 证据：每种缩放两张截图，并记录窗口尺寸。

**M-14（M6-F11）原生主题**

- 前置：主窗、文件独立窗、PTY 独立窗各开一个。
- 步骤：记录系统外观（系统设置 → 外观）；把应用主题设为与系统相反；观察主窗与两种独立窗口；再切换应用主题一次；重启应用；恢复系统外观。
- 期望：窗口主题跟随应用主题并在跨窗和切换时同步，重启后偏好保持。标题栏外观如果由系统控制、无法跟随应用主题，记录平台、窗口类型和可见差异。
- 证据：截图。

**M-15 CSP 与 Monaco**

- 前置：使用 debug 构建（devtools 可用）。
- 步骤：
  1. 新建 `bad.json`，内容 `{"a": }`，打开；
  2. 新建 `t.ts`，内容 `const x: number = "s";`，打开；
  3. 按 Cmd+Option+I 打开 devtools 的 Console，筛选 `Refused`、`Content Security Policy`；
  4. 用正式安装包重复第 1 步。
- 期望：JSON 出现语法错误波浪线；Console 中没有 CSP 拒绝；正式包中波浪线同样出现。
- 证据：截图和 Console 截图。

**M-16 粘贴超过 64 KiB**

- 前置：Claude 或 Codex 的 PTY 会话在运行，停在输入提示处。
- 步骤：执行 `python3 -c "print('x'*102400, end='')" | pbcopy`；在输入提示处粘贴，**不要回车**；然后清空输入。
- 期望：CLI 显示的粘贴占位或字符数对应 100 KiB；应用没有“终端输入片段超过安全上限”报错；日志中没有 `pty_input_backpressure`。如果出现背压提示，记录界面上是否引导用户分段粘贴。
- 证据：截图、日志。

**M-17 非 UTF-8 文件名与大小写**

- 前置：M-00 的测试项目。
- 步骤：
  1. 执行 `python3 -c "import os; open(b'/tmp/clp-home/proj/bad-\xff.txt','w')"`，应失败并报 `[Errno 92] Illegal byte sequence`；
  2. 依次 `touch /tmp/clp-home/proj/Case.txt`、`touch /tmp/clp-home/proj/case.txt`，在应用中查看（APFS 默认不区分大小写）；
  3. 创建控制字符文件名：`touch "$(printf '/tmp/clp-home/proj/line\nbreak.txt')"`，在应用中查看并尝试打开，再观察布局自动保存是否报错（S1D-N08）。
- 期望：第 1 步失败，记录 errno；第 2 步只存在一个文件；第 3 步记录现象（修复后应被一致地跳过）。
- 证据：终端输出和截图。

**M-18 托盘与 Dock 重新打开**

- 前置：关闭行为设为“最小化到托盘”，有一个运行中的 PTY。
- 步骤：关闭主窗 → 点击 Dock 图标（Reopen）→ 再从托盘恢复。
- 期望：主窗恢复，PTY 持续运行。
- 证据：截图。

**M-19 路径语义探测的真实卷矩阵（PD-10，RS-T62 测试十；平台调研完成并经用户确认前仅为预备清单）**

- **说明：** 期望均为**待调研核实**的假设，以 RW6 步骤 8 的决策记录为准。观察方式同 W-20（devtools 调用 `get_project_path_semantics`，摘录日志）。macOS 的大小写属性是**按卷**的，所以每个卷都必须单独测试；macOS 还有第二根轴（Unicode 规范化是否不敏感），每个卷都要同时记录两根轴。
- **前置条件与创建方式（每个磁盘映像用完后 `hdiutil detach`）：**
  1. 默认 APFS 卷：`mkdir -p ~/clp/case-apfs`。期望（待核实）：大小写 `Insensitive`。
  2. 区分大小写的 APFS 卷：`hdiutil create -size 64m -fs "Case-sensitive APFS" -volname CLPCS /tmp/clpcs.dmg && hdiutil attach /tmp/clpcs.dmg`（卷在 `/Volumes/CLPCS`）。期望（待核实）：`Sensitive`。
  3. HFS+：`hdiutil create -size 64m -fs "HFS+" -volname CLPHFS /tmp/clphfs.dmg`；区分大小写的 HFS+：`-fs "Case-sensitive HFS+"`。期望（待核实）：分别为 `Insensitive` 与 `Sensitive`，规范化轴需要实测（HFS+ 强制 NFD，待核实）。
  4. exFAT：`hdiutil create -size 64m -fs ExFAT -volname CLPEX /tmp/clpex.dmg`；或真实 U 盘。期望（待核实）：`Insensitive`。
  5. SMB 共享：在系统设置中开启文件共享后挂载 `smb://localhost/<共享名>`。期望（待核实）：`Insensitive` 或 `Unknown`。
- **规范化轴的观察：** 在每个卷的项目目录中创建名字为 NFC 的 `café.txt`（`printf 'caf\xc3\xa9.txt'`）与 NFD 的 `café.txt`（`printf 'cafe\xcc\x81.txt'`），记录是否被视为同一文件、文件树显示几个条目。
- **每个位置的步骤：** 同 W-20（用 `a.txt`、`A.txt` 两个名字各创建一个文件并在应用里依次打开）。
- **期望与证据：** 探测结果与实际行为一致，不一致记为缺陷。证据：Console 输出、`ls -la`、截图、`diskutil info <卷>`（记录卷格式与大小写属性）、日志摘录。

#### 7.3 Linux 清单（L-xx）

**L-00 环境准备**

- 前置：记录发行版（`cat /etc/os-release`）、桌面环境与会话类型（`echo $XDG_CURRENT_DESKTOP $XDG_SESSION_TYPE`）、缩放、`uname -m`、安装包类型（deb、rpm 或 AppImage）及其 `sha256sum`、提交 SHA、WebKitGTK 版本（`dpkg -l libwebkit2gtk-4.1-0`）。
- 步骤：
  1. 确认可执行文件位置（`dpkg -L cli-launchpad | grep bin/`；AppImage 则直接使用该文件）；
  2. 退出所有实例；
  3. 用隔离 HOME 启动：`export H=$(mktemp -d) && HOME=$H <可执行文件>`；
  4. 在 `$H/proj` 下创建测试项目：UTF-8 文本 `a.txt`；嵌套目录 `dir 一/子 目录/`；200 字符长文件名；有效 PNG；二进制文件 `head -c 4096 /dev/urandom > bin.dat`。
  5. 可选：有 GNOME 时，分别在 Wayland 和 X11 下各跑一轮（登录界面切换会话，或设置 `GDK_BACKEND=x11`）。
- 期望：数据写入 `$H/.cli-launchpad`。
- 证据：终端输出。

**L-01（M6-F01）文件树**

- 前置：L-00 完成，并已添加项目 `$H/proj`。
- 步骤：逐层展开嵌套目录；打开含空格、中文、长名的目录；折叠后再展开；切换到其他项目再切回；使用应用内刷新；重启应用后再查看。
- 期望：名称可辨认；不同项目的路径不串；刷新后没有陈旧内容。
- 证据：`L-01-1..4.png`。

**L-02（M6-F02）打开与保存**

- 前置：L-01 完成。
- 步骤：打开 `a.txt`，改为 `L02-<时间>` 并保存；在文件树中再次打开同一文件；关闭标签后重新打开；独立窗口打开后再返回。
- 期望：保存成功；`cat $H/proj/a.txt` 与界面一致，`sha256sum a.txt` 与预期一致；重复打开会聚焦已有文档。
- 证据：截图，以及 `cat` 和 `sha256sum` 的输出。

**L-03（M6-F03 加 CAS）外部修改冲突（本平台重点，对应第 2 节的 CAS 竞态）**

- 前置：`a.txt` 已在应用中打开，并有未保存修改。
- 步骤：
  1. 并发循环：`for i in $(seq 1 200); do echo "ext $i" > $H/proj/tmp.l03 && mv -f $H/proj/tmp.l03 $H/proj/a.txt; sleep 0.02; done`，运行期间在应用中连续保存 10 次；
  2. 另外用 `sed -i 's/x/y/' $H/proj/a.txt` 制造冲突，回到应用保存，再选择“重新载入”。
- 期望：修复前预期可能出现“无法打开待保存文件”，作为基线证据；修复后不得出现；保存结果只能是冲突或成功；没有 `.writing` 残留（`ls -la $H/proj | grep writing` 为空）。
- 证据：截图、日志（错误信息中的路径应显示是否带 `(deleted)`）。

**L-04（M6-F04）窗格操作**

- 前置：两个窗格，并同时存在文件与 PTY 内容。
- 步骤：按 M6 文档执行关闭按钮、右键关闭当前、关闭其他、关闭全部、拖动移动和拆分；在有脏文件和运行中 PTY 的情况下再执行“关闭范围”并点取消。
- 期望：关闭范围准确；取消时不会部分关闭；内容无重复、无丢失。Wayland 下拖放如受限，记录并在 X11 会话下复测。
- 证据：录屏 `L-04.mp4`。

**L-05（M6-F05）独立窗口交接**

- 前置：存在文件和 PTY 内容。
- 步骤：分别把文件和 PTY 打开为独立窗口 → 在独立窗口内返回窗格 → 用窗口的原生关闭按钮关闭；在脏文件和运行中 PTY 的情况下再做一遍。
- 期望：归属唯一，缓冲区不丢，PTY 持续运行。
- 证据：录屏。

**L-06（M6-F06）二进制、图片与主题**

- 前置：L-00 的测试项目包含 `bin.dat` 与有效 PNG。
- 步骤：打开 `bin.dat`、有效 PNG、`cp bin.dat fake.png` 后打开 `fake.png`；缩窄窗格；切换应用的浅色和深色主题。
- 期望：二进制和伪造图片显示“不支持”；有效 PNG 显示预览；长标题不遮挡操作按钮。
- 证据：截图。

**L-07（M6-F07）退出矩阵**

- 前置：设置“关闭行为”为“退出”。
- 退出路径：
  - 路径 1：标题栏关闭；
  - 路径 2：托盘“退出”（GNOME 需要 AppIndicator 扩展；没有托盘时记为阻塞）；
  - 路径 3：桌面环境提供的“退出”入口，例如 GNOME Dash 中图标右键“退出”，它会向所有窗口发送关闭请求；KDE 任务栏右键“关闭”。
- 步骤：对每条路径分别在四种状态下执行：无脏文件且无 PTY；只有脏文件；只有 PTY；脏文件加 PTY。先点“取消”，再在新一轮数据下“确认”退出。另外记录在终端执行 `kill -TERM <pid>` 的行为（预期进程直接结束、不弹确认），列为风险备注。
- 期望与证据：同 M6-F07 矩阵；每格一张截图，以及日志中的 `app-exit` 相关行。

**L-08 注销**

- 前置：有一个脏文件和一个 PTY，使用临时数据。
- 步骤：执行注销。
- 期望：只记录现象。
- 证据：重新登录后的日志。

**L-09（M6-F08 与重复 reattach）PTY 独立窗口关闭后回收**

- 前置：一个可安全停止的 PTY 会话在主窗口运行。
- 步骤：
  1. 运行一个 PTY 并独立打开；用应用的关闭和返回流程关闭独立窗口；在主窗口重新聚焦该会话并输入 `echo l09`；
  2. 再快速连续点击“重新接管”（如果 UI 提供）或重复返回操作。
- 期望：会话唯一；输入有回显；不产生重复会话；重复接管的操作不报错，或给出明确提示。
- 证据：录屏，以及日志中的 `pty-session-owner-lost`、reattach 相关行。

**L-10（B3R-F05）子窗口强制销毁**

- 前置：一个 PTY 独立窗口与一个含脏缓冲区的文件独立窗口，使用临时数据。
- 方法 A（PD-14 已确认，主方法：使用 `acceptance-hooks` 验收构建，构建方式见 CI-10）：PTY 独立窗口正在运行时，在托盘点“验收：强制销毁全部独立窗口”。
- 方法 B（备选：验收构建不可用时）：
  1. 打开独立窗口之前执行 `pgrep -a WebKitWebProcess > before.txt`；
  2. 打开独立窗口后再执行一次，存为 `after.txt`，比较差异找出新增 PID；
  3. 如果恰好新增一个 PID，执行 `kill -9 <pid>`；没有新增或新增多个，记为“阻塞：无法单独定位”；
  4. 观察独立窗口并尝试原生关闭；
  5. 对文件独立窗口（含脏缓冲区）重复。
- 期望与证据：同 W-10 的期望：方法 A 窗口立即消失、会话回到主窗口且 PTY 存活、文件窗授权被撤销且内容没有丢失；方法 B 记录崩溃页面表现及关闭是否能完成，渲染进程崩溃后窗口无法关闭记为“失败”。证据为录屏、`before.txt`、`after.txt`、日志。

**L-11 返回进行中时关闭独立窗口**

- 前置：PTY 独立窗口正在运行。
- 步骤：点“返回主窗口”后立即（1 秒内）点该窗口的原生关闭按钮；重复 5 次。
- 期望：每次会话都只在主窗口出现一次，可以输入；没有“会话不存在”或卡死；日志中没有 panic。
- 证据：录屏、日志。

**L-12（M6-F09 与 J1）备份恢复**

- 前置：使用隔离 HOME（L-00），已有两个项目与若干会话历史。
- 步骤：
  1. 建立两种布局，其中包括一个命名布局；
  2. 执行会话搜索，确认能搜到结果；
  3. 执行备份，记录备份 ID；
  4. 新增一个项目并修改布局；
  5. 在有运行中 PTY、脏文件、独立窗口的情况下分别尝试恢复（应被阻断）；
  6. 清除这些阻断条件后再恢复；
  7. 恢复后再次搜索同一关键词。
- 期望：第 5 步每种情况都给出明确的阻断提示；恢复后当前布局和命名布局与备份时一致；关闭行为与备份时一致；搜索结果与恢复后的项目对应，没有旧项目的结果。
- 证据：截图、日志、`ls $H/.cli-launchpad/backups/manifests` 输出。

**L-13（M6-F10）标题与缩放**

- 前置：窗口中有多个文件与 PTY 标签。
- 步骤：GNOME 设置 → 显示器 → 缩放 100%/200%；或执行 `gsettings set org.gnome.desktop.interface text-scaling-factor 1.25`，测完后执行 `gsettings reset org.gnome.desktop.interface text-scaling-factor` 恢复；在宽窗口和窄窗口（最小 960 宽）里放多个文件和 PTY 标签；只用键盘打开溢出列表并激活、关闭项目。
- 期望：单个标题最宽 200 CSS px，单行省略；当前活动项始终可见；缩放变化后布局没有错位。
- 证据：每种缩放两张截图，并记录窗口尺寸。

**L-14（M6-F11）原生主题**

- 前置：主窗、文件独立窗、PTY 独立窗各开一个。
- 步骤：执行 `gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'`，把应用主题设为与系统相反；观察主窗与两种独立窗口；再切换应用主题一次；重启应用；测完后执行 `gsettings reset org.gnome.desktop.interface color-scheme` 恢复。
- 期望：窗口主题跟随应用主题并在跨窗和切换时同步，重启后偏好保持。标题栏外观如果由系统控制、无法跟随应用主题，记录平台、窗口类型和可见差异。
- 证据：截图。

**L-15 CSP 与 Monaco**

- 前置：使用 debug 构建（WebKit Inspector 可用）。
- 步骤：
  1. 新建 `bad.json`，内容 `{"a": }`，打开；
  2. 新建 `t.ts`，内容 `const x: number = "s";`，打开；
  3. 按 Ctrl+Shift+I 打开 WebKit Inspector 的 Console，筛选 `Refused`、`Content Security Policy`；
  4. 用正式包重复第 1 步。
- 期望：JSON 出现语法错误波浪线；Console 中没有 CSP 拒绝；正式包中波浪线同样出现。
- 证据：截图和 Console 截图。

**L-16 粘贴超过 64 KiB**

- 前置：Claude 或 Codex 的 PTY 会话在运行，停在输入提示处。
- 步骤：Wayland 执行 `python3 -c "print('x'*102400, end='')" | wl-copy`；X11 执行 `python3 -c "print('x'*102400, end='')" | xclip -selection clipboard`；在输入提示处粘贴，**不要回车**；然后清空输入。
- 期望：CLI 显示的粘贴占位或字符数对应 100 KiB；应用没有“终端输入片段超过安全上限”报错；日志中没有 `pty_input_backpressure`。如果出现背压提示，记录界面上是否引导用户分段粘贴。
- 证据：截图、日志。

**L-17 非 UTF-8 与控制字符文件名**

- 前置：L-00 的测试项目。
- 步骤：
  1. 执行 `touch "$H/proj/$(printf 'bad-\xff.txt')"` 创建非 UTF-8 文件名；
  2. 执行 `touch "$H/proj/$(printf 'line\nbreak.txt')"` 创建控制字符文件名；
  3. 在应用中刷新、尝试打开，并观察布局保存。
- 期望：非 UTF-8 文件被跳过，界面显示跳过计数（已有自动化覆盖，此处实机复核）；控制字符文件名记录当前现象（S1D-N08），修复后应一致地跳过。
- 证据：截图、日志。

**L-18 xdg-open**

- 前置：L-00 完成。
- 步骤：在应用中点击“关于”里的 GitHub 链接。
- 期望：浏览器打开 `https://github.com/SkyJourney/cli-launchpad`；没有 `xdg-utils` 时记录报错。
- 证据：截图。

**L-19 路径语义探测的真实卷矩阵（PD-10，RS-T62 测试十；平台调研完成并经用户确认前仅为预备清单）**

- **说明：** 期望均为**待调研核实**的假设，以 RW6 步骤 8 的决策记录为准。观察方式同 W-20。Linux 不能只靠文件系统类型判断：FUSE 类文件系统共用同一个类型魔数，CIFS 有 `nocase` 挂载选项，NFS 取决于服务端，ext4 与 f2fs 的 casefold 是按目录的。每个位置都用 `stat -f -c %T <路径>` 记录文件系统类型。需要 root 的挂载步骤不可用时，记“阻塞”并说明原因。
- **前置条件与创建方式：**
  1. tmpfs：`mkdir -p /dev/shm/clp-case`。期望（待核实）：`Sensitive`。
  2. ext4（家目录）：`mkdir -p ~/clp-case`。期望（待核实）：`Sensitive`。
  3. ext4 casefold 目录：`truncate -s 64M ext4cf.img && mkfs.ext4 -O casefold ext4cf.img && sudo mkdir -p /mnt/clp-cf && sudo mount -o loop ext4cf.img /mnt/clp-cf && sudo mkdir /mnt/clp-cf/d && sudo chattr +F /mnt/clp-cf/d && sudo chown $USER /mnt/clp-cf/d`，用 `lsattr -d /mnt/clp-cf/d` 确认标志；项目根设为该目录。期望（待核实）：`Insensitive`（目录级）；同一卷上的非 casefold 目录应为 `Sensitive`。
  4. vfat：`truncate -s 16M v.img && mkfs.vfat v.img && sudo mkdir -p /mnt/clp-vfat && sudo mount -o loop,uid=$(id -u) v.img /mnt/clp-vfat`。期望（待核实）：`Insensitive`。
  5. exfat：`mkfs.exfat` 同上，挂载到 `/mnt/clp-exfat`。期望（待核实）：`Insensitive`。
  6. ntfs-3g（FUSE）：`truncate -s 32M n.img && mkfs.ntfs -F -Q n.img && sudo mount -t ntfs-3g -o loop,uid=$(id -u) n.img /mnt/clp-ntfs3g`。期望（待核实）：`Insensitive` 或 `Unknown`；若类型魔数为 FUSE，必须依赖行为探测。
  7. 内核 ntfs3：`sudo mount -t ntfs3 -o loop,uid=$(id -u) n.img /mnt/clp-ntfs3`（内核需要支持）。期望（待核实）：`Insensitive`；与 ntfs-3g 的结果比较，记录差异。
  8. cifs：`sudo mount -t cifs //localhost/<共享名> /mnt/clp-cifs -o username=<用户>`，分别带与不带 `nocase` 选项各测一次。期望（待核实）：`Unknown` 或由行为探测得出。
  9. nfs：`sudo mount -t nfs localhost:/<导出路径> /mnt/clp-nfs`（需要本机 NFS 服务）。期望（待核实）：取决于服务端，行为探测得出。
- **每个位置的步骤：** 同 W-20；另外对只读挂载（`mount -o ro,loop`）的位置再测一次，期望（待核实）：没有含字母条目时得到 `Unknown`，且没有创建任何文件。
- **期望与证据：** 探测结果与实际行为一致，不一致记为缺陷。证据：Console 输出、`stat -f` 与 `mount` 输出、`ls -la`、日志摘录。
- **清理：** `sudo umount` 全部挂载点，删除镜像文件。

#### 7.4 三平台共用补充项（对应 RS-T56~RS-T63 与 PD-10、PD-12、PD-13、PD-14，三平台各执行一次，记为 X-xx-W / X-xx-M / X-xx-L）

**X-20 0.3.0 升级用户的布局保存（RS-T56）**

- 前置：使用隔离 profile。用 0.3.0 安装包启动一次并建立至少两个窗格的布局，退出；确认 `workspace_state` 行的 `schema_version` 为 1（用 `sqlite3 <profile>/.cli-launchpad/data/<数据库文件名> "select schema_version, revision from workspace_state"`，数据库文件名以 `storage_service.rs` 中的 `DB_FILENAME` 为准）。
- 步骤：换成候选构建启动；修改布局（拖动分栏或新增窗格）；等待自动保存；退出并重启；重复查询。
- 期望：布局修改在重启后保持；`schema_version` 列变为 5，`revision` 增加；界面没有持续的“保存中”状态；日志中没有反复出现的保存失败或重试记录。
- 证据：查询输出、截图、日志摘录。

**X-21 文件图片预览与受限更新提示的字段名（RS-T57）**

- 前置：测试项目含有效 PNG；Hermes 的托管更新资格为“拒绝”的环境（如非默认安装路径）。
- 步骤：打开有效 PNG；打开设置中 Hermes 的更新状态区域。
- 期望：PNG 正常显示预览，不是“无法预览”；Hermes 的受限原因文案正常显示，而不是空白或翻译键本身。
- 证据：截图。

**X-22 伪造退出请求不能触发退出（RS-T58）**

- 前置：debug 构建（可使用 devtools）；一个运行中的 PTY；主窗口 devtools 已打开。
- 步骤：
  1. 在主窗口 devtools Console 执行 `window.__TAURI__.event.emit("app-exit-requested", { requestId: "forged", ptyCount: 0, executionTaskCount: 0 })`（若未暴露 `__TAURI__`，改在 PTY 独立窗口的 devtools 中执行 `emit_to("main", …)` 的等价调用，并记录该窗口能否发出）；
  2. 观察主窗口是否弹出退出确认；若弹出，点“确认退出”。
- 期望：伪造的请求即使弹出确认，点“确认退出”后也被后端拒绝（日志出现 `exit.request_mismatch` 或 `exit.no_pending_request`），PTY 仍在运行，应用不退出。随后用真实退出入口（托盘“退出”）取消一次、确认一次，行为符合 W-07/M-07/L-07。
- 证据：Console 截图、日志摘录、PTY 存活证据（`ps` 或任务管理器）。

**X-23 干净退出标记与异常退出提示（RS-T59、RS-T60；PD-12）**

- 前置：隔离 profile；候选构建；一个未保存的文件编辑（用于确认提示不声称恢复）。
- 步骤：
  1. 正常退出（托盘“退出”并确认）后重新启动：**不应**出现异常退出提示；
  2. 启动应用后强制结束进程（Windows：任务管理器结束任务或 `taskkill /F /IM <进程名>`；macOS：`kill -9 <pid>`；Linux：`kill -9 <pid>`），再重新启动：**应**出现一次“上次应用异常退出，未保存的编辑可能丢失”类提示，关闭后不再出现；
  3. 再次正常退出并重启：不出现提示；
  4. 应用运行时再启动第二个实例：第二实例应唤起已有窗口并退出，**不得**改写或清除标记（强杀主进程后重启仍应出现异常退出提示）；
  5. 系统级入口各测一次（对应已知限制表）：macOS Dock 退出与 `osascript -e 'quit app "CLI Launchpad"'`；Windows 注销；Linux `kill -TERM <pid>`。记录是否经过退出确认、重启后是否出现提示、PTY 与执行任务是否被清理（`RunEvent::Exit` 路径，RS-T60）、数据库里的任务状态是否为 `interrupted`。
- 期望：与上述一致；提示文案不包含“恢复”类字样；标记文件位于数据目录（`<profile>/.cli-launchpad/data/session-running.marker`），内容只有时间戳与 pid，不含文件路径或正文。
- 证据：每步的截图、标记文件内容、日志摘录、任务状态查询输出。

**X-24 托盘不可用时的降级（RS-T61；PD-13）**

- 前置：Linux 且桌面环境没有托盘宿主（例如未安装 AppIndicator 扩展的 GNOME）；候选构建；保存的关闭行为为默认“最小化到托盘”。
- 步骤：启动应用 → 观察日志中的托盘降级告警 → 关闭主窗口（有未保存文件与无未保存文件各一次）→ 检查应用是否退出、是否出现退出确认、重启后设置页里保存的关闭行为是否仍是“最小化到托盘”。
- 期望：应用正常启动；关闭主窗口走退出路径（有脏文件时出现退出确认）而不是隐藏后找不回；已保存的用户设置没有被改写。
- 证据：日志摘录、截图、设置页截图。Windows 与 macOS 无法构造“无托盘宿主”时记“不适用”，由 RS-T61 的注入测试覆盖。

**X-25 acceptance-hooks 验收构建（RS-T63、CI-10；PD-14）**

- 前置：能触发 `acceptance-build.yml`，或本地执行 `pnpm tauri build --features acceptance-hooks`（执行前核对选项，待核实）。
- 步骤：
  1. 构建验收包，运行后在托盘菜单确认出现“验收：强制销毁全部独立窗口”，对 W-10、M-10、L-10 的方法 A 执行一次；
  2. 构建正式发布包（不带 feature），运行后确认托盘菜单**没有**该项；
  3. 在正式发布包的二进制里搜索标记：`grep -a -c acceptance.force_destroy_windows <二进制>`（Windows 用 `Select-String -Path <exe> -Pattern acceptance.force_destroy_windows -Encoding Byte` 的等价做法，或 `findstr`），结果必须为 0。
- 期望：验收包有该菜单项且能强制销毁子窗口；发布包没有菜单项，二进制中也没有标记字符串。
- 证据：两个构建的托盘菜单截图、搜索命令输出。

**X-26 PD-10 折叠大小写在 hydrate 时的合并（RS-T62、FE-T63；平台调研完成并经用户确认前不执行）**

- 前置：PD-10 已实现（设计草案已评审通过，平台调研结论已经用户确认）；在 W-20、M-19、L-19 中选出至少一个 `Insensitive` 位置与一个 `Sensitive` 位置；准备一份已保存的布局，其中同一文件以 `a.txt` 与 `A.txt` 两种大小写分布在两个窗格。
- 步骤：启动应用并等待 hydrate 完成 → 观察两个文档是否都出现（只做精确去重）→ 等待探测结果到达后观察是否合并、保留哪个显示路径 → 重启应用确认合并结果落盘且没有重复提示；在 `Sensitive` 位置重复，确认不合并；在合并前（探测结果到达前）手动打开 `A.txt`，确认最终只有一个文档。
- 期望：`Insensitive` 位置合并为一个文档，显示先出现者的字面路径，出现一次“已合并 N 个仅大小写不同的重复文档”提示；`Sensitive` 与 `Unknown` 位置保持两个文档；合并前创建过保护性备份。
- 证据：合并前后的布局截图、日志摘录、备份清单、`sqlite3` 查询的 `workspace_state` payload 摘录。

### 8. 总评

1. **测试总量与跨平台覆盖都充分，薄弱点集中在编排层。** 三平台共执行 324 个不重复测试，没有漏跑的 cfg 测试。但退出门、窗口销毁、PTY 交接状态机、执行任务监督、恢复编排这些最容易出数据安全问题的路径，大多只测了辅助函数（1.4 节列出 21 项弱测试）。另有若干测试会静默通过或仅为同义反复，它们抬高了数字，却不提供证据。
2. **Ubuntu 的间歇失败是真实产品缺陷（P1），不能当作 flaky 忽略。** 根因是 cap-std 在 Linux 上的 `canonicalize` 存在“(deleted)”竞态（已在本地源码核实）。推荐的验证顺序是：SEAM-17 诊断 → 探针确认 → RS-T01 确定性复现 → 按方向 A 修复 → RS-T02、T03 压力测试及探针 0 失败。修复前，A 层门禁第 3 条“三平台 CI 在最终提交上通过”无法稳定满足。
3. **P0 有五组：** S1C-N01（Cmd+Q 绕过退出门，需要 SEAM-03 加 RS-T05/T06 加实机 M-08）；退出与窗口销毁编排没有测试（SEAM-01/02 加 RS-T07~T10）；CAS 竞态（RS-T01~T04）；布局 schema 单一版本源（RS-T56，0.3.0 升级用户的布局保存永远失败）；IPC DTO 序列化字段名（RS-T57，图片预览与受限更新原因的字段前后端不一致）。另外要注意：即使改用自定义菜单，macOS 上 Dock 退出、AppleScript 退出、注销仍会绕过退出门。这是 tao 的限制，需要在 M6 文档中明确列为已知限制，或者另做修复。
4. **本专项新发现的问题：**
   - N1：CAS 的 `(deleted)` 竞态（P1）；
   - N2：launch_service 测试测的是生产逻辑的副本；
   - N3：4 个安装测试在 CI 上不断言任何东西；
   - N4：执行事件目标测试是同义反复；
   - N5：主窗缺失且没有 PTY 时直接退出，不考虑文件窗的脏缓冲（P2）；
   - N6：macOS 系统级退出入口仍会绕过（P1 残留）；
   - N7：恢复编排中缓存清理在恢复 guard 之外执行，可能与会话启动、索引刷新并发（P2）；
   - N8：Windows `run_bounded` 先 spawn 后 attach，理论上存在逃逸窗口（P3）；
   - N9：离线安装包配置可能覆盖 CSP，需要守卫测试；
   - N10：发布的 Windows ARM64、Linux ARM64、macOS x64 没有在 CI 中跑测试；
   - N11：前端测试失败会跳过全部 Rust 步骤；
   - N12：`refresh_search_index` 只要一个工具的 context 构造失败（`?`）就整体失败（P3）；
   - N13：`complete_handoff` 不拒绝目标等于源（PD-09 已确认：拒绝）；
   - N14：capability 的 glob 比 label 规则宽（P3，提示性）；
   - N15：会话归属校验没有超时（P2）；
   - N16（P0）：布局 schema 单一版本源。0.3.0 升级用户的 `workspace_state` 行 `schema_version` 为 1，`read_current` 在内存迁移到 v5，`workspace_layout_repo::save_current` 因列值不等于 5 返回 `saved=false`，前端保存队列无限重试（RS-T56）；
   - N17（P0）：`ProjectFileOpenResult::Image` 与 `ManagedUpdateStatus::Denied` 缺少 `rename_all_fields = "camelCase"`，序列化为 `mime_type`、`base64_data`、`reason_key`，前端读 `mimeType`、`base64Data`、`reasonKey`（RS-T57）；
   - N18（P1）：`confirm_app_exit` 不核对待决退出请求，子窗口持有 `core:event:allow-emit-to` 可伪造 `app-exit-requested`（RS-T58）。
5. **建议执行顺序：**
   1. 先做 CI-03、CI-04、CI-01、CI-02，把证据链补起来（不改产品代码）；
   2. 再做 SEAM-17 加 CI-05 探针，确认 CAS 根因；
   3. 然后按 SEAM-12、SEAM-01~03、SEAM-04 的顺序推进 P0 和 P1 测试；RS-T57 的顺序必须是先修 serde 属性、再生成 golden fixture；RS-T56 与 RS-T57 都是已确认的用户可见缺陷，应与 CAS 修复并行排期；
   4. 产品决策已全部确认（主报告 4.7.1）；除 PD-10（设计草案已评审通过，但调研结论确认前保持 `#[ignore]` 或 `it.skip`）外，按最终决策实现。SEAM-05、SEAM-09、SEAM-21 的 DTO 形状仍需先向用户确认（它们不属于 PD-01 至 PD-16）；
   5. 实机清单在 P0 修复构建产出后，三平台分别执行（含 7.4 的 X-20~X-26），并按 7.0 节规则记录。

### 9. 终稿相对初稿的更正

1. **交叉引用笔误：** 初稿 2.4 节第 2 步与 RS-T03 的“稳定性”写成“CI-06 的探针”，flaky 探针实际是 CI-05（CI-06 是扩展架构矩阵）。终稿已改为 CI-05。
2. **对 macOS、Windows 的 canonicalize 行为表述过满：** 初稿写“macOS 走逐组件解析，Windows 走 GetFinalPathNameByHandle”。本专项只逐行核实了 Linux 的 `canonicalize_impl.rs`，没有逐行核实另两个平台的 cap-primitives 实现；它们不出现该问题的依据是 CI 在同一提交上通过，属于推断。终稿 2.2 节已按此改写。
3. **RS-T29 的占位符：** 初稿写“drop table <实际的缓存表名>”。终稿已改为具体表名 `cache_entries`（缓存库共四张表：`cache_entries`、`session_search_documents`、`session_search_sources`、`session_search_fts`）。
4. **RS-T56 位置描述：** 初稿未涉及。终稿注明 `db/workspace_layout_repo.rs` 已有 2 项测试，新测试加入其 `tests` 模块，不新建模块。
5. **CI-02 的下限值与 RS-T45 的联动：** 初稿的 `minimumPassed` 取自当前基线（297/298/296）。RS-T45 落地后三平台各少 1 项，终稿补充了同步下调与 `allowedIgnored` 的说明；同时补充了 RS-T56~RS-T58 新测试进入 `required.all` 的步骤。
6. **CI-05 与 `--include-ignored`：** 初稿说“单独处理刻画测试”但没给命令。终稿补充了 `--skip cap_std_canonicalize_can_return_deleted_suffix` 的写法。
7. **新增内容：** SEAM-21~SEAM-23、RS-T56~RS-T58、CI-09、第 7.4 节的 X-20~X-26、第 1.4 节弱测试 #20、#21，以及追踪矩阵里对应的三行；所有 seam 与规格补充了“关联审查编号”。
8. **总评中的数量：** 初稿“19 项弱测试”和“6 项静默通过或同义反复”的口径不统一，终稿统一写为 1.4 节列出的 21 项弱测试，并去掉了“6 项”这一单独数字。
9. **RS-T58 静态扫描的文件位置：** 草稿把 `invoke("confirm_app_exit")` 的位置写成 `src/App.tsx`；核对后它实际位于 `src/lib/tauri.ts:737`，`src/App.tsx:154` 只负责监听事件。终稿已分别写明两个文件。
10. **M-xx 与 L-xx 条目展开：** 初稿用“M-01 至 M-06 对应 W-01 至 W-06，使用 macOS 命令”这类合并写法，终稿已把 M-01~M-06、M-09~M-14、L-01~L-06、L-09~L-14 逐条展开，每条独立写出前置、步骤、期望与证据。

### 10. 产品决策落地后的修订（2026-10-06）

用户确认 PD-01 至 PD-16 后（PD-10 改选“折叠大小写”并提出“探测钩子 + flag”设计主线；PD-12 为增强版），本文件做了如下修订，便于追溯：

| 类别             | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通用约定         | 第 2 条改写：产品决策已确认，规格不再因决策而保持 ignore；唯一例外是 PD-10（设计草案已评审通过，但平台调研结论确认前保持 `#[ignore]`/`it.skip`）                                                                                                                                                                                                                                                                                                                                                   |
| 现有规格调整     | RS-T07（PD-01：执行任务数）、RS-T16 第 14 条（PD-09：拒绝）、RS-T24 与 RS-T26（PD-05：0015 删除遗留表、配置导入容忍旧字段）、RS-T25（PD-08）、RS-T36 与 FE-T29（PD-15：点分命名加旧码别名，`pty.input_backpressure` 与 `exec.plan_changed` 不再是死映射）、RS-T37（PD-02）、RS-T51（PD-11）、RS-T56（PD-16 的注记）、FE-T10（PD-01 新增三行）、FE-T58（PD-07：终端始终深色）、FE-T61（载荷字段统一为 `executionTaskCount`）、SEAM-18（PD-14 已采纳）、W-10/M-10/L-10（方法 A 为主，方法 B 为备选） |
| 新增规格         | RS-T59（PD-12 干净退出标记）、RS-T60（PD-12 退出事件尽力清理）、RS-T61（PD-13 托盘降级）、RS-T62（PD-10 探测钩子、flag 与 PathKey，调研确认前为骨架）、RS-T63（PD-14 feature 受控）；FE-T62（PD-12 异常退出提示）、FE-T63（PD-10 前端侧，调研确认前为骨架）                                                                                                                                                                                                                                        |
| 新增 seam        | SEAM-24（退出清理）、SEAM-25（托盘降级）、SEAM-26（干净退出标记）、SEAM-27（探测 trait 与 PathKey）；FE-SEAM-15（启动提示）、FE-SEAM-16、FE-SEAM-17（PD-10）                                                                                                                                                                                                                                                                                                                                       |
| 新增 CI          | CI-10（验收构建与发布包守卫）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 新增实机项       | W-20、M-19、L-19（路径语义真实卷矩阵，调研确认前为预备清单）；X-23（干净退出标记）、X-24（托盘降级）、X-25（验收构建）、X-26（PD-10 合并，调研确认前不执行）                                                                                                                                                                                                                                                                                                                                       |
| 标注为待调研核实 | 所有平台探测 API 名称、标志位、文件系统类型表、挂载选项与期望探测结果（见主报告 4.7.2.3 与 4.7.2.12）                                                                                                                                                                                                                                                                                                                                                                                              |
