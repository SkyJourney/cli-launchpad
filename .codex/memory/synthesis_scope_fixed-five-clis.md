---
name: 五项 CLI 的固定产品范围
description: 0.3.0 目标 CLI 范围的演进背景、取舍和适用边界
type: synthesis
last_updated: 2026-10-02
commit: 8d4a751
---

# 五项 CLI 的固定产品范围

## 背景

CLI Launchpad 从项目目录中的 CLI 启动和会话管理，演进为内置终端工作台。Grok Build 和 Hermes Agent 分别通过 G1、G2 独立里程碑加入；Hermes 的接入由用户明确批准，并有单独的验收边界。

## 分析过程

- 产品核心是围绕项目管理 CLI 会话，不是对任意命令行工具做泛化管理。
- 将支持集固定为 Claude Code、Codex、Antigravity、Grok Build、Hermes Agent，能让检测、安装、启动、历史会话、界面入口与验收范围保持一致。
- 适配器用于隔离这五项工具各自的已知差异，不构成动态插件或用户自定义 CLI 扩展入口。
- Hermes 只覆盖本地交互式 CLI；Gateway、消息平台、Desktop、Profile 管理和远程服务均在范围外。

## 结论

0.3.0 只支持上述五项目标 CLI。新工具须通过独立范围与验收决策后才可纳入；不能仅因适配器结构可扩展就扩大产品范围。此决策由 [[decisions.md#0.3.0-目标范围为五项-CLI]] 维护，当前清单见 [[project_overview.md#核心-CLI-范围]]。

## See Also

- [[decisions.md#0.3.0-目标范围为五项-CLI]]
- [[project_overview.md#核心-CLI-范围]]
