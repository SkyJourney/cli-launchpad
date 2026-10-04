# M9：Git 远程与系统认证

## 目标

增加远程配置、系统认证交互与基础同步能力；通过系统 Git 和现有 credential helper/SSH agent 完成认证，Launchpad 不独立管理或保存凭据。

## 依赖与设计门禁

- 依赖 M8 Git service、本地分支状态和后台进程管理。
- 明确首期支持 HTTPS 与 SSH remote；Git clone 不支持。
- remote URL 是不可信输入。校验协议和格式，限制不支持或危险的 ext transport；尊重用户已配置的 Git credential helper。显示、错误、事件和日志中对 URL userinfo/token 做脱敏。
- 新增/修改 remote 后提供显式连接验证；实际 Git 网络操作负责触发 helper 认证，不要求 Launchpad 读取凭据或预判秘密是否存在。
- 认证交互和凭据持久化由系统 helper/SSH agent 决定。优先验证 Windows Credential Manager、macOS Keychain 与已配置的 Linux Secret Service；仅配置临时 cache、无 helper 或 helper 存储方式未知时必须说明持久性边界并给出安全设置指引，不回退明文。

## 范围

- 列出、新增、编辑、移除 remote，支持指定默认 fetch/push 地址与 tracking/upstream 关系。
- 显示远端分支和本地领先/落后信息；支持 fetch、push 和安全快进拉取。
- Push 前展示目标 remote、branch 和待发送提交；设置 upstream 时明示目标关系。
- 快进拉取只在当前分支可安全前进时执行；分支分叉时阻止隐式整合，提示进入显式选择/后续 rebase 流程。
- 新 remote 保存后可运行连接验证。HTTPS 由 Git credential helper（含 GCM）调用系统浏览器或原生授权界面；SSH 委托系统 SSH 配置和 agent。
- 显示认证等待、成功、用户取消、helper 缺失、系统凭据存储不可用、仅临时缓存、权限拒绝和远端网络错误等状态。
- 认证等待不得阻塞 UI；无 TTY 时不能静默等待 stdin。提供取消并终止完整子进程树/关联 helper 流程。
- 持久 helper 配置下，成功认证在关闭并重启应用后仍由系统 Git 复用；临时缓存到期后的行为应明确可见。

## 非目标

- Launchpad 不实现平台专属 OAuth client、token vault、账号列表或自有密钥管理。
- 不克隆仓库、不提供浏览器内托管平台网页、不管理用户 SSH 私钥。
- 非快进 pull、rebase、merge 和冲突流程留给 M10。

## 任务清单

1. 验证 Windows、macOS、Linux 下 Git credential helper/GCM、系统浏览器回调和 SSH agent 的桌面交互。
2. 设计 remote URL 解析、秘密脱敏、协议限制和连接验证语义。
3. 实现 remote 配置和 upstream 展示，保证仓库本地配置是唯一事实来源。
4. 实现 fetch、push、fast-forward-only pull 的结构化命令计划、进度、取消和错误恢复。
5. 建立凭据 helper 启动、等待用户交互、用户取消和缺少可用 helper 的状态机。
6. 完成系统认证存储检查、文档化指引、平台实测和审查门禁。

## 验收覆盖

- HTTPS：未认证触发系统 helper 登录；已有认证复用；取消、拒绝、token 过期和 helper 不存在均可恢复。
- SSH：agent 已加载/未加载、key 无权限、首次 host key 确认、SSH 不可用和用户取消。
- Linux：Secret Service 可用、未配置 store、无图形认证环境；绝不自动选择 plaintext store。
- 持久性：验证凭据由安全系统 store 保存并跨应用重启复用；临时 cache 不得显示为永久保存成功。
- Remote：增加/修改/删除、多 remote、缺失 upstream、不同 push URL、无效协议、凭据形式 URL、URL 含秘密时脱敏。
- 网络操作：Fetch/Push 成功、超时、中断、服务端拒绝和远端分支更新；完成或失败后重新读取 Git 状态。
- 进程：认证 UI 期间工作台可继续响应；取消后 Git 与 helper 进程退出；重启不遗留任务或秘密。
- 实机：三个桌面平台至少验证一个 HTTPS helper 路径和一个 SSH agent 路径；平台不具备某能力时记录受支持配置和环境边界。

## 验收条件

- 新建 remote 的连接验证能触发系统认证交互；认证只由系统 helper/agent 保存或使用。
- Launchpad 数据库、日志、崩溃诊断、IPC payload 中均无 Git 密码、token 或私钥。
- Push、fetch 与快进拉取可取消；失败后界面状态与实际仓库一致。
- M9 自动门禁及平台认证验收通过后才进入 M10。
