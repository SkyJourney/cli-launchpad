# Noto Sans SC 资源说明

本目录内置 CLI Launchpad 全局 UI 使用的 Noto Sans SC 可变字体。

## 来源与授权

- 官方仓库：https://github.com/google/fonts/tree/main/ofl/notosanssc
- 字体文件：`NotoSansSC[wght].ttf`
- 授权协议：SIL Open Font License 1.1
- 完整授权文本：`LICENSE.txt`

## 变体与用途

应用使用单个 100–900 可变 TTF 文件，并采用 Regular、Medium、SemiBold、
Bold 四个主要字重，对应 400、500、600、700。字体通过 `src/fonts.css` 引入，
并随 Vite 前端产物进入 Windows 与 macOS 安装包。
