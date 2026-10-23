# M7：Markdown 连续预览

## 目标

在 M6 内容窗格和文本编辑器上增加 Markdown 连续渲染、文档主题与 ECharts 围栏能力。M7 先优化 `md-to-pdf` 的功能分包和按需组合语义，再由 Launchpad 通过显式配置接入优化后的包；不接入分页和导出。

## 依赖与设计门禁

- 依赖 M6 文件工作区及内容适配器。
- **依赖 M6 B 层门禁关闭**：[M6 收口复核报告](M6-closure-review.md) 第四章 4.5 节的 B 层清单全部关闭前，M7 不得开始任何实现工作。
- **渲染隔离方案已确认（PD-06，2026-10-06），且跨窗口信任边界改造先行**：Markdown 渲染采用 sandbox iframe（`srcdoc`，不给 `allow-scripts` 与 `allow-same-origin`），图片与字体经受授权约束的自定义资源协议提供，全局 CSP 不放宽；独立零命令窗口类别仅作为备选，未采用（见主报告 4.7.1）；主报告 3A.9 节列出的 7 项信任边界改造（退出请求关联、Rust 通知改走私有通道、PTY 交接令牌绑定目标、Rust 中继并盖发送方戳的跨窗消息、渲染隔离、导航与新窗口拦截、精确 CSP 契约）必须在 M7 实现前完成。事件系统不是隔离边界，渲染不可信 HTML 之前这些缺口会从理论风险变成可利用的攻击面。
- 实施顺序固定为：`md-to-pdf` 分包边界与 API → `md-to-pdf` 向后兼容和独立构建验证 → Launchpad 按配置集成 → 跨平台验收。
- 在实现前确定共享代码来源、许可证/声明、跨仓库依赖和版本固定策略；不得让 Launchpad 依赖开发机上的相邻仓库路径。
- 评估选定分包作为独立 npm 包发布的技术、许可证、命名和维护条件。当前 `md-to-pdf` 工作区为私有包且根项目声明 `UNLICENSED`；在完成权利确认、开源许可证选择、依赖许可证审查和发布决策前，不执行公开发布。
- 浏览器打包验证必须证明 renderer 入口在 Tauri WebView 工作，不依赖 Node runtime；未通过时先抽取或增加浏览器适配入口，不绕过安全清理。
- 明确 Markdown HTML、主题 CSS、图片/字体资源和 ECharts runtime 的隔离策略。

### 渲染隔离设计门禁（PD-06；m6-066 写入，M7 实现前必须逐条给出设计与验证方案，实现后逐条取得证据）

PD-06 已确认采用 sandbox iframe。下列 9 条门禁是该方案的可验证约束；任何一条需要偏离，都必须先经用户确认并回写本节。

- **M7-D1 iframe 属性。** 预览 iframe 使用 `srcdoc`，`sandbox` 属性为空字符串（不含任何 `allow-*`，尤其不含 `allow-scripts`、`allow-same-origin`、`allow-top-navigation`、`allow-popups`、`allow-forms`），带 `referrerpolicy="no-referrer"`，不使用指向 `http(s)` 的 `src`。验证：组件测试逐字断言这些属性。
- **M7-D2 全局 CSP 不放宽。** 生产 CSP 保持 `contracts/` 与 `tauri.conf.json` 中的 10 个指令；自定义资源协议的 scheme 如果必须加入 `img-src`、`font-src` 或 `style-src`，需要单独的用户确认，并同时升级 `src/lib/csp.contract.test.ts`（FE-T30-a）与 `contracts::production_csp_matches_exact_directive_contract`，且在 H-2 的 H2-07、H2-08 同类实机项上重测。`script-src` 保持 `'self'`。验证：两端精确契约测试。
- **M7-D3 资源协议。** 图片与字体经 Rust 自定义协议提供，协议处理必须：只读；授权来源于调用方窗口标签（`CallerWindow`/`WindowLabel`）对应的 `ContentWindowGrantRegistry` 授权项；路径定位采用“父目录句柄加名称”（不得用 `canonicalize` 的结果作为读取位置，R-RS-1）；拒绝授权项目目录之外的路径与符号链接逃逸；响应带 `Content-Type` 白名单与 `X-Content-Type-Options: nosniff`。验证：Rust 测试矩阵（越界路径、符号链接、保留名、未授权窗口、非白名单类型）。
- **M7-D4 iframe 与父页面隔离。** 父页面只向 iframe 发送渲染数据，不发送令牌、文件路径授权或 IPC 句柄；iframe 内 `typeof window.__TAURI_INTERNALS__` 为 `"undefined"`，访问 `parent.document` 抛出 `SecurityError`。验证：M7 阶段二第 4 项的实机条目（三平台各一次）。
- **M7-D5 链接处理。** 预览内的链接点击不得导航 iframe 或主 webview，也不得在 iframe 内触发网络请求；实现机制必须在 M7 设计文档中给出并经用户确认，且不得要求给 iframe 增加 `allow-scripts` 或 `allow-same-origin`（若设计需要其中之一，属于对 M7-D1 的偏离，先回到用户确认）；外链是否用系统浏览器打开由 `opener` 白名单决定；`src-tauri/src/services/navigation_guard.rs` 是兜底而不是主机制。验证：恶意链接用例（`javascript:`、`data:`、`file:`、相对路径越界、`target` 指向其他窗口）都不产生导航，也不出现被放行的网络请求。
- **M7-D6 不新增窗口类别。** 预览运行在现有内容窗格内。若 M7 需要新窗口类别，必须同时新增静态 capability、`contracts/window-kinds.json` 条目、`contracts/app-commands.json` 中该窗口类别对应命令的 `callerCheck`、`kinds` 条目、`contracts/window-messages.json` 的收发规则，以及 H-2 同类实机项。
- **M7-D7 卫生测试的豁免需要批准。** `src/lib/cspHygiene.test.ts` 的 `HTML_SINK_ALLOWLIST` 与 `src/lib/navigationHygiene.test.ts` 的 `ANCHOR_ALLOWLIST` 默认为空；渲染器文件加入名单必须经用户确认，并在该文件内用注释写明净化流程（净化库、版本、配置）与 iframe 隔离的对应关系。
- **M7-D8 双层防护。** 渲染前必须经 HTML 净化（沿用 `md-to-pdf` 的 sanitize 流程），iframe 沙箱是第二层而不是替代；净化失败时显示错误而不是回退为未净化渲染。验证：净化库升级与配置变化都有对应的恶意内容回归用例。
- **M7-D9 恶意内容验收。** M7 的安全验收必须包含：`<script>`、`onerror`/`onload` 属性、`<meta http-equiv="refresh">`、`<base>`、`<form action>`、`javascript:` 链接、`<object>`/`<embed>`、CSS `@import` 与 `url()` 外链、超大图表数据；在 iframe 内这些内容都不得产生导航、网络请求或对父页面的访问。验证：M7 验收覆盖“安全”一项逐条落实。

## 范围

- Markdown 文件既可按纯文本编辑，也可在 Markdown 预览 adapter 中连续滚动显示。
- 支持已验证的 Markdown 扩展、代码高亮和安全 HTML 清理。
- 支持文档主题切换；文档主题与应用浅色/深色主题相互独立。
- 复用 markdown-echarts 的安全围栏解析、浏览器 ECharts 按需注册和 SVG 渲染能力；图表应随容器变化重排并在关闭/更新时销毁。
- 图片、字体和相对链接必须限定在项目文件授权边界或明确支持的安全远程协议中。
- 文件变更或编辑器内容变化后可刷新预览；显示解析错误和可定位的渲染警告。

## 非目标

- 不引入分页引擎、打印布局、PDF/Word 导出或 HTML 文件导出。
- 不执行 Markdown 原始脚本、任意 HTML handler 或不受信任的主题脚本。
- 不把 md-to-pdf 的 PDF 预览、字体安装、导出、服务端或桌面应用依赖整体带入 Launchpad。

## 阶段一：优化 md-to-pdf 功能分包

1. 盘点 renderer、`markdown-echarts`、连续预览、分页预览、主题资源、安全策略和全部工作区调用方的真实依赖图。
2. 定义稳定的 Markdown 功能扩展接口：基础渲染核心负责统一安全清理和文档模型；功能包以显式导入/注册方式提供解析规则、渲染能力、能力标识和所需资源。
3. 提供按配置组合功能的 API，并保留现有 `renderMarkdown` 与完整功能默认预设作为兼容入口；配置未启用的功能不得被默认入口静态拉入轻量消费者的依赖图。
4. 将连续预览与分页/PDF 预览拆成独立包或可证明独立的包入口，确保 Launchpad 导入连续预览时不解析 Paged.js、PDF 或其他仅供分页链路使用的依赖；`md-to-pdf` 现有 Web/Desktop/DOCX 调用保持兼容。
5. 以 ECharts 为功能分包样板，明确注册、样式/资源、尺寸更新、错误回报和销毁生命周期；仅拆出有独立消费者或明显依赖收益的能力，避免为拆包而拆包。
6. 确认跨仓库共享策略（固定版本的包工件、受控 vendoring 或其他可复现方案），并记录升级、安全修复和兼容支持流程。
7. 评估 npm 可发布性：独立包构建与导出、包名和版本策略、README/API、许可证与第三方依赖许可、发布内容白名单及消费者 PoC。只完成评估和可发布性准备，不默认公开发布。
8. 验证 md-to-pdf 现有 Web、Desktop、Server、DOCX 调用和功能默认值无回归，轻量消费者可只安装/打包所选功能。

## 阶段二：Launchpad 按配置接入

1. 在 Vite/Tauri 生产构建中验证浏览器入口，检查 Node runtime、bundle 拆分、worker/动态导入和打包资源路径。
2. 接入连续预览 adapter，使用配置显式选择 Markdown 功能和文档主题；隔离文档 CSS 与工作台样式。
3. 接入 ECharts 浏览器 renderer，处理 resize、重复渲染、错误和 dispose 生命周期。
4. 完成恶意内容、资源路径、跨主题和跨平台 WebView 验收。

## 验收覆盖

- Markdown fixtures：标题/锚点、列表、表格、脚注、代码高亮、数学公式（若保留）、非法围栏、图片、相对链接与大型文档。
- 安全：脚本标签、事件属性、危险 URL、CSS 导入/资源路径越界、恶意 YAML、过大图表数据和无效 ECharts 配置。
- 生命周期：文档切换、窗格关闭、重复刷新、窗口尺寸变化和多窗格图表 dispose；无旧 SVG 或图表实例残留。
- 视觉：浅/深应用主题下分别切换多个文档主题；检查主题 CSS 不修改侧栏、编辑器控件或其他窗格。
- 打包：Windows、macOS、Linux 生产包均使用本地打包资源完成预览，不依赖开发服务器、分页 runtime 或外部服务。

## 验收条件

- Markdown 编辑与预览可在不同窗格共存，渲染结果不污染工作台样式。
- ECharts 围栏通过安全验证后可连续渲染、调整大小和清理。
- 无分页或导出能力；应用包不包含不需要的 md-to-pdf 页面引擎。
- 共享 renderer 的来源、版本、许可证和后续升级路径明确，跨平台生产构建与安全门禁通过。
- `md-to-pdf` 现有消费者继续通过兼容入口获得原有完整能力；Launchpad 只引入显式选择的功能和连续预览能力，构建依赖中不包含分页/PDF 运行时。
- npm 发布评估有明确结论和阻断项清单；未完成许可证及发布授权时，不将“可发布”误记为“已公开发布”。

## 风险与后续

- md-to-pdf 的 renderer 当前静态组合多项插件，且包含 sanitize-html 等依赖；必须以真实 Vite/Tauri 构建验证按需导入效果，不能仅凭配置 API 或包名推断依赖已被剔除。
- `md-to-pdf` 当前为私有工作区包并声明 `UNLICENSED`；npm 公共发布需要单独完成授权、许可证和依赖审查，不属于自动集成步骤。
- 主题 CSS 面向文档 DOM，可能含全局选择器；应限制在隔离容器并针对现有主题回归。
