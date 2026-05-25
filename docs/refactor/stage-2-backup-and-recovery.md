# 阶段 2：自动备份与恢复

## 目标

为用户业务数据库提供一致、可识别、可恢复的恢复点，不将 JSON 配置
导出误当作完整备份。

## 数据契约

```text
~/.cli-launchpad/backups/
├─ database/
│  └─ cli-launchpad-<timestamp>-<reason>.db
└─ manifests/
   └─ cli-launchpad-<timestamp>-<reason>.json
```

备份 manifest 包含：

- 唯一 id 与创建时间。
- 原因：`manual`、`pre_import`、`pre_restore`、`pre_migration`。
- 数据库 schema `user_version`。
- 数据库文件名与大小。

## 一致性原则

- 对运行中的 SQLite 使用 `rusqlite` 的 SQLite Online Backup API。
- 恢复前校验备份文件存在、`quick_check` 通过且 schema 可接受。
- 恢复前先对当前状态创建 `pre_restore` 保护备份。
- 恢复覆盖业务数据库，不触碰缓存、日志和 CLI 外部会话文件。

## 具体改动

- 为 `rusqlite` 启用 `backup` feature。
- 新增 `models/backup.rs` 与 `services/backup_service.rs`。
- 新增 commands：
  - `list_backups`
  - `create_backup`
  - `restore_backup`
- 配置导入前自动创建 `pre_import` 备份。
- 数据库 schema 更新前预留 `pre_migration` 自动备份入口。
- 前端设置页新增“数据恢复”区域：
  - 创建手动恢复点。
  - 展示备份列表、时间、原因和大小。
  - 二次确认后执行恢复。

## 保留策略

- 自动备份最多保留最近 10 个。
- 手动备份最多保留最近 5 个。
- 删除仅针对超过上限的已确认完整备份文件与对应 manifest。

## 测试与验收

- 备份生成后可打开且内容与当前库一致。
- 配置导入前自动出现 `pre_import` 恢复点。
- 恢复失败不改变当前数据。
- 成功恢复后前端缓存失效并展示恢复后的配置。
