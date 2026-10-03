---
name: 跨平台发布的 Tag 门禁
description: 手动预检与正式版本 Tag 发布的背景、门禁和当前平台矩阵
type: synthesis
last_updated: 2026-10-03
commit: ab34efc
---

# 跨平台发布的 Tag 门禁

## 背景

本地开发环境通常只能完整验证当前平台和架构。正式桌面发布需要同时覆盖 Windows、macOS 与 Linux；当前权威构建矩阵定义在 `.github/workflows/release.yml`，M5 验收范围见 `docs/milestones/0.3.0/M5-release-readiness.md`。

## 分析过程

- 手动 `workflow_dispatch` 执行相同构建矩阵，用于 Tag 前检查，不发布 GitHub Release，并保留限时 Actions Artifacts 供检查。
- 正式发布由 `v*.*.*` Tag 触发。工作流校验应用版本一致性，并要求 Tag 指向 `main` 历史中的提交。
- 当前有八个构建目标：Windows x64 与 ARM64 各在线/离线 NSIS、Linux x64 与 ARM64（各产出 deb/rpm/AppImage）、macOS Apple Silicon 与 Intel DMG。Windows ARM64 使用 `windows-11-arm` 原生 Runner 和 `aarch64-pc-windows-msvc`；2026-10-03 手动预检 run `37129066965` 已确认八个目标全部成功，并上传八组 Actions artifacts。
- 发布任务依赖校验及全部构建成功，再收集安装包、生成 SHA-256 清单和 Release Notes 并发布；失败的目标不会生成不完整 Release。
- M5 已把 Linux 加入正式分发矩阵，因此旧的四目标描述只代表早期发布阶段，不能再作为当前平台矩阵依据。

## 结论

保留手动预检和 Tag 正式发布的两段门禁。2026-10-03 八目标手动预检已通过，M5 验收文档推送后创建 `v0.3.0` Tag 并核对正式 Release。版本、Tag 来源、八目标矩阵或产物组装方式变化时，应以工作流实现和 M5 文档为准同步更新此决策与用户发布说明。规则由 [[decisions.md#Git-Tag-驱动跨平台自动发布]] 维护；界面和产物概况见 [[project_overview.md#桌面体验与分发]]，官方工作流资料见 [[reference.md#发布工具官方资料]]。

## See Also

- [[decisions.md#Git-Tag-驱动跨平台自动发布]]
- [[project_overview.md#桌面体验与分发]]
- [[reference.md#发布工具官方资料]]
