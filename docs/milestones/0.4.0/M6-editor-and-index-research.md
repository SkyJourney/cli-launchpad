# M6 编辑器与工作区索引调研

调研日期：2026-10-04

## 结论

- 首期代码编辑器选择 Monaco Editor，并使用其受支持的 ESM tree-shaking 入口及按需语言注册；React 封装只承担组件生命周期，不接管文件保存、脏状态或窗口生命周期。
- CodeMirror 6 更轻且模块颗粒更细，但 `@codemirror/language-data` 仓库已于 2026-04-15 归档并迁移到维护者的新托管站点。CM6 可通过 `LanguageDescription` 和按需语言包构造自己的语言清单，不依赖该归档仓库。考虑用户已倾向 Monaco，CM6 作为比较基线，不作为当前实现。
- Monaco 提供高质量编辑交互和部分语言的内建智能功能，但不能视为完整 VS Code，也不能为所有语言提供定义跳转、跨文件引用、工作区符号、诊断或重构。
- VS Code 没有适合直接嵌入 Tauri 应用、同时覆盖文件发现、全文检索和语义索引的通用工作区索引内核。其文件/文本搜索默认使用 ripgrep 并遵循 ignore 规则；定义、引用与工作区符号由具体语言提供者或 LSP 服务实现。Copilot 的语义索引是另一项服务能力，不等同于可复用的本地编辑器索引库。

## Monaco 与 CodeMirror 6

| 维度             | Monaco Editor                                                                               | CodeMirror 6                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 产品定位         | VS Code 编辑器核心的浏览器版本，功能体验更接近 IDE                                          | 小型、模块化的文本编辑器框架                                                   |
| 编辑器能力       | 查找、替换、命令、编辑器模型、差异编辑器和丰富键盘操作成熟                                  | 通过独立扩展组合编辑命令、语言、主题和差异视图                                 |
| 语言支持         | 常用语言定义丰富；TypeScript/JavaScript、CSS、HTML、JSON 有内建语言服务，其余多数是语法着色 | 官方维护大量独立语言包；语言元数据可由应用自建，也可参考迁移后的 language-data |
| React/Tauri 集成 | 需在 Vite 配置 ESM worker；本仓库验证 Vite worker 与 Tauri 离线资源打包                     | React 集成和 worker 较简单；更轻，扩展的行为与组合由应用负责                   |
| 包体控制         | 0.56+ 支持 tree-shakeable 入口、按需编辑器功能和语言定义；TS 服务可能显著增加分包体积       | 通过独立语言包天然按需加载，整体通常更小                                       |
| 工作区语义       | 需接入 LSP/语言服务；内建 TS 服务只适用于 JS/TS 文件能力                                    | 同样需接入 LSP/语言服务，不提供通用工程索引                                    |

Monaco 的接入必须本地打包 worker，不能依赖 CDN；使用 `monaco-editor/editor`、独立功能注册入口和按需语言模块，并审查生产构建的初始包、懒加载包与平台产物体积。优先提供高亮、缩进、括号/注释处理、撤销/重做、查找替换、全选、自动换行、模型标识、主题和保存快捷键。编辑器能力与文件服务通过单独接口连接，便于未来更换或增加引擎。

## `@codemirror/language-data` 状态

`@codemirror/language-data` 是 CodeMirror 官方生态的独立语言元数据与动态加载包，并未并入 `@codemirror/language`。仓库于 2026-04-15 被归档，README 指向维护者的新托管地址。CM6 的 `LanguageDescription` 仍允许应用自定义扩展名/别名、惰性加载语言包和自动识别；若以后使用 CM6，应由 Launchpad 维护经过审阅的精简语言清单，不把已归档仓库当作运行时必需依赖。

## VS Code 与工作区索引

应分开规划三类数据和能力：

1. **文件元数据缓存**：项目 ID 隔离的可重建缓存，仅存相对路径、文件类型、扩展名、大小、修改时间/版本、忽略状态等；不存绝对路径和文件正文。启动、文件系统事件或手动刷新时增量更新，事件缺失后进行有界校验/重扫。打开的未保存文档由内存缓冲覆盖磁盘版本。
2. **全文检索**：按查询调用 ripgrep 或 Rust `ignore` + 受限读取实现，遵循 `.gitignore`、`.ignore` 和符号链接边界；将未保存文档缓冲作为额外结果源。M6 文件树已有按目录有界读取，不能把该 UI 列表本身误认为完整索引。
3. **语义索引**：定义、引用、符号和诊断通过按需启动的语言服务/LSP 提供，服务按项目根目录启动并有超时、取消、输出限制、能力白名单与进程生命周期管理。树状语法解析可作为无 LSP 时的近似 Outline 补充，不宣称具备完整语义。

VS Code/Copilot 的远程或 agent 语义索引不作为本地索引依赖。ripgrep 内部实验性 `grep-index` 仍不适合作为当前生产基础。M6 先稳定文件内容宿主、文件 metadata/缓存边界与可重建机制；完整 watcher 缓存和 LSP 运行时列入后续子阶段评估，避免为尚未启用的跨文件语义能力提前引入常驻进程或数据库表。

## 适配器与插件演进边界

- 应用启动阶段通过内建注册 API 装配内容适配器；注册项包含稳定 ID、API 版本、内容类型、渲染入口、文案、受限命令/服务贡献和可选关闭/释放钩子。
- 内容宿主持有窗格、标签、焦点、拖动、关闭范围、独立窗口、布局恢复和资源调度。适配器只提供内容差异；文件授权、PTY 和 Git 执行仍由 Rust 与共享协调器负责。
- 编辑器引擎注册与内容类型注册分离；编辑器可以是文件适配器内部的可替换渲染引擎。
- 本阶段的动态注册只指随应用受控加载的内建模块，不提供第三方插件安装、磁盘/网络代码加载、任意命令执行或跨项目访问。
- 后续若开放插件，需要单独定义 API 版本兼容、权限声明/用户授权、沙箱隔离、签名校验、供应链审计、更新/卸载及崩溃隔离；仅有一个注册函数不足以构成安全的插件系统。

## 参考资料

- [Monaco Editor changelog](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md)
- [Monaco Editor ESM/Vite 集成指南](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)
- [Monaco React wrapper 文档](https://github.com/suren-atoyan/monaco-react)
- [CodeMirror language-data 仓库迁移说明](https://github.com/codemirror/language-data)
- [CodeMirror 参考文档：LanguageDescription](https://codemirror.net/docs/ref/)
- [VS Code Search Issues：ripgrep 与 ignore 规则](https://github.com/microsoft/vscode/wiki/Search-Issues)
- [VS Code 语言扩展概览与 LSP](https://code.visualstudio.com/api/language-extensions/overview)
- [VS Code 程序化语言功能：工作区符号](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
- [VS Code Copilot workspace context/index 说明](https://code.visualstudio.com/docs/copilot/reference/workspace-context)

## 本仓库集成验证

- 验证环境：Windows、本地 Vite 生产构建、`monaco-editor` 0.57.0 与 `@monaco-editor/react` 4.7.0。
- Monaco 编辑器作为动态加载的独立引擎，普通工作区首屏不载入编辑器运行时；语言定义分文件惰性加载。编辑器提供撤销/重做、查找/替换、全选、括号配对、折叠、缩进、自动换行和 Ctrl/Cmd+S 保存入口。
- 当前生产构建测得主应用 JS 为 492.82 KB（gzip 148.46 KB）；Monaco 懒加载 JS 为 3,558.07 KB（gzip 923.29 KB），编辑器 CSS 为 151.12 KB（gzip 22.28 KB）。worker 产物最大为 TypeScript worker 7,044.98 KB（未压缩），CSS worker 1,055.28 KB、HTML worker 713.97 KB、JSON worker 408.37 KB、通用 editor worker 276.32 KB。Vite 会对 Monaco 编辑器分包报告 >500 KB 提示；由于该包仅首次打开文本文件时加载，首屏包维持在 500 KB 以下。worker 文件参与安装体积，即使延迟启动也仍会随应用分发。
- 结论：Monaco 满足首选验证，功能和后续 LSP 接入能力合适；应保留惰性加载，跟踪安装包增量。内建 TS worker 的体积是最主要的成本；若发布体积门禁不接受此增量，应移除内建 TS 语言服务，仅保留 TS 语法定义并在以后以 LSP 方式按需提供语义功能。是否达到 Windows/macOS/Linux 实机交互体验仍需 M6 对应验收，不以构建通过代替。
- 文件元数据 watcher/持久缓存未纳入本次实现：本阶段锁定索引边界与服务设计，待文件服务生命周期和平台 watcher 可靠性验证后再实施。全文检索和语义索引也不由当前元数据缓存冒充。
- 文件打开类型已由 Rust 项目根目录约束服务统一判定：UTF-8 文本进入 Monaco；NUL/无效 UTF-8、超过文本上限的文件进入说明页；PNG/JPEG/GIF/WebP/BMP 在 10 MiB 上限内进行签名校验后以 data URL 预览，其他光栅/矢量图片格式明确显示不支持。此路径不向 WebView 暴露任意文件 URL，也不会将 SVG 当作可执行 HTML。
