---
name: 协作反馈
description: 用户协作偏好、范围纠正和执行约束
type: feedback
last_updated: 2026-05-25
commit: 3ad8ce1
---

# 协作反馈

## 使用简体中文

**结论：** 所有解释、询问、文档和汇报使用简体中文，代码除外。
**Why：** 项目协作规范和 AGENTS 指令要求中文沟通。
**How to apply：** 后续回复、文档和计划默认使用简体中文。

## 执行前确认清单

**结论：** 实质性任务前先列任务清单，修改文件前先说明变更内容并等待确认。
**Why：** 项目 AGENTS 规则明确要求先确认设计、任务清单和代码修改。
**How to apply：** 涉及写文件、架构变化或较大步骤时，不直接动手，先给出明确清单和预期修改。

## 不要扩展为通用 CLI 管理器

**结论：** 项目只围绕 `claude`、`codex`、`agy`，不要检测、安装或启动其他 CLI。
**Why：** 用户明确纠正过范围，核心功能是快速打开这三个 CLI 的 PowerShell 窗口。
**How to apply：** 不主动加入 Gemini、Qwen、GitHub CLI、uv 等工具的检测或安装逻辑。
**See Also：** [[decisions.md#只聚焦三项核心-CLI]]

## 不再关注 Gemini CLI

**结论：** Antigravity 是 Google 新品牌下的目标 CLI，本项目不再关注 Gemini CLI。
**Why：** 用户明确说明 Google 准备将 Gemini CLI 迁移到 Antigravity，新项目应只看 Antigravity。
**How to apply：** Gemini CLI 只可作为迁移背景提及，不进入功能范围。
**See Also：** [[decisions.md#Antigravity-使用-agy-作为官方主命令]]

## 修改前说明和确认

**结论：** 文件修改前先描述要写入或删除的内容，用户确认后再执行。
**Why：** 用户多次使用“确认/开始”的工作方式，项目规则也要求写文件前确认。
**How to apply：** 先说清楚目标文件、变更块和验证方式，再调用写文件工具。
**See Also：** [[decisions.md#安装命令必须来自官方来源]]
