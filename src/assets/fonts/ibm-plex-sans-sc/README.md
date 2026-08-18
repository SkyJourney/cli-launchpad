# IBM Plex Sans SC 资源说明

本目录内置 CLI Launchpad 全局 UI 使用的 IBM Plex Sans SC 静态字体文件。

## 来源与授权

- 官方仓库：https://github.com/IBM/plex
- npm 包：`@ibm/plex-sans-sc@1.1.0`
- npm 完整性：`sha512-IkhORwgw/CrsUss7uW9Rj6KKSsGQoIyIaNWjjju/7sV7SYS3yk0c/DgZN/leIG3Co5lN/X4Or/sQaL+SdvmSIg==`
- 授权协议：SIL Open Font License 1.1
- 完整授权文本：`LICENSE.txt`

## 变体与用途

应用只保留 Regular、Medium、SemiBold、Bold 四个 WOFF2 文件，分别对应
400、500、600、700 字重。字体通过 `src/fonts.css` 引入，并随 Vite 前端产物
进入 Windows 与 macOS 安装包。
