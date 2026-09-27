# 品牌图标资源

CLI Launchpad 当前唯一产品标识源图为 [`v3/macos-original.png`](v3/macos-original.png)：深蓝底色、终端提示符和圆角正方形轮廓。Windows 图标由该源图生成圆角正方形版本，不再使用圆形专属变体。

## 正式资源

- `v3/macos/`：macOS DMG 与应用图标。
- `v3/windows/`：Windows 尺寸图和 ICO；PNG 视觉与 macOS 源图一致。
- `src-tauri/icons/`：Tauri 实际打包与应用内 Logo 使用的跨平台资源。
- README 头部引用 `v3/macos/icon-512.png`，与安装包及应用内品牌图形保持一致。

`final/` 及 `icon.png`、`icon-final.png` 是未被应用或用户文档引用的旧图标探索资源，不是当前产品标识。新资源应从唯一源图重新生成，避免继续创建平台差异版本。
