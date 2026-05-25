# 阶段 4：配置交换、启动历史与路径校验

## 目标

补足业务配置可移植性和操作可追踪性，并在 Rust 边界拒绝无效项目路径。

## 配置导出契约

`ConfigBundle` 从版本 1 升级到版本 2，新增 Shell profile。导出内容为：

- 项目目录名称、路径、置顶和备注。
- 项目级工具参数。
- 三项工具的全局参数。
- Shell profile 和默认启动方式。

明确不导出：

- 日志、缓存、窗口位置。
- 外部 CLI 会话内容。
- 恢复备份。

版本 1 文件仍可导入；缺少的 Shell profile 保留目标应用当前配置。

## 启动历史契约

复用已有 `launch_history` 意图，迁移为不存储完整命令的安全结构：

```text
id, directory_id, tool_key, action, success, error_category, launched_at
```

其中 `action` 为 `launch` 或 `resume`；`error_category` 只记录分类，不存储
原始参数与终端输出。

## 路径校验

- 添加目录前验证路径存在且确为目录。
- 启动/恢复前再次验证路径仍存在。
- 路径失效时保留配置，UI 提示用户修正或移除，不静默删除。

## 具体改动

- 新增 SQLite migration 更新安全启动历史表。
- 新增 history model/repository/commands。
- 修改 `launch_service` 记录成功或失败动作。
- 扩展 `ConfigBundle` 和导入导出测试。
- 设置页或详情视图新增最近启动历史列表与清理操作。

## 测试与验收

- v1 配置导入兼容，v2 可 round-trip。
- 无效目录不能添加，也不能发起启动。
- 启动历史只含安全元数据，不出现参数明文。
