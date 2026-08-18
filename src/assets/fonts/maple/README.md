# Maple Font 资源说明

本目录内置 CLI Launchpad 使用的 Maple Font v7.9 静态字体文件。

## 来源与授权

- 官方仓库：https://github.com/subframe7536/maple-font
- 发布版本：https://github.com/subframe7536/maple-font/releases/tag/v7.9
- 授权协议：SIL Open Font License 1.1
- 完整授权文本：`LICENSE.txt`

字体文件来自官方 v7.9 发布资产，下载后已使用发布页提供的 SHA-256 值完成校验。

## 变体与用途

- `ui/`：Maple Mono NormalNL CN，用于全局 UI。
- `terminal/`：Maple Mono NL NF-CN，用于命令、路径、参数和日志。
- 两个变体均只保留 Regular、Medium、SemiBold、Bold，对应 400、500、600、700。
- 两个变体均关闭代码连字；终端变体额外包含 Nerd Font 图标字形。

字体通过 `src/fonts.css` 引入，由 Vite 复制到前端构建产物，并随 Tauri 安装包分发。更新版本或替换文件时，需要同步核验来源、SHA-256、内部字体家族名、授权文件和最终安装包体积。
