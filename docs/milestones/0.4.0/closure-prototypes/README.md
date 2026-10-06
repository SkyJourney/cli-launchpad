# M6 收口原型（参考文件）

本目录保存第二轮复核（2026-10-06）中用来证明“宿主测试 harness 可行”并复现缺陷的原型测试。它们是**参考材料，不是测试套件的一部分**：

- 文件统一加了 `.txt` 后缀，所以不会被 `vitest`、`tsc` 或 Prettier 当作源码处理，也不会进入 `pnpm test`。
- 原型里的导入使用了审查机器上的绝对路径（`C:/Projects/cli-launchpad/src/...`），不能直接运行。落地时需要把它们改成相对路径或 `@/` 别名，再按 `M6-closure-test-spec.md` 第一部分的 HX-1~HX-6 设计整理到 `src/test/host/` 与对应的 `*.host.test.tsx` 中。
- 原型验证用的是当时 `cd4feac` 的代码；落地前请对照最新代码，核对被引用的函数名与行号。

## 文件说明

| 文件                              | 用途                                                                                                                                               | 对应规格与缺陷                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `host/mocks.tsx.txt`              | 稳定 `t` 的 `react-i18next` mock、`sonner` mock、假 `PtyTerminal`（`fakeTerminals`、`onFakeTerminalCreated`）                                      | HX-2                                     |
| `host/harness.tsx.txt`            | `mountWorkspace`、Probe 上下文、`CapturingBoundary`、`flush`、`deferred`、`openFile`、`launchPty`、文件与 PTY 分离辅助函数                         | HX-3、HX-4                               |
| `ptyWorkspace.proto.test.tsx.txt` | 在 jsdom 中挂载 `PtyWorkspaceProvider` 并 hydrate、持久化出合法布局；文件分离后返回、PTY 分离后返回时挂起 attach，复现 return 阶段持久化抛 unowned | FE-T01、FE-T04、FE-T05；S1A-N01          |
| `appExit.proto.test.tsx.txt`      | 渲染完整 `<App/>`，静默退出被后端拒绝后对话框按钮全部禁用                                                                                          | FE-T11；S1A-N03                          |
| `language.proto.test.tsx.txt`     | 使用真实 i18n，切换语言后工作区被重新 hydrate、未保存 buffer 与运行中 slot 丢失                                                                    | FE-T08；FE-NEW-01                        |
| `timers.proto.test.tsx.txt`       | fake timers：owner-lost 重新接管重试无上限且卸载后遗留定时器；子窗口不应答 flush 时按脏处理                                                        | FE-T23、FE-T12；S1A-N05                  |
| `misc.proto.test.tsx.txt`         | rehydrate 不释放 Monaco model；重启 hydration 把已分离文件放回焦点 pane；已知 kind 的渲染错误占位上的关闭按钮无效                                  | FE-T21、FE-T15、FE-T22；S1A-N12、S1A-N04 |
| `calib.proto.test.tsx.txt`        | 分离状态下应用命名布局；保存进行中应用布局后 saving 被清除；Unknown 内容往返；双击保存只发一次 invoke（用于校准断言写法，这些用例当前均通过）      | FE-T14、FE-T16、FE-T42、FE-T44           |
| `vitest.config.mjs.txt`           | 原型使用的独立 vitest 配置（只匹配 `*.proto.test.*`，并注入 `tauriMock` 作为 setup 文件）                                                          | 仅供参考                                 |

## 不要做的事

- 不要把 `.txt` 后缀去掉后原样放进 `src/`：绝对路径与一次性的校准断言会让套件在其他机器上失败。
- 不要把这些原型的“当前失败”断言当作最终测试：最终测试以规格文档的“预期当前结果”和“反向断言”为准，并遵循规格文档“通用约定”第 1 条（先以失败状态落地，再修复转绿）。
