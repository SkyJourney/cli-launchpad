---
name: 项目进度
description: 当前完成状态、未提交变更和近期待办
type: project
last_updated: 2026-05-23
commit: a2fbb54
---

# 项目进度

## 当前状态

- 默认分支已改为 `main`。
- Node/pnpm 依赖已安装，`pnpm-lock.yaml` 已生成。
- Rust/Cargo 和 VS Build Tools 2022 环境已检查，Tauri/Rust 构建基础可用。
- 图标透明化、裁切、多尺寸 PNG 和 ICO 已完成。
- `README.md` 和 `AGENTS.md` 已中文化。
- `docs/` 已更新为中文，并围绕 `claude`、`codex`、`agy` 收窄产品范围。
- 官方资料已同步到文档：Claude、Codex、Antigravity 的命令和安装来源。

## 当前未提交变更

本次记忆初始化前，工作区已有未提交文档变更：

- `AGENTS.md`
- `docs/adr-0001-technology-stack.md`
- `docs/architecture.md`
- `docs/product-requirements.md`
- `docs/roadmap.md`
- `docs/tooling-and-installation.md`

记忆文件本身是本次新增内容，不应自动提交，除非用户明确要求。

## 近期待办

- 修正 `src-tauri/tauri.conf.json` 中仍使用 `npm run dev/build` 的配置，改为 pnpm。
- 验证 `bundle.icon` 配置是否需要指向已生成的 Tauri 图标。
- 设计并实现三项 CLI 的检测 service 和 UI 状态面板。
- 后续再实现一键安装，且必须先有命令预览和用户确认。

## See Also

- [[decisions.md#只聚焦三项核心-cli]]
- [[reference.md#官方-cli-资料]]
