# 里程碑 6 阶段报告：桌面体验与内部发布

## 目标

系统托盘、窗口状态持久化、配置导入导出、Windows 打包配置。

## 完成内容

### 桌面集成

- **系统托盘**：启用 tauri `tray-icon` 能力，`setup_tray` 构建托盘菜单「显示主窗口 / 退出」，左键点击托盘显示并聚焦主窗口；图标优雅降级（无嵌入图标时不 panic）。
- **窗口状态持久化**：接入 `tauri-plugin-window-state`，Rust 层自动保存/恢复窗口尺寸与位置（仅用 Rust 侧，无需 capability）。
- **capabilities**：新建 `capabilities/default.json`（`core:default`，`windows: ["main"]`）。核实窗口默认 label 为 `main`，与之匹配，自定义 IPC 命令无需在此声明。

### 配置导入导出

- `services/config_service.rs`：`export` 快照目录（含各自工具参数）+ 工具全局参数为 `ConfigBundle`；`import` 在**事务**内按 key 更新工具全局参数、按 path 合并目录（不存在则新增）、应用工具参数。round-trip 与幂等 2 项单测。
- `commands/config.rs`：`export_config`（返回 JSON）/ `import_config`（接受 JSON）。
- 仓储新增：`directory_repo::get_by_path`/`set_pinned_and_note`、`tool_repo::update_global_args`。
- `SettingsView`：配置备份区——导出显示 JSON + 复制，导入粘贴 JSON 后合并。采用复制/粘贴而非文件对话框，避免引入 dialog/fs 插件与 capability 配置风险。

### 打包

- `tauri.conf.json`：`bundle.targets` 改为 `["nsis"]`，Windows 内部分发用 NSIS，避免 WiX 依赖。

## 代码审查与修复

经 code-reviewer 审查，修复：

- **C-1**（修复）：`import` 无事务，中途失败半写入 → 包进 BEGIN/COMMIT，失败 ROLLBACK。
- **I-2**（修复）：`default_window_icon().unwrap()` 图标缺失会 panic 阻止启动 → 改为 `if let Some(icon)` 优雅降级。
- **I-3**（修复）：导入后 `directory-tool-args` 缓存未失效 → 补 invalidate。
- 审查核实：capability 的 `windows: ["main"]` 与默认 label 匹配（前端 invoke 不会失败）；window-state 无需 capability；import 合并无重复风险。

## 验证

- `cargo test`：25 项通过（含配置 round-trip/幂等）。
- `cargo check`：无警告（tray-icon、window-state 编译通过）。
- `pnpm run build`：通过。
- **未运行打包**：无人值守下未执行 `pnpm tauri build`（耗时长、需 NSIS 工具链、无法可靠验证）。
- **待人工验证**：托盘显示/菜单/点击、窗口尺寸位置跨启动恢复、配置导出导入实际效果、`pnpm tauri build` 产出 NSIS 安装包。

## 已知限制 / 后续

- **打包图标**：`src-tauri/icons/` 仅有 `icon.ico`（Windows NSIS 所需格式）。如需跨平台或更完整图标集，运行 `pnpm tauri icon assets/icon/icon.png` 生成 PNG 变体并加入 `bundle.icon`。
- 配置导入导出为复制/粘贴 JSON；文件选择器（dialog/fs 插件）可作后续增强。
- 托盘「关闭到托盘」（拦截窗口关闭事件最小化到托盘）未实现，当前关闭即退出；可后续增强。
