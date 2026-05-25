# 可靠性重构实施索引

本目录记录 CLI Launchpad 从可运行桌面工具提升为具备持久化、恢复、
诊断和缓存治理能力的软件工程方案。五个阶段按顺序实施，每个阶段都
必须完成代码修改、审查修正、编译/测试验证和独立 Git 提交。

## 目标目录布局

```text
~/.cli-launchpad/
├─ data/
│  └─ cli-launchpad.db
├─ cache/
│  └─ cache.db
├─ logs/
│  └─ cli-launchpad.log
└─ backups/
   ├─ database/
   └─ manifests/
```

Tauri `identifier` 采用稳定发布标识 `app.cli-launchpad.desktop`。业务
数据路径不依赖该标识；框架管理的 WebView 和窗口状态等运行时文件可
继续由 Tauri 的应用目录负责。

## 实施阶段

| 阶段 | 文档 | 目标 |
| --- | --- | --- |
| 1 | [stage-1-storage-and-startup.md](stage-1-storage-and-startup.md) | 稳定数据根目录、旧数据迁移、数据库启动防线、单实例 |
| 2 | [stage-2-backup-and-recovery.md](stage-2-backup-and-recovery.md) | 一致性备份、恢复命令、恢复界面 |
| 3 | [stage-3-logging-and-diagnostics.md](stage-3-logging-and-diagnostics.md) | 持久日志、脱敏诊断、诊断导出 |
| 4 | [stage-4-config-and-history.md](stage-4-config-and-history.md) | 完整配置交换、操作历史、路径校验 |
| 5 | [stage-5-cache-and-performance.md](stage-5-cache-and-performance.md) | 独立可删除缓存、TTL 策略、缓存治理界面 |

## 全局约束

- `data/` 是用户配置事实来源，删除前必须有用户明确动作或恢复流程。
- `cache/` 删除后必须能够由现有事实来源重新生成。
- `logs/` 不记录可能含密钥的工具参数、不记录完整会话正文。
- `backups/` 通过 SQLite 一致性备份能力生成，不直接复制活动数据库。
- 会话源文件始终属于 Claude Code / Codex，本应用只读，不修改来源。
- 任何路径迁移都保留旧文件，不执行自动删除。
