# 0.3.0 里程碑索引

目标：把 CLI Launchpad 从外部终端启动器转型为以项目和内置终端会话为中心的轻量工作台。

里程碑按依赖顺序推进。每个阶段完成后先按对应文档验收，再进入下一阶段。状态初始为“待开始”，完成情况由后续实施记录更新。

macOS/Linux 实机对齐安排在 Windows 版 M1–M4、G1–G4 完成之后，任务统一记录在[跨平台对齐待办](cross-platform-alignment.md)；它不阻塞 Windows 阶段推进，但属于 M5 发布门禁。

| 编号 | 里程碑                            | 依赖                            | 验收文档                             |
| ---- | --------------------------------- | ------------------------------- | ------------------------------------ |
| M0   | 产品方向、架构边界与视觉标识      | 无                              | [M0](M0-product-and-brand.md)        |
| M1   | 内置 PTY 核心闭环                 | M0                              | [M1](M1-pty-foundation.md)           |
| M2   | 跨项目共享终端工作台              | M1                              | [M2](M2-workspace-shell.md)          |
| G1   | Grok Build CLI 接入（独立关卡）   | M2                              | [G1](../grok-build-cli.md)           |
| M3   | 全局布局保存与会话恢复            | M2、G1                          | [M3](M3-sessions-and-layouts.md)     |
| G2   | Hermes Agent CLI 接入（独立关卡） | M3、G1                          | [G2](../hermes-agent-cli.md)         |
| G3   | 统一自定义窗口标题栏（独立关卡）  | M2、M3、G2                      | [G3](G3-custom-window-chrome.md)     |
| G4   | 主题、生命周期与适配边界治理      | M2、M3、G2、G3 Windows 实机验收 | [G4](G4-architecture-refactoring.md) |
| M4   | 现有能力接入与数据迁移            | M2、M3、G1–G4                   | [M4](M4-feature-integration.md)      |
| M5   | 跨平台验收与 0.3.0 发布           | M1–M4、G1–G4                    | [M5](M5-release-readiness.md)        |

## 验收约定

- 每个里程碑的验收条件须逐项检查，并记录通过、未通过或延期原因。
- 需要新增的架构决策先在文档中对齐，再开始对应阶段的实现。
- 里程碑验收不自动代表版本发布；M5 完成后另行确认 0.3.0 发布候选。

## 状态

- M0：已完成（生命周期与内置 PTY 产品方向已定；产品、架构、UI、路线图及后续里程碑验收条件已对齐，品牌资源通过复核）。
- M1：已完成（Windows 开发、自动化门禁和用户手工验收通过；macOS/Linux 实机对齐转由 M5 统一执行）。
- M2：Windows 阶段已完成（用户实机验收、最终代码审查及自动门禁通过；macOS/Linux 对齐留给 M5）。
- G1：已完成。G1.1a 工具基础、G1.1b 状态/版本/展示、G1.2 安装/更新、G1.3 PTY 会话、G1.4 本地历史搜索及 Windows 手工验收通过；G1.5 最终复核和门禁通过。真实安装/更新未执行，macOS/Linux Grok 验证留待 M5。
- M3：Windows 阶段已完成。阶段 0–7 实现、最终代码审查与门禁完成；命名布局应用保留主工作区运行 PTY，独立窗口保持独立且不参与窗格重排；主窗口大小/位置恢复有显示器边界保护。Windows 实机验收通过；macOS/Linux 对齐留给 M5。
- G2：实现、代码审查与自动门禁完成；2026-10-02 用户确认 Windows 实机验收通过。适配器框架、Hermes 检测/安装/更新、PTY 启动、历史检索/恢复已纳入统一边界；macOS/Linux 对齐由 M5 统一验收。
- G3：Windows 阶段实现、代码复核、自动门禁和用户实机验收已完成。主工作区和独立终端窗口统一自定义标题栏；macOS/Linux 窗口实机验收统一见 M5 清单，详见 [G3 文档](G3-custom-window-chrome.md)。
- G4：已完成。自动门禁、最终代码审查和五类 Windows 实机验收通过；独立窗口画布无法单独视觉确认的范围与代码复用依据已记录。详见 [G4 文档](G4-architecture-refactoring.md)。
- M4：已完成。0.2.4 schema 8 / bundle v3 升级自动门禁与配置兼容测试通过，用户确认 Windows 实机验收通过；macOS/Linux 对齐留给 M5。详见 [M4 验收记录](M4-feature-integration.md)。
- M5：跨平台对齐与整体验收已通过，后续平台问题按 bug+fix 处理；Windows 0.3.0 x64 NSIS 本地候选包已安装并启动验证，八目标 Release 预检全部成功。正在准备推送正式 `v0.3.0` tag 并核验 GitHub Release。详见 [跨平台对齐记录](cross-platform-alignment.md) 与 [M5 发布验收](M5-release-readiness.md)。
