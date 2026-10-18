# M6 PD-10 平台实现调研决策记录

> - 编制日期：2026-10-19（取证跨 2026-10-18 至 2026-10-19，各条来源的访问日期以其所在行为准）。
> - 基于主报告章节：`docs/milestones/0.4.0/M6-closure-review.md` 4.7.2.1 至 4.7.2.12、4.7.4；测试规格 RS-T62、FE-T63、SEAM-27、FE-SEAM-16、FE-SEAM-17、W-20、M-19、L-19、X-26。
> - 关联目标：m6-075（本记录）；PD-10；S3I-A14。
> - 状态：**待用户确认（D-1）**。本记录不改变主报告 4.7.2 的设计正文；与草案不一致处只记为“建议修改项”，由用户在 D-1 决定。
> - 本记录中“已验证”不等于实机验证：凡需要在真实卷上才能确认的结论，一律标“部分验证”或“未验证”，并列入第 6 部分。

## 1. 研究方法与记录规则

### 1.1 本次检索方式

1. 逐项落实主报告 4.7.2.3、4.7.2.12 中所有标“待调研核实”的 API 名、标志位、文件系统类型表与挂载选项（共 20 行，见第 4 部分覆盖表）。
2. 使用的联网能力：命令行 `curl` 直接取原文后用 `grep`/`sed` 摘句（GitHub 源码用 `raw.githubusercontent.com`，Linux 内核用 `git.kernel.org` 的 `plain`/`patch` 端点，Microsoft Learn 与 Apple Developer 页面取 HTML 后摘句）；`WebFetch`/`WebSearch`；Microsoft Learn 文档检索工具；crates.io 注册表 API。**`WebFetch` 返回的是小模型摘要，其“逐字引用”不可靠，凡标“已验证”的结论都以 `curl` 取回的原文复核为准。**
3. 调研分五路并行完成（Windows 与 Microsoft；macOS 与 Apple；Linux 与内核；Git、VS Code、Watchman、Jujutsu、Mercurial；Rust crate 评估），草稿保存在会话临时目录（不入库）；本记录由编制者逐份通读后整合，并在第 1.5 节记录抽查复核。
4. 固定的源码快照：Linux 内核 `v7.2`（提交 `8d3ae59288f1e7d58d76558a6ee96d533bc5019f`，2026-08-16）；XNU `xnu-12377.121.6`（提交 `ac9718fb1af618d5ce8678d0dc6e8a58f252216f`）；Apple HFS `hfs-715.120.4`、SMBClient `SMBClient-538.121.1`、NFS `NFS-343.100.5`、msdosfs `msdosfs-788.100.31`；Git `v2.56.0`；VS Code `1.142.0`；Watchman `v2026.10.12.00`；Jujutsu `v0.46.0`；Mercurial `7.2.4`；ntfs-3g `edge`（提交 `7f0f841fc52cf719106c5c93bafe465004e36816`）；Rust 标准库 `1.95.0`。APFS 内核实现不公开，没有源码可引。
5. 本机（Windows 11 10.0.26300）没有 macOS、Linux 环境，也没有 ReFS 卷、Dev Drive 卷或 Samba 服务端；macOS 与 Linux 的全部结论只来自文档与源码。

### 1.2 记录规则（本记录全文遵守）

1. 每条结论格式：`结论一句话｜来源 URL｜访问日期（YYYY-MM-DD）｜证据类型｜验证状态`。
2. 证据类型取值：`官方文档`、`内核或标准库文档`、`项目源码（附文件路径与提交或标签）`、`社区讨论（降级，需另有佐证）`、`推断`。
3. 验证状态取值：`已验证`（有官方文档或源码明确支持）、`部分验证`（来源只覆盖一部分，写明缺什么）、`未验证`（没有找到来源，或需要实机才能确认）。**没有 URL 的结论只能标“未验证”。**
4. 引用来源时写出实际读到的关键句（引号，不超过两句）或源码的函数名与位置，不只贴链接。
5. 来源冲突时两个来源都列出，写明采信哪个及原因；不能裁决的标“未验证”并列入第 8 部分的决策问题。
6. 不使用记忆里的 API 名、常量值或挂载选项当结论；记忆只作检索线索，查到出处后才写入。
7. Rust crate：只记录评估（名称、版本、许可证、最近发布日期、维护状态、下载量级、是否已在 `Cargo.lock`、与本项目 MIT 许可证的兼容性、是否需要新增 Cargo feature），不修改 `Cargo.toml`。
8. 本机只读观察（例如 `fsutil file queryCaseSensitiveInfo`、`GetVolumeInformationByHandleW`、`NtQueryInformationFile` 的只读查询、`Test-Path`、本机 OS 大小写表的逐码点对照、`cargo` 小实验）一律归入“推断”类线索，单独标注“本机只读观察”，**永远不计“已验证”**，不替代官方来源。调研中没有创建、删除、修改仓库内外任何文件或系统设置（实验代码与下载的原文副本只在会话临时目录）。
9. 本记录对“折叠”的约定：两个名字在某个文件系统上被视为同一个名字。

### 1.3 状态取值定义（第 2 部分总表按行统计）

<!-- prettier-ignore -->
| 状态 | 含义 | 本表的判定口径 |
| --- | --- | --- |
| 已验证 | 有官方文档或源码明确支持，且该行的主要结论都被覆盖 | 行内的“探测 API、判定规则、失败降级”的事实都有出处；仍可能存在列入第 6 部分的实机项 |
| 部分验证 | 来源只覆盖该行的一部分 | 单元格内写明缺什么 |
| 未验证 | 没有来源，或必须实机 | 本表没有整行为未验证的位置类型；各行内的未验证子结论见第 6 部分 |

### 1.4 访问日期口径

调研会话跨过 2026-10-18 午夜。Windows 区域首批 8 个 Microsoft Learn 页面与 macOS、Linux 区域的取证记 2026-10-18，其余记 2026-10-19，Git 等项目区域与 crate 区域记 2026-10-19；每条来源按实际取证日写在自己行里（日期取本机时钟的日历日，时区 UTC+8；个别区域按 UTC 记日期，相差不超过一天），总表“访问日期”列写 `2026-10-18`、`2026-10-19` 或 `2026-10-18 至 2026-10-19`。

### 1.5 抽查复核记录

整合完成后，另派一个全新的只读复核员，对下列 5 条“已验证”结论各自独立用 `curl -sL` 取回原文并 `grep`/`sed` 摘句（不使用 `WebFetch` 摘要），取证时间 2026-10-18 16:42 UTC（本机时钟 UTC+8，即 2026-10-19 00:42）。5 条全部取到原文，**全部与本记录一致**。

<!-- prettier-ignore -->
| # | 被抽查的结论 | 取到的原文关键句 | 结果 |
| --- | --- | --- | --- |
| 1 | Git 的 `core.ignorecase` 探测是对 `.git/config` 的变体 `CoNfIg` 做 `access(F_OK)`，不创建文件（第 3 部分 Git 小节；第 4.2 节第 6 条） | https://raw.githubusercontent.com/git/git/v2.56.0/setup.c 第 2655–2658 行：`/* Check if the filesystem is case-insensitive */ repo_git_path_replace(repo, &path, "CoNfIg"); if (!access(path.buf, F_OK)) repo_config_set(repo, "core.ignorecase", "true");` | 一致 |
| 2 | 内核 ntfs3 仅在 `nocase` 时安装大小写不敏感的 dentry 操作（总表 Linux ⑥） | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/super.c?id=v7.2 第 1291 行：`set_default_d_op(sb, options->nocase ? &ntfs_dentry_ops : NULL);`；第 297 行 `fsparam_flag("nocase", Opt_nocase)` | 一致 |
| 3 | `FileCaseSensitiveInformation`(71) 需 `FILE_READ_ATTRIBUTES`，Windows 10 1803 起可用（总表 Windows ①） | https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryinformationfile（HTML 去标签后）：“The caller must have opened the file with the FILE_READ_ATTRIBUTES flag specified in the DesiredAccess parameter. This value is available starting with Windows 10, version 1803.” | 一致 |
| 4 | XNU 定义 `_PC_CASE_SENSITIVE`=11 与 `VOL_CAP_FMT_CASE_SENSITIVE`=0x100（总表 macOS ①） | https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/unistd.h 第 154–155 行 `#define _PC_CASE_SENSITIVE 11`、`#define _PC_CASE_PRESERVING 12`；同标签 `bsd/sys/attr.h` 第 282 行 `#define VOL_CAP_FMT_CASE_SENSITIVE 0x00000100` | 一致 |
| 5 | `unicode-normalization` 最新稳定版 0.1.26，许可证 `(MIT OR Apache-2.0) AND Unicode-3.0`（第 5.10 节） | https://crates.io/api/v1/crates/unicode-normalization：`max_stable_version` 为 `0.1.26`，`versions[0].license` 为 `(MIT OR Apache-2.0) AND Unicode-3.0`，创建于 2026-10-16T23:28:29Z（0.1.25 的许可证为 `MIT OR Apache-2.0`） | 一致（版本号有时效性） |

此外，编制者在前置检查中用 `WebFetch` 与原始文档源读到了 https://git-scm.com/docs/git-config 的 `core.ignoreCase` 条目：“Internal variable which enables various workarounds to enable Git to work better on filesystems that are not case sensitive, like APFS, HFS+, FAT, NTFS, etc.”（前置检查 7 通过）。

## 2. 平台 × 文件系统总表

### 2.1 总表（24 行：Windows 7、macOS 7、Linux 10）

列：平台｜位置类型｜探测方法（第一步 API）｜API 或常量确切名称｜行为探测是否需要｜失败时降级｜证据来源（URL）｜访问日期｜验证状态｜对规格期望值（RS-T62 / W-20 / M-19 / L-19）的影响。单元格里的 URL 只列最关键的几条，完整来源与引文见第 3 部分各对象小节。Windows 的 ⑥（SMB）与 Linux 的 ④（vfat 与 exfat）按任务要求保持为一行，行内用“（a）（b）”分写。

<!-- prettier-ignore -->
| 平台 | 位置类型 | 探测方法（第一步 API） | API 或常量确切名称 | 行为探测是否需要 | 失败时降级 | 证据来源（URL） | 访问日期 | 验证状态 | 对规格期望值的影响 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows | ① NTFS 默认目录（本地卷） | 以 `FILE_READ_ATTRIBUTES` 加 `FILE_FLAG_BACKUP_SEMANTICS` 打开项目根得句柄；判定非远程后，用 `GetVolumeInformationByHandleW` 取卷标志，再用 `NtQueryInformationFile(FileCaseSensitiveInformation)` 读目录级标志；`Flags & 1 == 0` 则 `Insensitive`。NTFS 的卷标志 `FILE_CASE_SENSITIVE_SEARCH` 恒置位，不能单独使用 | `GetVolumeInformationByHandleW`；`FILE_CASE_SENSITIVE_SEARCH`=0x00000001；`NtQueryInformationFile`；`FileCaseSensitiveInformation`=71；`FILE_CASE_SENSITIVE_INFORMATION { ULONG Flags }`；`FILE_CS_FLAG_CASE_SENSITIVE_DIR`=0x00000001 | 否（目录级查询成功时） | 目录级查询失败 → 已有条目换大小写 → `Unknown`；“查询失败”不得当作“标志为 0” | https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63 ；https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file ；https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryinformationfile ；https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_case_sensitive_information | 2026-10-18 至 2026-10-19 | 已验证（卷标志置位、默认不区分、信息类与结构的名称与值、需 `FILE_READ_ATTRIBUTES`、Windows 10 1803 起可用）；本机只读观察与之一致，不计已验证 | RS-T62 测试十“Windows 默认 NTFS 目录 → Insensitive”成立。实现必须读目录级标志，只读卷标志会把 NTFS 全部判成“可能区分大小写” |
| Windows | ② NTFS 按目录启用大小写敏感的目录，及其新建子目录是否继承 | 同 ①，对该目录自身查询目录级标志，`Flags & 1 == 1` 则 `Sensitive`；子目录必须各自查询，不得由根目录的结果推断 | 同 ①；设置端 `fsutil file setCaseSensitiveInfo <路径> enable\|disable`，读取端 `fsutil file queryCaseSensitiveInfo <路径>`；WSL 内扩展属性 `system.wsl_case_sensitive` | 否（API 成功时）；继承规则有来源冲突，子目录单独探测 | 同 ① | https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity ；https://devblogs.microsoft.com/commandline/per-directory-case-sensitivity-and-wsl/ ；https://devblogs.microsoft.com/commandline/improved-per-directory-case-sensitivity-support-in-wsl/ | 2026-10-18 至 2026-10-19 | 部分验证：目录级标志存在、需空目录、需提升权限与四项目录权限已验证；“新建子目录是否继承”官方来源互相矛盾，结论为“取决于创建方”，缺实机 | W-20 步骤 2 的“`sub` 继承”不能写成确定期望，改为记录 `mkdir` 与 WSL 两种创建方的实际结果 |
| Windows | ③ ReFS | 同 ①（ReFS 的卷标志同样恒置位；Microsoft 文档称 ReFS 支持按目录大小写敏感），读目录级标志 | 同 ①；注册表 `RefsEnableDirCaseSensitivity`（`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`，仅本地） | 否（目录级查询成功时）；ReFS 默认语义无专属来源，实机交叉记录 | 同 ① | https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63 ；https://learn.microsoft.com/en-us/windows-server/storage/refs/refs-registry-values | 2026-10-19 | 部分验证：缺 ReFS 专属的“默认不区分大小写”原文与注册表值的取值含义；本机无 ReFS 卷 | W-20 步骤 3 的“ReFS 或 Dev Drive → Insensitive”仍是推断；步骤中加入 `fsutil` 输出与注册表值作证据 |
| Windows | ④ Dev Drive | Dev Drive 是 ReFS 卷，同 ③；另有杀毒“性能模式”，影响副作用，不影响大小写判定 | 同 ③；创建 `Format-Volume -DriveLetter D -DevDrive` 或 `Format D: /DevDrv /Q` | 同 ③ | 同 ③ | https://learn.microsoft.com/en-us/windows/dev-drive/ | 2026-10-18 | 部分验证：“Dev Drive 使用 ReFS”已验证；Dev Drive 上大小写行为无专门说明，按 ReFS 推断 | 同 ③；W-20 的创建命令有官方出处，可直接采用 |
| Windows | ⑤ exFAT 与 FAT | 只用卷标志：FAT 与 exFAT 不置位 `FILE_CASE_SENSITIVE_SEARCH`，判 `Insensitive`；不调用目录级查询 | `FILE_CASE_SENSITIVE_SEARCH`（未置位）；`FILE_CASE_PRESERVED_NAMES`=0x00000002；`FILE_UNICODE_ON_DISK`=0x00000004 | 否 | 卷标志读取失败 → 行为探测 → `Unknown`；第三方驱动不受 MS-FSA 约束，未验证 | https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63 ；https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification | 2026-10-19 | 部分验证：MS-FSA 附录 A 表给出 FAT、EXFAT 两列未置位；exFAT 规范写明“case insensitive and case preserving”；FAT 的非 ASCII 比较规则原文未查到 | W-20 没有 exFAT、FAT 项，建议补一行（VHD 格式化，期望 `Insensitive`，属实机项） |
| Windows | ⑥ SMB 共享：（a）服务端为 Windows；（b）服务端为区分大小写配置的 Samba | 先判远程（`FILE_REMOTE_DEVICE` 或 `DRIVE_REMOTE`），远程一律直接行为探测，不使用卷标志与目录级标志。（a）本机环回观察：客户端把 NTFS 服务端的卷标志位清零，目录级查询返回 `STATUS_NOT_SUPPORTED`；（b）Samba 的 `case sensitive` 默认 `auto`，对 Windows 客户端等同 `no`，只有显式 `yes` 才区分，且无论配置如何都在属性信息里报告 `FILE_CASE_SENSITIVE_SEARCH` | `NtQueryVolumeInformationFile(FileFsDeviceInformation=4)` 的 `Characteristics & FILE_REMOTE_DEVICE`(0x10)；`GetDriveTypeW`==`DRIVE_REMOTE`(4)；`STATUS_NOT_SUPPORTED`=0xC00000BB；Samba `smb.conf` 参数 `case sensitive = yes\|no\|auto` | 需要 | 行为探测失败 → `Unknown`（不折叠） | https://devblogs.microsoft.com/commandline/improved-per-directory-case-sensitivity-support-in-wsl/ ；https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew ；https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html ；https://raw.githubusercontent.com/samba-team/samba/master/source3/smbd/smb2_trans2.c | 2026-10-18 至 2026-10-19 | 部分验证：官方“SMB 不支持按目录标志”、Samba 默认语义与源码写入标志已核；`case sensitive = yes` 时 Windows 客户端的表现无 Samba 服务端可测；本机环回观察为推断类 | W-20 步骤 5“`Insensitive` 或 `Unknown`”对 Windows 服务端成立；Samba 需另加条目；实现必须在读卷标志之前先判远程：本机观察 SMB 客户端会把 NTFS 服务端的卷标志位清零，若先套用“卷不支持则 `Insensitive`”的规则，SMB 就可能被误判为 `Insensitive`（Samba 服务端的客户端表现未实测） |
| Windows | ⑦ `\\wsl$` 共享（经 9P 访问 WSL 中的 ext4；`\\wsl.localhost` 为同一服务另一写法） | 先判远程（同 ⑥）再行为探测。本机观察该位置卷标志置位但目录级查询返回 `STATUS_NOT_SUPPORTED`，若把“查询失败”当成“标志为 0”会误判为 `Insensitive` | 同 ⑥；`GetVolumeInformationByHandleW` 返回的文件系统名在本机为 `9P`（观察） | 需要 | 行为探测失败（例如 WSL 实例未运行，路径不可解析）→ `Unknown` | https://learn.microsoft.com/en-us/windows/wsl/troubleshooting ；https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop ；https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55 | 2026-10-19 | 部分验证：“9P 服务提供 `\\wsl$`”“ext4 默认区分大小写”有官方来源；卷标志、失败码、换大小写结果均为本机只读观察（推断，仅一个发行版） | W-20 步骤 4“`Sensitive` 或 `Unknown`；得到 `Insensitive` 即误判”成立，并补充：`Sensitive` 只能由行为探测得出；先启动 WSL 实例 |
| macOS | ① APFS 不区分大小写的卷（默认） | 对项目根目录得到 `fd`：先 `fstatfs`（取 `f_fstypename`、只读、本地标志），再 `fpathconf(fd, _PC_CASE_SENSITIVE)`（0=不区分，非 0=区分，-1 且 `errno==EINVAL`=未实现）；第二选择 `fgetattrlist` 读 `VOL_CAP_FMT_CASE_SENSITIVE`，必须同时检查 `valid` 位。规范化轴按 `f_fstypename=="apfs"` 判 `Yes` | `fpathconf`/`pathconf`；`_PC_CASE_SENSITIVE`=11；`fgetattrlist`/`getattrlist`；`ATTR_VOL_INFO`=0x80000000；`ATTR_VOL_CAPABILITIES`=0x00020000；`VOL_CAPABILITIES_FORMAT`；`VOL_CAP_FMT_CASE_SENSITIVE`=0x00000100；`fstatfs`、`statfs.f_fstypename` | 仅当 API 报错、`valid` 位未置位或类型未知时 | API 失败 → 行为探测（已有条目翻转大小写）→ `Unknown` | https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/unistd.h ；https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/attr.h ；https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html ；https://developer.apple.com/support/downloads/Apple-File-System-Reference.pdf | 2026-10-18 | 部分验证：接口语义与内核路由已验证；APFS 对该选择子的实际返回值未验证（APFS 内核实现闭源） | M-19 第 1 项期望“Insensitive、规范化 Yes”目前只有间接支持；实机须记录 `fpathconf` 返回值、`capabilities` 与 `valid`、`f_fstypename` |
| macOS | ② APFS 区分大小写的卷（同一容器内不同卷可不同） | 同 ①。大小写位是**卷**属性：磁盘上 `APFS_INCOMPAT_CASE_INSENSITIVE` 未置位即区分大小写，`diskutil apfs addVolume` 的 personality 对该卷永久。规范化轴仍为 `Yes` | 同 ①；`APFS_INCOMPAT_CASE_INSENSITIVE`=0x1；`APFS_INCOMPAT_NORMALIZATION_INSENSITIVE`=0x8 | 同 ① | 同 ① | https://developer.apple.com/support/downloads/Apple-File-System-Reference.pdf ；https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html ；https://keith.github.io/xcode-man-pages/diskutil.8.html（社区镜像，降级） | 2026-10-18 | 部分验证：“按卷、同容器可不同”已验证；`pathconf` 对该卷的返回值未验证 | M-19 第 2 项期望 `Sensitive` 合理；规范化轴期望应为 `Yes`（官方 FAQ：区分大小写变体同样规范化不敏感），草案若写 `No` 需修正 |
| macOS | ③ HFS+ 不区分大小写（日志式，默认） | 同 ①。HFS+ 内核实现开源：`hfs_vnop_pathconf` 读卷标志；`statfs.f_fssubtype` 含 `HFS_SUBTYPE_CASESENSITIVE` 位时为区分。规范化轴 `Yes`（强制 NFD） | 同 ①；`f_fstypename=="hfs"`；`HFS_CASE_SENSITIVE` | 否（API 可用时） | API 失败 → 行为探测 → `Unknown` | https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vnops.c ；https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vfsutils.c ；https://developer.apple.com/library/archive/technotes/tn/tn1150.html | 2026-10-18 | 已验证（源码加官方技术说明；真实卷未实测） | M-19 第 3 项“HFS+ → Insensitive、规范化 Yes”有源码支持；折叠为 Apple 自定义表（Unicode 3.2），不是标准 Unicode 折叠 |
| macOS | ④ HFS+ 区分大小写（日志式，HFSX） | 同 ③；磁盘上由目录 B-tree 头的 `keyCompareType` 决定（`kHFSBinaryCompare` 区分，`kHFSCaseFolding` 不区分）。规范化轴仍为 `Yes`（`buildkey` 无论是否区分大小写都转 NFD） | 同 ③；`keyCompareType`；`HFS_SUBTYPE_CASESENSITIVE` | 否 | 同 ③ | https://developer.apple.com/library/archive/technotes/tn/tn1150.html ；https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vfsutils.c | 2026-10-18 | 已验证（源码加官方技术说明；真实卷未实测） | M-19 第 3 项“区分大小写 HFS+ → Sensitive”成立；规范化轴为 `Yes`，草案若写 `No` 需修正；TN1150 提醒 HFSX 卷也可能是不区分大小写的，不可假设 |
| macOS | ⑤ exFAT | 同 ① 的入口，但 Apple 的 exFAT 驱动闭源，`_PC_CASE_SENSITIVE` 与 `VOL_CAP_FMT_CASE_SENSITIVE` 的返回值无法从源码确认；exFAT 规范本身规定不区分大小写、保留大小写 | 同 ①；`f_fstypename`（预期 `exfat`，未实测） | 需要（API 返回不可信或失败时） | 行为探测 → `Unknown`；即使 API 有返回，也建议与行为探测交叉 | https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification ；https://keith.github.io/xcode-man-pages/mount_exfat.8.html（社区镜像，降级） | 2026-10-18 | 部分验证：规范语义已验证；macOS 驱动对 API 的返回值与规范化行为未验证 | M-19 第 4 项期望 `Insensitive` 有规范支持；API 返回值与规范化轴必须实机记录 |
| macOS | ⑥ SMB 共享 | `pathconf` 对 smbfs 固定返回 0（不区分），仅当服务器自称 OS X 服务器（AAPL 扩展）且声明区分大小写时返回 1，源码注释写明客户端没有办法判断；因此对 `smbfs` 不采信 API，直接行为探测 | `_PC_CASE_SENSITIVE`；`VOL_CAP_FMT_CASE_SENSITIVE`；`f_fstypename=="smbfs"`；`smbfs_vnop_pathconf` | 需要 | 行为探测不可用（只读、无含字母条目）→ `Unknown` | https://raw.githubusercontent.com/apple-oss-distributions/SMBClient/SMBClient-538.121.1/kernel/smbfs/smbfs_vnops.c ；https://raw.githubusercontent.com/apple-oss-distributions/SMBClient/SMBClient-538.121.1/kernel/smbfs/smbfs_vfsops.c | 2026-10-18 | 已验证（macOS 客户端侧源码；服务端行为属实机项） | M-19 第 5 项 `smb://localhost` 测的是 macOS 自作服务器的路径，不代表 Samba 或 Windows 服务器；规格应改为“对 `smbfs` 固定行为探测，API 值不采信”，并补 Samba 与 Windows 共享 |
| macOS | ⑦ NFS 共享 | `nfs_vnop_pathconf`：NFSv2 返回 `EINVAL`；NFSv3 发 `PATHCONF` RPC 读 `case_insensitive`；NFSv4 读服务器属性；`getattrlist` 的 `valid` 位仅在服务器提供属性时置位。该调用可能发起网络 RPC | `_PC_CASE_SENSITIVE`；`VOL_CAP_FMT_CASE_SENSITIVE` 及对应 `valid` 位；`f_fstypename=="nfs"` | `pathconf` 返回 `EINVAL` 或 `valid` 位未置位时需要 | `EINVAL`/`valid` 未置位 → 行为探测 → `Unknown`；API 本身须放进有预算的阻塞包装 | https://raw.githubusercontent.com/apple-oss-distributions/NFS/NFS-343.100.5/kext/nfs_vnops.c ；https://raw.githubusercontent.com/apple-oss-distributions/NFS/NFS-343.100.5/kext/nfs_vfsops.c ；https://www.rfc-editor.org/rfc/rfc1813.txt | 2026-10-18 | 已验证（客户端源码加 RFC；服务端行为未验证） | M-19 当前没有 NFS 项，建议新增（v3 与 v4 各一次，记录 `fpathconf` 返回值含 `EINVAL` 与耗时） |
| Linux | ① ext4（默认，未开 casefold） | 对项目根目录 fd（`open(O_RDONLY\|O_DIRECTORY)`）先 `fstatfs` 取 `f_type`，为 `EXT4_SUPER_MAGIC` 后 `ioctl(fd, FS_IOC_GETFLAGS, &u32)`；未置位 `FS_CASEFOLD_FL` 即区分大小写。规范化轴 `No` | `fstatfs`；`EXT4_SUPER_MAGIC`=0xEF53（与 ext2/ext3 同值）；`FS_IOC_GETFLAGS`；`FS_CASEFOLD_FL`=0x40000000 | 否（ioctl 成功时） | ioctl 失败或 `f_type` 不是预期值 → 行为探测 → `Unknown`；不得把“ioctl 失败”当作“区分大小写” | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/uapi/linux/magic.h?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/uapi/linux/fs.h?id=v7.2 ；https://docs.kernel.org/admin-guide/ext4.html | 2026-10-18 | 已验证（常量、ioctl 路径、flag 语义的源码与文档均读到；实机待 L-19） | L-19 步骤 2（ext4）与 RS-T62 测试四“普通 Linux 文件系统 → Sensitive”成立 |
| Linux | ② ext4 开启 casefold 的目录（`chattr +F`） | 同 ①，对**目录** fd 做 `FS_IOC_GETFLAGS`，`FS_CASEFOLD_FL` 置位即不敏感；普通文件的该位被屏蔽，必须对目录查询；子目录创建时继承。规范化轴 `Yes`（比较前 NFD，再做完整折叠 C+F，Unicode 12.1.0） | `FS_IOC_GETFLAGS`；`FS_CASEFOLD_FL`；`EXT4_FEATURE_INCOMPAT_CASEFOLD`=0x20000；`utf8_strncasecmp`（`UTF8_NFDICF`） | 否 | 同 ① | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ext4/ext4.h?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/unicode.h?id=v7.2 ；https://man7.org/linux/man-pages/man1/chattr.1.html | 2026-10-18 | 已验证（源码加文档；实机待 L-19） | L-19 步骤 3 期望 `Insensitive` 成立，建议补期望：规范化轴 `Yes`（NFC 与 NFD 同名）；ext4 casefold 自 v5.2、f2fs 自 v5.4 起存在 |
| Linux | ③ tmpfs | `fstatfs` 得 `TMPFS_MAGIC`；默认区分大小写；仅当以 `casefold` 挂载选项（内核 v6.13 起）挂载时目录才可 `chattr +F`，此时同样读目录位 | `TMPFS_MAGIC`=0x01021994；`FS_IOC_GETFLAGS`；`FS_CASEFOLD_FL` | 否 | 同 ① | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/mm/shmem.c?id=v7.2 ；https://docs.kernel.org/filesystems/tmpfs.html | 2026-10-18 | 已验证（`shmem_fileattr_get`、`Opt_casefold`、文档句子；实机待 L-19） | L-19 步骤 1（`/dev/shm`）与 RS-T62 测试十“Linux tmpfs → Sensitive”成立 |
| Linux | ④ vfat 与 exfat（内核驱动）：（a）vfat（含 msdos）；（b）exfat | （a）`fstatfs` 得 `MSDOS_SUPER_MAGIC`，不能只靠类型：默认 `check=n` 不敏感，`check=s` 严格区分；比较用 `iocharset` 的单字节小写表逐字节进行，`iocharset=utf8` 时连 ASCII 也不折叠；选项读 `/proc/self/mountinfo` 第 11 段；v7.2 起 `FS_IOC_GETFLAGS` 返回 `FS_CASEFOLD_FL`。规范化轴 `No`。（b）`EXFAT_SUPER_MAGIC`，类型即结论：恒不敏感（卷 upcase 表，仅 BMP），规范化轴 `No` | `MSDOS_SUPER_MAGIC`=0x4d44；`EXFAT_SUPER_MAGIC`=0x2011BAB0；挂载选项 `check=s\|r\|n`、`iocharset=`；`FS_CASEFOLD_FL`（v7.2+）；`exfat_toupper`、`exfat_d_cmp` | （a）读不到挂载选项或要确认 `iocharset=utf8` 的实际行为时需要；（b）否 | （a）无 flag 且无选项信息 → 行为探测（仅翻转 ASCII 字母）→ `Unknown`；（b）无 | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fat/namei_vfat.c?id=v7.2 ；https://docs.kernel.org/filesystems/vfat.html ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/exfat/namei.c?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/exfat/nls.c?id=v7.2 | 2026-10-18 | 部分验证：（b）exfat 源码已验证；（a）vfat 的挂载选项语义与源码读到，`iocharset=utf8` 的实际 lookup 行为是源码推导，未实机 | L-19 步骤 4、5 期望 `Insensitive`：vfat 仅在 `check` 非 `s` 且 `iocharset` 非 `utf8` 时成立，建议补 `-o check=strict`（期望 `Sensitive`）与 `-o iocharset=utf8` 两个变体；exfat 成立 |
| Linux | ⑤ ntfs-3g（FUSE） | `fstatfs` 只能得 `FUSE_SUPER_MAGIC`（内核统一写入）。ntfs-3g 默认**区分大小写**（`ntfs_volume_alloc` 默认置位 `NVolCaseSensitive`，`ignore_case` 仅对 `lowntfs-3g` 有效）；类型串可从 `/proc/self/mountinfo` 第 9 段读（具体字符串未核实） | `FUSE_SUPER_MAGIC`=0x65735546；`NVolCaseSensitive`；挂载选项 `ignore_case`（仅 lowntfs-3g） | 需要（FUSE 共用魔数；若要确认实际行为） | 行为探测 → `Unknown`；FUSE 上“找到但身份不同”不可信（见第 5 部分） | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fuse/inode.c?id=v7.2 ；https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/libntfs-3g/dir.c ；https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/src/ntfs-3g.8.in | 2026-10-18 | 部分验证：源码与手册读到，行为探测结果是推导，未实机 | L-19 步骤 6 期望“`Insensitive` 或 `Unknown`”应改为 `Sensitive`（源码默认），并保留“依赖行为探测” |
| Linux | ⑥ ntfs3（内核驱动） | `fstatfs` 得 `0x7366746e`（字面量 `"ntfs"`，不在 `magic.h`）。**默认区分大小写**，只有挂载选项 `nocase`（v6.2 起）才不敏感；选项读 `/proc/self/mountinfo`；v7.2 起 `FS_CASEFOLD_FL` 随 `nocase` 报告。注意：v7.1 起新 `fs/ntfs` 驱动 `f_type`=`NTFS_SB_MAGIC`(0x5346544e) 默认也区分大小写，而已删除的旧驱动（≤v6.8）默认不敏感且 `f_type` 同值，所以魔数不能单独决定结论 | `0x7366746e`；`NTFS_SB_MAGIC`=0x5346544e；挂载选项 `nocase`；`FS_CASEFOLD_FL`（v7.2+） | 需要（选项不可读时） | 无选项信息且无 flag → 行为探测 → `Unknown` | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/super.c?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/index.c?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs/super.c?id=v7.2 | 2026-10-18 | 已验证（`set_default_d_op(sb, options->nocase ? &ntfs_dentry_ops : NULL)`、`both_case = … && !sbi->options->nocase`、补丁说明“otherwise it is case-sensitive”；实机待 L-19） | L-19 步骤 7 期望 `Insensitive` 实为默认 `Sensitive`，要 `-o nocase` 才 `Insensitive`，应拆为“默认”与“nocase”两项；草案 4.7.2.3 的“已知不敏感类型表含 ntfs、ntfs3”应删除这两项 |
| Linux | ⑦ cifs（含 `nocase` 挂载选项） | `fstatfs` 得 `CIFS_SUPER_MAGIC`；语义由服务器决定（“case sensitive is the default if the server supports it”）；`nocase`（别名 `ignorecase`）让客户端 dentry 不敏感；选项读 `/proc/self/mountinfo`；v7.2 起目录上 `FS_IOC_GETFLAGS` 返回 `FS_CASEFOLD_FL`（取自服务器属性，无答复回退 `nocase`）。规范化轴 `Unknown` | `CIFS_SUPER_MAGIC`=0xFF534D42；`nocase`/`ignorecase`；`FS_CASEFOLD_FL`（v7.2+，仅目录）；`FILE_CASE_SENSITIVE_SEARCH` | 需要（旧内核；服务端语义无法由客户端 API 读出） | 行为探测 → `Unknown`；`noserverino` 下“找到但身份不同”不可信 | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/smb/client/cifsfs.c?id=v7.2 ；https://man7.org/linux/man-pages/man8/mount.cifs.8.html ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=e50bc12f5a3653c0ab1bbb80b427efd96eb6208d | 2026-10-18 | 部分验证：客户端源码与手册读到；“不带 `nocase` 时对 Windows 服务器翻转大小写能否找到”是推导，未实机 | L-19 步骤 8 期望成立，建议补 `serverino`/`noserverino` 两个变体，以及 Windows 服务器与 Samba 两种服务端 |
| Linux | ⑧ nfs | `fstatfs` 得 `NFS_SUPER_MAGIC`（v2/v3/v4 同值）；客户端不做大小写折叠，结论取决于服务端导出的文件系统；v7.2 起客户端把 PATHCONF（v3）与 `FATTR4_CASE_INSENSITIVE`（v4）暴露为 `FS_CASEFOLD_FL`，v2 或未答复一律回到“区分”默认，“服务端说否”与“服务端未答复”不可区分；旧内核没有客户端 API | `NFS_SUPER_MAGIC`=0x6969；`FS_CASEFOLD_FL`（v7.2+）；`NFS_CAP_CASE_INSENSITIVE` | 需要（旧内核，以及对“未答复=默认”不放心时） | 行为探测 → `Unknown` | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=92d67628a1a91c0585e004ffce8975c7898f9ed1 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/nfs/super.c?id=v7.2 ；https://man7.org/linux/man-pages/man5/nfs.5.html | 2026-10-18 | 部分验证：v7.2 补丁完整读到；`nfs.5` 无大小写条目；旧内核行为与服务端语义未实机 | L-19 步骤 9 期望成立；记录里同时写内核版本号（是否 ≥7.2） |
| Linux | ⑨ zfs（`casesensitivity` 属性） | `fstatfs` 得 `ZFS_SUPER_MAGIC`；属性 `casesensitivity=sensitive\|insensitive\|mixed`，默认 `sensitive`，创建后不可改；`FS_IOC_GETFLAGS` 没有 casefold 位；读属性需 `zfs get casesensitivity <数据集>`（数据集名取自 mountinfo 第 10 段，权限未验证）；`normalization` 属性决定规范化轴 | `ZFS_SUPER_MAGIC`=0x2fc12fc1；属性 `casesensitivity`、`normalization`、`utf8only`；`FIGNORECASE` | 需要（无 ioctl 或 statfs 可读的属性） | 行为探测 → `Unknown` | https://raw.githubusercontent.com/openzfs/zfs/master/man/man7/zfsprops.7 ；https://raw.githubusercontent.com/openzfs/zfs/master/module/os/linux/zfs/zpl_inode.c ；https://raw.githubusercontent.com/openzfs/zfs/master/include/sys/fs/zfs.h | 2026-10-18 | 部分验证：属性语义（man 与源码）已验证；`zfs get` 在非特权下是否可用、数据集到路径的映射未验证 | L-19 当前没有 zfs 项，建议新增（`casesensitivity=insensitive` 数据集加默认数据集各一，无环境则记“阻塞”） |
| Linux | ⑩ btrfs | `fstatfs` 得 `BTRFS_SUPER_MAGIC`；dentry 操作只有 `d_delete`，没有 `d_hash`/`d_compare`，名称逐字节比较，始终区分大小写。规范化轴 `No` | `BTRFS_SUPER_MAGIC`=0x9123683E；`btrfs_dentry_operations` | 否 | `f_type` 取不到 → 行为探测 → `Unknown` | https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/btrfs/inode.c?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/btrfs/super.c?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/btrfs/ioctl.c?id=v7.2 ；https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/uapi/linux/magic.h?id=v7.2 | 2026-10-18 | 部分验证（只读了 `inode.c`、`ioctl.c`、`super.c` 三个文件，未全树搜索 casefold） | L-19 当前没有 btrfs 项；若补，期望 `Sensitive`（`mkfs.btrfs` 回环镜像） |

### 2.2 总表补充说明

1. 行级状态统计：24 行中，已验证 9 行（Windows ①；macOS ③④⑥⑦；Linux ①②③⑥），部分验证 15 行，未验证 0 行。“未验证”的子结论不在行级统计里，全部列入第 6 部分（每个子结论都有编号、原因与验证方式）。macOS ⑥⑦ 的“已验证”仅限客户端源码，服务端行为属实机项。
2. 不在 24 行内但读 FUSE 魔数时必须给出的一类：其他 FUSE（sshfs、exfat-fuse 等）。`fstatfs` 只得 `FUSE_SUPER_MAGIC`，大小写由具体守护进程与其后端决定，没有内核 API，一律行为探测，最终 `Unknown`；libfuse 高层 API 未开 `use_ino` 时，同一文件的两个名字会得到不同 `st_ino`，行为探测的“找到但身份不同”不可信（部分验证，见第 3 部分 Linux 内核小节与第 6 部分）。
3. 第 4 部分列出本表与草案 4.7.2.3 探测链表的差异；第 5 部分给出据此定稿的探测链伪代码。

## 3. 逐对象调研结论

本部分按任务文档 5.3 节的 9 个对象各一个三级小节，顺序为 Git、VS Code、Watchman、Jujutsu、Mercurial、Apple、Microsoft、Linux 内核、Rust crate。每个小节包含：①逐问作答（没有答案写“未验证”及原因）；②来源表（URL、访问日期、证据类型、关键句或函数位置）；③对本项目的启示。Apple、Microsoft、Linux 内核、Rust crate 小节还附有支撑第 5 部分结论的素材（保留原编号，如“B.1 问 3”“E.4”）。

编号约定：各小节正文里的“F-n”或“Fn”是该区域的未验证项编号，分别对应第 6 部分的 UW-n（Windows）、UM-n（macOS）、UL-n（Linux）、UV-n（Git 等项目）、UC-n（Rust crate）。“总表①”等指第 2 部分同平台的行。本机只读观察一律是推断类，不计已验证。

### Git

#### ① 逐问作答

<!-- prettier-ignore -->
| 问题 | 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| `git init` 如何探测 `core.ignorecase`：创建什么文件 | 不额外创建探测文件。它复用 init 过程中已经写好的 `.git/config`：前面的 `repo_config_set(repo, "core.filemode", ...)` 已经把 `config` 写出，探测只是对这个已存在的文件做变体访问。位置在 git 目录里，不在工作树里 | https://raw.githubusercontent.com/git/git/v2.56.0/setup.c，`create_default_files`（约 2566–2663 行），探测在 `if (!reinit) {` 块内（约 2643–2660 行） | 2026-10-19 | 项目源码（`setup.c`，标签 v2.56.0） | 已验证 |
| 如何以不同大小写访问 | 把路径换成 `CoNfIg`，只调用 `access(path.buf, F_OK)` 判断是否存在。关键代码：`repo_git_path_replace(repo, &path, "CoNfIg"); if (!access(path.buf, F_OK)) repo_config_set(repo, "core.ignorecase", "true");` 只看存在性，不比较文件身份 | 同上 | 2026-10-19 | 项目源码 | 已验证 |
| 失败时默认 | 没有 `Unknown` 状态：`access` 失败（含权限错误等任何原因）就什么都不写，`core.ignorecase` 保持未设置，运行时默认为 0（`environment.c` 的 `cfg->ignore_case = 0;`，且 `repo_ignore_case()` 在仓库未初始化时返回 0）。Git 自己的测试也接受“未设置”：`t0050-filesystem.sh` 在非大小写不敏感文件系统上断言 `test_must_fail git config --bool core.ignorecase` 或值为 `false` | https://raw.githubusercontent.com/git/git/v2.56.0/environment.c（`repo_ignore_case`、默认值赋值处约 761 行）；https://raw.githubusercontent.com/git/git/v2.56.0/t/t0050-filesystem.sh（约 20–28 行） | 2026-10-19 | 项目源码 | 已验证 |
| 何时探测、结果存哪里 | 只在新建仓库（`!reinit`）时探测一次，结果写入 `.git/config`；重复 `git init` 不重探。官方文档：默认 false，“`git-clone` 或 `git-init` 会在仓库创建时探测，必要时设为 true”；并警告“Git relies on the proper configuration of this variable for your operating and file system. Modifying this value may result in unexpected behavior.” | https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/config/core.adoc（第 29 行起）；https://git-scm.com/docs/git-config（html 中 grep 到同句：“The default is false, except git-clone[1] or git-init[1] will probe and set core.ignoreCase true if appropriate when the repository is created.”） | 2026-10-19 | 官方文档 + 项目源码 | 已验证 |
| 探测的是哪个位置的文件系统 | 探测发生在 git 目录（`repo_git_path`），而不是工作树。`init_db` 中 `separate_git_dir`（约 2867 行）先于 `create_default_files`（约 2896 行）执行，所以使用 `--separate-git-dir` 时探测的是分离后的 git 目录所在位置。这是代码路径的字面事实；“工作树在另一个文件系统时会不一致”是由此得出的推断 | https://raw.githubusercontent.com/git/git/v2.56.0/setup.c（`init_db`，约 2841–2900 行） | 2026-10-19 | 项目源码（事实）；推断（后果） | 事实已验证，后果为推断 |
| `core.precomposeUnicode` 在 macOS 上做什么 | 文档：“This option is only used by Mac OS implementation of Git. When core.precomposeUnicode=true, Git reverts the unicode decomposition of filenames done by Mac OS.” 实现：readdir 返回的文件名用 iconv 从 `UTF-8-MAC` 转成 `UTF-8`（`precompose_utf8_readdir`），命令行参数与路径前缀同样用 `precompose_string_if_needed` 转为预组合形式 | https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/config/core.adoc（第 44–51 行）；https://raw.githubusercontent.com/git/git/v2.56.0/compat/precompose_utf8.c（`precompose_string_if_needed`、`precompose_utf8_readdir`）；https://git-scm.com/docs/git-config | 2026-10-19 | 官方文档 + 项目源码 | 已验证 |
| `core.precomposeUnicode` 如何探测 | 函数 `probe_utf8_pathname_composition`：在 git 目录里用 `open(..., O_CREAT\|O_EXCL\|O_RDWR, 0600)` 创建一个预组合名称（NFC，字节 `\xc3\xa4`，即 `ä`）的文件；创建成功后用分解名称（NFD，字节 `a\xcc\x88`）做 `access(path, R_OK)`，能访问则 `precomposed_unicode = 1`，否则 0；把结果写入 `core.precomposeunicode`，最后 `unlink` 预组合名称，`unlink` 失败则 `die_errno`。如果配置里已有该键（`cfg->precomposed_unicode != -1`）则直接返回，尊重已有配置 | https://raw.githubusercontent.com/git/git/v2.56.0/compat/precompose_utf8.c（第 50–70 行） | 2026-10-19 | 项目源码 | 已验证 |
| 该探测只在 macOS 构建里存在 | `git-compat-util.h` 中 `#ifdef PRECOMPOSE_UNICODE` 才包含 `compat/precompose_utf8.h`，否则 `#define probe_utf8_pathname_composition()` 为空宏；`config.mak.uname` 只在 `ifeq ($(uname_S),Darwin)` 块（第 130–199 行）里加入 `COMPAT_OBJS += compat/precompose_utf8.o` 与 `BASIC_CFLAGS += -DPRECOMPOSE_UNICODE` | https://raw.githubusercontent.com/git/git/v2.56.0/git-compat-util.h（约 166–182 行）；https://raw.githubusercontent.com/git/git/v2.56.0/config.mak.uname（第 130、155–156 行） | 2026-10-19 | 项目源码 | 已验证 |
| precompose 探测失败/只读目录 | 创建失败（`output_fd < 0`）时整个块被跳过，不设置、不报错，`core.precomposeunicode` 保持未设置，`precomposed_unicode` 仍为 -1，之后在 `precompose_string_if_needed` 里首次需要时再读配置，读不到则按非 1 处理（不转换）。`git init` 本身要求 git 目录可写，所以“只读目录”在 Git 里是 init 整体失败而不是探测降级。这是对代码路径的阅读 | https://raw.githubusercontent.com/git/git/v2.56.0/compat/precompose_utf8.c（第 56–70、85–95 行） | 2026-10-19 | 项目源码 | 部分验证（没有对只读目录做实测） |
| precompose 的设计背景 | 提交说明：“Mac OS X mangles file names containing unicode on file systems HFS+, VFAT or SAMBA”；HFS+ 把名称转成分解形式写盘；VFAT 上 macOS 以预组合形式存储但 readdir 仍返回分解形式；“NFS mounted from Linux is fully transparent and does not suffer from the above.” | https://github.com/git/git/commit/76759c7dff53e8c84e975b88cb8245587c14c7ba.patch（提交 76759c7，2012-07-08，Torsten Bögershausen） | 2026-10-19 | 项目源码（提交说明） | 部分验证（2012 年的描述，是否仍与当前 macOS 一致需要 Apple 部分的来源佐证） |
| Git 运行时如何比较路径 | `core.ignorecase` 为真时，`git_fspathcmp` 用 `strcasecmp`，`fspathhash` 用 `strihash`（只把 `a`–`z` 转大写，纯 ASCII）。所以 Git 的折叠函数是 ASCII 级近似，不是 Unicode 折叠，也不做规范化 | https://raw.githubusercontent.com/git/git/v2.56.0/dir.c（`git_fspathcmp`、`fspathhash`，约 126–157 行）；https://raw.githubusercontent.com/git/git/v2.56.0/hashmap.c（`strihash`，第 18–27 行） | 2026-10-19 | 项目源码 | 已验证 |
| Git 在 checkout 时如何发现大小写碰撞 | `mark_colliding_entries` 用“或”关系：`(trust_ino && !match_stat_data(&dup->ce_stat_data, st)) \|\| paths_collide(ce->name, dup->name)`，即先看 inode/stat 数据是否相同，再看名字是否按 `fspathcmp` 碰撞；在 `GIT_WINDOWS_NATIVE` 或 `__CYGWIN__` 下强制 `trust_ino = 0`（源码没有写原因） | https://raw.githubusercontent.com/git/git/v2.56.0/entry.c（`mark_colliding_entries`，约 442–480 行）；https://raw.githubusercontent.com/git/git/v2.56.0/dir.c（`paths_collide`，约 142–151 行） | 2026-10-19 | 项目源码 | 已验证 |
| Git 自己的测试如何判断“文件系统是否不区分大小写” | `test_lazy_prereq CASE_INSENSITIVE_FS`：写 `CamelCase` 内容 `good`，写 `camelcase` 内容 `bad`，若读 `CamelCase` 的内容不再是 `good` 则为不敏感。这是“写后读内容”的探测，不依赖文件身份 | https://raw.githubusercontent.com/git/git/v2.56.0/t/test-lib.sh（约 1817–1821 行） | 2026-10-19 | 项目源码 | 已验证 |
| Windows 上的目录级大小写敏感标志与 Git | 没有在 Git 源码或官方文档里找到对该标志的处理：`setup.c` 的探测是 `access("CoNfIg")`，不涉及 `FileCaseSensitiveInformation`。社区博客（Nerdbank，2026-04-16）给出的做法是为大小写敏感的 worktree 手工 `git config --worktree core.ignorecase false`，说明默认探测在这类目录中不会自动得到“区分大小写” | https://blog.nerdbank.net/2026/04/16/case-sensitive-git-worktrees-on-windows/ | 2026-10-19 | 社区讨论（降级，需另有佐证）；源码层面为“没有相关代码”的否定性观察 | 部分验证（缺：Git for Windows 在大小写敏感目录里 `git init` 的实测结果） |

#### ② 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://raw.githubusercontent.com/git/git/v2.56.0/setup.c | 2026-10-19 | 项目源码（标签 v2.56.0） | `create_default_files`：`/* Check if the filesystem is case-insensitive */ repo_git_path_replace(repo, &path, "CoNfIg"); if (!access(path.buf, F_OK)) repo_config_set(repo, "core.ignorecase", "true"); probe_utf8_pathname_composition();` |
| https://raw.githubusercontent.com/git/git/v2.56.0/compat/precompose_utf8.c | 2026-10-19 | 项目源码 | `probe_utf8_pathname_composition`；`path_encoding = "UTF-8-MAC"`；`precompose_utf8_readdir` |
| https://raw.githubusercontent.com/git/git/v2.56.0/git-compat-util.h 与 config.mak.uname | 2026-10-19 | 项目源码 | `#define probe_utf8_pathname_composition()`（非 Darwin 为空宏）；`BASIC_CFLAGS += -DPRECOMPOSE_UNICODE` 位于 `ifeq ($(uname_S),Darwin)` |
| https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/config/core.adoc | 2026-10-19 | 官方文档（源） | `core.ignoreCase::`“Internal variable which enables various workarounds to enable Git to work better on filesystems that are not case sensitive, like APFS, HFS+, FAT, NTFS, etc.” |
| https://git-scm.com/docs/git-config | 2026-10-19 | 官方文档 | 同上两句（html 中 grep 复核） |
| https://raw.githubusercontent.com/git/git/v2.56.0/dir.c、hashmap.c、entry.c、environment.c | 2026-10-19 | 项目源码 | `git_fspathcmp`（`strcasecmp`）、`strihash`（只转 ASCII）、`mark_colliding_entries`、`repo_ignore_case` |
| https://raw.githubusercontent.com/git/git/v2.56.0/t/test-lib.sh 与 t/t0050-filesystem.sh | 2026-10-19 | 项目源码 | `CASE_INSENSITIVE_FS`；“detection of case insensitive filesystem during repo init” |
| https://github.com/git/git/commit/76759c7dff53e8c84e975b88cb8245587c14c7ba.patch | 2026-10-19 | 项目源码（提交说明） | “git on Mac OS and precomposed unicode” |
| https://blog.nerdbank.net/2026/04/16/case-sensitive-git-worktrees-on-windows/ | 2026-10-19 | 社区讨论（降级） | `git config --worktree core.ignorecase false` |

#### ③ 对本项目的启示

Git 对大小写的探测其实就是“已有条目换大小写”：访问 `.git/config` 的变体 `CoNfIg`，不创建文件、不比较身份、失败就当作敏感，这与草案首选方案同类，不是草案所写的“创建后查询变体”；真正“创建后查询变体”的是仅 macOS 构建的 precompose 探测，它同时说明大小写与规范化在 Git 里是两个独立开关、两个独立探测。Git 的探测对象是 git 目录而不是工作树，结果一次写入配置、不再重测，这提示我们：探测对象必须是“项目根本身所在位置”，而且要有缓存失效策略（草案已有）。

#### ④ 补充：探测的副作用与只读目录

<!-- prettier-ignore -->
| 问题 | 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| `core.ignorecase` 探测有什么副作用 | 没有：只对已存在的 `.git/config` 做 `access(F_OK)` 的变体访问，不创建、不删除任何文件，所以不会产生创建或删除通知 | https://raw.githubusercontent.com/git/git/v2.56.0/setup.c（`create_default_files`，`CoNfIg` 附近） | 2026-10-19 | 项目源码 | 已验证 |
| `core.precomposeunicode` 探测有什么副作用 | 在 git 目录里创建一个 NFC 名称（`ä`）的文件，访问其 NFD 变体后立即 `unlink`；监视 git 目录的工具会看到一次创建与删除（对事件的推断；杀毒、同步工具的实际反应没有来源） | https://raw.githubusercontent.com/git/git/v2.56.0/compat/precompose_utf8.c（`probe_utf8_pathname_composition`，约第 50–70 行） | 2026-10-19 | 项目源码；推断 | 部分验证 |
| 对只读目录的处理 | `git init` 本身要求 git 目录可写，只读时整个 init 失败而不是降级；`ignorecase` 的 `access` 在只读目录里照常可用；precompose 的创建失败时静默跳过，不设置、不报错（读码所得，未实测） | 同上两个文件 | 2026-10-19 | 项目源码 | 部分验证 |

### VS Code

#### ① 逐问作答

<!-- prettier-ignore -->
| 问题 | 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| 文件系统提供者如何声明“路径是否区分大小写” | 通过能力位：`FileSystemProviderCapabilities.PathCaseSensitive = 1 << 10`，注释 “Provider is path case sensitive.” 能力位**置位表示区分大小写**，不置位表示按不敏感处理（默认不敏感） | https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/common/files.ts（约 626–628 行） | 2026-10-19 | 项目源码（标签 1.142.0） | 已验证 |
| 扩展提供的文件系统如何声明 | 公开 API `registerFileSystemProvider(scheme, provider, options)` 的 `options.isCaseSensitive?: boolean`，注释 “Whether the file system provider use case sensitive compare for Uri.path paths” | https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vscode-dts/vscode.d.ts（约 14517–14521 行） | 2026-10-19 | 项目源码 | 已验证 |
| 本地磁盘提供者按什么判定 | 只按操作系统：`DiskFileSystemProvider.capabilities` 里 `if (isLinux) { this._capabilities \|= FileSystemProviderCapabilities.PathCaseSensitive; }`。也就是 Linux 一律“区分大小写”，macOS 与 Windows 一律“不区分大小写”，与具体卷、挂载选项、目录标志无关 | https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/node/diskFileSystemProvider.ts（约 60–64 行） | 2026-10-19 | 项目源码 | 已验证 |
| 是否有按卷或按目录探测 | 在 `diskFileSystemProvider.ts`、`fileService.ts`、`uriIdentityService.ts`、`resources.ts`、`pfs.ts` 中没有任何创建探测文件或查询卷属性的代码；`PathCaseSensitive` 只有上面一处置位 | 同上各文件（grep `PathCaseSensitive`、`isLinux`） | 2026-10-19 | 项目源码（否定性观察） | 已验证（限于 1.142.0 的这几个文件） |
| `extUri` / `ignorePathCasing` 如何使用该能力 | `UriIdentityService` 对每个 scheme 计算一次并缓存：`ignorePathCasing = _fileService.hasProvider(uri) && !_fileService.hasCapability(uri, FileSystemProviderCapabilities.PathCaseSensitive)`；能力变化事件到来时重算。`ExtUri.getComparisonKey` 在需要忽略大小写时用 `uri.path.toLowerCase()`（JavaScript 的 Unicode 小写，不做规范化）。`extUriBiasedIgnorePathCase` 对 `file` scheme 用 `!isLinux`，注释说明 “Should come from File system provider” | https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/uriIdentity/common/uriIdentityService.ts（约 44–75 行）；https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/common/resources.ts（约 143–170、354–372 行） | 2026-10-19 | 项目源码 | 已验证 |
| 大小写敏感性对 move/copy/watch 的影响 | `validateMoveCopy`：不敏感时同路径不同大小写的 copy 报 “File cannot be copied to same path with different path case”，move 放行；文件监听用 `ignoreCase = !isLinux`；`existsChildStrictCase` 在非 Linux 上读父目录列表做严格大小写比较，而不是 `exists` | diskFileSystemProvider.ts（约 750–775 行）；https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/node/watcher/nodejs/nodejsWatcherLib.ts（约 99–101、553–565 行）；parcelWatcher.ts（约 68–70 行） | 2026-10-19 | 项目源码 | 已验证 |
| 失败案例（按 OS 判定的后果）：macOS 区分大小写卷 | 维护者回复：“We currently do not support case-sensitive file systems on macOS or Windows. It may have worked by chance in the past but we never officially did anything to enable this scenario.” 另一条：“macOS is case insensitive. File System Provider would have to specify that it is case sensitive which it does not atm.” 追踪 issue #94307（https://github.com/microsoft/vscode/issues/94307） 仍为 open | https://github.com/microsoft/vscode/issues/101267（评论）；https://github.com/microsoft/vscode/issues/94307（评论与状态，用 GitHub API 取回） | 2026-10-19 | 社区讨论（项目 issue 中维护者的回复，降级），与源码一致 | 已验证（与上面的源码相互印证） |
| 失败案例：Windows 目录级标志 | #90983（https://github.com/microsoft/vscode/issues/90983）：“For this the FileSystem provider for windows would have to notify us that it is case insensitive. Not currently working”（以 out-of-scope 关闭，重复于 #94307（https://github.com/microsoft/vscode/issues/94307））；#177925（https://github.com/microsoft/vscode/issues/177925）（open）：“Seems like we will have to handle this special FS util flag differently.” 使用 WSL 远程打开时能正常列出，因为 “that file system provider correctly states it is case insensitive”（原文如此，语义是 WSL 一侧的提供者正确声明了自己） | https://github.com/microsoft/vscode/issues/90983；https://github.com/microsoft/vscode/issues/177925 | 2026-10-19 | 社区讨论（降级，项目 issue） | 部分验证（现象来自 issue，机制由源码印证） |
| 规范化轴 | 与大小写轴分开处理，同样按操作系统：读目录结果在 macOS 上 `normalizeNFC`（`handleDirectoryChildren`：“Mac: uses NFD unicode form on disk, but we want NFC”），文件监听事件路径在 macOS 上 `normalizeNFC`；不是按卷探测 | https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/node/pfs.ts（约 176–190 行）；parcelWatcher.ts（约 520–524 行）；nodejsWatcherLib.ts（约 283–287 行） | 2026-10-19 | 项目源码 | 已验证 |
| 其他（与探测相关的保守处理） | macOS 上对 `/Volumes/` 下的路径拒绝用 `fs.watch` 监视，原因是 “watching samba shares can crash VSCode”（issue #106879（https://github.com/microsoft/vscode/issues/106879）），即用路径前缀猜测网络共享；`realcase()` 在 Linux 直接返回原路径，注释指出该方法不适用于“同一路径可以有多种形式”的区分大小写系统（#139709（https://github.com/microsoft/vscode/issues/139709）） | https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/node/watcher/nodejs/nodejsWatcherLib.ts（约 205–215 行）；https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/node/pfs.ts（`realcase`，约 683–715 行） | 2026-10-19 | 项目源码 | 已验证 |

#### ② 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/common/files.ts | 2026-10-19 | 项目源码 | `PathCaseSensitive = 1 << 10` |
| https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/node/diskFileSystemProvider.ts | 2026-10-19 | 项目源码 | `capabilities` getter：`if (isLinux) { ... PathCaseSensitive }` |
| https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/common/resources.ts | 2026-10-19 | 项目源码 | `ExtUri`、`extUriBiasedIgnorePathCase`、`extUriIgnorePathCase` |
| https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/uriIdentity/common/uriIdentityService.ts | 2026-10-19 | 项目源码 | `ignorePathCasing` 的计算与缓存 |
| https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/common/fileService.ts | 2026-10-19 | 项目源码 | `isPathCaseSensitive`、`getExtUri` |
| https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vscode-dts/vscode.d.ts | 2026-10-19 | 项目源码 | `registerFileSystemProvider` 的 `isCaseSensitive` |
| https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/node/pfs.ts | 2026-10-19 | 项目源码 | `realcase`、`handleDirectoryChildren` |
| https://github.com/microsoft/vscode/issues/101267、/94307、/90983、/177925、/16591 | 2026-10-19 | 社区讨论（降级） | 维护者对 macOS 与 Windows 区分大小写位置“不支持”的回复 |

#### ③ 对本项目的启示

VS Code 的做法是“按 OS 写死 + 提供者可声明”，没有任何按卷探测；公开 issue 显示这正是它在 macOS 区分大小写卷与 Windows 目录级标志上长期出问题的原因（这些 issue 的关闭或搁置是官方对“不支持”的态度）。这印证了本项目“探测以项目根所在位置为准、不以 OS 为准”的方向，也说明只按 OS 判断是一个已知会出现真实用户故障的方案，但它同时是“探测失败时的保底默认”的现成参照（Linux 敏感，macOS 与 Windows 不敏感）。

### Watchman

#### ① 逐问作答

<!-- prettier-ignore -->
| 问题 | 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| 对根目录大小写敏感性如何探测 | 函数 `getCaseSensitivityForPath(path)` 按编译平台分三支：macOS（`__APPLE__`）用 `pathconf(path, _PC_CASE_SENSITIVE) ? CaseSensitive : CaseInSensitive`；Windows（`_WIN32`）直接 `CaseInSensitive`；其余（Linux、BSD 等）直接 `CaseSensitive`。没有行为探测、没有创建文件、不看目录级标志 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FSDetect.cpp（约 35–43 行） | 2026-10-19 | 项目源码（标签 v2026.10.12.00） | 已验证 |
| macOS 分支的错误处理 | 三元表达式把 `pathconf` 的任何非零返回都当作“区分大小写”。C 语言中 `pathconf` 出错返回 -1（非零），因此出错会被判为 `CaseSensitive`，不存在 `Unknown` 分支（该返回值约定属于 `pathconf` 本身，由 Apple 部分核实；此处只陈述 Watchman 代码的字面写法） | 同上 | 2026-10-19 | 项目源码；错误返回值为 -1 的约定属推断 | 代码字面已验证；对 -1 的后果为推断 |
| 判定在什么时候做、作用于哪里 | 在构造 `Root` 时对 `root_path` 调用一次（`RootConfig{... getCaseSensitivityForPath(root_path.c_str()) ...}`），保存为 `Root::case_sensitive`（`const`），之后传给爬取、过期清理、同步等所有路径操作；还在 `watch-list` 输出里暴露为 `case_sensitive` 布尔值 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/root/init.cpp（约 240–260、307–308 行）；watchman/root/Root.h（第 102 行）；watchman/root/watchlist.cpp（约 250 行） | 2026-10-19 | 项目源码 | 已验证 |
| 对大小写不同名文件的处理 | 官方文档承认：“Watchman is currently completely unaware of case-insensitivity in file systems, and does not attempt to do any case-folding of file names.”；重命名大小写时会同时报告新名为创建、旧名为变化；并说明做完整折叠的难度分四级（ASCII 95%、含重音 98%、完整 Unicode 数据库 99%、使用文件系统创建时写入隐藏文件的折叠表 100%）。把折叠交给客户端处理 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/website/docs/casefolding.md | 2026-10-19 | 官方文档（源） | 已验证 |
| 文档与代码是否冲突 | 文档说“完全不感知大小写”，代码里却有 `CaseSensitivity` 枚举与 `checkCanonicalBaseName`。采信的解释：文档指的是“不做折叠/不合并名字”，代码里的大小写信息只用于“打开文件时校验文件名是否为磁盘上的规范大小写”：macOS 用 `getattrlist(ATTR_CMN_NAME)` 取规范名与请求名比较；其他平台读父目录条目做精确匹配（并注释：目录里可能同时有 `pod` 与 `Pod`，所以不在大小写不敏感匹配时提前返回）。文档页较旧，两者不矛盾但文档措辞过于绝对 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FileSystem.cpp（`checkCanonicalBaseName`，约 70–143 行；`openFileHandle`、`getFileInformation`，约 225–300 行） | 2026-10-19 | 项目源码 + 官方文档 | 已验证（代码事实）；“文档较旧”为推断 |
| 对 `ENOENT` 的补偿 | 大小写不敏感根上，若因名字不是规范大小写被拒绝，会“speculatively look at parent dir”重新扫描父目录以发现新条目 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/root/iothread.cpp（约 950–965 行） | 2026-10-19 | 项目源码 | 已验证 |
| 文件系统类型探测与大小写的关系 | 另有 `w_fstype()`：Linux 上读 `/proc/self/mounts`，取与路径最长前缀匹配的挂载点（“we intentially bias towards the last matching path”），fuse 与 nfs 取设备名（为识别 edenfs）；用途是识别“已知有问题的网络/远程文件系统”（`illegal_fstypes` 配置），不用于判断大小写 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FSDetect.cpp（约 46–140 行）；watchman/root/resolve.cpp（`check_allowed_fs`） | 2026-10-19 | 项目源码 | 已验证 |

#### ② 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FSDetect.cpp | 2026-10-19 | 项目源码 | `getCaseSensitivityForPath`：`#ifdef __APPLE__ return pathconf(path, _PC_CASE_SENSITIVE) ? CaseSensitivity::CaseSensitive : CaseSensitivity::CaseInSensitive; #elif defined(_WIN32) return CaseSensitivity::CaseInSensitive; #else return CaseSensitivity::CaseSensitive;` |
| https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FileDescriptor.h | 2026-10-19 | 项目源码 | `enum class CaseSensitivity { CaseInSensitive, CaseSensitive, Unknown }`，注释 “The caller does not know if the path(s) are case sensitive” |
| https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FileSystem.cpp | 2026-10-19 | 项目源码 | `checkCanonicalBaseName`、`getFileInformation` |
| https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/website/docs/casefolding.md | 2026-10-19 | 官方文档（源） | “Watchman is currently completely unaware of case-insensitivity in file systems” |
| https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/website/docs/cookies.md | 2026-10-19 | 官方文档（源） | “A cookie is a temporary file that is created inside a directory observed by watchman.” |

#### ③ 对本项目的启示

Watchman 是“OS 常量 + 仅 macOS 向系统查询”的最简实现，且它的枚举里保留了 `Unknown`（调用方不知道时再按路径查询），但 macOS 分支没有区分出错与敏感；它把折叠问题交给调用者，并用“规范大小写名校验”代替折叠。对本项目最有用的是：它承认完整折叠有四个正确度等级，并选择不做；这与草案“折叠函数只是近似、文件身份兜底必须保留”的立场一致。

### Jujutsu

#### ① 逐问作答

<!-- prettier-ignore -->
| 问题 | 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| 工作副本是否探测文件系统大小写敏感性 | 不探测。在 `lib/src/local_working_copy.rs`、`core/src/file_util.rs` 中没有任何“检测大小写是否敏感”的函数或配置；grep `case`/`insensitiv` 只命中两类：测试里的 `is_icase_fs`，以及源码注释 TODO | GH 取 tarball 解压后 grep（`https://github.com/jj-vcs/jj/archive/refs/tags/v0.46.0.tar.gz`）：lib/src/local_working_copy.rs、core/src/file_util.rs | 2026-10-19 | 项目源码（标签 v0.46.0，否定性观察） | 已验证（限于 v0.46.0 的这两个文件与全仓库关键词搜索） |
| 对大小写不敏感文件系统的处理 | 用“文件身份”代替“大小写判断”：`FileIdentity` 的文档注释：“Opaque value that can be tested to know whether file or directory paths point to the same filesystem entity. The primary use case is to detect file name aliases on case-insensitive filesystem. On Unix, device and inode numbers are compared.” Unix 实现是 `symlink_metadata` 取 `dev`+`ino`；Windows 用 `same_file::Handle`（打开文件句柄比较卷序列号与文件索引，加 `FILE_FLAG_OPEN_REPARSE_POINT` 以不跟随符号链接） | https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/core/src/file_util.rs（约 281–305、330–420 行） | 2026-10-19 | 项目源码 | 已验证 |
| 这套机制用在哪里 | 检出（写工作副本）时防止路径别名指向保留目录 `.git` 与 `.jj`：`can_create_new_file` 先用 `create_new(true)` 在目标路径创建一个空文件（“Don't overwrite, don't follow symlink”），对它取身份，与同一父目录下的 `.git`、`.jj` 的身份比较，相同则报 `ReservedPathComponent`；文件已存在时对已有路径做同样比较。注释说明是安全问题：路径若指向 `.git`/`.jj`，“git/jj CLI could be tricked to load configuration from an attacker-controlled location” | https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/lib/src/local_working_copy.rs（约 770–820、824–930 行） | 2026-10-19 | 项目源码 | 已验证 |
| 更新日志佐证 | CHANGELOG 的 Fixed bugs：Windows 上文件身份查询不再跟随符号链接，“This identity check is used when writing the working copy to detect aliases of the reserved `.git` and `.jj` directories.”（issue #8924） | https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/CHANGELOG.md（约 548–553 行） | 2026-10-19 | 项目源码（变更记录） | 已验证 |
| 文件状态里是否记录规范大小写 | 没有，只有一条 TODO：“Could possibly handle case-insensitive file systems keeping an Option<PathBuf> with the actual path here.” | https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/lib/src/local_working_copy.rs（约 301 行） | 2026-10-19 | 项目源码 | 已验证 |
| 其他探测（非大小写）如何处理失败与只读 | 可执行位探测 `check_executable_bit_support(path)` 在传入目录里创建临时文件（`tempfile::tempfile_in`），翻转位后回读确认；调用处（`ExecChangePolicy::new`）在探测报错时 `tracing::warn!` 并**默认 `Respect`**；传入的是 `.jj` 的状态目录（`state_path`），不是用户工作树根。符号链接支持在 Windows 上查注册表 `AllowDevelopmentWithoutDevLicense`，不创建文件 | https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/core/src/file_util.rs（约 313–326 行）；lib/src/local_working_copy.rs（约 180–205 行） | 2026-10-19 | 项目源码 | 已验证 |

#### ② 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://github.com/jj-vcs/jj/archive/refs/tags/v0.46.0.tar.gz（解压到本地后读取） | 2026-10-19 | 项目源码（标签 v0.46.0） | core/src/file_util.rs：`FileIdentity`、`platform::FileIdentity`（Unix：`dev`、`ino`；Windows：`same_file::Handle`）；lib/src/local_working_copy.rs：`can_create_new_file`、`reject_reserved_existing_file_identity`、`RESERVED_DIR_NAMES` |
| 同上 core/src/file_util.rs 测试 | 2026-10-19 | 项目源码 | `test_file_identity_unix_symlink_loop`：`let is_icase_fs = upper_file_path.try_exists()?;`（测试里用“变体名是否存在”判断是否不敏感，源码里没有同类生产代码） |
| 同上 CHANGELOG.md | 2026-10-19 | 项目源码（变更记录） | “On Windows, querying a path's file identity no longer follows symbolic links, matching the behavior on Unix.” |

#### ③ 对本项目的启示

Jujutsu 完全绕开“先判断文件系统，再决定怎么比较”，直接用文件身份（Unix 的 `dev`+`ino`，Windows 的 `same_file::Handle`）判断别名，并且选择在安全敏感处（保留目录）使用；这正是草案 4.7.2.5 “文件身份兜底”的成熟先例，也证明身份比较可以单独成立、不依赖探测。它的 Windows 实现用 `same-file` 这个 crate（`Cargo.toml` 里 `same-file = "1.0.6"`），可供 Rust crate 评估部分引用。

### Mercurial

#### ① 逐问作答

<!-- prettier-ignore -->
| 问题 | 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| `util.fscasesensitive` 如何探测 | 函数文档：“Return true if the given path is on a case-sensitive filesystem. Requires a path (like /foo/.hg) ending with a foldable final directory component.” 实现：`s1 = os.lstat(path)`；取路径最后一段 `b`，先 `b.upper()`，若与原名相同再 `b.lower()`，仍相同则 `return True`（“no evidence against case sensitivity”）；否则对变体路径 `os.lstat`，**若 `s2 == s1`（整个 stat 结果相等）返回 False（不敏感），不相等返回 True；`OSError`（含找不到、权限等任何错误）返回 True（敏感）** | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/util.py（`fscasesensitive`，第 2292–2315 行） | 2026-10-19 | 项目源码（标签 7.2.4） | 已验证 |
| 它是只读的吗 | 是。只对已存在的 `.hg`（或传入的路径）做两次 `lstat`，不创建任何文件，因此在只读目录上也能工作；唯一的例外是调试命令 `hg debugfsinfo`，它在目录下创建 `.debugfsinfo*` 临时文件再调用该函数，`OSError` 时报告 `case-sensitive: (unknown)` | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/debugcommands.py（约 1768–1774 行） | 2026-10-19 | 项目源码 | 已验证 |
| 比较的是什么 | 比较 `os.lstat` 返回的完整 `stat_result`（包含 `st_ino`、`st_dev`、`st_nlink`、时间戳等），不是只比 `dev`+`ino`。文件名类型是 `bytes` | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/util.py（同上） | 2026-10-19 | 项目源码 | 已验证 |
| 在哪里被调用 | `dirstate._checkcase`：`return not util.fscasesensitive(self._join(b'.hg'))`（`.hg` 在仓库根下，天然含字母）；`merge.py`：`if not util.fscasesensitive(repo.path)` 才检查碰撞，`repo.path` 即 `.hg`；`pathutil.pathauditor.__init__`：`if os.path.lexists(root) and not util.fscasesensitive(root)` 才启用 `normcase`——这里传的是工作树根，最后一段由用户目录名决定，若名字不含字母则返回 True（视为敏感） | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/dirstate.py（约 524–525 行）；merge.py（约 1533、1760 行）；pathutil.py（约 74–77 行） | 2026-10-19 | 项目源码 | 已验证 |
| 对大小写冲突的处理 | 合并/更新时若文件系统不敏感，构造“临时合并后清单”，对每个路径做 `util.normcase` 折叠，遇到相同折叠键的两个不同路径就 `Abort`：“case-folding collision between %s and %s”。`dirstate.normalize` 在不敏感时把传入路径折叠成“dirstate 中已有的写法优先，其次磁盘上的写法，最后命令行写法”，磁盘写法通过 `util.fspath`（列目录建 `normcase(n) -> n` 缓存）获得 | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/merge.py（`_checkcollision`，约 320–375 行）；dirstate.py（`_discoverpath`、`_normalize`、`normalize`，约 968–1045 行）；util.py（`fspath`，约 2407–2450 行） | 2026-10-19 | 项目源码 | 已验证 |
| 折叠函数 `normcase` 怎么选 | **按操作系统选，不按卷**：posix 默认 `path.lower()`（对 `bytes` 只转 ASCII 大写，Python 文档：“Return a copy of the sequence with all the uppercase ASCII characters converted to their corresponding lowercase counterpart.”）；Windows：`encoding.upper(path)`，注释 “NTFS compares via upper()”；macOS（`isdarwin`）：先尝试 ASCII 小写，非 ASCII 时走 `normcasefallback`：按 UTF-8 解码，`unicodedata.normalize('NFD', u).lower()`，再丢弃 HFS+ 忽略字符，文档字符串写明 “Normalize a filename for OS X-compatible comparison: escape-encode invalid characters; decompose to NFD; lowercase; omit ignored characters [200c-200f, 202a-202e, 206a-206f,feff]”；cygwin 另有大写版本 | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/posix.py（约 431–530 行）；https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/windows.py（约 334–360 行）；https://docs.python.org/3/library/stdtypes.html（`bytes.lower()`） | 2026-10-19 | 项目源码 + 官方文档 | 已验证 |
| 大小写与规范化是否分轴 | **没有分轴**：macOS 的 `normcase` 把 NFD 规范化与小写合并成一个函数，且是否启用由 `fscasesensitive` 的结果（大小写轴）决定，而不是单独探测规范化。Mercurial 只有“检测到不敏感才用 `normcase`”这一个开关 | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/posix.py、dirstate.py（同上） | 2026-10-19 | 项目源码 | 已验证（结构层面为读码所得） |
| 官方历史说明 | 已存档的 Mercurial wiki（标注“已停更、信息可能很旧”）指出：“case folding is also part of the larger problem of name collision which can also result from dot-notation and Unicode representation”，并说明 “Mercurial now by default uses a storage format where case collisions in the history isn't a problem on windows and where updating to a problematic revisions fails nicely” | https://www.mercurial-scm.org/wiki/CaseFolding | 2026-10-19 | 官方文档（已存档，页面自述过时）→ 降级使用 | 部分验证（仅作背景，不作为当前行为依据） |

#### ② 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/util.py | 2026-10-19 | 项目源码（标签 7.2.4） | `fscasesensitive`（第 2292 行）；`fspath`（第 2410 行起）；`checknlink`（第 2454 行起，硬链接数报告能力检测） |
| https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/dirstate.py | 2026-10-19 | 项目源码 | `_checkcase`（第 524 行）；`_normalize`；`_discoverpath` |
| https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/pathutil.py | 2026-10-19 | 项目源码 | `pathauditor.__init__`（第 74 行）：`if os.path.lexists(root) and not util.fscasesensitive(root):` |
| https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/merge.py | 2026-10-19 | 项目源码 | `_checkcollision`：`msg = _(b"case-folding collision between %s and %s")` |
| https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/posix.py 与 windows.py | 2026-10-19 | 项目源码 | `normcase`（posix `lower`；darwin NFD+lower；windows `upper`） |
| https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/debugcommands.py | 2026-10-19 | 项目源码 | `debugfsinfo`：`pycompat.namedtempfile(prefix=b'.debugfsinfo', dir=path)`；`casesensitive = b'(unknown)'` |
| https://docs.python.org/3/library/stdtypes.html | 2026-10-19 | 官方文档 | `bytes.lower()` 只转 ASCII |
| https://www.mercurial-scm.org/wiki/CaseFolding | 2026-10-19 | 官方文档（存档，自述过时） | 同上 |

#### ③ 对本项目的启示

`fscasesensitive` 与草案首选方案几乎同构（取已有条目、换大小写、`lstat` 比较、只读），是最直接的成熟先例；差别在三点：Mercurial 把一切错误都当作“敏感”（我们要 `Unknown`）、要求名字含字母且没有“无字母时退到别的条目”的步骤（我们的草案有）、比较的是整个 stat 而不是显式的身份。它把大小写与 macOS 规范化合并在一个 `normcase` 里、且按 OS 而非按卷选择，这是我们要避免的耦合（草案已拆成两轴）。

### Apple

#### 源码快照

<!-- prettier-ignore -->
| 简称 | 仓库与标签 | 备注 |
| --- | --- | --- |
| XNU | `apple-oss-distributions/xnu` 标签 `xnu-12377.121.6`（提交 `ac9718fb1af618d5ce8678d0dc6e8a58f252216f`，提交日期 2026-06-17） | 对应哪个 macOS 发行版源码里没写，未验证 |
| HFS | `apple-oss-distributions/hfs` 标签 `hfs-715.120.4` | HFS+ 内核实现 |
| SMBClient | `apple-oss-distributions/SMBClient` 标签 `SMBClient-538.121.1` | macOS SMB 客户端内核实现 |
| NFS | `apple-oss-distributions/NFS` 标签 `NFS-343.100.5` | macOS NFS 客户端内核实现 |
| msdosfs | `apple-oss-distributions/msdosfs` 标签 `msdosfs-788.100.31` | 只含 FAT，**不含 exFAT**（仓库树里没有 exfat 文件） |
| APFS 内核实现 | 无公开源码（`apple-oss-distributions/apfs` 返回 404；FAQ 原文写“An open source implementation is not available at this time”） | 所以 APFS 的 `pathconf` 返回值只能实机验证 |

#### B.1 逐问回答

格式：结论｜来源｜访问日期 2026-10-18｜证据类型｜验证状态。每条后面括号里写调研员实际读到的关键句或函数位置。

**问 1：`pathconf(_PC_CASE_SENSITIVE)` 的语义与适用范围（对路径还是对文件系统；适用哪些位置）**

1.1 `_PC_CASE_SENSITIVE`（值 11）与 `_PC_CASE_PRESERVING`（值 12）在 XNU 头文件里有定义。｜https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/unistd.h ｜2026-10-18｜项目源码（xnu 标签 xnu-12377.121.6，`bsd/sys/unistd.h` 第 154–155 行）｜已验证。（原文：`#define _PC_CASE_SENSITIVE               11`、`#define _PC_CASE_PRESERVING              12`）

1.2 Apple 随 Xcode 发布的 `pathconf(2)` man 页**没有**列出 `_PC_CASE_SENSITIVE`，只列到 `_PC_LINK_MAX … _PC_VDISABLE`、`_PC_FILESIZEBITS`、`_PC_XATTR_SIZE_BITS`、`_PC_MIN_HOLE_SIZE`；也就是说这个选择子在官方 man 页里是**无文档**的，只存在于头文件与内核源码。｜官方归档版 https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/pathconf.2.html （对 `_PC_CASE` 的 grep 为 0 命中）；新版（社区镜像，降级）https://keith.github.io/xcode-man-pages/pathconf.2.html （Xcode 27.2 beta 3，同样 0 命中）｜2026-10-18｜官方文档（归档版）+ 社区镜像佐证｜已验证（“man 页未收录”这一事实）。

1.3 语义：对**文件系统**而非对单个文件或目录；内核把 `pathconf(path, name)` 解析成该路径的 vnode，再交给文件系统自己的 `VNOP_PATHCONF`。｜https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_syscalls.c （`pathconf()`：`NDINIT(&nd, LOOKUP, OP_PATHCONF, FOLLOW | AUDITVNPATH1…)` 后 `vn_pathconf(nd.ni_vp, …)`，注释“all other constants are per-FS implementation, and therefore must be handled in each respective FS”）；https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_vnops.c （`vn_pathconf` 的 `default:` 分支调 `VNOP_PATHCONF`）｜2026-10-18｜项目源码｜已验证。

1.4 路径版与句柄版等价：`fpathconf(fd, name)` 对 `DTYPE_VNODE` 的描述符同样调用 `vn_pathconf`。｜https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/kern/kern_descrip.c 第 5948–5953 行（`case DTYPE_VNODE: … vn_pathconf(vp, uap->name, retval, vfs_context_current())`）｜2026-10-18｜项目源码｜已验证。路径版会跟随符号链接（`FOLLOW`），句柄版是对已打开对象。

1.5 内核自己的使用与失败默认：重命名路径里用 `VNOP_PATHCONF(…, _PC_CASE_SENSITIVE, …)`，“Assume that the target file system is case sensitive if \_PC_CASE_SENSITIVE selector isn't supported.”，即选择子不支持时内核按“区分大小写”假设；返回值约定为 0 表示不区分、非 0 表示区分（`if (err != 0 || pval != 0) { error = EEXIST; …}` 在“目标文件系统不区分大小写”的分支里）。｜https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_syscalls.c 第 9650–9670 行与第 9773–9778 行｜2026-10-18｜项目源码｜已验证。对本项目的含义：失败时内核的默认是“区分”，但我们的草案已规定失败时进入行为探测、最终 `Unknown`（不折叠），两者效果一致。

1.6 各文件系统的实现与返回值：

- HFS+：`*ap->a_retval = (hfs_flags & HFS_CASE_SENSITIVE) ? 1 : 0`；`_PC_CASE_PRESERVING` 恒为 1。｜hfs 标签 hfs-715.120.4 `core/hfs_vnops.c` 第 6143–6151 行｜项目源码｜已验证。
- FAT（msdosfs，**不是 exFAT**）：`_PC_CASE_SENSITIVE` 恒 0，`_PC_CASE_PRESERVING` 恒 1。｜msdosfs 标签 msdosfs-788.100.31 `msdosfs_vnops.c` 第 2489–2494 行｜项目源码｜已验证（仅限 FAT）。
- SMB：见总表⑥（固定 0，除非 AAPL 服务器声明区分大小写）。｜SMBClient 标签 `kernel/smbfs/smbfs_vnops.c` 第 9740–9763 行，原文注释：“Thought about using FILE_CASE_SENSITIVE_SEARCH, but this really just means they will search by case. It does not mean this is a case sensitive file system.”｜项目源码｜已验证。
- NFS：见总表⑦（v2 `EINVAL`；v3 `PATHCONF` RPC；v4 属性）。RFC 1813 对字段的定义：“case_insensitive: If TRUE, the server file system does not distinguish case when interpreting filenames.”｜https://www.rfc-editor.org/rfc/rfc1813.txt（curl 后 grep 得到）｜标准文档（RFC）+ 项目源码｜已验证。
- APFS：内核实现不公开，返回值无法从源码确认。｜见本文件开头“APFS 内核实现”行｜—｜**未验证**（验证方式：M-19 第 1、2 项实机，记录 `fpathconf` 返回值）。
- exFAT：同上，Apple 的 exFAT 驱动不公开。｜msdosfs 仓库树无 exfat｜—｜**未验证**（验证方式：M-19 第 4 项）。

  1.7 第三方佐证：Emacs 的 `file_name_case_insensitive_err` 在 macOS 上用 `pathconf (filename, _PC_CASE_SENSITIVE)`，`res >= 0` 时按 `res == 0` 判不区分；若 `errno != EINVAL` 则返回“无法判定”，`EINVAL` 时按平台默认（macOS 为区分）；注释写“macOS is the only platform known to support the latter”，并承认 FIXME：“Mounted filesystems on Posix hosts, like Samba shares or NFS-mounted Windows volumes, might be case-insensitive. Can we detect this?”｜https://raw.githubusercontent.com/emacs-mirror/emacs/master/src/fileio.c （镜像提交 `5248340c9803ca7a052e356c7e4c67d7bfece0d2`，`file_name_case_insensitive_err`）｜2026-10-18｜项目源码（Emacs，镜像仓库）｜部分验证（证明有生产软件按此约定使用；不证明 APFS 的返回值）。

**问 2：`getattrlist` 的 `ATTR_VOL_CAPABILITIES` 与 `VOL_CAP_FMT_CASE_SENSITIVE`**

2.1 定义与语义。｜https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html ｜2026-10-18｜官方文档（归档版）｜已验证。关键句：“VOL_CAP_FMT_CASE_SENSITIVE If this bit is set the volume format treats upper and lower case characters in file and directory names as different. Otherwise an upper case character is equivalent to a lower case character, and you can't have two names that differ solely in the case of the characters.”；常量值 `VOL_CAP_FMT_CASE_SENSITIVE 0x00000100`、`ATTR_VOL_CAPABILITIES 0x00020000`、`ATTR_VOL_INFO 0x80000000`。｜XNU `bsd/sys/attr.h` 第 282、511 行及 libc crate 同值｜项目源码｜已验证。

2.2 必须检查 `valid` 位：man 页：“The valid field contains bit sets that indicate which flags are known to the volume format implementation. Each bit indicates whether the contents of the corresponding bit in the capabilities field is valid.”；NFS 实现里确实只在服务器给出属性时才把 `valid |= VOL_CAP_FMT_CASE_SENSITIVE`，所以 `capabilities` 位为 0 但 `valid` 位也为 0 时，不能解读为“不区分”。｜官方归档 man 页（同 2.1）；https://raw.githubusercontent.com/apple-oss-distributions/NFS/NFS-343.100.5/kext/nfs_vfsops.c 第 911–915 行｜官方文档+项目源码｜已验证。

2.3 调用要求：卷属性必须同时置位 `ATTR_VOL_INFO`，不能与文件/目录属性混用。｜man 页：“You must set ATTR_VOL_INFO in the volattr field if you request any other volume attributes.”；XNU `vfs_attrlist.c` 第 3361–3371 行（混用返回 `EINVAL`）｜官方文档+项目源码｜已验证。

2.4 **文档与源码冲突（需记录）**：man 页错误列表写“[EINVAL] You requested volume attributes but path does not reference the root of the volume.”，但 XNU `getvolattrlist()` 写的是：“If we do not have root vnode, look it up and substitute it in”（`if (!vnode_isvroot(vp)) { … error = VFS_ROOT(mnt, &root_vp, ctx); … vp = root_vp; }`），即对非卷根路径会替换为所在挂载的根。采信源码（xnu-12377.121.6，较新）；man 页的这一条可能是历史遗留，且旧系统是否同样替换**未验证**。因此“路径不是卷根”不应成为不能用 `getattrlist` 的理由，但为稳妥可在失败时降级。｜官方归档 man 页第 990 行；`bsd/vfs/vfs_attrlist.c` 第 1044–1058 行｜官方文档 vs 项目源码｜部分验证（旧版本行为未验证，验证方式：在最低支持的 macOS 上对子目录调用）。

2.5 HFS+ 的 `getattrlist` 路径：`(hfsmp->hfs_flags & HFS_CASE_SENSITIVE ? VOL_CAP_FMT_CASE_SENSITIVE : 0) | VOL_CAP_FMT_CASE_PRESERVING | …`。｜hfs 标签 `core/hfs_vfsops.c` 第 4124–4125 行｜项目源码｜已验证。

2.6 另外 `statfs` 的 `f_fssubtype` 对 HFS+ 带 `HFS_SUBTYPE_CASESENSITIVE`。｜`core/hfs_vfsops.c` 第 2257–2259 行｜项目源码｜已验证（仅 HFS+）。

**问 3：APFS 的规范化行为（“保留但不敏感”）与大小写变体**

3.1 官方原文：“APFS accepts only valid UTF-8 encoded filenames for creation, and preserves both case and normalization of the filename on disk in all variants. APFS, like HFS+, is case-sensitive on iOS and is available in case-sensitive and case-insensitive variants on macOS, with case-insensitive being the default.”｜https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html （页面标注 Updated: 2018）｜2026-10-18｜官方文档（归档版）｜已验证。

3.2 官方原文：“In macOS High Sierra, APFS is normalization-insensitive in both the case-insensitive and case-sensitive variants, using a hash-based native normalization scheme.” 以及“Being normalization-insensitive ensures that normalization variants of a filename cannot be created in the same directory, and that a filename can be found with any of its normalization variants.” 还有“APFS preserves the normalization of the filename and uses hashes of the normalized form of the filename to provide normalization insensitivity, whereas HFS+ stores the normalized form of the filename on disk”。｜同上｜官方文档（归档版）｜已验证（针对 macOS High Sierra 及以后；该页同时说 iOS 10.3 与 macOS Sierra 的区分大小写开发者预览是“normalization-sensitive”，那是历史版本，本项目不需要考虑）。

3.3 APFS 的大小写折叠规则：“APFS implements normalization and case insensitivity according to the Unicode 9.0 standard; this enables APFS to support a wider range of languages for these features than HFS+, which is based on Unicode 3.2.” 官方没有发布 APFS 的折叠表，也没有说明是 simple 还是 full case folding。｜同上｜官方文档（归档版）｜部分验证（只确认了 Unicode 9.0 这一版本号；折叠类型未验证）。

3.4 APFS 磁盘格式里的两个标志：`APFS_INCOMPAT_CASE_INSENSITIVE 0x00000001LL`（“Filenames on this volume are case insensitive.”）与 `APFS_INCOMPAT_NORMALIZATION_INSENSITIVE 0x00000008LL`（“Filenames on this volume are normalization insensitive. Normalization insensitivity is part of hashing filenames…”）；目录项的名字哈希：“Normalize the string using canonical decomposition (NFD). Represent the normalized filename as a null-terminated UTF-32 string. Compute the CRC-32C hash…”。两个标志都在卷超级块字段 `apfs_incompatible_features`（“A bit field of the backward-incompatible features being used by this volume.”）里，**是卷级属性**。｜https://developer.apple.com/support/downloads/Apple-File-System-Reference.pdf （2020-06-22 版，`pdftotext` 后 grep；第 68–69 页与 `j_drec_hashed_key_t` 一节）｜2026-10-18｜官方文档｜已验证。

3.5 APFS 引用里“case”一词仅出现在上述卷级标志处（对该 PDF 文本 grep `case` 只有 `APFS_INCOMPAT_CASE_INSENSITIVE` 相关行与一处枚举措辞），没有 inode、目录项或文件夹级的大小写标志。｜同 3.4｜官方文档｜已验证（“未发现”类结论，限于本版 2020-06-22 引用）。

3.6 公开 API 里**没有**规范化敏感性的查询接口：XNU 的 `attr.h`、`unistd.h`、`mount.h` 对 `normaliz|unicode|NFD|NFC` 的 grep 无命中，`VOL_CAP_FMT_*` 列表里也没有对应位。｜xnu 标签 xnu-12377.121.6｜项目源码（“未发现”类结论）｜已验证（限本标签的这三个头文件）。所以规范化轴只能按文件系统类型表判定（apfs/hfs → `Yes`），或做行为探测。

3.7 社区重新实现的佐证：linux-apfs-rw（GPL-2.0，内核驱动）的 `unicode.c` 注释写明表格“were built with data provided by the Unicode Standard, version 9.0”，并实现 NFD 后再折叠；其折叠表包含 `ß → ss`、`ﬃ → ffi`、`İ → i + U+0307`（full case folding 的 F 条目）。｜https://raw.githubusercontent.com/linux-apfs/linux-apfs-rw/master/unicode.c （镜像提交 `03187127cd2e62cf78321cdb942eb3a7b17981f9`；函数 `apfs_normalize_char`）｜2026-10-18｜项目源码（社区重新实现，非 Apple）｜**社区讨论（降级，需另有佐证）**，部分验证：说明社区认为 APFS 用 full folding，但没有 Apple 原文，真实 APFS 是否把 `ß` 与 `ss` 视为同名**未验证**。

**问 4：HFS+ 强制 NFD 的描述**

4.1 官方原文：“HFS Plus stores strings fully decomposed and in canonical order. HFS Plus compares strings in a case-insensitive fashion.”；“HFS Plus defines that Unicode strings will be stored in fully decomposed form, with composing characters stored in canonical order. The other equivalent forms are illegal in HFS Plus strings. An implementation must convert these equivalent forms to the fully decomposed form before storing the string on disk.”；分解基于 Unicode 3.2（“Mac OS X version 10.3 and later use decompositions based on Unicode 3.2”）。｜https://developer.apple.com/library/archive/technotes/tn/tn1150.html （TN1150 HFS Plus Volume Format；`curl` 后 grep）｜2026-10-18｜官方文档（技术说明，归档版）｜已验证。

4.2 例外：U+2000–U+2FFF 与 U+F900–U+FAFF（CJK 兼容表意文字）**不分解**。原文：“The characters with codes in the range u+2000 through u+2FFF are punctuation, symbols, dingbats, arrows, box drawing, etc. … they are left unchanged in HFS Plus strings.” 这意味着 KELVIN SIGN（U+212A）在 HFS+ 上不被分解成 `K`（和标准 NFD 不同）。｜同上｜官方文档｜已验证；Kelvin 的具体后果用 `vfs_utfconvdata.h` 的可分解位图在 对应小节的“D. 向量判定”核算。

4.3 内核实现：构造目录键时 `utf8_flags |= UTF_DECOMPOSED` 调用 `utf8_decodestr`，不区分大小写与否都执行。｜hfs 标签 `core/hfs_catalog.c` `buildkey()` 第 3517–3540 行｜项目源码｜已验证。

4.4 HFS+ 区分大小写（HFSX）：“A case-sensitive HFSX volume … simply compares each character of the name as an unsigned 16-bit integer.”；“Case sensitivity (or lack thereof) is global to the volume”；“To determine whether an HFSX volume is case-sensitive, use the keyCompareType field of the B-tree header of the catalog file.” 以及“Do not assume that an HFSX volume is case-sensitive.”（HFSX 卷也可以是不区分大小写的）。｜TN1150（同上）｜官方文档｜已验证。

4.5 HFS+ 的折叠表：不是标准 Unicode 折叠，是 Apple 自定义表 `gLowerCaseTable` 与 `gLatinCaseFold`；规则“All ignorable characters are folded to the value zero”（折叠为 0 的字符在比较时被跳过）。｜TN1150（“The lower case table starts with 256 entries …”）；hfs 标签 `core/UCStringCompareData.h`、`core/UnicodeWrappers.c` 的 `FastUnicodeCompare`（基本拉丁字符 `< 0x0100` 先查 `gLatinCaseFold`，其余查 `gLowerCaseTable`）｜官方文档+项目源码｜已验证。用这些表核算的向量结果见 对应小节的“D. 向量判定”。

**问 5：是否有按目录的属性**

5.1 macOS 没有按目录的大小写属性：`pathconf` 在 HFS+ 上读的是卷标志（`VTOHFS(vp)->hfs_flags`），APFS 的标志在卷超级块（问 3.4、3.5），XNU 头文件里没有目录级选择子。｜hfs `hfs_vnops.c` 第 6143–6148 行；APFS 引用 PDF；`unistd.h`｜项目源码+官方文档｜已验证（“未发现”类结论）。

5.2 对“嵌套挂载点”的含义：项目根下面的某个子目录可以是另一个卷的挂载点（例如 `mount -t nfs` 到项目子目录，或另一个 APFS 卷挂到项目下），大小写属性随之不同；这与草案 4.7.2.4 的已知限制一致。可通过比较 `fstatfs` 的 `f_fsid` 或 `stat.st_dev` 发现跨设备。｜`statfs(2)` man 页：https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html （`f_fsid`、`f_mntonname`：“directory on which mounted”）｜官方文档+推断｜部分验证。

#### B.2 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/pathconf.2.html | 2026-10-18 | 官方文档（归档） | 选择子列表 `_PC_LINK_MAX` … `_PC_VDISABLE`，无 `_PC_CASE_SENSITIVE` |
| https://keith.github.io/xcode-man-pages/pathconf.2.html | 2026-10-18 | 社区讨论（降级；Xcode 27.2 beta 3 随附 man 页的转换） | 同上，另含 `_PC_FILESIZEBITS`、`_PC_XATTR_SIZE_BITS`、`_PC_MIN_HOLE_SIZE`，仍无 `_PC_CASE_SENSITIVE` |
| https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/unistd.h | 2026-10-18 | 项目源码（xnu-12377.121.6） | 第 154–155 行 `_PC_CASE_SENSITIVE 11`、`_PC_CASE_PRESERVING 12` |
| https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_syscalls.c | 2026-10-18 | 项目源码（同标签） | `pathconf()`（`FOLLOW`，转 `vn_pathconf`）；第 9650–9670、9773–9778 行内核自用与“选择子不支持则假设区分大小写”注释 |
| https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_vnops.c | 2026-10-18 | 项目源码（同标签） | 第 1925 行起 `vn_pathconf`：未特殊处理的选择子转 `VNOP_PATHCONF` |
| https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/kern/kern_descrip.c | 2026-10-18 | 项目源码（同标签） | 第 5948–5953 行 `fpathconf` 的 `DTYPE_VNODE` 分支 |
| https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/attr.h | 2026-10-18 | 项目源码（同标签） | 第 186–196 行注释与第 282–283 行 `VOL_CAP_FMT_CASE_SENSITIVE 0x00000100`、`VOL_CAP_FMT_CASE_PRESERVING 0x00000200`；第 259–262 行 `VOL_CAP_FMT_VOL_GROUPS` |
| https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_attrlist.c | 2026-10-18 | 项目源码（同标签） | `getvolattrlist()` 第 992 行起；第 1044–1058 行“If we do not have root vnode, look it up and substitute it in” |
| https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html | 2026-10-18 | 官方文档（归档） | `VOL_CAP_FMT_CASE_SENSITIVE` 定义；`valid` 字段语义；错误项“path does not reference the root of the volume” |
| https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html | 2026-10-18 | 官方文档（归档） | `struct statfs` 的 `f_fssubtype`、`f_fstypename`、`f_mntonname` |
| https://keith.github.io/xcode-man-pages/getattrlist.2.html 与 statfs.2.html | 2026-10-18 | 社区讨论（降级） | 较新版文本：`getattrlistat`、`FSOPT_RESOLVE_BENEATH` 等；“fgetattrlist() works on the provided file descriptor fd” |
| https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vnops.c | 2026-10-18 | 项目源码（hfs-715.120.4） | 第 6143–6151 行 `hfs_vnop_pathconf` |
| https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vfsops.c、https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vfsutils.c、https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_catalog.c | 2026-10-18 | 项目源码（同标签） | `hfs_vfsops.c` 第 4124–4125 行；`hfs_vfsutils.c` 第 452–453 行；`hfs_catalog.c` `buildkey()` |
| https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/UCStringCompareData.h、https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/UnicodeWrappers.c | 2026-10-18 | 项目源码（同标签） | `gLowerCaseTable`、`gLatinCaseFold`、`FastUnicodeCompare`、`UnicodeBinaryCompare` |
| https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_utfconv.c 与 vfs_utfconvdata.h | 2026-10-18 | 项目源码（同标签） | “Includes Unicode 3.2 decomposition code derived from Core Foundation”；`unicode_decomposeable()` 位图 |
| https://developer.apple.com/library/archive/technotes/tn/tn1150.html | 2026-10-18 | 官方文档（技术说明，归档） | 见问 4.1–4.5 引文 |
| https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html | 2026-10-18 | 官方文档（归档，Updated: 2018） | 见问 3.1–3.3 引文 |
| https://developer.apple.com/support/downloads/Apple-File-System-Reference.pdf | 2026-10-18 | 官方文档（2020-06-22 版） | `APFS_INCOMPAT_CASE_INSENSITIVE`、`APFS_INCOMPAT_NORMALIZATION_INSENSITIVE`；`name_len_and_hash` 的 NFD 步骤；`apfs_volume_group_id`；`FIRMLINK_EA_NAME` |
| https://raw.githubusercontent.com/apple-oss-distributions/SMBClient/SMBClient-538.121.1/kernel/smbfs/smbfs_vnops.c 、smbfs_vfsops.c 、netsmb/smb_smb_2.c 、netsmb/smb_converter.c | 2026-10-18 | 项目源码（SMBClient-538.121.1） | 见总表⑥；`smb_convert_to_network` 总置 `UTF_PRECOMPOSED`，`smb_convert_from_network` 总置 `UTF_DECOMPOSED` |
| https://raw.githubusercontent.com/apple-oss-distributions/NFS/NFS-343.100.5/kext/nfs_vnops.c 、nfs_vfsops.c 、nfs_subs.c | 2026-10-18 | 项目源码（NFS-343.100.5） | 见总表⑦；`nfsm_chain_add_string_nfc` 用 `UTF_PRECOMPOSED`，仅在 `NFS_MFLAG_NFC` 时使用 |
| https://keith.github.io/xcode-man-pages/mount_nfs.8.html | 2026-10-18 | 社区讨论（降级） | “nfc: Convert name strings to Unicode Normalization Form C (NFC) when sending them to the NFS server.” |
| https://raw.githubusercontent.com/apple-oss-distributions/msdosfs/msdosfs-788.100.31/msdosfs.kextproj/msdosfs.kmodproj/msdosfs_lookup.c 、msdosfs_vnops.c | 2026-10-18 | 项目源码（msdosfs-788.100.31） | lookup 把输入 UTF-8 解码为 `UTF_PRECOMPOSED`；读目录时编码为 `UTF_DECOMPOSED`（仅 FAT） |
| https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification | 2026-10-18 | 标准文档（Microsoft 规范） | “the exFAT file system being case insensitive and case preserving”；“The Up-case Table defines the conversion from lower-case to upper-case characters” |
| https://www.rfc-editor.org/rfc/rfc1813.txt | 2026-10-18 | 标准文档（RFC） | PATHCONF3resok 的 `case_insensitive`、`case_preserving` |
| https://raw.githubusercontent.com/linux-apfs/linux-apfs-rw/master/unicode.c | 2026-10-18 | 社区项目源码（降级） | “built with data provided by the Unicode Standard, version 9.0”；`apfs_normalize_char` |
| https://arxiv.org/pdf/2211.16735 （Unsafe at Any Copy） | 2026-10-18 | 社区讨论（学术论文，降级） | “`temp_200K' (where K = Kelvin Sign, U+212A in UTF-8) and `temp_200k' are considered identical on NTFS and APFS, but on ZFS … different” |
| https://raw.githubusercontent.com/emacs-mirror/emacs/master/src/fileio.c | 2026-10-18 | 项目源码（Emacs 镜像） | `file_name_case_insensitive_err` 对 macOS 使用 `pathconf (…, _PC_CASE_SENSITIVE)` |
| https://keith.github.io/xcode-man-pages/diskutil.8.html 、synthetic.conf.5.html | 2026-10-18 | 社区讨论（降级） | diskutil：“you should specify APFS or Case-sensitive APFS”；“Volumes … of any particular APFS Volume Group must all be on the same” 容器；synthetic.conf：“All writeable paths must reside on the data volume, which is mounted at /System/Volumes/Data.” |

#### B.3 对本项目的启示

- macOS 上“按卷判定”完全可行且应以**句柄**为单位（`fpathconf`/`fgetattrlist`/`fstatfs` 都接受 `fd`），APFS 之外的位置（SMB、NFS、exFAT、FUSE）API 值要么不可信要么可能失败，必须有行为探测兜底；对 `smbfs` 应直接不采信 API。
- APFS 的“折叠函数”只有 Unicode 9.0 这一条官方信息，是否 full folding 要实机确认；折叠函数继续按“近似、靠文件身份兜底”处理，且 HFS+（Unicode 3.2、自定义表）与 APFS（Unicode 9.0）折叠结果不同（见 对应小节的“D. 向量判定”，`ß`/`ss`、`K` Kelvin、Cherokee、`ς` 都有差异），因此折叠键**必须按位置类型取不同折叠策略，或者保守地只折叠 ASCII**。

#### E.1 “精确到项目所在卷”的做法

1. **路径还是句柄**：三个系统调用都有句柄版：`fpathconf`（`kern_descrip.c` 第 5948–5953 行转 `vn_pathconf`）、`fgetattrlist`（man 页：“fgetattrlist() works on the provided file descriptor fd”；`getattrlistat` 还允许 `fd` 加相对路径）、`fstatfs`（`statfs(2)`：“The fstatfs() routine returns the same information about an open file referenced by descriptor fd.”）。因此可以在已经用 `cap_std::fs::Dir` 打开的项目根上直接查询，避免路径被替换（TOCTOU）且与草案“父目录句柄 + 名称”一致。路径版 `pathconf` 会跟随符号链接（`FOLLOW`），句柄版则对应已打开对象；若项目根本身是符号链接，要先决定查询“链接所在卷”还是“目标所在卷”（本项目的项目根校验已规范化路径，应查目标）。｜来源：B.1 问 1.4、问 2；`statfs.2` 官方归档页｜官方文档+项目源码｜已验证。
2. **是否需要 `statfs` 取挂载点**：大小写位本身不需要（`pathconf`/`getvolattrlist` 内部自己找到所在挂载；XNU 对非卷根路径替换为所在挂载的根，见 B.1 问 2.4）。但 `fstatfs` 仍值得调用，用途：①`f_fstypename`（决定规范化轴与是否信任 API，例如 `smbfs` 不信、`apfs`/`hfs` 信）；②`f_mntonname` + `f_fsid` 作缓存键，让同一卷上的多个项目共享探测结果；③`f_flags & MNT_RDONLY` 判只读（只读则绝不创建临时文件）、`MNT_LOCAL` 判本地/网络；④`f_fssubtype` 对 HFS+ 带大小写位。｜`statfs(2)` 官方归档页（`MNT_RDONLY`、`MNT_LOCAL`、`f_fssubtype`、`f_fstypename`、`f_mntonname`）；`hfs_vfsops.c` 第 2257 行｜官方文档+项目源码｜已验证。
3. **APFS 卷组（Volume Group）与系统卷/数据卷**：macOS 10.15 起系统卷与数据卷组成卷组，二者共享同一个 `apfs_volume_group_id`（“Both volumes have the same value for the apfs_volume_group_id field”），内核头文件有 `VOL_CAP_FMT_VOL_GROUPS`（“this volume is part of a volume-group that implies multiple volumes must be mounted in order to boot and root the operating system. Typically, this means a read-only system volume and a writable data volume”）。可写路径都在数据卷：`synthetic.conf(5)`：“All writeable paths must reside on the data volume, which is mounted at /System/Volumes/Data.” 用户项目（`/Users/...`）因此位于数据卷，经 firmlink 暴露在根路径下（APFS 引用有 `FIRMLINK_EA_NAME "com.apple.fs.firmlink"`）。对判定的影响：**无需特殊处理**——只要对项目根的句柄查询，得到的就是数据卷的属性；不能拿系统卷（根 `/`）去推断。系统卷与数据卷是否必须大小写属性一致，官方文档未找到说明，**未验证**（不影响本设计，因为我们只查项目所在卷）。｜APFS 引用 PDF（`APFS_FEATURE_VOLGRP_SYSTEM_INO_SPACE`、`FIRMLINK_EA_NAME`）；`attr.h` 第 259–262 行；https://keith.github.io/xcode-man-pages/synthetic.conf.5.html（社区镜像，降级）｜官方文档+项目源码｜部分验证。
4. 同一容器多卷可不同：见总表②；因此**不能按物理磁盘/容器判定**。｜已验证。
5. 缓存键建议：`(f_fsid, f_mntonname)`；但 `f_fsid` 在重新挂载后可能变化，失效策略沿用草案（项目移除/路径修改/备份恢复/60 秒 `Unknown` 重试）。`f_fsid` 的稳定性**未验证**（`statfs(2)` 没有承诺）。

#### E.2 规范化轴

<!-- prettier-ignore -->
| 位置类型 | 规范化轴表现 | 出处 | 状态 |
| --- | --- | --- | --- |
| APFS（两个变体） | 保留首次创建的规范化形式，但查找按 NFD 哈希，创建规范化变体会冲突（“normalization-insensitive”）；`normalization_insensitive = Yes` | APFS FAQ；APFS 引用（`name_len_and_hash` 的 NFD 步骤） | 已验证（High Sierra 及以后） |
| HFS+（含 HFSX） | 磁盘上存 NFD（Unicode 3.2 分解，U+2000–U+2FFF 与 U+F900–U+FAFF 例外）；查找前先转 NFD；`Yes` | TN1150；`hfs_catalog.c buildkey` | 已验证 |
| FAT（msdosfs，仅供参考） | 磁盘存预组合（输入名按 `UTF_PRECOMPOSED` 解码），读目录时按 `UTF_DECOMPOSED` 编码给上层；因此应用层 NFC/NFD 两种写法指向同一项 | msdosfs `msdosfs_lookup.c` 第 233、585 行 | 已验证（**只限 FAT**，不能推广到 exFAT） |
| exFAT | exFAT 规范只定义 Up-case Table，没有规范化规则；macOS 驱动闭源 | 规范；msdosfs 仓库无 exfat | 规范层**已验证**“无规范化”；macOS 驱动行为**未验证**（UM-7） |
| SMB（macOS 客户端） | 客户端对发往服务器的文件名**总是**转 NFC（`smb_convert_to_network` 注释“We always set the precomposed flag”），收到的名字**总是**转 NFD（`smb_convert_from_network` “We always set the decomposed flag”）；所以在这个客户端上，应用传 NFC 或 NFD 都发出同一个 NFC 名；服务器侧是否把 NFC/NFD 当同名取决于服务器 | `smb_converter.c` 第 262–302、340–366 行 | 客户端行为已验证；服务器端未验证。判定建议：规范化轴按客户端视角记 `Yes`，但存在服务器上以 NFD 形式存储的文件名无法用 NFC 形式访问的风险，**未验证**（UM-8） |
| NFS（macOS 客户端） | 默认不做规范化；仅挂载选项 `nfc` 时把发往服务器的名字转 NFC（`nfsm_chain_add_string_nfc` 用 `UTF_PRECOMPOSED`，受 `NFS_MFLAG_NFC` 控制）；所以默认下 NFC 与 NFD 是服务器上的两个不同名字，规范化轴 `No`（取决于服务器） | `nfs_subs.c` 第 859–871 行；`mount_nfs(8)`：“nfc … Convert name strings to Unicode Normalization Form C (NFC) when sending them to the NFS server”；`nfs_vnops.c` 里没有 `UTF_` 标志的使用 | 部分验证（未发现默认规范化的代码路径，属“未发现”类结论；服务器行为未验证） |

#### E.3 `pathconf(_PC_CASE_SENSITIVE)` 对路径还是对文件系统；FUSE/第三方挂载

- 对文件系统（卷）：见 B.1 问 1.3、5.1。HFS+ 用卷标志；SMB 用共享会话；NFS 用服务器 PATHCONF 结果，对非“homogeneous”的服务器按每个节点各发一次 RPC（`nfs_vnop_pathconf`：`if (!(nmp->nm_state & NFSSTA_GOTPATHCONF) || (!(nmp->nm_fsattr.nfsa_flags & NFS_FSFLAG_HOMOGENEOUS) && nmp->nm_dnp != np))` 才发 `nfs3_pathconf_rpc`）。网络文件系统上这是网络 IO，必须走带预算的阻塞包装。｜来源：NFS `nfs_vnops.c` 第 7735–7790 行｜项目源码｜已验证。
- FUSE/macFUSE：macFUSE 用户态库定义了 `FUSE_CAP_CASE_INSENSITIVE (1 << 29)`，文件系统在 `init` 里设置后，`fuse_lowlevel.c` 把 `FUSE_CASE_INSENSITIVE` 放进回复标志，所以第三方文件系统**自己声明**是否不区分大小写；默认不声明即当作区分。内核扩展（决定 `pathconf`/`getattrlist` 如何把该声明反映给上层）不在公开仓库（`macfuse/macfuse` 仓库顶层仅 `Framework`、`Library-2`、`Library-3`、`Mount`），所以 `pathconf` 对 FUSE 卷是否返回此声明**未验证**。｜https://raw.githubusercontent.com/macfuse/library/master/include/fuse_common.h 第 181、281 行；…/lib/fuse_lowlevel.c 第 2002–2003、2100–2101 行（库提交 `7a6cdd2b6e11071a706f4295aa931c65223ba953`，2024-11-27）｜项目源码（macFUSE 用户态库）｜部分验证（用户态声明已验证，内核侧返回未验证）。规范化轴对 FUSE 完全由用户态文件系统决定，**未验证**。
- FSKit（macOS 15.4 起的用户态文件系统扩展框架）：官方文档有 `FSVolume.CaseFormat`（“An enumeration of case-sensitivity support types.”，macOS 15.4+），模块自己声明；内核如何反映到 `pathconf` **未验证**。｜https://developer.apple.com/tutorials/data/documentation/fskit/fsvolume/caseformat.json （Apple 文档站数据）｜官方文档｜部分验证。
- iCloud Drive 等 File Provider 位置（`~/Library/CloudStorage/...`）：本机宿主卷是 APFS，`pathconf` 反映宿主卷而非远端服务；File Provider 对远端的大小写语义是否与宿主卷一致，未找到官方说明，**未验证**（UM-10）。

#### E.4 行为探测副作用在 macOS 上的已知经验

- **FSEvents**：内核在创建与删除路径上调用 `add_fsevent(FSE_CREATE_FILE, …)`、`add_fsevent(FSE_DELETE, …)`，`need_fsevent()` 只在“没有订阅者”或“`VT_DEVFS`”时返回 0；所以临时文件的创建与删除，会被任何订阅了该目录层级的 FSEvents 客户端（IDE、构建工具、Watchman 类监听器、备份软件）看到。官方指南对这套 API 的定义：“ask for notification when the contents of a directory hierarchy are modified”，且“a backup application can use this to determine what files have changed”。｜https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_syscalls.c （第 6088、6144、6569、6672 行）、https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_fsevents.c （第 320–330 行 `need_fsevent`）；https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/Introduction/Introduction.html ｜项目源码+官方文档｜已验证。
- 只读 lookup（对已有条目翻转大小写后 `symlink_metadata`/`lstat`）不经过上述创建/删除路径，因此推断不会产生 FSEvents 的创建/删除事件；该推断没有逐一核对 `lstat` 对 atime 或其他事件的影响，标推断。｜推断｜未验证。
- **Spotlight 索引**、**Time Machine 备份**、**iCloud/File Provider 同步**对“创建后立即删除的小文件”的影响：本次没有找到官方文档或源码级来源。可以确定的只是事件会产生；是否被索引、备份或上传取决于守护进程的合并延迟与目录排除规则，**未验证**（UM-5）。
- **Emacs 的做法**：不创建文件，直接用 `pathconf`；说明“只读 API 优先、不碰磁盘”是社区已有做法（来源见 B.1 问 1.7）。
- 其他降低副作用的 macOS 特有手段（`.metadata_never_index`、Time Machine 排除属性等）是调研员检索时联想到的，**未查到来源，不写入结论**。

#### E.5 用 Rust 调用：`libc` crate 暴露情况

核对对象：`src-tauri/Cargo.lock` 中 `libc` 版本 `0.2.186`（第 2313–2314 行），本机源码 `C:/Users/skyji/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/libc-0.2.186/`；许可证 `MIT OR Apache-2.0`（该 crate 的 `Cargo.toml` 第 44 行）；本项目依赖声明：`[target.'cfg(unix)'.dependencies] libc = "0.2"`（`src-tauri/Cargo.toml` 第 45–46 行），macOS 属 unix，所以不需要改依赖也不需要新增 feature。｜项目源码（本仓库与 crates.io 源码）｜已验证（符号存在性）。

<!-- prettier-ignore -->
| 符号 | 位置（相对 `libc-0.2.186/`） | 备注 |
| --- | --- | --- |
| `pathconf(path: *const c_char, name: c_int) -> c_long` | `src/unix/mod.rs` 第 1092 行 | 通用 unix 声明 |
| `fpathconf(filedes: c_int, name: c_int) -> c_long` | `src/unix/mod.rs` 第 1069 行 | 同上 |
| `_PC_CASE_SENSITIVE: c_int = 11`、`_PC_CASE_PRESERVING: c_int = 12` | `src/unix/bsd/apple/mod.rs` 第 1969–1970 行 | 只在 Apple 目标下存在，值与 XNU `unistd.h` 一致 |
| `getattrlist(path, attrList: *mut c_void, attrBuf: *mut c_void, attrBufSize: size_t, options: u32) -> c_int` | `src/unix/bsd/apple/mod.rs` 第 5048 行 | 参数用 `*mut c_void`，需自己传 `attrlist` |
| `fgetattrlist(fd, …)`、`getattrlistat(fd, path, …, options: c_ulong)` | 同文件第 5055、5062 行 | |
| `struct attrlist { bitmapcount: c_ushort, reserved: u16, commonattr, volattr, dirattr, fileattr, forkattr: attrgroup_t }` | 同文件第 1080–1088 行 | |
| `struct vol_capabilities_attr_t { capabilities, valid: vol_capabilities_set_t }`，`vol_capabilities_set_t = [u32; 4]` | 同文件第 1095–1098 行、第 176 行 | 注意 `getattrlist` 返回缓冲区首 4 字节是长度，再接 `vol_capabilities_attr_t`，需自己定义 `#[repr(C, packed(4))]` 缓冲区结构（libc 不提供该组合结构；这条是对 Apple man 页示例“aligned(4), packed”的推断） |
| `ATTR_BIT_MAP_COUNT: c_ushort = 5`、`ATTR_VOL_INFO = 0x80000000`、`ATTR_VOL_CAPABILITIES = 0x00020000`、`VOL_CAPABILITIES_FORMAT: usize = 0`、`VOL_CAP_FMT_CASE_SENSITIVE = 0x00000100`、`VOL_CAP_FMT_CASE_PRESERVING = 0x00000200`、`FSOPT_NOFOLLOW` 等 | 同文件第 4011、4072、4066、4100、4110–4111 行 | 值均与 XNU `attr.h` 一致 |
| `statfs`/`fstatfs`（x86_64 macOS 自动链接 `statfs$INODE64`/`fstatfs$INODE64`）、`struct statfs`（含 `f_fssubtype`、`f_fstypename: [c_char; 16]`、`f_mntonname: [c_char; 1024]`、`f_flags_ext`） | 同文件第 4557–4566 行、第 1335–1353 行 | |
| `MNT_LOCAL = 0x1000`、`MNT_DONTBROWSE`、`MNT_JOURNALED`；`MNT_RDONLY` | `src/unix/bsd/apple/mod.rs` 第 3751、3756、3759 行；`src/unix/bsd/mod.rs` 第 253 行 | |

缺口：libc 没有 `VOL_CAP_FMT_VOL_GROUPS`、`ATTR_VOL_FSTYPENAME` 这类本设计不需要的符号调研员没有逐个核对；`cargo check --target aarch64-apple-darwin` 在本机 Windows 上没有运行（需要安装目标且不应修改环境），所以“这些符号在本项目里编译通过”**未验证**，交 CI 的 macOS 任务验证。

#### D. 向量判定（APFS、HFS+）

约定：同名＝在该文件系统上两个名字指向同一目录项。状态缩写：V＝已验证，P＝部分验证，U＝未验证。

方法与依据：

- **HFS+ 两列**：用 Apple 开源的 `UCStringCompareData.h`（`gLowerCaseTable`、`gLatinCaseFold`，hfs-715.120.4）、`FastUnicodeCompare` 的查表规则，以及 XNU `vfs_utfconvdata.h` 的“可分解”位图（决定是否先做 NFD；可分解字符用 Python `unicodedata` NFD 替代 Apple 的 Unicode 3.2 分解表）自行写脚本（`scratchpad/pd10/macos-raw/hfsfold.py`）机械计算折叠键。结果是“源码表机械计算”，没有在真实 HFS+ 卷上跑过，所以统一标 P（来源完全是 Apple 官方源码，缺的是实机与分解表的 Unicode 版本差异）。区分大小写 HFS+ 的“不同名”依据 TN1150 的“compares each character of the name as an unsigned 16-bit integer”，而规范化轴同样先 NFD（`buildkey`）。
- **APFS 不敏感列**：官方只给出“Unicode 9.0 的大小写不敏感 + 规范化不敏感（NFD 哈希）”。具体折叠表来自社区重新实现 linux-apfs-rw（`apfsfold.py` 解析其 `apfs_nfd_trie`/`apfs_cf_trie` 表，结果与 Unicode 9.0 `CaseFolding.txt` 的 C+F 条目一致）。凡依赖折叠类型（simple 还是 full）的格子，调研员同时给出两种假设下的结果，标 P 或 U。
- **APFS 区分大小写列**：大小写轴不折叠（定义）；规范化轴仍折叠（官方 FAQ），所以只有“规范分解等价”的两个名字（第 7 组、第 11 组中的 Kelvin 与拉丁大写 `K`）同名。
- 本机观察不计入任何格子。

<!-- prettier-ignore -->
| # | 输入 | APFS 不敏感（默认） | APFS 区分大小写 | HFS+ 不敏感（日志式，默认） | HFS+ 区分大小写（HFSX） |
| --- | --- | --- | --- | --- | --- |
| 1 | `README` 与 `readme` | 折叠（同名）；V（官方 FAQ“case-insensitive variant”+ `getattrlist` 定义“an upper case character is equivalent to a lower case character”） | 不折叠（不同名）；V（官方定义） | 折叠；V（TN1150：“HFS Plus compares strings in a case-insensitive fashion”；`gLatinCaseFold` 将 `R`→`r` 等） | 不折叠；V（TN1150 二进制比较） |
| 2 | `Straße` 与 `STRASSE` | 若 full folding 则折叠，若 simple folding 则不折叠；社区实现 linux-apfs-rw 折叠（`ß→ss`）；**P（真实 APFS 未验证，见 UM-1）** | 不折叠；V | 不折叠；P（折叠键 `straße` ≠ `strasse`，`ß` 在 HFS+ 表里不折叠；源码表机械计算） | 不折叠；V |
| 3 | `ß`（U+00DF）与 `ẞ`（U+1E9E） | 折叠；P（Unicode 9.0 `CaseFolding.txt`：`1E9E; F; 0073 0073` 与 `1E9E; S; 00DF`，full 下两者都折叠为 `ss`，simple 下 `ẞ→ß`；两种假设都同名；依赖 Apple 使用 Unicode 的折叠数据，来源为官方“Unicode 9.0”+ 社区实现） | 不折叠；V | 不折叠；P（两者在 HFS+ 表里都不变；表基于早期 Unicode，U+1E9E 为 Unicode 5.1 新增字符） | 不折叠；V |
| 4 | `i` 与 `İ`（U+0130） | 不折叠；P（full 下 `İ→i + U+0307`≠`i`；simple 下 `İ` 无 C/S 折叠，保持不变≠`i`；两种假设都不同名） | 不折叠；V（NFD 后 `İ`=`I+U+0307`，与 `i` 仍不同） | 不折叠；P（`İ` 可分解为 `I + U+0307`，折叠键 `i + U+0307`≠`i`） | 不折叠；V |
| 5 | `I` 与 `ı`（U+0131） | 不折叠；P（`CaseFolding.txt` 对 U+0131 没有条目，`ı` 保持不变，`I→i`） | 不折叠；V | 不折叠；P（`I→i`，`ı` 不变） | 不折叠；V |
| 6 | `σ`、`ς`（U+03C2）与 `Σ` | 三者折叠为同名；P（Unicode 9.0 `CaseFolding.txt`：`03A3; C; 03C3`、`03C2; C; 03C3`） | 三者互不同名；V | `σ` 与 `Σ` 同名，**`ς` 与它们不同名**；P（HFS+ 表只把 `Σ→σ`，`ς` 不变；源码表机械计算） | 三者互不同名；V |
| 7 | `é`（U+00E9）与 `é`（e + U+0301） | 折叠（同名）；V（官方 FAQ：“a filename can be found with any of its normalization variants”） | 折叠（同名）；V（官方 FAQ：区分大小写变体同样规范化不敏感） | 折叠（同名）；V（TN1150：预组合形式“illegal”，必须先转 NFD；`buildkey` 用 `UTF_DECOMPOSED`） | 折叠（同名）；V（同上，规范化与大小写无关） |
| 8 | `É`（U+00C9）与 `é`（U+00E9） | 折叠；P（规范化后 `E+0301` 与 `e+0301`，大小写折叠后相同；官方说明仅到“Unicode 9.0”级别） | 不折叠；V | 折叠；P（`buildkey` 先 NFD，再 `E→e`；源码表机械计算） | 不折叠；V |
| 9 | `Ａ`（U+FF21 全角）与 `a`/`A` | 不折叠；P（`FF21` 折叠为全角小写 `FF41`，不会变成 ASCII；`CaseFolding.txt`：`FF21; C; FF41`；全角是兼容分解，规范分解不处理） | 不折叠；V | 不折叠；P（`gLowerCaseTable` 将 `FF21→FF41`，与 ASCII 不同） | 不折叠；V |
| 10 | `ǅ`（U+01C5）、`ǆ`（U+01C6）、`Ǆ`（U+01C4） | 三者同名；P（`CaseFolding.txt`：`01C5; C; 01C6`，`01C4; C; 01C6`） | 三者互不同名；V | 三者同名；P（表中三者都折叠为 `01C6`；源码表机械计算） | 三者互不同名；V |
| 11 | `K`（U+212A KELVIN SIGN）与 `k`/`K` | 与 `k` 和 `K` 都同名；P（Unicode `UnicodeData.txt` 9.0：`212A;KELVIN SIGN;Lu;0;L;004B`，规范分解成 `K`；再大小写折叠为 `k`；独立来源：linux-apfs-rw 的表与学术论文“considered identical on NTFS and APFS”） | 与 `K`（U+004B）同名（规范化不敏感）；与 `k` 不同名；P（官方 FAQ + APFS 引用的 NFD 步骤 + Unicode 数据；Kelvin 的单例规范分解推断为 APFS 的 NFD 所涵盖，实机未验证） | **不同名**（与 `k` 和 `K` 都不同）；P（TN1150：U+2000–U+2FFF 不分解，U+212A 不可分解且 `gLowerCaseTable` 不折叠它；`vfs_utfconvdata.h` 位图核算 `decomposable(212A)=False`） | 不同名；P（同上，且无折叠） |
| 12 | `ﬃ`（U+FB03）与 `ffi` | full folding 下同名，simple 下不同名；社区实现折叠（`FB03; F; 0066 0066 0069`）；**U（真实 APFS 未验证，见 UM-1）** | 不同名；V（连字只有兼容分解，不属于规范化轴） | 不同名；P（表中 U+FB03 不变，不可分解） | 不同名；V |
| 13 | Cherokee `Ꭰ`（U+13A0）与 `ꭰ`（U+AB70） | 折叠（同名）；P（Unicode 9.0 `CaseFolding.txt`：`AB70; C; 13A0`；Apple 声明按 Unicode 9.0；社区表同） | 不折叠；V | 不折叠；P（HFS+ 表基于早期 Unicode，无此映射；源码表机械计算） | 不折叠；V |

补充说明：

- 脚本输出可复现：`python -X utf8 -I scratchpad/pd10/macos-raw/hfsfold.py`（输出各向量折叠键与 SAME/DIFF）。
- 作为对照，**exFAT** 规范附带的推荐 Up-case Table（仅大小写，按 UTF-16 码元转大写，无规范化）按同样方法计算（`exfatup.py`）：第 1 组同名；第 2、3、4、5 组不同名；第 6 组三者同名；第 7 组不同名（exFAT 规范没有规范化）；第 8 组（`É` 与 `é`）同名；第 9 组不同名；第 10 组只有 `ǆ` 与 `Ǆ` 同名（`ǅ` 与另两者不同名，因为推荐表只做转大写，`ǅ` 自身不变）；第 11、12、13 组不同名。这是**规范推荐表**的结果，macOS 格式化出的 exFAT 卷用什么表、macOS 驱动是否规范化名字，**未验证**，仅供参考，exFAT 的权威向量应由 Microsoft、Linux 内核小节给出。

### Microsoft

#### B.1 逐问回答

**问 1：`GetVolumeInformationByHandleW` 的 `FILE_CASE_SENSITIVE_SEARCH`、`FILE_CASE_PRESERVED_NAMES` 标志含义。**

- `GetVolumeInformationByHandleW` 的文档：`FILE_CASE_SENSITIVE_SEARCH`=0x00000001“The specified volume supports case-sensitive file names.”；`FILE_CASE_PRESERVED_NAMES`=0x00000002“The specified volume supports preserved case of file names when it places a name on disk.”；`FILE_UNICODE_ON_DISK`=0x00000004“supports Unicode in file names as they appear on disk”。已验证（官方文档，curl 取得原文并 grep）。
- MS-FSCC 2.5.1 对前者的措辞更精确：“The file system supports case-sensitive file names when looking up (searching for) file names in a directory.”。已验证。含义是“文件系统有能力做区分大小写的查找”，**不是**“当前这个目录默认区分”。
- 哪些文件系统置位：MS-FSA 附录 A 的产品行为表（列 ReFS、NTFS、FAT、EXFAT、UDFS、CDFS）：`FILE_CASE_SENSITIVE_SEARCH` 在 ReFS、NTFS、UDFS、CDFS 为“Always Set”，在 FAT、EXFAT 为空（未置位）；`FILE_CASE_PRESERVED_NAMES` 在前五列为“Always Set”，CDFS 为空。已验证（调研员用 curl 取到 HTML 表格，逐单元格核对了列位置）。
- 为什么 NTFS 置位但默认目录仍不区分：Win32 层默认对路径做不区分大小写的处理，除非调用者传 `FILE_FLAG_POSIX_SEMANTICS`；而全局注册表项可让后者也失效。原文：Naming a File 页“Note that NTFS supports POSIX semantics for case sensitivity but this is not the default behavior.”；CreateFile 页 `FILE_FLAG_POSIX_SEMANTICS`“Access will occur according to POSIX rules. This includes allowing multiple files with names, differing only in case, for file systems that support that naming.”；WSL 团队博客“for compatibility reasons, there is a global registry key that overrides this behavior; when this key is set, all file operations are case insensitive, even when the FILE_FLAG_POSIX_SEMANTICS flag is specified. Since Windows XP, this has been the default.”。已验证（前两条官方文档，第三条为微软官方开发博客）。
- 本机只读观察（推断）：`C:\` 的 `GetVolumeInformationW` 返回 `fs=NTFS maxcomp=255 flags=0x03E72EFF`，三个低位均置位；同一台机器上 `fsutil file queryCaseSensitiveInfo C:\Projects\cli-launchpad` 输出 `Case sensitive attribute on directory C:\Projects\cli-launchpad is disabled.`。即“卷标志置位 + 目录标志为 0”同时成立。
- 对远程卷不可靠：该 API 文档的“Remarks”表列出 SMB 3.0 为“No”（“SMB does not support volume management functions.”）；本机环回 SMB 调用却返回成功，但 NTFS 服务端的 `FILE_CASE_SENSITIVE_SEARCH` 位被清为 0（flags=0x00C700FE）。二者的冲突如实记录，不裁决，结论是**远程位置不得使用卷标志**。

**问 2：按目录大小写敏感（`FILE_CASE_SENSITIVE_INFORMATION`、`FileCaseSensitiveInformation`、`fsutil file queryCaseSensitiveInfo` / `setCaseSensitiveInfo`）。**

- 结构：`typedef struct _FILE_CASE_SENSITIVE_INFORMATION { ULONG Flags; }`，`FILE_CS_FLAG_CASE_SENSITIVE_DIR`=0x00000001“Specifies the directory is case-sensitive.”，头文件 ntifs.h。已验证（官方文档）。
- 信息类：`FILE_INFORMATION_CLASS` 里 `FileCaseSensitiveInformation`=71，“This value is available starting with Windows 10 April 2018 Update.”；`FileCaseSensitiveInformationForceAccessCheck`=75 仅供内核，文件系统不应收到。已验证。
- 用户态查询要求：`NtQueryInformationFile` 页“FileCaseSensitiveInformation (71): A FILE_CASE_SENSITIVE_INFORMATION structure. The caller must have opened the file with the FILE_READ_ATTRIBUTES flag specified in the DesiredAccess parameter. This value is available starting with Windows 10, version 1803.”。已验证。打开目录需要 `FILE_FLAG_BACKUP_SEMANTICS`：来源为社区 C# 示例（meziantou.net，注释 “FILE_FLAG_BACKUP_SEMANTICS is required to open a directory”），与 CreateFile 通用规则一致，部分验证。
- `fsutil`：`fsutil.exe file queryCaseSensitiveInfo <path>` 查询，`fsutil.exe file setCaseSensitiveInfo <path> enable|disable` 设置（WSL 文档）。注意：fsutil 官方“fsutil file”命令页的子命令表**没有**列出这两个子命令（调研员 grep 了该页，只有 queryallocranges、queryextents、queryfileid 等），所以它们的权威出处只有 WSL case-sensitivity 页。
- 设置条件（WSL 页，已验证）：需提升权限；还需要目录上的“Write attributes”“Create files”“Create folders”“Delete subfolders and files”；目录必须为空；含仅大小写不同文件的目录不能关闭；从 Windows 10 build 17107 起支持。
- 错误信息（WSL 页，已验证）：“A local NTFS volume is required for this operation”，“The case sensitivity attribute can only be set on directories within an NTFS-formatted file system.”。但见下面的矛盾：
  - 本机 `fsutil` 对 SMB、`\\wsl$` 路径输出：“A volume supporting case-sensitivity is required for this operation (e.g., a local REFS or NTFS volume).”（本机观察，推断）。比文档措辞多了 REFS，与 refs-registry-values 页“ReFS also underlies Dev Drive and supports per-directory case sensitivity”一致，说明 WSL 页关于“只有 NTFS”的说法已过时（部分验证）。
- 查询在不支持的卷上的行为（本机观察）：SMB 环回与 `\\wsl$` 上 `NtQueryInformationFile(…, 71)` 均返回 `0xC00000BB`，即 `STATUS_NOT_SUPPORTED`（MS-ERREF 确认该码值与名称）；NTFS 本地目录返回 `0x00000000` 且 `Flags`=0。其余文件系统（FAT、exFAT、ReFS）的返回码未观察，见 UW-10。

**问 3：子目录继承规则。**

三处官方来源互相矛盾，全部列出：

1. 官方开发博客 2018-03-01（insider build 17093–17110 时期）：“Note that the per-directory case sensitivity flag is not inherited; directories created in a case sensitive directory are not automatically case sensitive themselves. You must explicitly mark each directory as case sensitive.”
2. 官方开发博客 2018-06-14（build 17692 时期）：“Previously, it was necessary to explicitly mark every directory you create as case sensitive. Now, we’ve made it so that the per-directory case sensitivity flag is inherited when creating a new directory.”
3. Microsoft Learn 当前页（WSL “Adjust case sensitivity”）：“When creating new directories, those directories will inherit the case sensitivity from its parent directory.”，并警告 “There is an exception to this inheritance policy when running in WSL 1 mode … the per-directory case sensitivity flag is not inherited”。同一页另一处警告又写：“if Windows applications create new directories in a directory tree where you are using case sensitive files, these directories are not case sensitive.”

采信：以较新的两条（2 与 3）为准，认为新目录默认继承；但第 3 条自身的两处措辞存在张力，且 GitHub issue 里有用户在 2020 年仍报告相关问题。最稳妥的结论是“继承与否取决于创建目录的一方（WSL 与 Win32 应用可能不同），不得用根目录的标志推断子目录”。状态：部分验证，必须用 W-20 实机确认。

**问 4：ReFS 与 Dev Drive 的行为。**

- ReFS 卷标志：MS-FSA 附录 A：ReFS 的 `FILE_CASE_SENSITIVE_SEARCH`“Always Set”。已验证。
- ReFS 支持按目录大小写敏感：refs-registry-values 页“ReFS also underlies Dev Drive and supports per-directory case sensitivity. … `RefsEnableDirCaseSensitivity` is local only: ReFS reads it from `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` and doesn’t check `HKLM\SYSTEM\CurrentControlSet\Policies`.”已验证“存在且仅读本地”；该注册表值的取值含义、默认值：未查到（它指向的 WSL 页并没有提到它）。本机观察：`RefsEnableDirCaseSensitivity`=3、`NtfsEnableDirCaseSensitivity`=3、`obcaseinsensitive`=1（均为推断类，只说明存在，含义未验证）。
- Dev Drive：文档原话“Dev Drive builds on ReFS technology”“The Dev Drive utilizes ReFS”。已验证。Dev Drive 上的大小写行为无专门说明，按 ReFS 对待。
- 其他 ReFS 事实对我们有影响：BY_HANDLE_FILE_INFORMATION 页“The ReFS file system … includes 128-bit file identifiers … The 64-bit identifier in this structure is not guaranteed to be unique on ReFS.”——本项目 `src-tauri/src/platform/file_identity.rs` 的 Windows 分支用 `GetFileInformationByHandle` 的 64 位索引，在 ReFS/Dev Drive 上不保证唯一，见 E.2。硬链接：MS-FSA 注 “Hard links are supported on NTFS volumes, UDFS volumes, and ReFS volumes formatted version 3.5 or later (Windows Server 2022 and later).”
- Dev Drive 的杀毒过滤器默认附加，Defender 默认“performance mode”（异步扫描），见 E.5。

**问 5：NTFS upcase 表。**

- 存在与用途：MS-FSCC 5.3 “\$UpCase — Table of uppercase characters used for collating”。内核例程文档 `FsRtlAreNamesEqual`：“Case-insensitive matching is performed by converting both strings to uppercase before they are compared. Thus the value of UpcaseTable, if supplied, is used only if IgnoreCase is TRUE.”并说明该表“is an array of uppercase Unicode characters, indexed by the Unicode character to be converted to uppercase”。已验证。
- 表是**每卷**的、格式化时写入：微软员工在 Old New Thing 评论区（降级为社区讨论）：“when an NTFS (or exFAT) filesystem is created, the OS writes into the filesystem’s metadata a table of all known uppercase codepoint mappings. From then on, those are the casing tables that everyone uses when contemplating files on that volume.”；并举例：Unicode 6 的实现创建的卷把 U+037F 与 U+03F3 视为不同文件名，写入 Unicode 7 之后的表则视为同名。部分验证（官方文档未直接写“格式化时写入”，另有 Kaplan 2005 博客“Vista 更新了 casing table 到 Unicode 4.1”佐证表会随 OS 版本变化）。
- 结构是**逐 UTF-16 码元一对一**：Linux 内核 ntfs3（v6.12）`upcase.c` 的 `upcase_unicode_char(const u16 *upcase, u16 chr)` 对 `chr` 直接 `return upcase[chr]`；ntfs-3g 2022.10.3 `unistr.c` 的 `ntfs_names_full_collate` 同样用 `upcase[u1]`。exFAT 规范（同一思路）：“An up-case table is a series of Unicode character mappings. A character mapping consists of a 2-byte field, with the index of the field in the up-case table representing the Unicode character to be up-cased, and the 2-byte field representing the up-cased Unicode character.”。因此：不能把 `ß` 映射成 `SS`（长度会变），非 BMP 字符不参与大小写映射。Kaplan 存档博客：“normalization still does not happen, and the updated casing table is limited to the BMP”“the OS does not upcase the ‘off the BMP’ characters”。部分验证（源码与社区博客，缺 Microsoft 官方对 NTFS 的直接陈述）。
- `$UpCase` 大小：Kaplan 评论“$UpCase is still 131,072 bytes on Vista”，即 65536×2 字节（社区，与上面源码一致）。
- 与 Unicode 标准大小写折叠**不等价**（本项目草案 4.7.2.2 “折叠函数只是近似”的判断成立）。证据：调研员用本机 Windows 的 OS 大小写表（`RtlUpcaseUnicodeChar`，`CompareStringOrdinal` 文档称 `bIgnoreCase` 为 TRUE 时“using the operating system uppercase table information”）与 Unicode 18.0.0 `CaseFolding.txt` 对照，差异见 对应小节的“D. 向量判定”。注意 OS 表只是“新格式化卷会写入的那份”，旧卷的 `$UpCase` 可能不同，且本机无管理员权限，读不了真实卷的 `$UpCase`。
- 微软员工对“如何判断两个文件名是否等价”的建议：“It’s essentially impossible to predict in advance, given all the special cases (junction points, non-NTFS filesystems, goofy filesystem filter drivers, and `fsutil file SetCaseSensitiveInfo c:\some\special\path enable`). So I’d suggest just creating the two files and checking if you get an error.”（社区降级）。这与草案“行为探测”的思路一致，同时说明“创建后检查”是该员工推荐的主路径；我们的“已有条目换大小写”比它更少侵入。

#### B.2 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew | 2026-10-18 | 官方文档 | “FILE_CASE_SENSITIVE_SEARCH 0x00000001 The specified volume supports case-sensitive file names.” “FILE_CASE_PRESERVED_NAMES 0x00000002 The specified volume supports preserved case of file names when it places a name on disk.” Remarks 表：SMB 3.0 为 No，“SMB does not support volume management functions.” |
| https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/ebc7e6e5-4650-4e54-b17c-cf60f6fbeeaa | 2026-10-19 | 官方文档 | 2.5.1 FileFsAttributeInformation：“FILE_CASE_SENSITIVE_SEARCH 0x00000001 The file system supports case-sensitive file names when looking up (searching for) file names in a directory.” |
| https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63 | 2026-10-19 | 官方文档 | 附录 A 表（列 ReFS、NTFS、FAT、EXFAT、UDFS、CDFS）：FILE_CASE_SENSITIVE_SEARCH 行为 Always Set、Always Set、空、空、Always Set、Always Set；硬链接注：“Hard links are supported on NTFS volumes, UDFS volumes, and ReFS volumes formatted version 3.5 or later” |
| https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file | 2026-10-18 | 官方文档 | “Do not assume case sensitivity. … Note that NTFS supports POSIX semantics for case sensitivity but this is not the default behavior.” |
| https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew | 2026-10-19 | 官方文档 | `FILE_FLAG_POSIX_SEMANTICS`：“Access will occur according to POSIX rules. This includes allowing multiple files with names, differing only in case, for file systems that support that naming.” |
| https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_case_sensitive_information | 2026-10-18 | 官方文档 | “The FILE_CASE_SENSITIVE_INFORMATION structure is used to query or set per-directory case-sensitive information.” `FILE_CS_FLAG_CASE_SENSITIVE_DIR 0x00000001 Specifies the directory is case-sensitive.` |
| https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ne-wdm-_file_information_class | 2026-10-18 | 官方文档 | “FileCaseSensitiveInformation Value: 71 … available starting with Windows 10 April 2018 Update.” |
| https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryinformationfile | 2026-10-19 | 官方文档 | “FileCaseSensitiveInformation (71) … The caller must have opened the file with the FILE_READ_ATTRIBUTES flag specified in the DesiredAccess parameter. This value is available starting with Windows 10, version 1803.” |
| https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity | 2026-10-18 | 官方文档 | “Support for per-directory case sensitivity began in Windows 10, build 17107.” “A directory must be empty in order to change the case sensitivity flag attribute on that directory.” “When creating new directories, those directories will inherit the case sensitivity from its parent directory.” “There is an exception to this inheritance policy when running in WSL 1 mode.” “…these directories are not case sensitive.”（Windows 应用新建目录）“Error: A local NTFS volume is required for this operation”；“NTFS-formatted drives mounted to a WSL distribution will be case-insensitive by default. (EXT4 drives will be case-sensitive by default).” |
| https://devblogs.microsoft.com/commandline/per-directory-case-sensitivity-and-wsl/ | 2026-10-19 | 官方文档（微软官方开发博客，发布于 2018-03-01） | “Note that the per-directory case sensitivity flag is not inherited; directories created in a case sensitive directory are not automatically case sensitive themselves.” “Not all file systems support per-directory case sensitivity; currently, it only works on local NTFS drives.” |
| https://devblogs.microsoft.com/commandline/improved-per-directory-case-sensitivity-support-in-wsl/ | 2026-10-19 | 官方文档（微软官方开发博客，发布于 2018-06-14） | “the per-directory case sensitivity flag is inherited when creating a new directory.” “The case sensitivity attribute is not available on file systems that do not support per-directory case sensitivity, such as FAT or SMB file systems. Currently, only local NTFS volumes support per-directory case sensitivity.” |
| https://learn.microsoft.com/en-us/windows-server/storage/refs/refs-registry-values | 2026-10-19 | 官方文档 | “ReFS also underlies Dev Drive and supports per-directory case sensitivity. … RefsEnableDirCaseSensitivity is local only: ReFS reads it from HKLM\SYSTEM\CurrentControlSet\Control\FileSystem” |
| https://learn.microsoft.com/en-us/windows/dev-drive/ | 2026-10-18 | 官方文档 | “Dev Drive builds on ReFS technology …” “The Dev Drive utilizes ReFS …” “Microsoft Defender Antivirus defaults to the new ‘performance mode’ setting on Dev Drives”；创建（curl 取回的页面原文已 grep 确认）：`Format D: /DevDrv /Q`、`Format-Volume -DriveLetter D -DevDrive`；信任：`fsutil devdrv trust D:` |
| https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information | 2026-10-18 | 官方文档 | “nNumberOfLinks: The number of links to this file. For the FAT file system this member is always 1. For the NTFS file system, it can be more than 1.” “The ReFS file system … includes 128-bit file identifiers … The 64-bit identifier in this structure is not guaranteed to be unique on ReFS.” |
| https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/b04c3bd0-79dc-4e58-b8ed-74f19fc2ea0a | 2026-10-19 | 官方文档 | 5.3 NTFS Reserved File Names：“\$UpCase  Table of uppercase characters used for collating” |
| https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-_fsrtl_advanced_fcb_header-fsrtlarenamesequal | 2026-10-19 | 官方文档 | “Case-insensitive matching is performed by converting both strings to uppercase before they are compared. Thus the value of UpcaseTable, if supplied, is used only if IgnoreCase is TRUE.” |
| https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-comparestringordinal | 2026-10-19 | 官方文档 | `bIgnoreCase`：“TRUE if the function is to perform a case-insensitive comparison, using the operating system uppercase table information.” |
| https://learn.microsoft.com/en-us/windows/win32/intl/security-considerations--international-features | 2026-10-19 | 官方文档 | “CompareStringOrdinal … Except for the option of being case-insensitive, this function disregards all non-binary equivalences” |
| https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification | 2026-10-19 | 官方文档 | 7.2“the exFAT file system being case insensitive and case preserving”；7.2.5“An up-case table is a series of Unicode character mappings. A character mapping consists of a 2-byte field …”；“The first 128 Unicode characters have mandatory mappings”；7.2.5.1 推荐表“for which the value of the TableChecksum field is E619D30Dh” |
| https://devblogs.microsoft.com/oldnewthing/20200804-00/?p=104040 | 2026-10-19 | 社区讨论（降级，需另有佐证）：评论者 Jeffrey Tippet | “when an NTFS (or exFAT) filesystem is created, the OS writes into the filesystem’s metadata a table of all known uppercase codepoint mappings.” “It’s essentially impossible to predict in advance … So I’d suggest just creating the two files and checking if you get an error.” |
| https://archives.miloush.net/michkap/archive/2006/09/24/769540.html 与 https://archives.miloush.net/michkap/archive/2005/08/20/454071.html | 2026-10-19 | 社区讨论（降级；前微软员工 Michael Kaplan 的存档博客，评论） | “Nope, normalization still does not happen, and the updated casing table is limited to the BMP.” “Correct, the OS does not upcase the ‘off the BMP’ characters.” “$UpCase is still 131,072 bytes on Vista” “Finally, in Vista, the casing table is being updated to all of the Unicode 4.1 values.” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/upcase.c?h=v6.12 | 2026-10-19 | 项目源码（linux 标签 v6.12，文件 fs/ntfs3/upcase.c） | 函数 `upcase_unicode_char(const u16 *upcase, u16 chr)`：`chr < 'a'` 原样返回，`chr <= 'z'` 减 32，否则 `return upcase[chr]` |
| https://raw.githubusercontent.com/tuxera/ntfs-3g/2022.10.3/libntfs-3g/unistr.c | 2026-10-19 | 项目源码（ntfs-3g 标签 2022.10.3） | 函数 `ntfs_names_full_collate` 注释“If @ic is IGNORE_CASE, then the names are only compared case-insensitively”，内部以 `le16_to_cpu(upcase[u1])` 逐码元映射 |
| https://learn.microsoft.com/en-us/windows/wsl/troubleshooting | 2026-10-19 | 官方文档 | “A 9p protocol file server provides the service on the Linux side to allow Windows to access the Linux file system. If you cannot access WSL using `\\wsl$` on Windows …” |
| https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop | 2026-10-19 | 官方文档 | 表格行 “Windows process reading Linux files (`\\wsl$\...`) Slow (cross-filesystem 9P protocol)”；“The `\\wsl$\` path is only available when the WSL instance is running.”（curl 取回原文已 grep 确认） |
| https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55 | 2026-10-19 | 官方文档 | “0xC00000BB STATUS_NOT_SUPPORTED” |
| https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ns-wdm-_device_object | 2026-10-19 | 官方文档 | “FILE_REMOTE_DEVICE Indicates that the device is remote.” |
| https://github.com/microsoft/WSL/issues/3885 | 2026-10-19 | 社区讨论（降级，需另有佐证） | “Case-sensitive directories inaccessible from remote machines”；评论“Windows 10 ver. 2004 clients trying to read a remote case-sensitive folder will now report ‘The file cannot be opened because the path has a case-sensitive directory.’” |
| https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html | 2026-10-19 | 官方文档（Samba 项目） | “case sensitive = yes/no/auto … The default setting of auto allows clients that support case sensitive filenames (Linux CIFSVFS and smbclient 3.0.5 and above currently) to tell the Samba server on a per-packet basis … No Windows or DOS system supports case-sensitive filename so setting this option to auto is the same as setting it to no for them.” “Samba 3.0 has the same semantics as a Windows NT server, in that it is case insensitive but case preserving.” |
| https://raw.githubusercontent.com/samba-team/samba/master/source3/smbd/smb2_trans2.c | 2026-10-19 | 项目源码（samba-team/samba master，取回时 master 为 1e3906f，该文件最近修改提交 89fe40b9b3625a73205ea29477406c1f22805c36） | `case SMB_QUERY_FS_ATTRIBUTE_INFO: case SMB_FS_ATTRIBUTE_INFORMATION:` 分支：`SIVAL(pdata,0,FILE_CASE_PRESERVED_NAMES\|FILE_CASE_SENSITIVE_SEARCH\| FILE_SUPPORTS_OBJECT_IDS\|FILE_UNICODE_ON_DISK\| conn->fs_capabilities);`（文件内约第 2105–2110 行） |
| https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt 与 .../UnicodeData.txt | 2026-10-19 | 官方文档（Unicode 联盟，CaseFolding-18.0.0） | 例：“03C2; C; 03C3”“1E9E; S; 00DF”“212A; C; 006B”“01C5; C; 01C6”“AB70; C; 13A0”“FF21; C; FF41” |

#### B.3 对本项目的启示

1. Windows 判定必须分三类处理：本地 NTFS/ReFS（卷标志加目录级标志）、本地 FAT/exFAT（卷标志位未置位即不区分）、远程位置（不使用任何标志，直接行为探测）。草案流程里“SMB、`\\wsl$` 在 API 失败时才走行为探测”需要改为“先判远程，远程一律走行为探测”，否则 SMB 会被卷标志误判成 `Insensitive`，`\\wsl$` 会因“目录级查询失败”被误判。
2. 折叠函数不能取标准 Unicode simple case folding：Windows 的 upcase 表只做“逐码元大写”，且逐卷固定。保守做法是 Windows 上只把 ASCII 与“必定一致”的子集作为折叠依据，其余靠文件身份兜底；若要精确，可用 `CompareStringOrdinal(..., TRUE)` 与 OS 表保持一致（`Win32_Globalization`），但它与旧卷的 `$UpCase` 仍可能不同。

#### E.2 硬链接盲区与链接数取法

- 取链接数：Win32 `GetFileInformationByHandle` 返回的 `BY_HANDLE_FILE_INFORMATION.nNumberOfLinks`（官方文档：“The number of links to this file. For the FAT file system this member is always 1. For the NTFS file system, it can be more than 1.”）。本项目 `src-tauri/src/platform/file_identity.rs` 的 Windows 分支已经调用同一个函数并填充同一个结构，只是没有读取 `nNumberOfLinks`，所以**不需要新增 Cargo feature**即可取得该字段。
- 硬链接支持：NTFS、UDFS、ReFS（版本 3.5 及以后，Windows Server 2022 及以后）（MS-FSA 注）。`GetVolumeInformationByHandleW` 的 `FILE_SUPPORTS_HARD_LINKS`=0x00400000 可用于判断卷是否支持；本机观察 `\\wsl$`（9P）也报告该位。
- “已有条目换大小写”要求“普通文件且链接数为 1”是否合理：**合理，建议保留并补充**。原因：在区分大小写的目录里，翻转大小写的名字可能恰好是同一文件的另一个硬链接名（如 `a.txt` 与 `A.txt` 是同一 inode 的两个名字），此时文件身份相同，会被误判为 `Insensitive`；链接数为 1 排除了这种可能。补充条件：① 排除重解析点（junction、符号链接、OneDrive 占位文件等），查询时不跟随；② 目录条目也可作为探测对象（NTFS 目录不能有多个硬链接，但目录联接/符号链接除外，且“目录的 nNumberOfLinks”官方文档没有说明，见 UW-11），所以仍建议只用普通文件；③ 若项目根下全是目录和多链接文件，则按草案降级到“临时文件兜底”或 `Unknown`。
- 与文件身份兜底的关联：BY_HANDLE_FILE_INFORMATION 页“The 64-bit identifier in this structure is not guaranteed to be unique on ReFS”，而本项目 `FileIdentity::of` 用 64 位索引；ReFS/Dev Drive 上应改用 `GetFileInformationByHandleEx(FileIdInfo)` 的 128 位 `FILE_ID_INFO`（`windows-sys 0.59` 的 `FILE_ID_INFO` 与 `FileIdInfo` 在 `Win32_Storage_FileSystem` 下，已启用）。这是现有代码的潜在缺口，不属于本调研的实现范围，但与“身份兜底必须保留”的设计相关。

#### E.3 `windows-sys 0.59` 所需 Cargo feature（本机 `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/windows-sys-0.59.0/` 源码只读核对）

当前 `src-tauri/Cargo.toml` 已启用：`Win32_Foundation`、`Win32_Security`、`Win32_Security_Authorization`、`Win32_Storage_FileSystem`、`Win32_System_Diagnostics_ToolHelp`、`Win32_System_IO`、`Win32_System_JobObjects`、`Win32_System_Registry`、`Win32_System_Threading`。`Cargo.lock` 里 `windows-sys` 有 0.45.0、0.52.0、0.59.0、0.60.2、0.61.2 五个版本，本项目直接依赖的是 0.59.0。windows-sys 许可证为 `MIT OR Apache-2.0`（Cargo.toml 的 `license` 字段），与本项目 MIT 兼容。

<!-- prettier-ignore -->
| 需要的项 | 所在文件（相对 `src/Windows/`） | 门控 | 需要的 feature | 当前是否已启用 |
| --- | --- | --- | --- | --- |
| `GetVolumeInformationByHandleW` | `Win32/Storage/FileSystem/mod.rs` 第 236 行 | 无额外 cfg，仅模块门控 | `Win32_Storage_FileSystem` | 是 |
| `GetFileInformationByHandle`、结构 `BY_HANDLE_FILE_INFORMATION` | 同上，第 185 行、第 1557 行 | 无额外 cfg | `Win32_Storage_FileSystem`（`FILETIME` 来自 `Win32_Foundation`） | 是 |
| `GetFileInformationByHandleEx`、`FILE_ID_INFO`、`FileIdInfo` | 同上 | 无额外 cfg | `Win32_Storage_FileSystem` | 是 |
| `CreateFileW`、`FILE_FLAG_BACKUP_SEMANTICS`、`FILE_READ_ATTRIBUTES`、`GetDriveTypeW`、`GetVolumePathNameW` | 同上 | `CreateFileW` 另需 `Win32_Security` | `Win32_Storage_FileSystem` 与 `Win32_Security` | 是 |
| `NtQueryInformationFile` | `Wdk/Storage/FileSystem/mod.rs` 第 671 行 | `#[cfg(feature = "Win32_System_IO")]`，模块 `Wdk_Storage_FileSystem` | **`Wdk_Storage_FileSystem`**（链：`Wdk_Storage_FileSystem` → `Wdk_Storage` → `Wdk` → `Win32_Foundation`）加 `Win32_System_IO`（`IO_STATUS_BLOCK`） | `Wdk_Storage_FileSystem` **未启用，需新增**；`Win32_System_IO` 已启用 |
| `FILE_INFORMATION_CLASS`、`FileCaseSensitiveInformation`（=71i32）、结构 `FILE_CASE_SENSITIVE_INFORMATION { Flags: u32 }` | `Wdk/Storage/FileSystem/mod.rs` 第 2034、1503、2354 行 | 无额外 cfg | **`Wdk_Storage_FileSystem`**（同上） | 需新增（同一个 feature） |
| 常量 `FILE_CASE_SENSITIVE_SEARCH`(1)、`FILE_CASE_PRESERVED_NAMES`(2)、`FILE_CS_FLAG_CASE_SENSITIVE_DIR`(1)、`FILE_SUPPORTS_HARD_LINKS` | `Win32/System/SystemServices/mod.rs` 第 457–478 行 | 无额外 cfg，模块门控 | **`Win32_System_SystemServices`** | **未启用**。这些常量值固定且已由官方文档给出，可以改为在 `platform/` 内本地定义以免多开 feature，两种做法都可行 |
| `NtQueryVolumeInformationFile`、`FileFsDeviceInformation`（=4） | `Wdk/Storage/FileSystem/mod.rs` 第 681、1516 行 | 前者 `#[cfg(feature = "Win32_System_IO")]` | `Wdk_Storage_FileSystem` 加 `Win32_System_IO` | 同上（用于 `FILE_REMOTE_DEVICE` 判定；若沿用 file_cas.rs 的 UNC 前缀加 `GetDriveTypeW` 做法则不需要） |
| `FILE_FS_DEVICE_INFORMATION`、`FILE_REMOTE_DEVICE`(0x10) | `Wdk/System/SystemServices/mod.rs` 第 6038、2309 行 | 无额外 cfg | **`Wdk_System_SystemServices`**（链 → `Wdk_System` → `Wdk`） | **未启用**；同样可本地定义 `#[repr(C)] struct { DeviceType: u32, Characteristics: u32 }` 与常量 0x10 |
| `DRIVE_REMOTE`(4) | `Win32/System/WindowsProgramming/mod.rs` 第 494 行 | 模块门控 | `Win32_System_WindowsProgramming` | 未启用；`file_cas.rs` 已自己定义 `DRIVE_REMOTE_TYPE: u32 = 4`，沿用即可 |
| `CompareStringOrdinal`（可选：与 OS 大写表一致的比较） | `Win32/Globalization/mod.rs` 第 4 行 | 无额外 cfg | `Win32_Globalization` | 未启用，可选 |

**需新增 feature 清单**：必须新增 `Wdk_Storage_FileSystem`（一个就够取得 `NtQueryInformationFile`、信息类与结构）。可选新增：`Win32_System_SystemServices`（可改为本地常量）、`Wdk_System_SystemServices`（可改为本地结构，或复用 file_cas.rs 的 UNC/`GetDriveTypeW` 判法）、`Win32_Globalization`（仅在选用 `CompareStringOrdinal` 时）。这些 feature 不引入新 crate，因此 `Cargo.lock` 不应变化（未实际构建验证，此项为按依赖图的推断）。`NtQueryInformationFile` 在 0.59 里是存在的，并非需要自写 `extern`（`windows_targets::link!("ntdll.dll" "system" fn NtQueryInformationFile(...))`）。

#### E.4 本机只读观察（推断类，不计已验证）

环境：Windows 11 10.0.26300；仓库 `C:\Projects\cli-launchpad` 位于 `C:`（NTFS）。

1. `fsutil file queryCaseSensitiveInfo C:\Projects\cli-launchpad` 原始输出：`Case sensitive attribute on directory C:\Projects\cli-launchpad is disabled.`；对 `C:\Projects\cli-launchpad\src`、`C:\` 同样为 disabled。解读：本地 NTFS 默认目录的目录级标志为 0。
2. `fsutil fsinfo volumeinfo C:` 原始输出：`Error 5: Access is denied.`。解读：该命令需要管理员，普通会话读不到。改用等价的 Win32 `GetVolumeInformationW("C:\")`（P/Invoke，只读）：`fs=NTFS maxcomp=255 flags=0x03E72EFF`，其中 `FILE_CASE_SENSITIVE_SEARCH`（bit0）、`FILE_CASE_PRESERVED_NAMES`（bit1）、`FILE_UNICODE_ON_DISK`（bit2）均置位。解读：NTFS 卷标志置位，与目录标志为 0 同时成立，印证“不能只看卷标志”。
3. 对目录句柄（`FILE_READ_ATTRIBUTES` + `FILE_FLAG_BACKUP_SEMANTICS`）调用 `NtQueryInformationFile(…, FileCaseSensitiveInformation)`：
   - `C:\Projects\cli-launchpad` → NTSTATUS `0x00000000`，`Flags`=0；
   - `\\localhost\C$\Projects\cli-launchpad`（环回 SMB，服务端 NTFS）→ `0xC00000BB`（STATUS_NOT_SUPPORTED）；`GetVolumeInformationByHandleW` 返回 `fs=NTFS flags=0x00C700FE`，即 `FILE_CASE_SENSITIVE_SEARCH` 位**为 0**；
   - `\\wsl$\docker-desktop\etc` 与 `\\wsl.localhost\docker-desktop\etc` → `0xC00000BB`；`GetVolumeInformationByHandleW` 返回 `fs=9P flags=0x00400003`（`FILE_CASE_SENSITIVE_SEARCH`、`FILE_CASE_PRESERVED_NAMES`、`FILE_SUPPORTS_HARD_LINKS` 置位）。
   - `NtQueryVolumeInformationFile(FileFsDeviceInformation)`：本地 `C:` 的 `Characteristics`=0x220020（无 `FILE_REMOTE_DEVICE`）；`\\localhost\C$` 与 `\\wsl$` 为 0x10（`FILE_REMOTE_DEVICE` 置位）；`GetDriveTypeW` 对 `C:\` 为 3，对 `\\localhost\C$\`、`\\wsl$\docker-desktop\` 为 4（`DRIVE_REMOTE`）。
4. 换大小写的“已有条目”只读探测（`Test-Path`）：`C:\Projects\cli-launchpad\README.md` 与 `readme.MD` 均存在；`\\localhost\C$\...\README.md` 与 `readme.MD` 均存在（SMB 环回，NTFS 服务端）；`\\wsl$\docker-desktop\etc\hostname` 存在而 `...\ETC\hostname`、`...\etc\HOSTNAME` 不存在。解读：本地 NTFS 与 SMB→NTFS 为不区分大小写行为，`\\wsl$`（9P，Linux 侧）为区分大小写行为。
5. 其他：`fsutil file queryCaseSensitiveInfo` 对 `\\wsl$`、`\\wsl.localhost`、`\\localhost\C$` 路径均输出 `A volume supporting case-sensitivity is required for this operation (e.g., a local REFS or NTFS volume).`；`F:` 为未就绪的可移动盘（`Error 21: The device is not ready.`），机器上没有 ReFS 卷（`Get-Volume` 过滤 ReFS 计数为 0），`fsutil devdrv query` 输出 `Developer volumes are enabled.`（说明系统启用了 Dev Drive 功能，但没有实际的 Dev Drive 卷）。注册表（只读）：`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` 下 `RefsEnableDirCaseSensitivity`=3、`NtfsEnableDirCaseSensitivity`=3，`...\Session Manager\Kernel` 下 `obcaseinsensitive`=1；这些值的取值含义未在官方文档找到，仅记录存在。
6. OS 大小写表（`RtlUpcaseUnicodeChar`、`CompareStringOrdinal`）的逐码点结果见 对应小节的“D. 向量判定”。

#### E.5 行为探测副作用在 Windows 上的已知经验

<!-- prettier-ignore -->
| 结论 | 来源 URL | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- |
| 在被监听目录里创建或删除文件会触发 `ReadDirectoryChangesW` 的文件名变更通知：“Any file name change in the watched directory or subtree causes a change notification wait operation to return. Changes include renaming, creating, or deleting a file.” 所以“临时文件兜底”必然被文件监听器看到；“已有条目换大小写”的只读查询不改变目录，不触发该类通知（推断） | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw | 2026-10-19 | 官方文档（通知部分）+ 推断（只读查询不触发） | 部分验证 |
| Dev Drive 上杀毒过滤器默认附加：“Antivirus filters, including both Microsoft Defender and 3rd-party antivirus filters, are attached to a Dev Drive by default.” Defender 在受信任的 Dev Drive 上默认“performance mode”（异步扫描），非受信任时为实时保护。这说明在 Dev Drive 或普通卷上创建文件都可能被杀毒过滤器看到；具体对一个小临时文件的开销与告警未见官方说明 | https://learn.microsoft.com/en-us/windows/dev-drive/ | 2026-10-18 | 官方文档 | 部分验证（缺对小临时文件的具体影响） |
| `FILE_ATTRIBUTE_TEMPORARY`、`FILE_FLAG_DELETE_ON_CLOSE` 能让探测文件在句柄关闭后立即删除：“The file is to be deleted immediately after all of its handles are closed”。它减少残留，但不会让创建/删除事件对监听器不可见（推断） | https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew | 2026-10-19 | 官方文档（删除语义）+ 推断（不隐藏事件） | 部分验证 |
| 微软员工建议用“创建两个文件再检查”作为判断大小写等价的主路径，并提醒要处理竞态：“Since you have to handle the TOCTOU race anyway, you might as well make that the main path.” | https://devblogs.microsoft.com/oldnewthing/20200804-00/?p=104040 | 2026-10-19 | 社区讨论（降级） | 部分验证（仅说明业界做法，与副作用无关） |
| OneDrive/Dropbox/Syncthing 等同步工具、构建工具（cargo/MSBuild/vite）、资源管理器缩略图对临时探测文件的反应 | 未检索到可靠来源 | 2026-10-19 | 推断 | 未验证 |

#### D. 向量判定（NTFS、ReFS、exFAT、FAT）

约定：“折叠”表示两个名字被视为同一个名字。每个单元格的来源在表后统一列出，并在单元格里写明来源类别。“OS 表观察”指：在本机 Windows 11 10.0.26300 上调用 `RtlUpcaseUnicodeChar` 与 `CompareStringOrdinal(bIgnoreCase=TRUE)`（后者文档称使用 OS 大写表），脚本为 `win-upcase.ps1`；这是 OS 当前的大小写表，**新格式化的 NTFS/exFAT/ReFS 卷据微软员工评论会写入这份表**，但旧卷的 `$UpCase` 可能不同，且调研员没有管理员权限去读真实卷，所以不计已验证。“exFAT 推荐表”指调研员从 exFAT 规范 Table 25（推荐的 up-case 表）解析出的映射（`exfat_upcase.py`；解析得到 0xFFFA 项，页面表末尾缺 6 项，按规范算出的校验和与 E619D30Dh 不符，所以该列为部分验证）。

<!-- prettier-ignore -->
| 组 | 输入 | NTFS | ReFS | exFAT | FAT |
| --- | --- | --- | --- | --- | --- |
| 1 | `README` 与 `readme` | 折叠（已验证：Naming a File 页“consider the names OSCAR, Oscar, and oscar to be the same”；MS-FSA 表 NTFS 不区分是 Win32 默认；exFAT 规范“first 128 Unicode characters have mandatory mappings”同类） | 折叠（部分验证：仅有 Win32 通用语句，缺 ReFS 专属语句） | 折叠（已验证：exFAT 规范 7.2 “case insensitive and case preserving”，ASCII 映射为强制项） | 折叠（部分验证：MS-FSA 表 FAT 未置位 CASE_SENSITIVE_SEARCH；缺 FAT 专属的比较规则原文） |
| 2 | `Straße` 与 `STRASSE` | 不折叠（部分验证：upcase 表是逐码元一对一，不能把 ß 变成 SS；OS 表观察 ß→ß，`CompareStringOrdinal` 比较结果为不相等；长度也不同） | 未验证（ReFS 的比较表来源未查到） | 不折叠（部分验证：exFAT 规范的 up-case 表为 2 字节逐码元映射；推荐表中 U+00DF→U+00DF） | 未验证 |
| 3 | `ß`（U+00DF）与 `ẞ`（U+1E9E） | 不折叠（部分验证：OS 表观察两者都映射到自身；upcase 方向的表从不把 ß 映到 ẞ。对照：Unicode 简单折叠 `1E9E; S; 00DF` 会折叠，所以与标准折叠不同） | 未验证 | 不折叠（部分验证：推荐表 U+00DF→U+00DF、U+1E9E→U+1E9E） | 未验证 |
| 4 | `i` 与 `İ`（U+0130） | 不折叠（部分验证：OS 表观察 i→I，İ→İ，比较结果 i 小于 İ；Unicode 的 `0130; T; 0069` 属土耳其专用映射，默认折叠不含） | 未验证 | 不折叠（部分验证：推荐表 U+0130→U+0130） | 未验证 |
| 5 | `I` 与 `ı`（U+0131） | 不折叠（部分验证：OS 表观察 ı→ı，I 与 ı 比较不相等；注意 UnicodeData 里 U+0131 的简单大写是 U+0049，Windows 表**刻意不采用**，与按 UnicodeData 生成的表不同） | 未验证 | 不折叠（部分验证：推荐表 U+0131→U+0131） | 未验证 |
| 6 | `σ`（U+03C3）、`ς`（U+03C2）与 `Σ`（U+03A3） | σ 与 Σ 折叠；ς 与二者的关系**来源冲突，裁决为未验证**：OS 表观察 ς→ς（不折叠），而 exFAT 规范的推荐表 U+03C2→U+03A3（折叠）；NTFS 真实卷取决于其 `$UpCase`。标准折叠（`03C2; C; 03C3`）会折叠 | σ 与 Σ 未验证；ς 未验证 | σ 与 Σ 折叠、ς 折叠（部分验证：推荐表 U+03C3→U+03A3、U+03C2→U+03A3，但卷上的表可能不同，且校验和未能复现） | 未验证 |
| 7 | `é`（U+00E9）与 `e`+U+0301 | 不折叠（部分验证：Kaplan 存档博客“normalization still does not happen”；OS 表观察 `CompareStringOrdinal` 不相等；Unicode 规范化不做） | 未验证 | 不折叠（部分验证：规范只有 up-case 逐码元映射，无规范化步骤，推断） | 未验证 |
| 8 | `É`（U+00C9）与 `é`（U+00E9） | 折叠（部分验证：OS 表观察 é→É，比较相等；与标准折叠一致） | 未验证 | 折叠（部分验证：推荐表 U+00E9→U+00C9） | 未验证 |
| 9 | `Ａ`（U+FF21）与 `a`/`A` | 与 `a`/`A` 不折叠；`Ａ` 与 `ａ`（U+FF41）折叠（部分验证：OS 表观察 U+FF21→自身，U+FF41 比较 U+FF21 相等，与 a/A 不相等；标准折叠对 FF21→FF41 一致，也不与 ASCII 合并） | 未验证 | 与 `a`/`A` 不折叠（部分验证：推荐表 U+FF41→U+FF21） | 未验证 |
| 10 | `ǅ`（U+01C5）、`ǆ`（U+01C6）、`Ǆ`（U+01C4） | `ǆ` 与 `Ǆ` 折叠；`ǅ` 与二者都**不折叠**（部分验证：OS 表观察 U+01C6→U+01C4，U+01C5→U+01C5；标准简单折叠 `01C5; C; 01C6` 会三者合并，所以不同） | 未验证 | 同 NTFS（部分验证：推荐表 U+01C6→U+01C4，U+01C5→U+01C5） | 未验证 |
| 11 | `K`（U+212A KELVIN SIGN）与 `k`/`K` | 不折叠（部分验证：OS 表观察 U+212A→自身，k→K 且比较 U+212A 与 k、K 均不相等；标准折叠 `212A; C; 006B` 会折叠，所以不同） | 未验证 | 不折叠（部分验证：推荐表 U+212A→U+212A） | 未验证 |
| 12 | `ﬃ`（U+FB03）与 `ffi` | 不折叠（部分验证：upcase 表逐码元映射，U+FB03→自身；完整折叠 `FB03; F; 0066 0066 0069` 才会折叠） | 未验证 | 不折叠（部分验证：推荐表 U+FB03→U+FB03） | 未验证 |
| 13 | Cherokee `Ꭰ`（U+13A0）与 `ꭰ`（U+AB70） | 不折叠（部分验证：**仅限 OS 当前表**：U+AB70→U+AB70，比较结果不相等；标准折叠 `AB70; C; 13A0` 会折叠，所以不同。此项随卷的格式化时间变化——据 Tippet 评论，更晚写入新 Unicode 版本表的卷可能折叠，**真实卷未验证**） | 未验证 | 不折叠（部分验证：推荐表 U+AB70→U+AB70；规范表是旧 Unicode 版本） | 未验证 |

小结（供设计使用）：

1. 与标准简单折叠不同的有 ς（OS 表）、ẞ、K、ǅ、Cherokee 小写，以及“刻意不折叠”的 ı。如果实现用 Rust `char::to_lowercase`/`to_uppercase` 或 Unicode 折叠，会在这些位置与 Windows 不一致；不一致的方向多数是“我们折叠而 Windows 不折叠”（误折叠，后果较重），所以文件身份二次确认必须保留。
2. 所有 Windows 本地文件系统的规范化轴按 `No` 处理（部分验证）。
3. 本表 NTFS/exFAT 列的 Windows 表是“OS 当前表”，真实卷有版本差异；跨版本一致的只有 ASCII 与拉丁-1 补充的大小写对（组 1、8）。

### Linux 内核

#### 本小节最关键的发现（先读这里）

1. **内核 ntfs3 与 ntfs-3g 默认都是区分大小写的**，与草案 4.7.2.3 把 `ntfs`、`ntfs3` 放进“已知不敏感类型表”相反。ntfs3 要加 `nocase` 挂载选项（v6.2 起才有）才不敏感；v6.1 及以前根本没有不敏感模式。新内核驱动 `fs/ntfs`（v7.1 起，f_type 与已删除的旧 ntfs 驱动相同）默认也区分大小写，而旧驱动（≤v6.8）默认不敏感。**`f_type == NTFS_SB_MAGIC` 本身不能决定结论。**
2. **Linux v7.2（2026-08-16 发布）新增了统一的只读报告接口**：`FS_IOC_FSGETXATTR` 的 `FS_XFLAG_CASEFOLD`、`FS_XFLAG_CASENONPRESERVING`，以及 `FS_IOC_GETFLAGS` 的 `FS_CASEFOLD_FL`，现在由 vfat/msdos、exfat、ntfs3、cifs、nfs、xfs、hfs、hfsplus、isofs、vboxsf 实现。**旧内核没有**，所以不能作为唯一依据；而且“标志位未置位”只在文件系统确实实现了该接口时才等于“区分大小写”。
3. **vfat 的“不敏感”是按 `iocharset` 的单字节小写表逐字节比较**，不是 Unicode 折叠；ASCII 折叠，非 ASCII 的 UTF-8 多字节字符基本不折叠；`iocharset=utf8`（恒等表）时连 ASCII 都不折叠；`check=s` 为严格区分。探测应读 `/proc/self/mountinfo` 的挂载选项或做行为探测。
4. **ext4 casefold 目录的比较是“NFD + 去掉 Default_Ignorable 码点 + 完整 case folding（C+F）”，数据固定为 Unicode 12.1.0**；因此它同时是“大小写不敏感”和“规范化不敏感（NFC=NFD）”，且 `ß`=`ss`、`K`(U+212A)=`k`、`ﬃ`=`ffi`、Cherokee 小写=大写。这与草案“先限定 simple case folding”的起点不同。
5. **FUSE 的 `f_type` 恒为 `FUSE_SUPER_MAGIC`；FUSE 上用“翻转大小写再比较文件身份”有误判风险**：libfuse 高层 API 未开 `use_ino` 时 `st_ino` 被忽略，内核 nodeid 按“父目录+名称”分配，同一文件的两个名字会得到不同 `st_ino`（部分验证）。cifs 在 `noserverino` 下同样用 `iunique` 给每个路径新 inode 号。

#### 问 1：ext4 / f2fs 的 casefold 如何启用？`FS_CASEFOLD_FL` 是什么？

答：

- 文件系统级：ext4 需要超级块带 `casefold` 特性，`mke2fs -E encoding=<名称>` 写入，“Enable the casefold feature in the super block and set encoding-name as the encoding to be used”。（`mke2fs(8)`）
- 目录级：对**空目录**执行 `chattr +F`，“all the path lookups inside that directory are made in a case-insensitive fashion. This attribute can only be changed in empty directories on file systems with the casefold feature enabled.”（`chattr(1)`）
- ext4 源码：`ext4_ioctl_setflags` 在翻转 `EXT4_CASEFOLD_FL` 时检查：无 casefold 特性 → `-EOPNOTSUPP`；非目录 → `-ENOTDIR`；非空 → `-ENOTEMPTY`。f2fs 同理（`f2fs_setflags_common`：无特性 `-EOPNOTSUPP`，非空 `-ENOTEMPTY`）。
- ext4 文档：“The case-insensitive file name lookup feature is supported on a per-directory basis … It is enabled by flipping the +F inode attribute of an empty directory.”
- `FS_CASEFOLD_FL = 0x40000000`（`include/uapi/linux/fs.h`），注释：“FS_CASEFOLD_FL indicates case-insensitive name lookup. The bit is most often reported on directories …; userspace must not assume the bit is directory-only.”（v7.2 起，文件系统若从挂载/卷状态推导不敏感，也可能在非目录 inode 上报告）。
- 子目录继承：`EXT4_FL_INHERITED` 含 `EXT4_CASEFOLD_FL`，`ext4_new_inode` 以父目录标志经 `ext4_mask_flags` 初始化；普通文件被 `EXT4_REG_FLMASK` 屏蔽该位（所以对**普通文件**查 `FS_IOC_GETFLAGS` 永远得不到该位）。
- 版本：ext4 casefold 特性在 v5.2 的 `ext4.h` 出现（v5.1 无）；f2fs 的 `F2FS_CASEFOLD_FL` 在 v5.4 出现（v5.3 无）；tmpfs 的 `casefold` 挂载选项在 v6.13 出现（v6.12 无）。（三处均用 `curl` 取各标签 `ext4.h`、`f2fs.h`、`shmem.c` 后 grep 计数，v5.1/v5.3/v6.12 为 0，v5.2/v5.4/v6.13 非 0。）
- 比较算法（ext4 / f2fs / tmpfs 共用 `fs/unicode`）：`utf8_strncasecmp` 用 `UTF8_NFDICF`。`include/linux/unicode.h` 注释：“NFDICF - Apply unicode normalization form NFD. - Remove any Default_Ignorable_Code_Point. - Apply a full casefold (C + F).” 数据版本固定：`#define UTF8_LATEST UNICODE_AGE(12, 1, 0)`，ext4 编码表 `ext4_sb_encoding_map[]` 只有一项 `{EXT4_ENC_UTF8_12_1, "utf8", UNICODE_AGE(12, 1, 0)}`；`mkutf8data.c` 仅取 `CaseFolding.txt` 中状态 `C` 与 `F` 的行（`if (status != 'C' && status != 'F')`）。ext4 文档：“The comparison algorithm is implemented by normalizing the strings to the Canonical decomposition form, as defined by Unicode, followed by a byte per byte comparison.” 且“name-preserving on the disk”。
- 严格模式：ext4 遇到非法 UTF-8 名且未开 strict 时“falls back to considering the entire string as an opaque byte sequence … the case-insensitive lookups won't work”。

#### 问 2：`ioctl(FS_IOC_GETFLAGS)` 怎么用？哪些文件系统支持？对目录与文件的要求？

答：

- 用法：`fd = open(目录, O_RDONLY|O_DIRECTORY)`；`ioctl(fd, FS_IOC_GETFLAGS, &attr)`。`ioctl_iflags(2)`：“fd = open("pathname", ...); ioctl(fd, FS_IOC_GETFLAGS, &attr);”。**`ioctl_iflags(2)` 没有列出 `FS_CASEFOLD_FL`（该页的标志清单到 `FS_UNRM_FL` 为止），该位只在 uapi 头文件、`chattr(1)`、ext4/tmpfs 文档里出现。**
- 缓冲区宽度：内核 `ioctl_getflags` 写入的是 `unsigned int __user *argp`（4 字节，`put_user(fa.flags, argp)`），而请求号 `_IOR('f', 1, long)` 在 64 位编码的是 8 字节。用 32 位变量接收（rustix 的封装也这样做，64 位用 `FS_IOC_GETFLAGS`、32 位用 `FS_IOC32_GETFLAGS`，缓冲区 `u32`）。
- 不支持的文件系统：`vfs_fileattr_get` 在 inode 没有 `->fileattr_get` 时返回 `-ENOIOCTLCMD`，随后落到 `vfs_ioctl`，`-ENOIOCTLCMD` 被改写为 `-ENOTTY`。所以**不支持的文件系统返回 `ENOTTY`**（源码推导；errno 未实机核对）。
- 谁实现了 casefold 位（v7.2 源码）：ext4（`ext4_fileattr_get` 经 `fileattr_fill_flags`）、f2fs（`F2FS_GETTABLE_FS_FL` 含 `FS_CASEFOLD_FL`）、tmpfs（`shmem_fileattr_get`）；以及 v7.2 新增的 vfat/msdos、exfat、ntfs3、cifs（仅目录）、nfs、xfs、hfs、hfsplus、isofs、vboxsf（合并提交 `5d15ab717d503ff10b585a144870648b9a88c616`，“Merge tag 'vfs-7.2-rc1.casefold'”，2026-06-15；补丁系列 “Exposing case folding behavior”，作者 Chuck Lever，提交说明日期 2026-05-07）。**ZFS 与 btrfs 没有该位**（ZFS：`__zpl_ioctl_getflags` 只映射 `z_pflags`；btrfs：没有 casefold）。
- 新接口：`FS_IOC_FSGETXATTR` / `file_getattr(2)` 系统调用的 `fsx_xflags`/`fa_xflags` 带 `FS_XFLAG_CASEFOLD = 0x00040000`、`FS_XFLAG_CASENONPRESERVING = 0x00080000`，“Default (neither set) indicates POSIX semantics: case-sensitive lookups and case-preserving storage.” 二者加入 `FS_XFLAG_RDONLY_MASK`（不能通过 ioctl 设置）。`file_getattr` 系统调用在 v6.17 的 `fs/file_attr.c` 出现（v6.16 无）。
- **“未置位 = 区分大小写”只对实现了该接口的文件系统成立。** 旧内核的 vfat 没有 `fileattr_get`（v6.8、v7.1 的 `fs/fat/file.c` 里没有，`fs/fat/dir.c` 只有 `FAT_IOCTL_GET_ATTRIBUTES`），ioctl 会失败而不是返回 0；但 xfs 等“成功返回 0 却不含大小写信息”的旧实现会产生**假的 `Sensitive`**（xfs ascii-ci 在 v7.2 前不报告，未验证具体版本）。因此建议只对 `f_type ∈ {ext4, f2fs, tmpfs}` 把“位未置位”解释为 `Sensitive`，对其他类型按各自规则或行为探测。

#### 问 3：`statfs` 的 `f_type` 对 FUSE 的表现？

答：FUSE 统一返回 `FUSE_SUPER_MAGIC`。内核 `fs/fuse/inode.c`：`convert_fuse_statfs` 里 `stbuf->f_type = FUSE_SUPER_MAGIC;`，进程无权访问时 `buf->f_type = FUSE_SUPER_MAGIC; return 0;`，超级块 `sb->s_magic = FUSE_SUPER_MAGIC;`。守护进程提供的 statfs 数据不含 `f_type`。`statfs(2)` 手册列有 `FUSE_SUPER_MAGIC 0x65735546`。所以 ntfs-3g、sshfs、exfat-fuse 的 `f_type` 无法互相区分，只能读 `/proc/self/mountinfo` 的文件系统类型串 `type[.subtype]`（第 9 段）或做行为探测。`statmount(2)` 需要 `CAP_SYS_ADMIN`，桌面应用不能用。

#### 问 4：vfat、exfat、ntfs3 的大小写语义

- **vfat**：`setup()` 里 `if (MSDOS_SB(sb)->options.name_check != 's') set_default_d_op(sb, &vfat_ci_dentry_ops); else set_default_d_op(sb, &vfat_dentry_ops);`。不敏感路径 `vfat_cmpi` → `nls_strnicmp(t, ...)`，`nls_strnicmp` 逐**字节**比较 `nls_tolower(t, c)`（`t->charset2lower[c]`）。`fat_search_long` 的 `fat_name_match` 同样逐字节。文档：`check=s|r|n`，“s: strict, case sensitive; r: relaxed, case insensitive; n: normal, default setting, currently case insensitive”。`FAT_DEFAULT_IOCHARSET` 默认 `iso8859-1`，`FAT_DEFAULT_UTF8` 默认 `n`；文档“iocharset=utf8 is not recommended”。`nls_utf8.c` 的 `charset2lower = identity`（“no conversion”）。后果：ASCII 字母折叠（iso8859-1 表 `0x41→0x61`），UTF-8 多字节字符基本不折叠（调研员用 `nls_iso8859-1.c` 的表复算，对应小节的“D. 向量判定”表）；`iocharset=utf8` 时连 ASCII 都不折叠（推导）。末尾的点被忽略（`vfat_striptail_len`）。无规范化（`fs/fat` 不含 `linux/unicode.h`）。
- **exfat**：`exfat_d_cmp` / `exfat_utf8_d_cmp` 对每个 UTF-16 单元（或 ≤U+FFFF 的码点）比较 `exfat_toupper(sb, c)`，即 `sbi->vol_utbl[a] ? sbi->vol_utbl[a] : a`；`exfat_utf8_d_hash` 注释“`exfat_toupper()` works only for code points up to the U+FFFF.”，超出的码点按原值比较。upcase 表优先取卷上的（`exfat_create_upcase_table` 校验后加载），否则用内核默认表 `uni_def_upcase`（调研员解压该表复算，见 D）。无规范化（`fs/exfat` 不含 `linux/unicode.h`）。
- **ntfs3**：见总表 ⑥。比较用卷的 `$UpCase`（`sbi->upcase`，`ntfs_d_hash`/`ntfs_d_compare` 的慢路径 “Try slow way with current upcase table”），但仅在 `nocase` 时安装；默认 `d_op` 为 `NULL`（字节比较），`index.c` 的 `both_case = f2->type != FILE_NAME_DOS && !sbi->options->nocase`（先不敏感比较，再用大小写敏感比较打破平局，因此仅大小写不同的两个名字可共存）。**v6.1 及以前没有 `nocase` 选项**：`fs/ntfs3/super.c` 在 v5.15、v6.1 里没有 `nocase` 字样，`index.c` 里是 `both_case = f2->type != FILE_NAME_DOS /*&& !sbi->options.nocase*/;`；v6.2 起有。
- **ntfs-3g（FUSE）**与新旧 `fs/ntfs` 驱动见总表 ⑤、⑥。

#### 问 5：cifs 的 `nocase`

答：见总表 ⑦。mount.cifs(8)：“nocase Request case insensitive path name matching (case sensitive is the default if the server supports it).” “ignorecase Synonym for nocase.” 内核：`cifs_sb` 设置时 `if (tcon->nocase) set_default_d_op(sb, &cifs_ci_dentry_ops); else set_default_d_op(sb, &cifs_dentry_ops);`；`cifs_ci_hash` 用 `cifs_toupper(c)`（客户端本地表）。show_options：`if (tcon->nocase) seq_puts(s, ",nocase");`。v7.2 起 `cifs_fileattr_get`：目录上“The authoritative source is the server itself: … FILE_CASE_SENSITIVE_SEARCH and FILE_CASE_PRESERVED_NAMES”。`cifs_fileattr_get` 注释说明文件上不报告（“Confine the case-handling bits to directories”）。

#### 问 6：zfs 的 `casesensitivity`

答：见总表 ⑨。`zfsprops(7)`：“The default value for the casesensitivity property is sensitive.” “Currently, case-insensitive matching behavior on a file system that supports mixed behavior is limited to the SMB server product.” “The following three properties cannot be changed after the file system is created”（`casesensitivity`、`normalization`、`utf8only`）。`zpl_lookup`：“If we are a case insensitive fs, we need the real name … zfs_flags = FIGNORECASE;”。

#### 问 7：btrfs 的行为

答：见总表 ⑩，始终区分大小写，无 casefold；`btrfs_dentry_operations` 只含 `.d_delete`。

#### 问 8：tmpfs 与 nfs

答：见总表 ③、⑧。

#### 来源表

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://docs.kernel.org/admin-guide/ext4.html | 2026-10-18 | 内核或标准库文档 | “It is enabled by flipping the +F inode attribute of an empty directory.”；“By default, the charset adopted is the latest version of Unicode (12.1.0, by the time of this writing), encoded in the UTF-8 form.” |
| https://man7.org/linux/man-pages/man1/chattr.1.html | 2026-10-18 | 官方文档（man-pages 站） | “F A directory with the 'F' attribute set indicates that all the path lookups inside that directory are made in a case-insensitive fashion.” |
| https://man7.org/linux/man-pages/man8/mke2fs.8.html | 2026-10-18 | 官方文档 | “encoding=encoding-name Enable the casefold feature in the super block and set encoding-name as the encoding to be used.” |
| https://man7.org/linux/man-pages/man2/ioctl_iflags.2.html | 2026-10-18 | 官方文档 | “ioctl(fd, FS_IOC_GETFLAGS, &attr); /* Place current flags in 'attr' */”；该页未列 `FS_CASEFOLD_FL` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/uapi/linux/fs.h?id=v7.2 | 2026-10-18 | 项目源码（`fs.h`，标签 v7.2，提交 `8d3ae59288f1e7d58d76558a6ee96d533bc5019f`） | `#define FS_IOC_GETFLAGS _IOR('f', 1, long)`；`#define FS_CASEFOLD_FL 0x40000000`；`#define FS_XFLAG_CASEFOLD 0x00040000`；`#define FS_XFLAG_CASENONPRESERVING 0x00080000` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/uapi/linux/magic.h?id=v7.2 | 2026-10-18 | 项目源码（同上） | `EXT4_SUPER_MAGIC 0xEF53`；`BTRFS_SUPER_MAGIC 0x9123683E`；`TMPFS_MAGIC 0x01021994`；`FUSE_SUPER_MAGIC 0x65735546`；`MSDOS_SUPER_MAGIC 0x4d44`；`EXFAT_SUPER_MAGIC 0x2011BAB0`；`NFS_SUPER_MAGIC 0x6969`；`CIFS_SUPER_MAGIC 0xFF534D42`；`SMB2_SUPER_MAGIC 0xFE534D42`；`F2FS_SUPER_MAGIC 0xF2F52010`；`SMB_SUPER_MAGIC 0x517B`。**没有 NTFS、ZFS 的常量。** |
| https://man7.org/linux/man-pages/man2/statfs.2.html | 2026-10-18 | 官方文档 | 列出 `FUSE_SUPER_MAGIC 0x65735546`、`NTFS_SB_MAGIC 0x5346544e`、`CIFS_MAGIC_NUMBER 0xff534d42`、`MSDOS_SUPER_MAGIC 0x4d44`、`NFS_SUPER_MAGIC 0x6969` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/file_attr.c?id=v7.2 | 2026-10-18 | 项目源码 | `vfs_fileattr_get`：`if (!inode->i_op->fileattr_get) return -ENOIOCTLCMD;`；`ioctl_getflags`：`put_user(fa.flags, argp)`；`SYSCALL_DEFINE5(file_getattr, ...)` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ioctl.c?id=v7.2 | 2026-10-18 | 项目源码 | `vfs_ioctl`：`if (error == -ENOIOCTLCMD) error = -ENOTTY;` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ext4/ioctl.c?id=v7.2 | 2026-10-18 | 项目源码 | `ext4_ioctl_setflags`（翻转 `EXT4_CASEFOLD_FL` 时 `-EOPNOTSUPP`/`-ENOTDIR`/`-ENOTEMPTY`）；`ext4_fileattr_get` 用 `EXT4_FL_USER_VISIBLE` + `fileattr_fill_flags` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ext4/ext4.h?id=v7.2 | 2026-10-18 | 项目源码 | `EXT4_REG_FLMASK` 含 `~EXT4_CASEFOLD_FL`；`EXT4_FL_INHERITED` 含 `EXT4_CASEFOLD_FL`；`ext4_mask_flags` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/unicode.h?id=v7.2 | 2026-10-18 | 项目源码 | “2) NFDICF - Apply unicode normalization form NFD. - Remove any Default_Ignorable_Code_Point. - Apply a full casefold (C + F).”；`UTF8_LATEST UNICODE_AGE(12, 1, 0)` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/unicode/mkutf8data.c?id=v7.2 | 2026-10-18 | 项目源码 | `nfdicf_init`：`/* Use the C+F casefold. */ if (status != 'C' && status != 'F')` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/unicode/README.utf8data?id=v7.2 | 2026-10-18 | 项目源码 | “The utf8data.c file in this directory is generated from the Unicode Character Database for version 12.1.0”；`CaseFolding.txt` md5 `900e76da1d822a160fd6b8c0b1d70094`（调研员下载 `https://www.unicode.org/Public/12.1.0/ucd/CaseFolding.txt` 复算 md5 与 sha1 `dc9245f6…` 均一致） |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/unicode/tests/utf8_kunit.c?id=v7.2 | 2026-10-18 | 项目源码 | KUnit 向量：ß→`ss`；`CHEROKEE SMALL LETTER A`（UTF-8 `ea ad b0`，即 U+AB70）折叠为 `CHEROKEE LETTER A`（`e1 8e a0`，U+13A0）；“Cherokee letters … fold to upper-case.” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fat/namei_vfat.c?id=v7.2 | 2026-10-18 | 项目源码 | `setup()` 按 `name_check != 's'` 选 `vfat_ci_dentry_ops`；`vfat_cmpi` → `nls_strnicmp`；`vfat_striptail_len` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fat/dir.c?id=v7.2 | 2026-10-18 | 项目源码 | `fat_name_match`：`if (sbi->options.name_check != 's') return !nls_strnicmp(sbi->nls_io, a, b, a_len); else return !memcmp(...)` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/nls.h?id=v7.2 | 2026-10-18 | 项目源码 | `nls_tolower`：`t->charset2lower[c]`；`nls_strnicmp` 逐字节 |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/nls/nls_utf8.c?id=v7.2 | 2026-10-18 | 项目源码 | `.charset2lower = identity, /* no conversion */` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/nls/nls_iso8859-1.c?id=v7.2 | 2026-10-18 | 项目源码 | `charset2lower[256]`（调研员解析表：`0x41→0x61`，`0x89→0x89`，`0xa9→0xa9`） |
| https://docs.kernel.org/filesystems/vfat.html | 2026-10-18 | 内核或标准库文档 | “check=s\|r\|n Case sensitivity checking setting. s: strict, case sensitive …”；“iocharset=utf8 is not recommended.” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=c92db2ca726fe61a66580d30ecff8c192a791935 | 2026-10-18 | 项目源码（补丁，作者 Chuck Lever，2026-05-07） | `fat_fileattr_get`：“VFAT becomes case-sensitive when mounted with 'check=strict'”；非 vfat 加 `FS_XFLAG_CASENONPRESERVING` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/exfat/namei.c?id=v7.2 | 2026-10-18 | 项目源码 | `exfat_d_cmp`；`exfat_utf8_d_hash` 注释 “exfat_toupper() works only for code points up to the U+FFFF.” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/exfat/nls.c?id=v7.2 | 2026-10-18 | 项目源码 | `exfat_toupper`；`uni_def_upcase[EXFAT_NUM_UPCASE]`（2918 项压缩表）；`exfat_load_default_upcase_table` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=27e0b573dd4aa927670fbfd84732e569fde72078 | 2026-10-18 | 项目源码（补丁） | “exFAT compares names through the volume's upcase table; in practice that table folds case, and case is preserved at rest.” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/super.c?id=v7.2 | 2026-10-18 | 项目源码 | `fsparam_flag("nocase", Opt_nocase)`；`set_default_d_op(sb, options->nocase ? &ntfs_dentry_ops : NULL);`；`sb->s_magic = 0x7366746e; // "ntfs"`；show_options：`if (opts->nocase) seq_puts(m, ",nocase");` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/index.c?id=v7.2 | 2026-10-18 | 项目源码 | `both_case = f2->type != FILE_NAME_DOS && !sbi->options->nocase;` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=eeb7b37b9700f0dbb3e6fe7b9e910b466ac190dd | 2026-10-18 | 项目源码（补丁） | “Case sensitivity depends on mount options: with "nocase", NTFS is case-insensitive; otherwise it is case-sensitive.” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/log/fs/ntfs3/namei.c?id=v6.6 | 2026-10-18 | 项目源码（提交列表） | “2022-09-30 fs/ntfs3: Add option "nocase" Konstantin Komarov”；v6.1 的 `super.c` 无 `nocase`，v6.2 有（`curl` 逐标签 grep 计数） |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs/super.c?id=v7.2 | 2026-10-18 | 项目源码 | 新驱动：`NVolSetCaseSensitive(vol);`（`ntfs_init_fs_context` 默认）；`fsparam_flag("nocase", Opt_nocase)`；`.name = "ntfs"`；`sb->s_magic = NTFS_SB_MAGIC`；该文件在 v7.0 为 404、v7.1 为 200 |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/Documentation/filesystems/ntfs.rst?id=v6.8 | 2026-10-18 | 内核或标准库文档 | 旧 ntfs 驱动：“Otherwise the default behaviour is to treat file names as case insensitive”（选项 `case_sensitive=<BOOL>`）；v6.8 的 `fs/ntfs/super.c` 同样 `sb->s_magic = NTFS_SB_MAGIC`；旧驱动由 “2024-01-24 fs: Remove NTFS classic” 删除 |
| https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/libntfs-3g/dir.c （`edge`，提交 `7f0f841fc52cf719106c5c93bafe465004e36816`） | 2026-10-18 | 项目源码 | `ntfs_inode_lookup_by_name`：“If the volume is mounted with the case sensitive flag set, then we only allow exact matches.” |
| https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/libntfs-3g/volume.c | 2026-10-18 | 项目源码 | `ntfs_volume_alloc`：“Default with no locase table and case sensitive file names … NVolSetCaseSensitive(vol);”；`ntfs_set_ignore_case` 才 `NVolClearCaseSensitive` |
| https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/src/ntfs-3g.8.in | 2026-10-18 | 官方文档（项目手册源） | “This means that filenames are case sensitive and all characters are allowed except '/' and '\\0'.”；“ignore_case (only with lowntfs-3g)” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/smb/client/cifsfs.c?id=v7.2 | 2026-10-18 | 项目源码 | `sb->s_magic = CIFS_SUPER_MAGIC;`；`if (tcon->nocase) set_default_d_op(sb, &cifs_ci_dentry_ops)`；show_options `",nocase"` |
| https://man7.org/linux/man-pages/man8/mount.cifs.8.html | 2026-10-18 | 官方文档 | “nocase Request case insensitive path name matching (case sensitive is the default if the server supports it).” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=e50bc12f5a3653c0ab1bbb80b427efd96eb6208d | 2026-10-18 | 项目源码（补丁） | `cifs_fileattr_get`（仅目录；`FILE_CASE_SENSITIVE_SEARCH`；无答复回退 `tcon->nocase`） |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=92d67628a1a91c0585e004ffce8975c7898f9ed1 | 2026-10-18 | 项目源码（补丁） | `nfs_fileattr_get`；“NFSv2 lacks PATHCONF support, so mounts using that protocol version default to standard POSIX behavior”；“"server said no" and "server did not answer" both collapse to the case-sensitive default” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=3035e4454142327ec5faee2ff57ab7cb1e9fc712 | 2026-10-18 | 项目源码（补丁） | “Filesystems report case-insensitive or case-nonpreserving behavior by setting these flags … The default (flags unset) indicates POSIX semantics”；`FS_XFLAG_RDONLY_MASK` 加入两个新位 |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/log/?id=v7.2&qt=grep&q=case+sensitiv | 2026-10-18 | 项目源码（提交列表） | 合并 “Merge tag 'vfs-7.2-rc1.casefold'” 2026-06-15；系列各提交清单（nfsd、ksmbd、isofs、vboxsf、nfs、cifs、xfs、hfsplus、hfs、ntfs3、exfat、fat、fs 核心） |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=v7.2 | 2026-10-18 | 项目源码 | “Linux 7.2 … 2026-08-16 14:32:26 -0700”，提交 `8d3ae59288f1e7d58d76558a6ee96d533bc5019f` |
| https://docs.kernel.org/filesystems/tmpfs.html | 2026-10-18 | 内核或标准库文档 | “casefold Enable casefold support at this mount point using the given argument as the encoding standard.”；“This option doesn't render the entire filesystem case-insensitive. One needs to still set the casefold flag per directory, by flipping the +F attribute in an empty directory.”；“The mountpoint itself cannot be made case-insensitive.” |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/mm/shmem.c?id=v7.2 | 2026-10-18 | 项目源码 | `shmem_fileattr_get`；`shmem_inode_casefold_flags`；`fsparam_string("casefold", Opt_casefold_version)` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/f2fs/file.c?id=v7.2 | 2026-10-18 | 项目源码 | `F2FS_GETTABLE_FS_FL`/`F2FS_SETTABLE_FS_FL` 含 `FS_CASEFOLD_FL`；翻转时 `-EOPNOTSUPP`/`-ENOTEMPTY` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fuse/inode.c?id=v7.2 | 2026-10-18 | 项目源码 | `convert_fuse_statfs`：`stbuf->f_type = FUSE_SUPER_MAGIC;` |
| https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/btrfs/inode.c?id=v7.2 | 2026-10-18 | 项目源码 | `const struct dentry_operations btrfs_dentry_operations = { .d_delete = btrfs_dentry_delete, };` |
| https://raw.githubusercontent.com/openzfs/zfs/master/man/man7/zfsprops.7 （提交 `7c3d85aaf1670d7386b0d4a157ef4ce96e17cba2`） | 2026-10-18 | 官方文档 | “The default value for the casesensitivity property is sensitive.”；“Currently, case-insensitive matching behavior on a file system that supports mixed behavior is limited to the SMB server product.”；“The following three properties cannot be changed after the file system is created” |
| https://raw.githubusercontent.com/openzfs/zfs/master/include/sys/fs/zfs.h | 2026-10-18 | 项目源码 | 第 1561 行 `#define ZFS_SUPER_MAGIC 0x2fc12fc1`；`module/os/linux/zfs/zfs_vfsops.c` 里 `statp->f_type = ZFS_SUPER_MAGIC;`、`sb->s_magic = ZFS_SUPER_MAGIC;` |
| https://raw.githubusercontent.com/openzfs/zfs/master/module/os/linux/zfs/zpl_inode.c | 2026-10-18 | 项目源码 | `zpl_lookup`：“If we are a case insensitive fs, we need the real name … if (zfsvfs->z_case == ZFS_CASE_INSENSITIVE) { zfs_flags = FIGNORECASE;” |

**对本项目的启示：** Linux 上没有单一 API 能给出“项目根是否大小写敏感”：只有 ext4/f2fs/tmpfs 的目录位是权威的，其余类型要么由挂载选项（vfat、ntfs3、cifs）、数据集属性（zfs）、服务端（cifs、nfs）、守护进程（FUSE）决定；因此“已知不敏感类型表”应改成“类型 → 需要读哪个挂载选项/用哪种探测”的表，且表中不能含 ntfs/ntfs3（默认敏感）。读 `/proc/self/mountinfo`（按 `st_dev` 的 major:minor 匹配）能补足 vfat/ntfs3/cifs 的选项，行为探测留给 FUSE/nfs/zfs/cifs。

#### B2. 可选的 mountinfo 读取（作为总表“探测方法”的补充）

答：`proc_pid_mountinfo(5)`：第 3 段“major:minor: the value of st_dev for files on this filesystem”，第 9 段“the filesystem type in the form "type[.subtype]"”，第 11 段“per-superblock options”。vfat 的 `check=%c`（`fat_show_options` 在 `name_check != 'n'` 时输出）、ntfs3 与 cifs 的 `,nocase` 均由各自 show_options 写入（见来源表中 `fs/fat/inode.c`、`fs/ntfs3/super.c`、`fs/smb/client/cifsfs.c` 对应位置）。来源：https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html （2026-10-18，官方文档，已验证）；`fs/fat/inode.c` 第 992–993 行 `if (opts->name_check != 'n') seq_printf(m, ",check=%c", opts->name_check);`（https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fat/inode.c?id=v7.2 ，项目源码，已验证）。**`statmount(2)` 需要 `CAP_SYS_ADMIN`，不可用**（https://man7.org/linux/man-pages/man2/statmount.2.html ，官方文档，已验证）。

#### E1. 探测链各步在 Linux 的落点

1. **取 `f_type`**：`fstatfs(root_dir_fd)`（对项目根目录 fd，`open(O_RDONLY|O_DIRECTORY|O_CLOEXEC)`）。结构 `statfs.f_type` 类型为 `__fsword_t`。`statfs(2)`：“Unless you need the f_type field, you should use the standard statvfs(3) interface instead.”
2. **魔数表（出处均为 `include/uapi/linux/magic.h`@v7.2，除注明外）：**

<!-- prettier-ignore -->
| 类型 | 常量 | 值 | 头文件/出处 | `libc` 0.2.186 是否有 |
| --- | --- | --- | --- | --- |
| ext2/3/4 | `EXT4_SUPER_MAGIC` | `0xEF53` | `magic.h` | 有（`src/unix/linux_like/mod.rs`） |
| tmpfs | `TMPFS_MAGIC` | `0x01021994` | `magic.h` | 有 |
| vfat/msdos | `MSDOS_SUPER_MAGIC` | `0x4d44` | `magic.h` | 有 |
| exfat | `EXFAT_SUPER_MAGIC` | `0x2011BAB0` | `magic.h` | **无** |
| 旧 ntfs（≤v6.8）与新 ntfs（≥v7.1） | `NTFS_SB_MAGIC` | `0x5346544e` | 内核 `fs/ntfs/ntfs.h` 第 79 行（v7.2）；`statfs(2)` 手册；**不在 `magic.h`** | **无** |
| ntfs3 | 字面量 `0x7366746e`（`"ntfs"`） | `0x7366746e` | `fs/ntfs3/super.c` 第 1286 行 | **无** |
| cifs | `CIFS_SUPER_MAGIC` | `0xFF534D42` | `magic.h`；`fs/smb/client/cifsfs.c` 第 248 行使用 | **无**（`libc` 只有 `SMB_SUPER_MAGIC 0x517b`） |
| SMB2（定义但 cifs 不用） | `SMB2_SUPER_MAGIC` | `0xFE534D42` | `magic.h` | 无 |
| nfs（v2/3/4） | `NFS_SUPER_MAGIC` | `0x6969` | `magic.h` | 有 |
| zfs | `ZFS_SUPER_MAGIC` | `0x2fc12fc1` | OpenZFS `include/sys/fs/zfs.h` 第 1561 行；内核树无 | **无** |
| btrfs | `BTRFS_SUPER_MAGIC` | `0x9123683E` | `magic.h` | 有 |
| FUSE（含 fuseblk、sshfs、ntfs-3g） | `FUSE_SUPER_MAGIC` | `0x65735546` | `magic.h`；`fs/fuse/inode.c` | 有 |
| f2fs | `F2FS_SUPER_MAGIC` | `0xF2F52010` | `magic.h` | 有 |

状态：以上值均**已验证**（读到源码行）；“libc 是否有”见 E5。

3. **casefold 标志**：仅对 `f_type ∈ {ext4, f2fs, tmpfs}` 把“位未置位”解释为 `Sensitive`；对其余类型，位已置位可直接信 `Insensitive`（v7.2 起 vfat/exfat/ntfs3/cifs/nfs 会置位），位未置位不能信（旧内核该 ioctl 要么 `ENOTTY` 要么不含此信息）。
4. **必须落到行为探测（或 mountinfo 选项）的位置**：FUSE（ntfs-3g、sshfs、exfat-fuse）、cifs（`nocase` 与服务端）、nfs（服务端）、zfs（数据集属性）、vfat 的 `iocharset=utf8`、ntfs3/新 ntfs 的 `nocase` 选项读不到时、以及 `f_type` 未知的一切类型。
5. **降级**：任何一步失败 → 下一步，最终 `Unknown`（不折叠）。

#### E2. 规范化轴

- Linux 上**可靠探测**只有两类：casefold 目录（NFD，`Yes`）和 ZFS（需读属性，权限未验证）。其他文件系统的规范化轴按类型固定为 `No`（vfat、exfat、ntfs3、ntfs 新旧、ntfs-3g、btrfs、ext4 默认）是**源码可证**的（这些驱动不含 Unicode 规范化调用，部分验证：只做了字符串搜索 `linux/unicode.h`、`utf8_normalize` 等，未逐文件读完）。cifs/nfs/其他 FUSE 为 `Unknown`（服务端决定）。
- 建议：Linux 的规范化轴“不做行为探测”，直接按文件系统类型/目录位推断，推断不了则 `Unknown`。理由：规范化探测需要创建带非 ASCII 字符的文件名，在 vfat（`iocharset` 非 UTF-8）等位置会失败或产生副作用，且源码已经给出了类型到结论的映射。
- 不能固定为统一的 `No`：casefold 目录上 NFC/NFD 同名，固定 `No` 会漏折叠（影响仅是多出一个文档，文件身份兜底会拦住）。

#### E3. 硬链接盲区

- `st_nlink` 的含义：`statx(2)` 的 `stx_nlink` 是“The number of hard links on a file.”（`stat(2)` 示例同样打印 `st_nlink`）。同一文件有另一个硬链接名时 `st_nlink >= 2`，与“翻转大小写后找到同一 (dev, ino)”在敏感文件系统上的假阳性来源一致，因此“普通文件且链接数为 1”的筛选在 Linux 上**合理且必要**（也要用 `lstat` 语义，符号链接不当作候选，`symlink_metadata`）。
- 但它不充分，Linux 上还有这些盲区（均未实机，来源标注）：
  1. **FUSE 且未开 `use_ino`**：libfuse 文档“The 'st_ino' field is ignored except if the 'use_ino' mount option is given … libfuse and the kernel will still assign a different inode for internal use (called the "nodeid")”，且 `fuse.c` 的节点表以 `name_hash(f, parent, name)` / `find_node(f, parent, name)` 按“父目录+名称”建键（部分验证）。结果：在不敏感的后端上，翻转后的名字能被找到但 `st_ino` 不同，会被判成“找到但身份不同 → `Sensitive`”（漏折叠方向，安全但不准）。ntfs-3g 自己传 `-ouse_ino,kernel_cache`（`ntfs-3g.c` 第 4259、4268、4272 行），不受此影响。
  2. **cifs `noserverino`**：`inode.c` 里 `if (!(cifs_sb_flags(cifs_sb) & CIFS_MOUNT_SERVER_INUM)) fattr->cf_uniqueid = iunique(sb, ROOT_I);`，每个路径解析得到新 inode 号（部分验证），同一问题。
  3. **链接数不可靠的文件系统**（部分 FUSE/网络文件系统可能一律报 1）：未验证。
  4. 候选条目稀缺：项目根只有目录和多链接文件时进入临时文件分支。
- 建议：判定“身份相同”时同时比较 `st_dev` 与 `st_ino`；对 FUSE/cifs，把“找到但身份不同”视为**不可信**（映射到 `Unknown`，而不是 `Sensitive`），除非 mountinfo 里能证明 `serverino`/`use_ino`。

#### E4. 行为探测的副作用在 Linux 上的已知经验

- **inotify（官方手册）**：监视目录会收到 `IN_CREATE`（“File/directory created in watched directory (e.g., open(2) O_CREAT …)”）、`IN_DELETE`、`IN_OPEN`、`IN_CLOSE_WRITE`、`IN_ATTRIB`（链接数变化也会触发）。来源 https://man7.org/linux/man-pages/man7/inotify.7.html （已验证）。所以**临时文件探测一定会被监视项目根的 inotify 观察者看到**：创建/打开/关闭/删除各一组事件。
- “已有条目换大小写”只调用 `lstat`/`symlink_metadata`；该手册的事件清单里没有 stat/路径查找类事件（部分验证，来自事件清单的缺席，非明文）。fanotify 同理（`fanotify(7)` 已下载，未逐条核对 `FAN_*` 事件，未验证）。
- **同步工具**：Syncthing 文档只说明 `caseSensitiveFS=false` 时会做大小写冲突检查（https://docs.syncthing.net/advanced/folder-caseSensitiveFS.html ，官方文档，已验证）；Syncthing 的 wiki 页把“通过创建两个大小写冲突的文件并观察结果来自动检测大小写敏感性”列为**备选提案**之一（https://github.com/syncthing/syncthing/wiki/Filesystem-Case-Sensitivity ，社区讨论，降级），并非已采纳的实现。对 Syncthing/Dropbox/构建工具监听临时文件的实际影响，未找到可靠来源，**未验证**。
- 推荐的缓解（设计层，非来源结论）：临时文件名使用专用前缀且尽量放在监听器常见的排除模式内；探测次数以项目为单位缓存（草案已有）；只读项目目录不创建（草案已有）。

#### E5. 若用 Rust 调用：`libc` 与 `rustix`（只评估，不改依赖）

`src-tauri/Cargo.toml`：`[target.'cfg(unix)'.dependencies] libc = "0.2"`（已是直接依赖）；`Cargo.lock`：`libc` 0.2.186、`rustix` 1.1.4、`cap-primitives` 4.0.3、`linux-raw-sys` 0.12.1、`nix` 0.28.0（传递依赖）。本机 `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/libc-0.2.186/`、`.../rustix-1.1.4/` 源码。

<!-- prettier-ignore -->
| 项 | `libc` 0.2.186 | `rustix` 1.1.4 | 状态 |
| --- | --- | --- | --- |
| `fstatfs` | 有：`src/unix/linux_like/mod.rs` 第 1911 行 `pub fn fstatfs(fd: c_int, buf: *mut statfs) -> c_int;`；`statfs.f_type: __fsword_t`（`gnu/b64/x86_64/mod.rs`） | 有：`rustix::fs::fstatfs`（`src/fs/fd.rs` 第 181 行），`StatFs.f_type: FsWord`（`linux_raw/fs/types.rs`）；`fs` 特性 | 已验证（读到源码行） |
| `ioctl` | 有：`pub fn ioctl(fd: c_int, request: Ioctl, ...) -> c_int;`（`linux_like/mod.rs` 第 1731 行） | 有 `rustix::ioctl`，另有专用封装 | 已验证 |
| `FS_IOC_GETFLAGS` | 有：`pub const FS_IOC_GETFLAGS: Ioctl = _IOR::<c_long>('f' as u32, 1);`（`linux_like/mod.rs` 第 1483 行） | 封装 `rustix::fs::ioctl::ioctl_getflags(fd) -> io::Result<IFlags>`（`src/fs/ioctl.rs` 第 142 行）：64 位用 `FS_IOC_GETFLAGS`、32 位用 `FS_IOC32_GETFLAGS`，缓冲区为 `u32` | 已验证 |
| `FS_CASEFOLD_FL` | **无**（全库搜索 `FS_CASEFOLD_FL`、`FS_XFLAG_CASEFOLD` 无结果）；需本地定义 `0x4000_0000` | `IFlags` 没有该常量，但 `from_bits_retain` 保留未知位，可用 `flags.bits() & 0x4000_0000`；`linux-raw-sys` 0.12.1 含该常量（见 Rust crate 小节 B5，`src/x86_64/general.rs` 第 1525 行） | 已验证 |
| 各 `*_SUPER_MAGIC` | 有：EXT4、TMPFS、MSDOS、NFS、FUSE、BTRFS、F2FS、`SMB_SUPER_MAGIC`；**无**：EXFAT、`CIFS_SUPER_MAGIC`、ntfs（两种）、ZFS | 只有 `PROC_SUPER_MAGIC`、`NFS_SUPER_MAGIC` 两个公开常量（`src/fs/fd.rs`） | 已验证 |
| 类型注意 | `f_type` 在 32 位目标可能是有符号 32 位，比较 `0xFF534D42`、`0xF2F52010` 时需先转 `u32`；`libc` 常量类型因目标是 `c_long` 或 `c_uint` | `FsWord` | 推断 |
| 是否需要新增依赖 | 否（已有，`cfg(unix)`） | `rustix` 已在 `Cargo.lock`（经 `cap-primitives` 以 `fs`、`process`、`termios`、`time` 特性启用，`cap-primitives-4.0.3/Cargo.toml` 第 73–79 行）；若要直接使用需在 `Cargo.toml` 声明 `rustix = { version = "1", features = ["fs"] }`，不引入新 crate，但属于新增直接依赖声明，需评审。许可证 `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`（`rustix` Cargo.toml 第 52 行），与 MIT 兼容 | 已验证 |

`cap-primitives` 4.0.3 源码中没有 `statfs`/`ioctl`/`FS_IOC` 的相关封装（对 `src` 全文 grep 无结果），不提供相关能力。结论：`libc` 已足够完成 `fstatfs` 与 `ioctl(FS_IOC_GETFLAGS)`，缺的魔数和 `FS_CASEFOLD_FL` 在本项目本地常量表里定义并加出处注释；`rustix::fs::ioctl::ioctl_getflags` 在缓冲区宽度上更省心，但需要新增直接依赖声明。

#### D. 向量判定（ext4 默认、ext4 casefold、vfat、exFAT）

约定：“折叠”表示两个名字在该位置被视为同一个名字；“不折叠”表示不同名。证据说明：

- **ext4 casefold**（同样适用于 f2fs casefold、tmpfs casefold）：由内核算法 `UTF8_NFDICF`（B1 问 1）和 `CaseFolding.txt` 12.1.0（md5 与内核 `README.utf8data` 一致）机械推导，脚本 `c-scripts/nfdicf.py`，实现为“NFD → 逐码点取 C+F 折叠 → 再 NFD”；用 KUnit 向量交叉核对（ß→ss、U+AB70→U+13A0、Å→a+◌̊）。状态：**部分验证**（逻辑来源明确，但未在真实内核上运行；Python `unicodedata` 的 NFD 版本比 12.1.0 新，本组向量不受影响）。
- **ext4 默认 / btrfs / tmpfs 默认 / ZFS sensitive / ntfs3 与 ntfs-3g 默认**：无 d_hash/d_compare（或按字节比较），不折叠。
- **vfat（默认 `check=n`、`iocharset=iso8859-1`，用户空间传 UTF-8 字节）**：逐字节经 `iso8859-1` 小写表比较，调研员用 `nls_iso8859-1.c` 的表对 UTF-8 字节序列复算（脚本在内联命令里，结果同下表）。状态：**部分验证**（源码推导，未实机；`iocharset=utf8` 时全部不折叠，包含第 1 组，推导，未验证）。
- **exfat（内核默认 upcase 表）**：按 `uni_def_upcase` 解压后的映射对每个 BMP 码点取大写，脚本 `c-scripts/exfat_up.py`。状态：**部分验证**（卷上自带的 upcase 表可能不同，且未实机）。

<!-- prettier-ignore -->
| # | 输入 | ext4 默认（也是 btrfs、tmpfs 默认、ZFS sensitive、ntfs3/ntfs-3g 默认） | ext4 casefold 目录（Unicode 12.1.0，NFDICF） | vfat（默认选项，iso8859-1） | exfat（内核默认 upcase 表） |
| --- | --- | --- | --- | --- | --- |
| 1 | `README` 与 `readme` | 不折叠（按字节比较；`vfs` 无 d_compare，源码已验证） | 折叠（`R→r`，C 状态） | 折叠（`0x52`→`0x72` 经小写表，部分验证） | 折叠（`uni_def_upcase` 中 `r→R`） |
| 2 | `Straße` 与 `STRASSE` | 不折叠 | 折叠（`ß`→`ss`，F 状态；KUnit 有 ß→ss 向量） | 不折叠（长度不同且 `ß` 的 UTF-8 字节不被表折叠） | 不折叠（上表映射 `ß` 保持，长度不同） |
| 3 | `ß`（U+00DF）与 `ẞ`（U+1E9E） | 不折叠 | 折叠（二者都折成 `ss`；`1E9E; F; 0073 0073`） | 不折叠 | 不折叠（`ß`、`ẞ` 在默认表里各自保持原值） |
| 4 | `i` 与 `İ`（U+0130） | 不折叠 | 不折叠（`İ`→`i`+U+0307，F 状态；T 状态被忽略） | 不折叠 | 不折叠 |
| 5 | `I` 与 `ı`（U+0131） | 不折叠 | 不折叠（`I`→`i`，`ı` 无折叠项；T 状态被忽略） | 不折叠 | 不折叠 |
| 6 | `σ`、`ς`（U+03C2）与 `Σ` | 不折叠 | 折叠（三者都→`σ`） | 不折叠 | 折叠（三者都→U+03A3） |
| 7 | `é`（U+00E9）与 `é`（e+U+0301） | 不折叠（字节不同） | 折叠（NFD 后相同；这是规范化轴） | 不折叠（无规范化） | 不折叠（无规范化；上表映射 `é→É` 与 `e`+组合符不同） |
| 8 | `É`（U+00C9）与 `é`（U+00E9） | 不折叠 | 折叠 | 不折叠（UTF-8 第二字节 `0x89` 与 `0xA9` 不被表折叠） | 折叠 |
| 9 | `Ａ`（U+FF21）与 `a`/`A` | 不折叠 | 不折叠（`Ａ`→全角`ａ` U+FF41，不到 ASCII）；与 `ａ` 折叠 | 不折叠 | 不折叠（`Ａ` 保持 U+FF21，与 ASCII 不同）；与 `ａ`（U+FF41）折叠 |
| 10 | `ǅ`（U+01C5）、`ǆ`（U+01C6）、`Ǆ`（U+01C4） | 不折叠 | 折叠（三者→U+01C6，C 状态） | 不折叠 | **部分折叠**：`ǆ`（U+01C6）与 `Ǆ`（U+01C4）折叠（→U+01C4）；`ǅ`（U+01C5）在默认表中保持原值，与另两个不折叠 |
| 11 | `K`（U+212A KELVIN）与 `k`/`K` | 不折叠 | 折叠（U+212A→`k`，C 状态） | 不折叠 | 不折叠（U+212A 在默认表中保持原值，与 `K` 不同） |
| 12 | `ﬃ`（U+FB03）与 `ffi` | 不折叠 | 折叠（`FB03; F; 0066 0066 0069`） | 不折叠 | 不折叠 |
| 13 | Cherokee `Ꭰ`（U+13A0）与 `ꭰ`（U+AB70） | 不折叠 | 折叠（`AB70; C; 13A0`；Unicode 8.0 起，12.1.0 数据含该项；KUnit 有 U+AB70→U+13A0 向量） | 不折叠 | 不折叠（默认表不含 Cherokee 小写映射） |

其他位置：

- **ntfs3 `nocase`**、**cifs `nocase`（`cifs_toupper` 本地表）**、**ntfs-3g `lowntfs-3g ignore_case`**、**ZFS insensitive**：折叠集合取决于各自的 `$UpCase`/`UniCase` 表或 ZFS 的 casefold 实现，本次没有逐码点复算，全部标**未验证**；唯一可定的是 ASCII（第 1 组）折叠。
- 第 7 组（规范化轴）除 ext4/f2fs/tmpfs casefold 目录与 ZFS `normalization≠none` 外，Linux 各文件系统均不折叠（见 C 表第一行）。
- 提醒：ext4 casefold 还会**去掉 Default_Ignorable_Code_Point**（如 U+200D、U+00AD、U+FE0F 等），仅这类码点不同的两个名字也会被视为同名（`utf8_validate` 用 `UTF8_NFDI` 的同类处理；`include/linux/unicode.h` 注释）；本组 13 个向量不涉及，但 `PathKey` 若为 casefold 目录建键应当考虑，状态：已验证（注释）、未实机。

### Rust crate

#### B0. 一览表（每个候选一行，细节见各小节）

<!-- prettier-ignore -->
| crate | 最新稳定版（发布日期） | 许可证（SPDX，crates.io 字段） | 近 90 天下载量 | 在 `Cargo.lock`（锁定版本） | 直接/传递 | MSRV（crates.io `rust_version`）与本项目 | `no_std` / 纯 Rust | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| same-file | 1.0.6（2020-01-11） | `Unlicense/MIT`（旧式写法，等价于 Unlicense OR MIT） | 169143075 | 是，1.0.6 | 传递（walkdir 2.5.0 ← tauri、tauri-build 等）；`Cargo.toml` 未声明 | 未声明（edition 2018）；无冲突 | 非 `no_std`；纯 Rust（Windows 经 `winapi-util 0.1.11` 调 `windows-sys 0.61.2`） | 不采用 |
| unicode-normalization | 0.1.26（2026-10-16） | `(MIT OR Apache-2.0) AND Unicode-3.0` | 120072771 | 否（未锁定） | 无（需新增直接依赖） | 1.36；无冲突（本机 1.95.0） | 默认 `std` feature；关闭后 `no_std`+`alloc`；纯 Rust，`#![deny(unsafe_code)]` | 采用（仅用于 NFC/NFD） |
| caseless | 0.2.2（2024-12-30） | `MIT` | 7930423 | 否 | 无（需新增） | 未声明（edition 2015 风格，本机 1.95.0 编译通过）；无冲突 | 非 `no_std`；纯 Rust，无 `unsafe` | 不采用（数据停在 Unicode 16.0.0） |
| unicase | 2.10.0（2026-10-05） | `MIT OR Apache-2.0` | 107286105 | 否 | 无（需新增） | 未声明（edition 2018）；无冲突 | `#![no_std]`+`alloc`；纯 Rust | 采用（完整折叠 C+F 的键函数） |
| rustix | 1.1.5（2026-09-16）；已锁 1.1.4（2026-02-22） | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 301763727 | 是，1.1.4 | 传递（cap-primitives、tempfile 等）；`Cargo.toml` 未声明 | 1.65（1.1.5）/1.63（1.1.4）；无冲突 | `std` 关闭可 `no_std`；Linux 默认走 linux_raw（不经 libc），其他平台经 libc；非纯 Rust 绑定（系统调用） | 仅评估（不新增；Linux 探测直接用已有的 `libc` 或经 cap-std 现有传递版本均可） |
| windows-sys | 0.61.2（2025-10-06）；项目声明 0.59，已锁 0.59.0（2024-07-30） | `MIT OR Apache-2.0` | 461838651 | 是，0.59.0（另有 0.45.0、0.52.0、0.60.2、0.61.2） | 直接（仅 Windows） | 1.60（0.59.0）/1.71（0.61.2）；无冲突 | `#![no_std]`；原始 FFI 绑定 | 采用（已是依赖；需新增 feature `Wdk_Storage_FileSystem`，见 E） |
| cap-primitives | 4.0.3（2026-08-20）；已锁 4.0.3 | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 13115931 | 是，4.0.3 | 传递（cap-std 4.0.3 ← 直接依赖） | 未声明（edition 2021）；无冲突 | 非 `no_std`；系统调用封装 | 不采用（不提供大小写能力，不直接依赖） |

#### B1. same-file

**① 逐问回答**

1. 最新稳定版本与发布日期：1.0.6，2020-01-11（共 11 个版本，最近一次发布是 2020 年）。｜https://crates.io/api/v1/crates/same-file｜2026-10-19｜官方文档（crates.io 注册表 API 元数据）｜已验证
2. 许可证：`Unlicense/MIT`，仓库里 `UNLICENSE`、`LICENSE-MIT`、`COPYING` 三个文件都存在，`COPYING` 写 “This project is dual-licensed under the Unlicense and MIT licenses. You may use this code under the terms of either license.”｜https://raw.githubusercontent.com/BurntSushi/same-file/HEAD/COPYING｜2026-10-19｜项目源码（BurntSushi/same-file，HEAD；crates.io 包内也有同名文件）｜已验证
3. 维护状态：crates.io 上最近发布 2020-01-11；GitHub 仓库 `pushed_at` 2025-10-17，未归档，12 个开放 issue。判断为“稳定、功能完成、低频维护”，不是废弃。｜https://api.github.com/repos/BurntSushi/same-file｜2026-10-19｜项目源码（仓库元数据）｜已验证（“低频维护”是调研员的归纳，属推断）
4. 下载量级：近 90 天 169143075（累计 674083649）。｜https://crates.io/api/v1/crates/same-file｜2026-10-19｜官方文档（注册表 API）｜已验证
5. 是否已在 `Cargo.lock`：是，`same-file 1.0.6`（`src-tauri/Cargo.lock` 第 3582 行起）。直接/传递：`cargo tree --offline --locked -i same-file` 显示它只经 `walkdir v2.5.0` 被 `tauri-build`（build-dependency）、`tauri` 及各 tauri 插件引入；`src-tauri/Cargo.toml` 没有声明。｜`src-tauri/Cargo.lock`、`cargo tree`（本机）｜2026-10-18｜项目源码（本仓库）｜已验证
6. 与 MIT 兼容性：Unlicense 与 MIT 二选一，均为宽松许可，与 MIT 项目兼容。｜同第 2 条｜2026-10-19｜项目源码｜已验证（“兼容”的法律判断是推断，不是法律意见）
7. 需要新增的 Cargo feature：无（`[features]` 为空）。若要直接依赖需新增一条 `same-file = "1"`，但它已在锁文件内，不会新增 crate。｜https://crates.io/api/v1/crates/same-file（features 为 `{}`）｜2026-10-19｜官方文档（注册表 API）｜已验证
8. `no_std`/纯 Rust：不是 `no_std`（`lib.rs` 无 `no_std`）；纯 Rust，Windows 上依赖 `winapi-util`（锁定 0.1.11，其依赖 `windows-sys 0.61.2`）。｜`~/.cargo/registry/src/*/same-file-1.0.6/Cargo.toml`（`[target."cfg(windows)".dependencies.winapi-util]`）、`Cargo.lock` 第 5490 行｜2026-10-18｜项目源码｜已验证
9. MSRV：crates.io 未登记 `rust_version`，edition 2018；本机 1.95.0 已能编译整个依赖图，与本项目（无 `rust-version`，CI 用 stable）不冲突。｜注册表 API；本仓库 `Cargo.toml`｜2026-10-19｜官方文档＋项目源码｜已验证
10. API 与需求匹配度（需求 a 文件身份比较）：Unix 比较 `(dev, ino)`，Windows 比较 `(volume_serial_number, file_index)`，与本项目 `src-tauri/src/platform/file_identity.rs` 的 `FileIdentity::of` 完全同构（Unix `MetadataExt::dev()/ino()`；Windows `GetFileInformationByHandle` 的 `dwVolumeSerialNumber` 与 `nFileIndexHigh/Low`）。区别：same-file 的入口是“按路径打开”或“按已有 `File`”，不支持“父目录句柄 + 名称、不跟随末尾符号链接”这一本项目已实现的 `of_entry(&Dir, &OsStr)`（`file_identity.rs` 第 72 行起）；same-file 还要求 Windows 目录用 `FILE_FLAG_BACKUP_SEMANTICS` 打开，由其内部处理。它**没有**解决 ReFS 128 位文件 ID 的问题，源码注释自己承认。结论：**对需求 (a) 多余**。｜`~/.cargo/registry/src/*/same-file-1.0.6/src/win.rs` 第 17–31 行、`src/unix.rs` 第 14–15、69–70 行；`src-tauri/src/platform/file_identity.rs`｜2026-10-18｜项目源码（same-file 1.0.6 包内；本仓库）｜已验证
11. ReFS 的 64 位索引不唯一：same-file 源码注释 “ReFS uses 128 bit numbers for unique identifiers. This requires a distinct syscall to get `FILE_ID_INFO`”，且 “It seems straight-forward enough to modify this code to use `FILE_ID_INFO` … but I don't have access to such Windows machines.”｜https://static.crates.io/crates/same-file/same-file-1.0.6.crate（`src/win.rs`）；已 `tar -xzf` 后 `sed -n 17,31p` 读取｜2026-10-19｜项目源码（same-file 1.0.6）｜已验证
12. 微软官方文档对同一问题的表述：“The ReFS file system, introduced with Windows Server 2012, includes 128-bit file identifiers.” 与 “The 64-bit identifier in this structure is not guaranteed to be unique on ReFS.”；取得 128 位标识需用 `GetFileInformationByHandleEx` 加 `FileIdInfo` 得到 `FILE_ID_INFO`。｜https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information｜2026-10-19｜官方文档（已用 curl 取 HTML 并 grep 出原句）｜已验证

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://crates.io/api/v1/crates/same-file | 2026-10-19 | 官方文档（注册表 API） | `max_stable_version` 1.0.6；`license` `Unlicense/MIT`；`recent_downloads` 169143075 |
| https://raw.githubusercontent.com/BurntSushi/same-file/HEAD/COPYING | 2026-10-19 | 项目源码 | “This project is dual-licensed under the Unlicense and MIT licenses.” |
| https://raw.githubusercontent.com/BurntSushi/same-file/HEAD/LICENSE-MIT | 2026-10-19 | 项目源码 | “The MIT License (MIT) Copyright (c) 2017 Andrew Gallant” |
| https://static.crates.io/crates/same-file/same-file-1.0.6.crate | 2026-10-19 | 项目源码 | `src/win.rs` 第 17–31 行（ReFS 注释）；`struct Key { volume: u64, index: u64 }`；`src/unix.rs` 的 `dev`/`ino` |
| https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information | 2026-10-19 | 官方文档 | 见上第 12 条 |

**③ 对本项目的启示：** `file_identity.rs` 已覆盖 same-file 能做的全部事，且支持目录句柄相对打开；不要新增 same-file。真正需要关注的是两者共有的缺口：ReFS（含 Windows 11 的 Dev Drive 默认格式，该事实归 Microsoft 小节核实，本小节未验证）上 64 位索引不保证唯一，设计里“用文件身份兜底”在 ReFS 上需要补 `FILE_ID_INFO`（`windows-sys 0.59.0` 的 `Win32_Storage_FileSystem` 里已有 `FileIdInfo`、`FILE_ID_INFO`、`FILE_ID_128`，该 feature 项目已启用，见 E.3）。

#### B2. unicode-normalization

**① 逐问回答**

1. 最新稳定版：0.1.26，2026-10-16（距今 2 天）；前一版 0.1.25 于 2025-10-30。共 30 个版本。｜https://crates.io/api/v1/crates/unicode-normalization｜2026-10-19｜官方文档（注册表 API）｜已验证
2. 许可证：0.1.26 的 `license` 字段为 `(MIT OR Apache-2.0) AND Unicode-3.0`（0.1.25 为 `MIT OR Apache-2.0`）；仓库 HEAD 的 `Cargo.toml` 第 14 行同样写 `license = "(MIT OR Apache-2.0) AND Unicode-3.0"`；仓库有 `LICENSE-MIT`、`LICENSE-APACHE`、`LICENSE-UNICODE`（正文开头 “UNICODE LICENSE V3”）与 `COPYRIGHT`。新增的 Unicode-3.0 对应的是内嵌的 Unicode 数据表。｜https://raw.githubusercontent.com/unicode-rs/unicode-normalization/HEAD/Cargo.toml、https://raw.githubusercontent.com/unicode-rs/unicode-normalization/HEAD/LICENSE-UNICODE｜2026-10-19｜项目源码｜已验证（“对应数据表”是调研员读 `LICENSE-UNICODE` 的理解，属推断）
3. 与 MIT 兼容性：MIT/Apache-2.0 可任选，Unicode License v3 是宽松许可（要求分发时保留版权与许可声明）。结论：可用于 MIT 项目，但**分发安装包时需在第三方声明里保留 Unicode-3.0 声明**；本仓库的 `THIRD_PARTY_NOTICES.md` 目前只列字体，不列 Rust crate，新增后是否要列、怎么列由项目决定（评审点）。｜`LICENSE-UNICODE`；本仓库 `THIRD_PARTY_NOTICES.md`｜2026-10-19｜项目源码｜部分验证（兼容性是调研员的判断，不是法律意见；缺：项目对 Rust 依赖声明的策略）
4. 维护状态：仓库 `pushed_at` 2026-10-16，未归档，18 个开放 issue；0.1.26 把 `UNICODE_VERSION` 更新为 (18, 0, 0)（0.1.25 为 (17, 0, 0)）。｜https://api.github.com/repos/unicode-rs/unicode-normalization；包内 `src/tables.rs` 的 `pub const UNICODE_VERSION`｜2026-10-19｜项目源码｜已验证
5. 下载量级：近 90 天 120072771。｜注册表 API｜2026-10-19｜官方文档｜已验证
6. 是否在 `Cargo.lock`：**否**（`grep '^name = "unicode-normalization"' src-tauri/Cargo.lock` 无结果）。需新增直接依赖；它的唯一依赖 `tinyvec`（features `alloc`）已在锁文件内（`tinyvec 1.11.0`，依赖 `tinyvec_macros 0.1.1`），tinyvec 许可证 `Zlib OR Apache-2.0 OR MIT`，所以新增的 crate 只有它本身一个。｜`src-tauri/Cargo.lock`（第 4634 行 tinyvec）；包内 `Cargo.toml.orig`｜2026-10-18｜项目源码｜已验证
7. 需要新增的 feature：无需。默认 `std`；`default-features = false` 时为 `no_std`+`alloc`（`#![cfg_attr(not(feature = "std"), no_std)]`）。本项目是 std 应用，保持默认即可。｜包内 `src/lib.rs` 第 45–53 行；`[features] default = ["std"]`｜2026-10-19｜项目源码｜已验证
8. MSRV：`rust-version = "1.36"`，edition 2018；与本项目无冲突。纯 Rust，`#![deny(missing_docs, unsafe_code)]`。｜包内 `Cargo.toml.orig`、`src/lib.rs` 第 40 行｜2026-10-19｜项目源码｜已验证
9. API 与需求 (b) NFC 的匹配度：`use unicode_normalization::UnicodeNormalization;` 后 `s.nfc()` / `s.nfd()` 返回字符迭代器；调研员已用 `rustc 1.95.0` 实际编译运行：`"\u{e9}".nfc()` 与 `"e\u{301}".nfc()` 逐字符相等，`"\u{212a}"`（KELVIN SIGN）NFC 后等于 `"K"`。完全满足 NFC 键需求；还提供 NFD（用于 D145 规范无大小写匹配）。｜`e_exp` 实验输出（`row 7` 与 `row 11b` 的 `nfc_eq` 列）；https://docs.rs/unicode-normalization/0.1.26/｜2026-10-19｜推断（本机运行观察，不计已验证）＋项目源码（API 位置）｜部分验证（缺：未对照 Unicode 官方 NormalizationTest.txt 跑全量；crate 自己有测试，调研员未复核）

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://crates.io/api/v1/crates/unicode-normalization | 2026-10-19 | 官方文档（注册表 API） | `max_stable_version` 0.1.26；版本级 `license` `(MIT OR Apache-2.0) AND Unicode-3.0`；`rust_version` 1.36；`features` `{"default":["std"],"std":[]}` |
| https://static.crates.io/crates/unicode-normalization/unicode-normalization-0.1.26.crate | 2026-10-19 | 项目源码 | `src/tables.rs`：`pub const UNICODE_VERSION: (u8, u8, u8) = (18, 0, 0);`；`Cargo.toml.orig`：`[dependencies.tinyvec] version = "1" features = ["alloc"]` |
| https://static.crates.io/crates/unicode-normalization/unicode-normalization-0.1.25.crate | 2026-10-19 | 项目源码 | `UNICODE_VERSION` (17, 0, 0)；license 行 `MIT OR Apache-2.0` |
| https://raw.githubusercontent.com/unicode-rs/unicode-normalization/HEAD/LICENSE-UNICODE | 2026-10-19 | 项目源码 | “UNICODE LICENSE V3 COPYRIGHT AND PERMISSION NOTICE” |
| https://api.github.com/repos/unicode-rs/unicode-normalization | 2026-10-19 | 项目源码（仓库元数据） | `pushed_at` 2026-10-16T23:28:43Z，`archived` false |

**③ 对本项目的启示：** 规范化轴（NFC）用它最合适；注意 0.1.26 才发布 2 天，实现时建议在 `Cargo.lock` 里明确锁定并在 PR 里写明数据版本 Unicode 18.0.0；`std` 标准库当前（Rust 1.95.0）的 Unicode 数据版本是 17.0.0（见 B8），且标准库**没有**任何规范化 API，所以规范化没有“只用标准库”的选项。

#### B3. caseless

**① 逐问回答**

1. 最新稳定版：0.2.2，2024-12-30（共 8 个版本）。｜https://crates.io/api/v1/crates/caseless｜2026-10-19｜官方文档（注册表 API）｜已验证
2. 许可证：`MIT`；仓库 `LICENSE` 开头 “Copyright (c) 2017 Simon Sapin MIT License”。｜https://raw.githubusercontent.com/unicode-rs/rust-caseless/HEAD/LICENSE｜2026-10-19｜项目源码｜已验证
3. 维护状态：最近发布 2024-12-30，仓库 `pushed_at` 2024-12-30，26 星、8 个开放 issue。**数据版本停在 Unicode 16.0.0**（`src/case_folding_data.rs` 第一行 `pub const UNICODE_VERSION: (u64, u64, u64) = (16, 0, 0);`，包内 `CaseFolding.txt` 标题 “CaseFolding-16.0.0.txt”）。Unicode 官网当前最新数据是 18.0.0（`CaseFolding-18.0.0.txt`，日期 2026-02-03），与 16.0.0 相比新增 49 条 C/F 映射、无变更、无删除；调研员把这 49 条逐条喂给 `caseless::default_case_fold_str`，**0/49 正确折叠**（对照 `unicase 2.10.0` 为 49/49）。判断为“维护停滞，数据已落后两个 Unicode 版本”。｜https://static.crates.io/crates/caseless/caseless-0.2.2.crate；https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt；https://api.github.com/repos/unicode-rs/rust-caseless｜2026-10-19｜项目源码＋官方文档（Unicode 官方数据文件）＋推断（本机运行对比）｜已验证（数据版本与差异条数）；“停滞”为推断
4. 下载量级：近 90 天 7930423。｜注册表 API｜2026-10-19｜官方文档｜已验证
5. 是否在 `Cargo.lock`：否；需新增，并传递引入 `unicode-normalization`（它的唯一依赖，`unicode-normalization = "0.1"`）。｜包内 `Cargo.toml.orig`；`src-tauri/Cargo.lock`｜2026-10-19｜项目源码｜已验证
6. 与 MIT 兼容：MIT，兼容。折叠数据来自 Unicode `CaseFolding.txt`，但 crate 自身声明仅 `MIT`，未带 Unicode-3.0 声明（对照：unicode-normalization 0.1.26 为此加了 `AND Unicode-3.0`）；是否需要补 Unicode 声明属评审点，调研员未能从来源判定，标未验证。｜注册表 API；包内 `LICENSE`｜2026-10-19｜项目源码｜部分验证（缺：Unicode 数据文件条款对再分发的要求，未研读 https://www.unicode.org/terms_of_use.html）
7. 需新增 feature：无（`features` 为空）。
8. `no_std`/纯 Rust：非 `no_std`（`lib.rs` 无 `#![no_std]`，用 `String`）；纯 Rust，无 `unsafe`（`grep unsafe src/lib.rs` 无结果）。MSRV 未登记，edition 2015（无 edition 字段），本机 1.95.0 编译通过。｜包内 `src/lib.rs`、`Cargo.toml.orig`｜2026-10-19｜项目源码＋推断（编译通过的本机观察）｜已验证
9. 实现哪种折叠：**完整默认折叠，即 `CaseFolding.txt` 的 C+F**，不含 S（简单）与 T（突厥语）。证据：`default_case_fold_str` 通过 `CASE_FOLDING_TABLE: &[(char, [char; 3])]` 查表输出至多 3 个字符；表中 `('\u{df}', ['s','s','\0'])`（ß→ss）、`('\u{1e9e}', ['s','s','\0'])`（ẞ→ss，而不是 S 条目给出的 ß）、`('\u{130}', ['i','\u{307}','\0'])`（İ→i̇，F 条目，不是 T 条目的 i）、`('\u{fb03}', ['f','f','i'])`；`U+0131`（ı）不在表里（无折叠，T 条目才映射到 ı 的反向）。官方文件对状态的定义：“A. To do a simple case folding, use the mappings with status C + S. B. To do a full case folding, use the mappings with status C + F.”｜`src/case_folding_data.rs`；https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt 第 36–52 行｜2026-10-19｜项目源码＋官方文档｜已验证
10. API：`default_case_fold_str(&str) -> String`（C+F 键）、`default_caseless_match_str`、`canonical_caseless_match_str`（实现为 `NFD → 折叠 → NFD` 后逐字符比较，对应 Unicode 标准 D145）、`compatibility_caseless_match_str`；迭代器 trait `Caseless` 提供 `default_case_fold()`。**没有现成的“规范无大小写键”输出函数**，要自己拼 `x.nfd().default_case_fold().nfd()`。｜`src/lib.rs`｜2026-10-19｜项目源码｜已验证

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://crates.io/api/v1/crates/caseless | 2026-10-19 | 官方文档（注册表 API） | `max_stable_version` 0.2.2，`license` `MIT`，`recent_downloads` 7930423 |
| https://static.crates.io/crates/caseless/caseless-0.2.2.crate | 2026-10-19 | 项目源码 | `src/case_folding_data.rs`：`UNICODE_VERSION = (16, 0, 0)`；`src/lib.rs`：`default_case_fold_str`、`canonical_caseless_match_str` |
| https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt | 2026-10-19 | 官方文档（Unicode 数据文件，当前版 18.0.0） | “C: common case folding … F: full case folding … S: simple case folding … T: special case for uppercase I and dotted uppercase I”；“A. To do a simple case folding, use the mappings with status C + S. B. To do a full case folding, use the mappings with status C + F.” |
| https://raw.githubusercontent.com/unicode-rs/rust-caseless/HEAD/LICENSE | 2026-10-19 | 项目源码 | MIT |

**③ 对本项目的启示：** 它是 C+F，API 也最贴近 D145，但数据已落后；若坚持用它，等于把 Unicode 17、18 新增的 49 个折叠（拉丁扩展、`U+16EA0` 起的一段、`U+1DF40` 起的一段等）拱手让掉。建议只作为“语义参照”，不作为依赖。

#### B4. unicase

**① 逐问回答**

1. 最新稳定版：2.10.0，2026-10-05；2.9.0 为 2026-01-06；共 29 个版本。｜https://crates.io/api/v1/crates/unicase｜2026-10-19｜官方文档（注册表 API）｜已验证
2. 许可证：`MIT OR Apache-2.0`；仓库有 `LICENSE-MIT`（“Copyright (c) 2014-2026 Sean McArthur”）与 `LICENSE-APACHE`。｜https://raw.githubusercontent.com/seanmonstar/unicase/HEAD/LICENSE-MIT｜2026-10-19｜项目源码｜已验证
3. 维护状态：活跃。仓库 `pushed_at` 2026-10-05，未归档，19 个开放 issue；2.10.0 的 `src/unicode/map.rs` 文件头为 “Generated by scripts/mapgen.py 2026-10-05”。｜https://api.github.com/repos/seanmonstar/unicase；包内 `src/unicode/map.rs`｜2026-10-19｜项目源码｜已验证
4. 下载量级：近 90 天 107286105。｜注册表 API｜2026-10-19｜官方文档｜已验证
5. 是否在 `Cargo.lock`：否；需新增直接依赖；它无任何运行时依赖（`[dependencies]` 空；`[features] nightly = []`）。｜包内 `Cargo.toml.orig`；`src-tauri/Cargo.lock`｜2026-10-19｜项目源码｜已验证
6. 与 MIT 兼容：`MIT OR Apache-2.0`，兼容。
7. 需新增 feature：无（`nightly` 是测试用，不要开）。
8. `no_std`/纯 Rust：`#![no_std]`（`lib.rs` 第 4 行）+ `extern crate alloc`，纯 Rust；MSRV 未登记（edition 2018）；与本项目无冲突。｜包内 `src/lib.rs`｜2026-10-19｜项目源码｜已验证
9. 实现哪种折叠：**完整折叠 C+F，无 S、无 T**。证据：`scripts/mapgen.py` 解析 `CaseFolding.txt` 时的过滤条件是 `if len(parts) > 2 and parts[1] in 'CF':`；`src/lib.rs` 文档写 “UniCase supports full Unicode case folding”；`map.rs` 中 `0xdf => Fold::Two('s','s')`、`0x1e9e => Fold::Two('s','s')`、`0xfb03 => Fold::Three('f','f','i')`、`0xab70 => 0x13a0`（Cherokee 小写折叠为大写）。运行观察：`UniCase::unicode("İ").to_folded_case()` 为 `"i\u{307}"`，与 caseless 一致。｜https://raw.githubusercontent.com/seanmonstar/unicase/master/scripts/mapgen.py 第 112–117 行；包内 `src/unicode/map.rs`｜2026-10-19｜项目源码＋推断（本机运行）｜已验证（折叠种类）
10. 数据版本：官方文档没写 Unicode 版本号；但把 Unicode 17/18 相对 16 新增的 49 条 C/F 映射逐条测试，**49/49 全部正确折叠**，故其数据至少包含 Unicode 18.0.0 的 CaseFolding 新增项。｜`e_exp` 实验（`added.txt` 由 `CaseFolding-18.0.0.txt` 与 `caseless` 内置 16.0.0 文件差分得出）｜2026-10-19｜推断（本机运行观察）｜部分验证（缺：作者未声明数据版本号；这是行为推断）
11. API：`UniCase::unicode(s).to_folded_case() -> String`（键）；`UniCase` 实现 `Eq/Ord/Hash`（比较时逐字符折叠）；也有 `unicase::eq(a, b)`。没有规范化功能，需与 unicode-normalization 配合。

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://crates.io/api/v1/crates/unicase | 2026-10-19 | 官方文档（注册表 API） | `max_stable_version` 2.10.0，`license` `MIT OR Apache-2.0`，`recent_downloads` 107286105 |
| https://static.crates.io/crates/unicase/unicase-2.10.0.crate | 2026-10-19 | 项目源码 | `src/lib.rs`：“UniCase supports full [Unicode case folding]”；`#![no_std]`；`src/unicode/mod.rs`：`to_folded_chars`、`to_folded_case` |
| https://raw.githubusercontent.com/seanmonstar/unicase/master/scripts/mapgen.py | 2026-10-19 | 项目源码 | `if len(parts) > 2 and parts[1] in 'CF':` |
| https://raw.githubusercontent.com/seanmonstar/unicase/HEAD/LICENSE-MIT | 2026-10-19 | 项目源码 | “Copyright (c) 2014-2026 Sean McArthur” |

**③ 对本项目的启示：** 在两个 C+F 实现里，unicase 数据更新、活跃、`no_std`、双许可，是折叠键的首选。它没有简单折叠（C+S）模式，也没有 Turkic 模式；设计上这恰好符合“不做区域设置相关折叠”的取向，但若调研（Microsoft/Apple 小节）结论是 NTFS/APFS 是 1:1 映射（`Straße` 与 `STRASSE` 不同名），则 C+F 键会把这两个名字归为候选相同，需靠“文件身份兜底”（draft 4.7.2.5）纠正——这是可接受的（误合并的候选会被身份比较拦住），见 E.2。

#### B5. rustix

**① 逐问回答**

1. 最新稳定版：1.1.5，2026-09-16；项目已锁 1.1.4（2026-02-22）。共 170 个版本。｜https://crates.io/api/v1/crates/rustix｜2026-10-19｜官方文档（注册表 API）｜已验证
2. 许可证：`Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`；仓库有 `LICENSE-MIT` 与 `LICENSE-Apache-2.0_WITH_LLVM-exception`（`LICENSE-Apache-2.0` 在 HEAD 返回 404，说明仓库只放了带 LLVM 例外的版本和 MIT，这与 SPDX 三选一的写法并不矛盾，MIT 文件存在即满足“选 MIT”）。｜https://raw.githubusercontent.com/bytecodealliance/rustix/HEAD/LICENSE-MIT｜2026-10-19｜项目源码｜已验证
3. 维护状态：活跃（Bytecode Alliance）。`pushed_at` 2026-10-15，2126 星，167 个开放 issue。｜https://api.github.com/repos/bytecodealliance/rustix｜2026-10-19｜项目源码（仓库元数据）｜已验证
4. 下载量级：近 90 天 301763727。
5. 是否在 `Cargo.lock`：是，`rustix 1.1.4`（依赖 `bitflags 2.11.1`、`errno`、`libc`、`linux-raw-sys`、`windows-sys 0.61.2`）。直接/传递：传递。引入者包括 `cap-primitives`、`cap-std`、`fs-set-times`、`tempfile` 等（`Cargo.lock` 里 `"rustix"` 出现在 15 个包的依赖表）；`src-tauri/Cargo.toml` 未声明。在 Windows 主机的 `cargo tree -i rustix` 无结果（`cap-primitives` 声明为 `cfg(not(windows))` 依赖），所以只在 Linux/macOS 构建出现。｜`src-tauri/Cargo.lock` 第 3518 行；`~/.cargo/registry/src/*/cap-primitives-4.0.3/Cargo.toml` 的 `[target."cfg(not(windows))".dependencies.rustix]`｜2026-10-18｜项目源码｜已验证
6. 当前已启用的 feature（Linux 目标）：`cargo tree --target x86_64-unknown-linux-gnu -e features -i rustix` 显示已启用 `default`、`std`、`alloc`、`event`、`fs`、`net`、`pipe`、`process`、`system`、`termios`、`time`（由 cap-primitives、tempfile 等引入）。macOS 目标的特性图离线无法解析（缺 `base64 v0.21.7` 包），未验证。｜本机 `cargo tree`｜2026-10-18｜项目源码（本仓库解析结果）｜部分验证（缺：macOS 目标特性图）
7. 与 MIT 兼容：三选一含 MIT，兼容。
8. MSRV：1.1.5 为 1.65，1.1.4 为 1.63；无冲突。`std` 关闭可 `no_std`；Linux x86_64 默认用 `linux_raw` 后端（直接系统调用，不经 libc），其他平台经 libc；不是纯 Rust 在“零 FFI”意义上的实现，但不需要 C 编译器。｜注册表 API；`rustix-1.1.4/Cargo.toml`、`build.rs` 的 `use_feature("linux_raw_dep")`｜2026-10-18｜项目源码｜已验证
9. 需求 (d) 的 `statfs`：`rustix::fs::fstatfs<Fd: AsFd>(fd) -> io::Result<StatFs>` 与 `rustix::fs::statfs(path)`，需要 `fs` feature；`cap_std::fs::Dir` 实现了 `AsFd`（`cap-std-4.0.3/src/fs/dir.rs` 第 800 行），可直接传入。`StatFs` 在 linux_raw 后端含 `f_type: FsWord`、`f_flags` 等字段；常量只提供 `PROC_SUPER_MAGIC`、`NFS_SUPER_MAGIC` 两个（`src/fs/fd.rs`），**没有** FUSE、NTFS、exFAT、CIFS、vfat 等魔数。（`fstatfs` 在 solarish、netbsd 等平台不可用，与本项目目标平台无关。）｜`~/.cargo/registry/src/*/rustix-1.1.4/src/fs/fd.rs`、`src/fs/abs.rs`、`src/backend/linux_raw/fs/types.rs` 第 772 行起｜2026-10-18｜项目源码｜已验证
10. 需求 (d) 的 `ioctl`：`rustix::fs::ioctl::ioctl_getflags<Fd: AsFd>(fd) -> io::Result<IFlags>`（`#[cfg(linux_raw_dep)]`，即默认 Linux 后端才有；若某依赖打开 `use-libc` 则该函数消失）。`IFlags` 只定义了 APPEND、COMPRESSED、DIRSYNC、IMMUTABLE、JOURNALING、NOATIME、NOCOW、NODUMP、NOTAIL、PROJECT_INHERIT、SECURE_REMOVAL、SYNC、TOPDIR、UNRM 十四项，**没有 `CASEFOLD`**（1.1.4 与 1.1.5 的 `src/` 里 `grep CASEFOLD` 均为 0 处）；但函数用 `IFlags::from_bits_retain`，未知位会保留，所以可用 `flags.bits() & 0x4000_0000`，其中 `FS_CASEFOLD_FL = 1073741824`（即 0x40000000）见 `linux-raw-sys 0.12.1` 的 `src/x86_64/general.rs` 第 1525 行。｜`rustix-1.1.4/src/fs/ioctl.rs` 第 99–150 行；`linux-raw-sys-0.12.1/src/x86_64/general.rs`；`rustix-1.1.5` 包｜2026-10-18、2026-10-19｜项目源码｜已验证
11. 没有的能力：`pathconf`/`fpathconf`/`getattrlist` 在 rustix 1.1.5 的 `src/` 中不存在（`grep -i pathconf|getattrlist|VOL_CAP|_PC_CASE` 只命中一条与 `getattrlist` 有关的注释）。所以 macOS 的 `pathconf(_PC_CASE_SENSITIVE)` 与 `getattrlist(ATTR_VOL_CAPABILITIES)` 用 rustix 做不到。｜rustix-1.1.5 包 `src/backend/libc/fs/syscalls.rs` 第 2315 行唯一命中｜2026-10-19｜项目源码｜已验证
12. 本项目已有替代：直接依赖 `libc = "0.2"`（`cfg(unix)`，锁定 0.2.186）已提供：Apple 的 `_PC_CASE_SENSITIVE`（`src/unix/bsd/apple/mod.rs` 第 1969 行）、`pathconf`/`fpathconf`（`src/unix/mod.rs` 第 1069、1092 行）、`getattrlist`/`fgetattrlist`（apple 第 5048、5055 行）、`attrlist`、`vol_capabilities_attr_t`、`ATTR_VOL_CAPABILITIES`（0x00020000）、`VOL_CAP_FMT_CASE_SENSITIVE`（0x00000100）、`VOL_CAP_FMT_CASE_PRESERVING`（0x00000200）、`VOL_CAPABILITIES_FORMAT`；Linux 的 `fstatfs`、`FS_IOC_GETFLAGS`（`linux_like/mod.rs` 第 1483 行，`_IOR::<c_long>('f', 1)`）、`FUSE_SUPER_MAGIC`（0x65735546）、`MSDOS_SUPER_MAGIC`（0x4d44，vfat 也用此值——该事实归 Linux 内核小节核实）、`SMB_SUPER_MAGIC`（0x517b，旧 smbfs，**不是** CIFS/SMB2 的魔数）、`EXT4_SUPER_MAGIC`、`F2FS_SUPER_MAGIC`、`BTRFS_SUPER_MAGIC`、`NFS_SUPER_MAGIC`。libc 里**没有** `FS_CASEFOLD_FL`、NTFS、exFAT、CIFS（0xFF534D42）、SMB2 魔数（`grep` 无命中），这些值需要从内核头文件取证后自己定义常量。｜`~/.cargo/registry/src/*/libc-0.2.186/src/`（上述路径）｜2026-10-18｜项目源码｜已验证（libc 中是否存在）；各常量的取值与语义归其他对应小节核实

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://crates.io/api/v1/crates/rustix | 2026-10-19 | 官方文档（注册表 API） | 1.1.5，`rust_version` 1.65，`license` 三选一 |
| https://static.crates.io/crates/rustix/rustix-1.1.5.crate | 2026-10-19 | 项目源码 | `grep -rn CASEFOLD src` 0 处；`pathconf`/`getattrlist` 无封装 |
| 本机 `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/rustix-1.1.4/src/fs/ioctl.rs`（校验和与 `Cargo.lock` 一致） | 2026-10-18 | 项目源码（rustix 1.1.4） | `pub fn ioctl_getflags<Fd: AsFd>(fd: Fd) -> io::Result<IFlags>`；`IFlags` 十四项无 CASEFOLD |
| 本机 `…/rustix-1.1.4/src/fs/fd.rs`、`src/fs/abs.rs` | 2026-10-18 | 项目源码 | `pub fn fstatfs<Fd: AsFd>`、`pub fn statfs<P: path::Arg>`、`NFS_SUPER_MAGIC`、`PROC_SUPER_MAGIC` |
| 本机 `…/libc-0.2.186/src/unix/bsd/apple/mod.rs` | 2026-10-18 | 项目源码 | `_PC_CASE_SENSITIVE`、`VOL_CAP_FMT_CASE_SENSITIVE`、`getattrlist` |
| https://raw.githubusercontent.com/bytecodealliance/rustix/HEAD/LICENSE-MIT | 2026-10-19 | 项目源码 | MIT 许可证正文 |

**③ 对本项目的启示：** rustix 对 Linux 的 `fstatfs` + `ioctl_getflags` 提供了安全封装，但缺 `CASEFOLD` 标志位与 macOS 的相关调用，增益有限；项目已有 `libc` 能覆盖 macOS 与 Linux 两个平台的全部所需调用，所以不必为探测新增 rustix 直接依赖。若选择用 rustix（想要无 `unsafe` 的 `fstatfs`/`ioctl_getflags`），应新增一条 `rustix = { version = "1", features = ["fs"] }` 的 `cfg(unix)` 直接依赖，它在锁文件内且 `fs` 已被启用，不会新增 crate，但会把 Linux 版本约束到 ≥ 1.0；评审点。

#### B6. windows-sys

**① 逐问回答**

1. 最新稳定版：0.61.2（2025-10-06）；项目声明 `0.59`，锁定 0.59.0（2024-07-30）。同一依赖图里还有 0.45.0、0.52.0、0.60.2、0.61.2。｜https://crates.io/api/v1/crates/windows-sys；`src-tauri/Cargo.lock`｜2026-10-19｜官方文档＋项目源码｜已验证
2. 许可证：`MIT OR Apache-2.0`；仓库 `license-mit`（“MIT License Copyright (c) Microsoft Corporation.”）与 `license-apache-2.0` 均存在。｜https://raw.githubusercontent.com/microsoft/windows-rs/HEAD/license-mit｜2026-10-19｜项目源码｜已验证
3. 维护状态：活跃，`pushed_at` 2026-10-18，12834 星，微软官方仓库。0.59.0 已是旧大版本（0.60、0.61 已发布），0.5x→0.6x 的升级无本评估需要的阻断，但依赖图里存在多版本并存。｜https://api.github.com/repos/microsoft/windows-rs｜2026-10-19｜项目源码（仓库元数据）｜已验证
4. 下载量级：近 90 天 461838651。
5. 是否在 `Cargo.lock`：是（0.59.0 是项目直接依赖，仅 `cfg(windows)`；经 `cargo tree -i windows-sys@0.59.0` 还被 `fs-set-times 0.20.3`、`window-vibrancy 0.6.0`、`winx 0.36.4` 引入）。**注意**：`cap-primitives 4.0.3` 用的是 **`windows-sys 0.61.2`**（`Cargo.lock` 里 `"windows-sys 0.61.2"`；其 `Cargo.toml` 写 `version = ">=0.60, <0.62"`，且启用了 `Wdk_Storage_FileSystem`、`Wdk_Foundation`），不是项目的 0.59.0；所以“cap-primitives 已经开了 Wdk feature”**并不**让项目的 0.59.0 实例拥有该 feature。｜`src-tauri/Cargo.lock` 第 530–545 行；`cap-primitives-4.0.3/Cargo.toml` 第 82–94 行；`cargo tree -e features -i windows-sys@0.59.0`（无任何 `Wdk` 项）与 `-i windows-sys@0.61.2`（有 `Wdk_Storage_FileSystem`）｜2026-10-18｜项目源码｜已验证
6. 与 MIT 兼容：兼容。
7. MSRV：0.59.0 为 1.60，0.61.2 为 1.71；无冲突。`#![no_std]`（`windows-sys-0.59.0/src/lib.rs` 第 7 行）；原始 FFI 绑定，不是“纯 Rust 实现”。
8. 项目当前声明的 feature（`src-tauri/Cargo.toml`）：`Win32_Foundation`、`Win32_Security`、`Win32_Security_Authorization`、`Win32_Storage_FileSystem`、`Win32_System_Diagnostics_ToolHelp`、`Win32_System_IO`、`Win32_System_JobObjects`、`Win32_System_Registry`、`Win32_System_Threading`。**统一后的实际启用集**（`cargo tree -e features -i windows-sys@0.59.0`）还多出 `Win32_System_Ioctl`、`Win32_System_SystemServices`、`Win32_System_LibraryLoader`、`Win32_System_Performance`、`Win32_System_SystemInformation`、`Win32_System_Time`、`Win32_System_Diagnostics_Debug`、`Win32_Graphics_Gdi`、`Win32_Graphics_Dwm`、`Win32_UI_WindowsAndMessaging`，来自 `winx`、`window-vibrancy`、`fs-set-times` 的声明，**项目不应依赖这种“碰巧启用”**（依赖图一变就会编译失败）。｜`src-tauri/Cargo.toml`；`cargo tree`｜2026-10-18｜项目源码｜已验证
9. 需求 (d) 所需符号与 feature：见 **E.3** 的逐符号表（以 `windows-sys-0.59.0` 本机源码为准）。结论一句：`NtQueryInformationFile` 与 `FILE_CASE_SENSITIVE_INFORMATION` 与 `FileCaseSensitiveInformation` 在 `Wdk::Storage::FileSystem` 模块，需**新增** feature `Wdk_Storage_FileSystem`（它会连带 `Wdk_Storage`、`Wdk`）；`GetVolumeInformationByHandleW` 与 `GetFileInformationByHandle` 所在的 `Win32_Storage_FileSystem` 项目**已启用**；卷标志常量（`FILE_CASE_SENSITIVE_SEARCH` 等）在 `Win32_System_SystemServices`，项目**未显式声明**。

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://crates.io/api/v1/crates/windows-sys | 2026-10-19 | 官方文档（注册表 API） | 0.61.2，`rust_version` 1.71；0.59.0 的 `rust_version` 1.60 |
| 本机 `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/windows-sys-0.59.0/`（`Cargo.lock` 校验和 `1e38bc4d…` 一致） | 2026-10-18 | 项目源码 | 见 E.3 |
| https://static.crates.io/crates/windows-sys/windows-sys-0.59.0.crate | 2026-10-19 | 项目源码 | 与本机目录同一内容的网络出处 |
| https://raw.githubusercontent.com/microsoft/windows-rs/HEAD/license-mit | 2026-10-19 | 项目源码 | “MIT License Copyright (c) Microsoft Corporation.” |
| `cap-primitives-4.0.3/Cargo.toml` 第 82–94 行 | 2026-10-18 | 项目源码 | `[target."cfg(windows)".dependencies.windows-sys] version = ">=0.60, <0.62"`，features 含 `"Wdk_Storage_FileSystem"` |

**③ 对本项目的启示：** 只需在现有 `windows-sys = "0.59"` 条目里追加 feature，不新增 crate；项目已有先例手写 `extern "system" { fn NtSetInformationFile }`（`platform/file_cas.rs` 第 642–657 行），两种做法都可行，建议用 `Wdk_Storage_FileSystem` 的带类型声明，少一份手写 FFI（R-RS-1 要求平台细节集中在 `platform/`）。0.59→0.61 的升级可以让依赖图少一个版本，但不是本事项的前提，且需单独评审。

#### B7. cap-primitives（与 cap-std）

**① 逐问回答**

1. 最新稳定版：4.0.3（2026-08-20）；项目已锁 4.0.3。crates.io 的 `newest_version` 显示 3.4.6（同日发布的 3.x 维护分支），稳定最大版为 4.0.3。共 95 个版本。｜https://crates.io/api/v1/crates/cap-primitives｜2026-10-19｜官方文档（注册表 API）｜已验证
2. 许可证：`Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`；仓库有 `LICENSE-MIT` 与 `LICENSE-Apache-2.0_WITH_LLVM-exception`。仓库已迁移：`github.com/bytecodealliance/cap-std` 301 重定向到 `github.com/sunfishcode/cap-std`（crates.io 元数据仍写旧地址）。｜https://raw.githubusercontent.com/bytecodealliance/cap-std/HEAD/LICENSE-MIT；`curl -sIL https://github.com/bytecodealliance/cap-std` 的 `Location` 头｜2026-10-19｜项目源码＋官方文档（HTTP 重定向）｜已验证
3. 维护状态：活跃，新仓库 `pushed_at` 2026-10-16，831 星，32 个开放 issue。｜https://api.github.com/repos/bytecodealliance/cap-std（跟随重定向）｜2026-10-19｜项目源码（仓库元数据）｜已验证
4. 下载量级：cap-primitives 近 90 天 13115931；cap-std 12053979。
5. 是否在 `Cargo.lock`：是，`cap-primitives 4.0.3`、`cap-std 4.0.3`；cap-std 是项目直接依赖（`Cargo.toml` `cap-std = "4.0.3"`），cap-primitives 是其传递依赖（`cargo tree -i cap-primitives` 只显示 `cap-std → cli-launchpad`）。｜`src-tauri/Cargo.toml`、`Cargo.lock`｜2026-10-18｜项目源码｜已验证
6. 与 MIT 兼容：兼容。MSRV 未登记（edition 2021）。非 `no_std`。
7. 需求 (d) 是否提供大小写相关能力：**没有**。对 `cap-primitives-4.0.3/src` 做 `grep -i "case.sens|casefold|case_sens|case-insens|FileCaseSensitive|ntfs|upcase|normaliz"` 只命中 3 处无关注释（`fs/manually/open.rs` 第 100 行“normalizes away `.` components”、`rustix/fs/dir_utils.rs` 第 27 行、`windows/fs/create_file_at_w.rs` 第 145 行）。
8. 需要知道的行为：`windows/fs/create_file_at_w.rs` 第 145–150 行：`// Compute objectattributes' Attributes field. Case-insensitive is the expected behavior on Windows.` 随后 `if dwflagsandattributes & FILE_FLAG_POSIX_SEMANTICS != 0 { attributes |= OBJ_CASE_INSENSITIVE as u32; }`。即**是否给 `NtCreateFile` 加 `OBJ_CASE_INSENSITIVE` 取决于调用方是否传了 `FILE_FLAG_POSIX_SEMANTICS`**，而注释与条件的方向看起来相反（POSIX 语义标志在 Win32 里是“区分大小写”）；这决定 cap-std 在“按目录区分大小写”的 Windows 目录里打开 `a.txt`/`A.txt` 时的行为，调研员只能读源码，无法在没有这种目录的本机验证。本机只读观察（默认不区分大小写的 NTFS 目录，仓库根）：用 `cap_std::fs::Dir::open` 与 `std::fs::metadata` 打开 `readme.md`、`Readme.MD`、`agents.md`、`docs/Architecture.md`（真实名为 `README.md`、`AGENTS.md`、`docs/architecture.md`）都成功，两者行为一致；`fsutil file queryCaseSensitiveInfo C:/Projects/cli-launchpad` 输出（GBK 转 UTF-8）“已禁用目录 C:\Projects\cli-launchpad 的区分大小写属性。”｜`~/.cargo/registry/src/*/cap-primitives-4.0.3/src/windows/fs/create_file_at_w.rs`；本机 `e_exp` 实验｜2026-10-18｜项目源码＋推断（本机只读观察，不计已验证）｜部分验证（缺：在区分大小写目录里的实际行为，需 W-20 实机）
9. 与 Dir 句柄的衔接：`cap_std::fs::Dir` 实现 `AsFd`（unix）与 `AsRawHandle`、`AsHandle`（windows），所以探测函数可以直接把 `&Dir` 传给 `rustix::fs::fstatfs`、`libc::fstatfs`、`GetVolumeInformationByHandleW`、`NtQueryInformationFile`。｜`cap-std-4.0.3/src/fs/dir.rs` 第 792–838 行｜2026-10-18｜项目源码｜已验证

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://crates.io/api/v1/crates/cap-primitives | 2026-10-19 | 官方文档（注册表 API） | 4.0.3，`license` 三选一，`recent_downloads` 13115931 |
| 本机 `…/cap-primitives-4.0.3/src/windows/fs/create_file_at_w.rs` 第 145–150 行 | 2026-10-18 | 项目源码 | 见上第 8 条 |
| 本机 `…/cap-std-4.0.3/src/fs/dir.rs` 第 792–838 行 | 2026-10-18 | 项目源码 | `impl AsFd for Dir`、`impl AsRawHandle for Dir`、`impl AsHandle for Dir` |
| https://raw.githubusercontent.com/bytecodealliance/cap-std/HEAD/LICENSE-MIT | 2026-10-19 | 项目源码 | MIT 许可证正文 |

**③ 对本项目的启示：** cap-primitives 不提供任何探测能力，也不该直接依赖；它的价值在于给出 `Dir` 句柄。要警惕：cap-std 的 Windows 打开路径用 `NtCreateFile` + 自管的 `OBJ_CASE_INSENSITIVE`，在“按目录区分大小写”的目录里是否仍能按字面区分大小写，决定了实机 W-20 的期望，需实机验证。

#### B8. 标准库（`str::to_lowercase` 等）

**① 逐问回答**

1. 是什么：`str::to_lowercase`/`to_uppercase` 实现 Unicode 的 `Lowercase_Mapping`/`Uppercase_Mapping`（来自 `UnicodeData.txt` 与 `SpecialCasing.txt` 的无条件映射），**不是** `CaseFolding.txt`；`char::to_lowercase` 文档写 “This operation performs an unconditional mapping without tailoring. That is, the conversion is independent of context and language.”｜https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/core/src/char/methods.rs 第 1066–1071 行｜2026-10-19｜内核或标准库文档（标准库源码文档注释）｜已验证
2. `str::to_lowercase` 对希腊词尾 Σ 做上下文处理：源码注释 “Σ maps to σ, except at the end of a word where it maps to ς.”（`library/alloc/src/str.rs` 第 386–415 行），所以同一个字符串的小写会随上下文变化，`"ς".to_lowercase()` 仍是 `"ς"` 而 `"Σ".to_lowercase()` 单独是 `"σ"`，两者不相等；折叠则把 ς、σ、Σ 都折为 σ。｜https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/alloc/src/str.rs｜2026-10-19｜内核或标准库文档｜已验证
3. Rust 1.95.0 标准库的 Unicode 版本：`pub const UNICODE_VERSION: (u8, u8, u8) = (17, 0, 0);`（`library/core/src/unicode/unicode_data.rs`）；本机 `core::char::UNICODE_VERSION` 运行输出 `(17, 0, 0)`。｜https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/core/src/unicode/unicode_data.rs 第 143 行｜2026-10-19｜内核或标准库文档＋推断（本机运行）｜已验证
4. 与折叠的差异（本机运行，`rustc 1.95.0`，不计已验证）：见 E.1 的行为表。要点：`"Straße"` 与 `"STRASSE"` 小写不相等、大写相等；`"ß"` 与 `"ẞ"` 小写相等、大写不相等；`"I"` 与 `"ı"` 小写不等、大写相等；`"K"`（U+212A）与 `"k"` 小写相等、大写不相等；`"ﬃ"` 与 `"ffi"` 小写不相等、大写相等。即无论用小写还是大写，都会在不同输入上漏判，**标准库的大小写映射不能替代折叠**。
5. 标准库没有 Unicode 规范化 API，也没有 `CaseFolding` 接口。｜标准库文档｜2026-10-19｜内核或标准库文档｜部分验证（“没有”无法用单一来源证明，依据是 `char`/`str` 的 API 列表与本机编译通过的 unicode 相关实验均未发现）

**② 来源表**

<!-- prettier-ignore -->
| URL | 访问日期 | 证据类型 | 关键句或函数位置 |
| --- | --- | --- | --- |
| https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/alloc/src/str.rs | 2026-10-19 | 内核或标准库文档 | 第 380 行 `pub fn to_lowercase`；第 387 行 “Σ maps to σ, except at the end of a word where it maps to ς.” |
| https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/core/src/char/methods.rs | 2026-10-19 | 内核或标准库文档 | 第 1070–1071 行 “This operation performs an unconditional mapping without tailoring.” |
| https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/core/src/unicode/unicode_data.rs | 2026-10-19 | 内核或标准库文档 | 第 143 行 `UNICODE_VERSION = (17, 0, 0)` |

**③ 对本项目的启示：** 现有 `models/` 或服务里若有用 `to_lowercase()` 当文件名相等判断的地方（RS-T62 测试九专门扫描这种用法），在 Unicode 层面都是不准确的近似。

#### B9. 其他候选（简评，供补充）

<!-- prettier-ignore -->
| crate | 版本（日期） | 许可证 | 近 90 天下载 | 在 Cargo.lock | 结论 | 理由（来源） |
| --- | --- | --- | --- | --- | --- | --- |
| icu_normalizer | 2.3.0（2026-08-13）；锁定 2.2.0 | `Unicode-3.0` | 215888033 | 是，2.2.0，经 `idna_adapter ← idna ← url ← tauri` 等传递，`compiled_data` feature 已启用 | 仅评估（NFC 的替代选择） | 已在构建图内，`ComposingNormalizerBorrowed::new_nfc()` 存在于 2.2.0（`src/lib.rs` 第 2878 行），直接依赖不新增 crate；但 MSRV 1.86（2.2.0）/1.88（2.3.0）、edition 2024、API 较重；数据的 Unicode 版本号调研员没查到明确出处（`icu_normalizer_data` README 只写 CLDR 48.2.0 / ICU release-78.1rc），标未验证。来源：注册表 API；`cargo tree`；`icu_normalizer-2.2.0.crate`。 |
| icu_casemap | 2.3.0（2026-08-13） | `Unicode-3.0` | 3449376 | 否 | 仅评估（需要“简单折叠 C+S”时的唯一成熟来源） | `CaseMapper::simple_fold(char) -> char`（`src/casemapper.rs` 第 580 行）、`fold_string`（完整）、`simple_fold_turkic`、`fold_turkic_string`；MSRV 1.88，依赖 icu_provider/zerovec 等，体积与编译成本大。来源：`icu_casemap-2.3.0.crate`。 |
| casefold | 0.1.0（2026-07-09，唯一版本） | `MIT` | 9315 | 否 | 仅评估，不采用 | README：“simple_fold(s: String) -> String … restricted to the simple (1-to-1) folds (statuses `C` and `S`). Full multi-character folds (`F`, e.g. `ß` → `ss`) and Turkic locale folds (`T`) are not supported.”；单版本、新、下载量小（github/rust-gems 子项目），未见 Unicode 版本声明。来源：`x_casefold/README.md`。 |
| focaccia | 2.5.0（2026-10-03） | `MIT AND Unicode-3.0` | 20399 | 否 | 仅评估，不采用 | `no_std`，`CaseFold::Full/Ascii/Turkic/Lithuanian` 比较 API，数据 `CaseFolding-18.0.0.txt`；README 只展示 `casecmp`/`case_eq`，未见导出折叠键字符串的 API（未验证）。MSRV 1.85、edition 2024。 |
| unicode-casefold | 0.2.0（2016-10-28） | `MIT/Apache-2.0` | 673185 | 否 | 不采用 | 2016 年后无发布，数据过时（API 细节未读，标未验证）。 |
| whichdisk | 0.7.0（2026-10-01） | `MIT OR Apache-2.0` | 15026 | 否 | **不采用**（专门“卷级大小写能力”的 crate，但不满足本项目需求） | 见下 B10。 |
| normalized-path | 0.2.0（2026-08-16） | `MIT OR Apache-2.0` | 70 | 否 | 不采用，可作设计参照 | 见下 B10。 |
| cageforge-path | 0.7.1（2026-09-23） | `Apache-2.0` | 456 | 否 | 不采用 | 只按“POSIX 区分、Windows 不区分”的操作系统静态规则，没有探测（README “It treats path components case-sensitively on POSIX systems and case-insensitively on Windows.”）。 |
| infinitier_fs | 0.0.14（2026-06-20） | `GPL-3.0-or-later` | 157 | 否 | 不采用 | GPL 与 MIT 分发模式不兼容，且是大小写不敏感文件系统抽象，非探测。 |
| uffs-text | 0.6.45（2026-10-14） | `MPL-2.0` | 149 | 否 | 不采用，仅作 NTFS `$UpCase` 差异的参考线索 | README 自称 “NTFS-bit-exact case folding via the `$UpCase` table.”（未验证，自述）；新、下载量小、MPL-2.0 有文件级 copyleft。 |

#### B10. 是否存在专门做“文件系统大小写敏感性探测”的 crate（检索记录）

检索方式：`curl -sL -H "User-Agent: cli-launchpad-research" "https://crates.io/api/v1/crates?q=<词>&per_page=10&sort=relevance"`，访问日期 2026-10-19。查询词（21 个）：`case sensitive filesystem`、`case sensitivity`、`fs case`、`case insensitive filesystem`、`filesystem case`、`casefold`、`case-sensitive`、`path case`、`caseless filesystem`、`detect case sensitivity`、`fs case-sensitivity`（0 结果）、`case_sensitive`、`is_case_sensitive`、`ntfs case folding`、`fs-case-sensitivity`（0 结果）、`case-insensitive path`、`fscase`（0 结果）、`casefs`（0 结果）、`wsl case sensitive directory`、`FILE_CASE_SENSITIVE_INFORMATION`、`APFS case-sensitive`。逐词结果保存在 `scratchpad/pd10/e_search_summary.txt`。`｜https://crates.io/api/v1/crates?q=case+sensitive+filesystem｜2026-10-19｜官方文档（注册表 API）｜已验证（检索动作与结果）`

结论：**没有**找到一个“对给定目录探测大小写敏感性”的成熟独立 crate。最接近的两个：

1. `whichdisk 0.7.0`（`MIT OR Apache-2.0`，al8n，2026-03-18 首发、共 9 个版本、近 90 天下载 15026，GitHub 4 星）：README 写 “per-volume capabilities (case-sensitivity, filesystem type)” 与 “`case_sensitive()` / `case_preserving()` … `None` means unknown”。实现来源：Apple 经 `getattrlist` 的 `VOL_CAP_FMT_CASE_SENSITIVE`/`VOL_CAP_FMT_CASE_PRESERVING`；**Windows 经 `FileFsAttributeInformation` 取文件系统名后按类型默认值推断大小写敏感**，`FILE_CASE_PRESERVED_NAMES` 取自标志位，而 `FILE_CASE_SENSITIVE_SEARCH` “is deliberately not used as the lookup mode”；**Linux 只按文件系统类型默认值**，`src/linux.rs` 第 2672 行注释写 “The per-directory ext4/f2fs casefold attribute (`chattr +F`) can make an individual directory case-insensitive, but that is not a volume-level property, so it is intentionally not reflected here”。因此它**不覆盖本项目最关心的目录级标志**（Windows 每目录标志、ext4/f2fs casefold），且是体量巨大的“卷解析器”（`wc -l`：`src/bsd.rs` 3858 行、`src/windows.rs` 7035 行、`src/linux.rs` 9501 行），不适合引入。来源：`x_whichdisk/README.md` 第 6、242–252、377 行，`src/linux.rs`、`src/capabilities_tests.rs` 第 235–241 行。证据类型：项目源码（whichdisk 0.7.0，`https://static.crates.io/crates/whichdisk/whichdisk-0.7.0.crate`）；验证状态：已验证（读到的就是上述原文）。
2. `normalized-path 0.2.0`（`MIT OR Apache-2.0`，ngg，近 90 天下载 70，GitHub 0 星）：不是探测，而是“与具体文件系统无关的路径元素规范化”，设计目标写明 “if any supported OS considers two names equivalent … they normalize to the same value”，管线为 NFD → 去空白 → 全角转 ASCII → NFC →（不区分大小写模式）`NFD(toCasefold(NFD(X)))` → 希腊记号移除 → ı 映射为 i → 软点符去除 → 亚美尼亚 Yew 映射 → NFC，基于 `icu_casemap`、`icu_normalizer`、`icu_properties`。它自己声明 “Fullwidth and ASCII variants of the same character (e.g. `Ａ` vs `A`) are deliberately normalized to the same form” 与 “Turkish İ (U+0130), dotless ı (U+0131), and ASCII I/i are all deliberately normalized to the same form”，即**故意过度折叠**，不适合当作“本项目文件系统真实行为”的近似键，但它列出的边界例子（希腊、亚美尼亚、土耳其、立陶宛）是很好的测试向量来源。来源：`x_normalized-path/src/lib.rs` 第 1–170 行；`Cargo.toml`。证据类型：项目源码；验证状态：已验证。

另：`cageforge-path`、`infinitier_fs`、`uffs-text`、`path_jail`、`soft-canonicalize`、`kimun_core` 等检索命中者，经读 README/源码均不是探测；见 B9 表。

#### E.1 规范化与折叠各用哪个 crate（或标准库能力）最合适

先分清三个概念（来源：Unicode 官方 `CaseFolding.txt` 说明）：简单折叠 = C+S；完整折叠 = C+F；T 是突厥语专用，默认不用。`str::to_lowercase` 属于 `Lowercase_Mapping`，不是折叠。｜https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt｜2026-10-19｜官方文档｜已验证

**建议**（建议，不改 Cargo.toml）：

- 规范化轴（NFC）：`unicode-normalization 0.1.26`（采用）。备选：`icu_normalizer 2.2.0`（已在 `Cargo.lock`，用 `ComposingNormalizerBorrowed::new_nfc()`，不新增 crate，但 MSRV 更高、API 更重、Unicode 版本号未核实）。标准库无此能力。
- 大小写折叠：`unicase 2.10.0` 的 `UniCase::unicode(s).to_folded_case()`（完整折叠 C+F；数据含 Unicode 18 新增 49 条中的 49 条）。不选 `caseless`（数据 Unicode 16.0.0，0/49）；不选标准库 `to_lowercase`/`to_uppercase`（见下表，会在不同输入上漏判，且词尾 Σ 受上下文影响）。
- 若调研结论要求“简单折叠 C+S”（例如 NTFS/APFS 是 1:1 映射，`Straße` 与 `STRASSE` 应为不同名）：没有成熟、数据新的小 crate；候选只有 `icu_casemap`（`CaseMapper::simple_fold`，但很重）与 `casefold 0.1.0`（C+S，新且单版本）。**建议先不引入**，原因：4.7.2.5 的兜底是“折叠键相同再用文件身份确认”，用完整折叠（更粗）只会多出“候选相同但身份不同”的情形，被身份比较拦住，不会造成静默合并；而用更细的折叠才可能漏掉候选，漏掉的无法被兜底纠正。这一取舍是调研员的推断（4.7.2.5 的流程描述 + 数学上 C+F 相等集合通常包含 C+S 相等集合），标“部分验证”，需 Microsoft/Apple 小节的 upcase/折叠结论确认后定稿。
- 键的拼法（调研员已在 `e_exp` 用 `unicase 2.10.0 + unicode-normalization 0.1.26` 编译运行验证可行）：
  - 大小写轴 `Insensitive` 且规范化轴 `Yes`：`key = nfc( nfd( fold( nfd(x) ) ) )`，其中 `fold` 为 unicase 的 `to_folded_case`；
  - 大小写轴 `Insensitive`、规范化轴 `No` 或 `Unknown`：`key = fold(x)`（不做规范化，与草案“`Unknown` 时该轴不处理”一致）；
  - 大小写轴 `Sensitive`/`Unknown`、规范化轴 `Yes`：`key = nfc(x)`；
  - 其余：`key = x`。
- 新增依赖的构建影响：`unicode-normalization` 的传递依赖 `tinyvec`/`tinyvec_macros` 已在锁文件内，`unicase` 无依赖；二者合计向 `Cargo.lock` 新增 2 个包（`unicode-normalization`、`unicase`）。

**13 组向量在各 crate/标准库上的本机运行结果**（`e_exp`，`rustc 1.95.0`；`caseless 0.2.2`、`unicase 2.10.0`、`unicode-normalization 0.1.26`；“相等”表示两个字符串经该函数处理后相等）。证据类型：推断（本机运行观察）＋项目源码；不计“已验证”：

<!-- prettier-ignore -->
| # | a | b | caseless 完整折叠 | caseless 规范无大小写匹配 | unicase 完整折叠 | `to_lowercase` 相等 | `to_uppercase` 相等 | 仅 NFC 相等 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | README | readme | 相等 | 相等 | 相等 | 相等 | 相等 | 不等 |
| 2 | Straße | STRASSE | 相等 | 相等 | 相等 | **不等** | 相等 | 不等 |
| 3 | ß | ẞ（U+1E9E） | 相等 | 相等 | 相等 | 相等 | **不等** | 不等 |
| 4 | i | İ（U+0130） | 不等 | 不等 | 不等 | 不等 | 不等 | 不等 |
| 5 | I | ı（U+0131） | 不等 | 不等 | 不等 | 不等 | **相等** | 不等 |
| 6a | σ | Σ | 相等 | 相等 | 相等 | 相等 | 相等 | 不等 |
| 6b | ς | Σ | 相等 | 相等 | 相等 | **不等** | 相等 | 不等 |
| 6c | σ | ς | 相等 | 相等 | 相等 | **不等** | 相等 | 不等 |
| 7 | é（U+00E9） | e＋U+0301 | 不等 | 相等 | 不等 | 不等 | 不等 | **相等** |
| 8 | É | é | 相等 | 相等 | 相等 | 相等 | 相等 | 不等 |
| 9a | Ａ（U+FF21） | a | 不等 | 不等 | 不等 | 不等 | 不等 | 不等 |
| 9b | Ａ | A | 不等 | 不等 | 不等 | 不等 | 不等 | 不等 |
| 10a | ǅ | ǆ | 相等 | 相等 | 相等 | 相等 | 相等 | 不等 |
| 10b | ǅ | Ǆ | 相等 | 相等 | 相等 | 相等 | 相等 | 不等 |
| 10c | ǆ | Ǆ | 相等 | 相等 | 相等 | 相等 | 相等 | 不等 |
| 11a | K（U+212A） | k | 相等 | 相等 | 相等 | 相等 | **不等** | 不等 |
| 11b | K（U+212A） | K | 相等 | 相等 | 相等 | 相等 | **不等** | **相等**（NFC 把 U+212A 映射为 K） |
| 12 | ﬃ（U+FB03） | ffi | 相等 | 相等 | 相等 | **不等** | 相等 | 不等 |
| 13 | Ꭰ（U+13A0） | ꭰ（U+AB70） | 相等 | 相等 | 相等 | 相等 | 相等 | 不等 |

补充观察：`caseless::default_case_fold_str("İ")` 与 `UniCase::unicode("İ").to_folded_case()` 都是 `"i\u{307}"`；`"ẞ"` 两者都折叠为 `"ss"`，而 `to_lowercase` 给出 `"ß"`；`"ΑΣ".to_lowercase()` 是 `"ας"`（词尾 ς）。拼好的键函数（`nfc(nfd(fold(nfd(x))))`）在 13 组（19 个配对）上与上表“规范无大小写匹配”列一致；其中 #4、#5、#9 为“不等”，意味着：若某文件系统把 İ/ı/全角字母也视为同名（这些由 Microsoft/Apple 小节核实），完整折叠键会漏判，需要文件身份兜底之外的手段（例如 normalized-path 的“过度折叠”思路），这是否需要由用户决策。

#### E.2 caseless 与 unicase 各实现哪种折叠；与 `str::to_lowercase` 的差异

- caseless 0.2.2：C+F，Unicode 16.0.0，无 S 无 T。｜B3 第 9 条｜已验证
- unicase 2.10.0：C+F，数据含 Unicode 18 新增项（49/49），无 S 无 T。｜B4 第 9–10 条｜折叠种类已验证，版本号部分验证
- 标准库 `str::to_lowercase`：`Lowercase_Mapping`（含无条件 SpecialCasing，词尾 Σ 上下文规则），Unicode 17.0.0，无折叠。｜B8｜已验证
- 差异的后果见上表（加粗行）。

#### E.3 `windows-sys` 需要新增哪些 feature（以 `windows-sys-0.59.0` 本机源码为准）

源码路径：`C:/Users/skyji/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/windows-sys-0.59.0/`（`Cargo.lock` 校验和 `1e38bc4d79ed67fd075bcc251a1c39b32a1776bbe92e5bef1f0bf1f8c531853b`；网络出处 https://static.crates.io/crates/windows-sys/windows-sys-0.59.0.crate）。访问日期 2026-10-18；证据类型：项目源码；验证状态：已验证（符号位置与 `cfg` 条件均直接读源码）。

<!-- prettier-ignore -->
| 符号 | 所在模块与行号 | 需要的 Cargo feature（模块级加符号级 `cfg`） | 项目 `Cargo.toml` 现状 |
| --- | --- | --- | --- |
| `NtQueryInformationFile` | `src/Windows/Wdk/Storage/FileSystem/mod.rs` 第 671 行（链接到 `ntdll.dll`） | 模块：`Wdk_Storage_FileSystem`（`src/Windows/Wdk/Storage/mod.rs` 的 `#[cfg(feature = "Wdk_Storage_FileSystem")] pub mod FileSystem;`）；符号：`#[cfg(feature = "Win32_System_IO")]`（第 670 行） | `Win32_System_IO` **已有**；`Wdk_Storage_FileSystem` **缺，需新增**（Cargo.toml 中 `Wdk_Storage_FileSystem = ["Wdk_Storage"]`，`Wdk_Storage = ["Wdk"]`，`Wdk = ["Win32_Foundation"]`，故只需加这一项） |
| `FILE_CASE_SENSITIVE_INFORMATION`（`pub Flags: u32`） | 同文件第 2354 行 | 模块级 `Wdk_Storage_FileSystem`，无额外符号级 `cfg`（紧邻上方只有 `#[repr(C)]`、`#[derive(Clone, Copy)]`） | 同上，需新增 |
| `FileCaseSensitiveInformation`（`FILE_INFORMATION_CLASS = 71i32`）与 `FileCaseSensitiveInformationForceAccessCheck`（75） | 同文件第 1503–1504 行；类型 `FILE_INFORMATION_CLASS = i32` 在第 2034 行 | 同上 | 同上，需新增 |
| `IO_STATUS_BLOCK` | `src/Windows/Win32/System/IO/mod.rs` 第 14 行 | `Win32_System_IO` | 已有 |
| `NtSetInformationFile`（若要写目录标志；探测不需要） | 同 Wdk 文件第 688 行 | 同 `NtQueryInformationFile` | 需新增（本项目 `platform/file_cas.rs` 第 642–657 行已手写了它的声明，说明项目先例是自写 FFI） |
| `GetVolumeInformationByHandleW` | `src/Windows/Win32/Storage/FileSystem/mod.rs` 第 236 行（`kernel32.dll`） | `Win32_Storage_FileSystem`；符号级无额外 `cfg`（参数类型 `HANDLE` 来自 `Win32_Foundation`） | 两项**都已有** |
| `GetFileInformationByHandle`、`BY_HANDLE_FILE_INFORMATION` | 同文件第 185 行、第 1557 行 | `Win32_Storage_FileSystem`（`file_identity.rs` 现在就在用它） | 已有 |
| `GetFileInformationByHandleEx`、`FileIdInfo`（18）、`FILE_ID_INFO`、`FILE_ID_128`（ReFS 128 位文件 ID，补身份缺口） | 同文件第 186、793、2174、2118 行 | `Win32_Storage_FileSystem` | 已有 |
| `FileCaseSensitiveInfo`（`FILE_INFO_BY_HANDLE_CLASS = 23i32`，经 `GetFileInformationByHandleEx`） | 同文件第 782 行；对应结构 `FILE_CASE_SENSITIVE_INFO` 在 `src/Windows/Win32/System/WindowsProgramming/mod.rs` 第 1185 行 | `Win32_Storage_FileSystem`（常量）与 `Win32_System_WindowsProgramming`（结构） | 常量所在 feature 已有，结构所在 feature 缺。**注意**：微软 `FILE_INFO_BY_HANDLE_CLASS` 页的枚举语法里列出了 `FileCaseSensitiveInfo`，但常量表无该项说明，`GetFileInformationByHandleEx` 页也无该类，所以这条路是否受支持**未验证**，不建议采用；有文档的是 ntifs 路线（上面 `NtQueryInformationFile`） |
| `FILE_CASE_SENSITIVE_SEARCH`（1）、`FILE_CASE_PRESERVED_NAMES`（2）、`FILE_UNICODE_ON_DISK`（4）、`FILE_SUPPORTS_CASE_SENSITIVE_DIRS`（8192）、`FILE_CS_FLAG_CASE_SENSITIVE_DIR`（1） | `src/Windows/Win32/System/SystemServices/mod.rs` 第 458、457、490、474、459 行 | `Win32_System_SystemServices`（`#[cfg(feature = "Win32_System_SystemServices")] pub mod SystemServices;`） | 项目 `Cargo.toml` **未声明**；当前统一后启用是因为 `winx 0.36.4` 声明了它（`winx/Cargo.toml`）。建议两选一：显式加 `Win32_System_SystemServices`，或像 `file_cas.rs` 对 `FILE_RENAME_*` 那样本地定义常量并注明出处 |

补充：

- `FILE_SUPPORTS_CASE_SENSITIVE_DIRS`（8192）这个卷标志位的含义（卷是否支持按目录大小写敏感）在 windows-sys 里存在，但微软文档 `GetVolumeInformationByHandleW` 页的表是否列出它，调研员只验证了 `FILE_CASE_SENSITIVE_SEARCH`；其他位的官方描述归 Microsoft 小节。
- `0.61.2` 版的 Wdk 与 Win32 布局相同（`Wdk/Storage/FileSystem/mod.rs` 第 671 行、第 1630 行、第 3151 行；`FILE_CASE_SENSITIVE_INFORMATION` 增加了 `Default` 派生）；因此若日后升级到 0.61，feature 名称不变。
- 链接：MSVC 目标上 `windows-targets 0.52.6` 用预编译导入库 `windows_x86_64_msvc-0.52.6/lib/windows.0.52.0.lib`，调研员在其中 `grep -c NtQueryInformationFile` 得 3 处命中，说明导入库含该符号；与项目 `+crt-static` 的配置（`src-tauri/.cargo/config.toml`）无关。｜本机 registry｜2026-10-18｜项目源码＋推断（二进制字符串匹配）｜部分验证（缺：未实际编译链接一个调用该符号的程序）

#### E.4 其他回答

- 文件身份比较是否需要 same-file：不需要（B1）。
- Unix 探测要不要 rustix：不需要（B5 第 12 条，`libc` 已覆盖）。
- cap-primitives：不提供大小写能力，只提供 `Dir` 句柄；Windows 上其打开路径的大小写行为在“目录级区分大小写”场景未验证（B7 第 8 条）。

## 4. 与设计草案的差异与建议修改项

### 4.1 核对口径

- 草案中“待调研核实”标注：`grep -n "待调研核实" docs/milestones/0.4.0/M6-closure-review.md` 命中 **20 行**（行内出现次数合计 21 处）；其中 4917、4922、4926–4928、4930、5019、5032、5046、5061 等行一行含多个条目。本部分第 4.3 节的覆盖表按**行**逐一处理（20 行，一行不漏），每行的条目在第 4.4 至 4.8 节的分区处理表里有逐条结论，覆盖行数 20 = grep 行数 20。
- 本部分引用的主报告行号基于提交 `cd66e96`（回写之前）；回写后 4.4.5 追加 1 行、4.7.2.12 追加约 9 行，实际 `grep` 行号相应后移（4.4.5 之后的行号约后移 1，4.7.2.12 之后约后移 10）。
- 本部分不修改主报告 4.7.2 的设计正文；下列“建议修改”由 076 或用户在 D-1 处理。
- 编制者核对到、且 075 前置检查已发现的陈旧引用（属主报告 4.7.2.1 与测试规格 FE-SEAM-16 的文字，不是调研结论）：4.7.2.1 写的 `PtyWorkspace.tsx:775/786/873`、`workspaceLayoutPersistence.ts:224/229/237` 现已迁移为 `src/lib/workspaceLayoutPersistence.ts:252/257/265`、`src/workspace/persistence/workspacePresetLayout.ts:115/122`、`src/workspace/domains/fileDocumentsDomain.ts:318`；`models/workspace_layout.rs:122` 的 `HashSet<(i64,&str)>` 去重现位于约 186–196 行；`WorkspaceFileDocument` 现位于 399–404 行；“`ProjectRef` 尚不存在、`open_for` 返回 `Result<Self,…>`”已过期（`ProjectRef` 与 `open_ref` 已存在，`open_for` 退为 `#[cfg(test)]`）；“依赖 3B.5 的 `platform/file_identity` 目标设计”已过期（`platform/file_identity.rs` 已存在，见 4.2 第 11 条）。这些由 076 在其偏差表里更正，本记录不改主报告。

### 4.2 与草案的主要差异（按影响排序）

<!-- prettier-ignore -->
| # | 草案位置（4.7.2.x） | 草案原文要点 | 调研发现 | 建议修改 | 影响的规格或文档 | 验证状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4.7.2.3 Linux 行 ② | “已知不敏感类型表（`f_type`：vfat、exfat、ntfs、ntfs3）” | 内核 ntfs3 与 ntfs-3g 默认都**区分大小写**；ntfs3 要 `nocase`（v6.2 起）才不敏感；v7.1 起新 `fs/ntfs` 驱动默认也区分，旧驱动（≤v6.8）默认不敏感，`f_type` 同为 0x5346544e，魔数不能决定结论 | 从类型表删除 ntfs、ntfs3；vfat 改为“默认不敏感但受 `check=` 与 `iocharset=` 影响，需读挂载选项”；exfat 保留；NTFS 系统一律先读挂载选项，读不到则行为探测 | L-19 步骤 6、7；RS-T62 | 已验证（ntfs3/新 ntfs/ntfs-3g 源码）；真实挂载未实机 |
| 2 | 4.7.2.3 Windows 行 | 判定规则：“卷不支持区分大小写搜索则为 Insensitive；卷支持则读目录级标志”；触发行为探测的条件并列写为“API 失败、SMB 共享、`\\wsl$` 共享” | 草案已把 SMB 与 `\\wsl$` 列为行为探测的触发条件，但没有规定**判定顺序**。NTFS、ReFS 卷标志恒置位（已验证）；本机观察 SMB 客户端把 NTFS 服务端的卷标志位清零，若先套用“卷不支持则 Insensitive”，SMB 就可能被判成 Insensitive；`\\wsl$` 卷标志置位但目录级查询返回 `STATUS_NOT_SUPPORTED`，把“查询失败”当“标志为 0”会误判（以上两点为本机只读观察，推断类，仅一个 SMB 环回与一个 WSL 发行版） | 明确判定顺序：**先判远程，远程一律行为探测**；本地再读卷标志（FAT/exFAT 未置位即 Insensitive）与目录级标志；目录级查询失败走行为探测，不得当作 0 | W-20 步骤 4、5；RS-T62 测试十 | 部分验证（官方文档与 MS-FSA 表已验证；SMB、`\\wsl$` 现象来自本机只读观察，推断类） |
| 3 | 4.7.2.3 macOS 行 | “`pathconf(_PC_CASE_SENSITIVE)` 或 `getattrlist` 的 `VOL_CAP_FMT_CASE_SENSITIVE`” | `pathconf(2)` 官方 man 页**没有**收录 `_PC_CASE_SENSITIVE`（只存在于 XNU 头文件与内核源码）；`getattrlist(2)` 官方 man 页收录 `VOL_CAP_FMT_CASE_SENSITIVE`，且必须同时检查 `valid` 位；smbfs 的 `pathconf` 固定返回 0，不能当探测；NFS 的 `pathconf` 可能发网络 RPC；三个入口都有句柄版（`fpathconf`、`fgetattrlist`、`fstatfs`） | 用项目根的 `fd` 查询；先 `fstatfs` 取类型名再分流；`smbfs` 直接行为探测；NFS 带预算 | M-19 第 5 项；RS-T62 | 已验证（官方 man 页、XNU 源码）；APFS 返回值未验证 |
| 4 | 4.7.2.2 与 4.7.2.12 一（规范化轴） | “macOS 以外通常只有大小写轴有意义…默认 No 或 Unknown”；“APFS 保留但不敏感、HFS+ 强制 NFD” | 确认 macOS：APFS 两个变体与 HFS+ 两个变体的规范化轴都应为 `Yes`（官方 FAQ：区分大小写变体同样规范化不敏感；TN1150）。Linux：ext4/f2fs/tmpfs 的 casefold 目录比较前做 NFD（`Yes`）；其余常见本地文件系统源码不含规范化调用（`No`，部分验证）；Windows 本地 NTFS/exFAT/FAT 不做规范化（部分验证）；macOS 无公开 API 查询规范化轴，只能按 `f_fstypename` 判 | 规范化轴不做行为探测，按类型与目录位推断；推断不了则 `Unknown`；APFS/HFSX 区分大小写变体也写 `Yes` | RS-T62；M-19 | 已验证（macOS、casefold）；其余部分验证 |
| 5 | 4.7.2.2 与 4.7.2.12 一（折叠函数） | “折叠函数只是近似：NTFS 比较用卷自己的 upcase 表，不等同标准 Unicode 大小写折叠（待调研核实）” | 确认。NTFS/exFAT 的 upcase 表是逐 UTF-16 码元一对一、格式化时写入卷、非 BMP 不处理；与标准简单折叠不同的有 ẞ、K（开尔文符号）、ǅ（titlecase）、Cherokee 小写，ς 在两个来源间冲突（未验证），ı 刻意不折叠。HFS+ 是 Apple 自定义表（Unicode 3.2）；APFS 官方只说 Unicode 9.0，不说 simple 还是 full；ext4 casefold 是 NFD 加完整折叠（C+F，Unicode 12.1.0）；vfat 是 `iocharset` 的单字节小写表 | 保留“折叠键相同只是候选、合并须文件身份确认”；折叠函数选型见第 5.6 节与 D-1-3 | 4.7.2.10 第 4 项；4.7.4 表第 4 行 | 部分验证（源码与官方规范；真实 `$UpCase`、真实 APFS 未实机） |
| 6 | 4.7.2.3 末尾“与 Git 的做法对照” | “`git init` 通过创建配置文件并以不同大小写访问来设置 `core.ignorecase`，是社区已有的‘创建后查询变体’探测” | 需要更精确：`git init` 确实先创建 `.git/config`，但那是 init 本来就要写的文件；`core.ignorecase` 探测**没有创建专用探测文件**，只对该已存在的文件访问变体 `CoNfIg`（`access(F_OK)`，只看存在性），属于“已有条目换大小写”，失败一律视为区分大小写（没有 Unknown），只在新建仓库时探测一次，探测位置是 git 目录而非工作树。真正“创建专用探测文件再查询变体”的是仅 macOS 构建的 `core.precomposeunicode` 探测（创建 NFC 名 `ä`，用 NFD 名 `access`，再 `unlink`）。大小写与规范化在 Git 里是两个独立开关、两个独立探测 | 改写该句：Git 复用 init 已创建的 `.git/config`，没有创建专用探测文件；补一句“五个成熟项目都没有在工作树根创建专用探测文件” | 4.7.2.3 | 已验证（Git v2.56.0 源码） |
| 7 | 4.7.2.3 行为探测第 1 条 | “能找到且身份相同 → Insensitive；找不到或身份不同 → Sensitive” | 与 Mercurial `fscasesensitive`（`lstat` 两次比较整个 stat 结果）几乎同构，但 Mercurial 把任何 `OSError` 都当“敏感”；Jujutsu 完全不探测，直接用文件身份。FUSE（libfuse 高层 API 未开 `use_ino`）与 cifs（`noserverino`）上同一文件的两个名字会得到不同 inode，“找到但身份不同 → Sensitive”不可信；vfat 逐字节比较，只翻转 ASCII 字母才可靠 | 行为探测只翻转 ASCII 字母；对 FUSE、cifs 把“找到但身份不同”映射为 `Unknown`，除非 mountinfo 证明 `use_ino` 或 `serverino` | 4.7.2.3；RS-T62 测试四 | 部分验证（Mercurial 源码已验证；FUSE、cifs 为源码推导） |
| 8 | 4.7.2.3 行为探测第 2 条 | “创建与删除文件可能被文件监听器、构建工具或同步工具看到（待调研核实其影响）” | 监听器一定能看到：`ReadDirectoryChangesW`、inotify、FSEvents 对创建与删除都发通知；杀毒、云同步、构建工具的具体反应**没有找到任何来源**。五个成熟项目的正常运行路径里都没有在用户工作树根创建大小写探测临时文件；Watchman 的 cookie 先例是“固定前缀加放进 `.git`/`.hg`/`.svn`” | 保持“已有条目换大小写优先、临时文件仅最后手段”；临时文件用专用前缀并纳入隐藏规则；副作用继续标未验证 | 4.7.2.3；4.7.4 表第 9 行 | 通知机制已验证；具体影响未验证 |
| 9 | 4.7.2.3 Windows 行 | “目录级标志在 WSL 场景下按目录开启且可被新建子目录继承” | 不止 WSL：`fsutil file setCaseSensitiveInfo` 即可在本地 NTFS（据文档含 ReFS）上设置；继承规则官方来源互相矛盾（2018-03 博客“不继承”，2018-06 博客与当前 Learn 页“继承，WSL 1 例外”，同一 Learn 页另一警告“Windows 应用创建的子目录不是大小写敏感”） | 结论改为“取决于创建目录的一方”；子目录必须各自查询 | W-20 步骤 2 | 部分验证（须实机） |
| 10 | 4.7.2.3 Windows 行 | “SMB 共享（服务端可能是区分大小写的 Samba）” | Samba 默认不区分（`case sensitive = auto`，对 Windows 客户端等同 `no`），只有显式 `yes` 才区分，且无论配置都报告 `FILE_CASE_SENSITIVE_SEARCH`，所以卷标志对 Samba 无信息量 | 改写；W-20 增加一个 Samba 条目 | 4.7.2.3；W-20 步骤 5 | 部分验证（手册与源码；客户端表现缺 Samba 服务端） |
| 11 | 4.7.2.4 与 4.7.2.5 | “依赖 3B.5 的 `platform/file_identity` 目标设计，不在本版范围” | `platform/file_identity.rs` 已存在并在用（提交 `516cf13`，`m6-034`；`file_cas.rs`、`path_identity.rs` 都用它）：Unix `(dev, ino)`，Windows `(卷序列号, 64 位文件索引)`。缺口：微软文档写明 “The 64-bit identifier in this structure is not guaranteed to be unique on ReFS”，现实现不用 `FILE_ID_INFO`（128 位）；`windows-sys` 已启用的 `Win32_Storage_FileSystem` 里有 `FileIdInfo`、`FILE_ID_INFO`，补缺口不需要新增 feature。Git 在 Windows 上关闭 inode 信任（`trust_ino = 0`，源码无注释，原因未验证） | 改写“目标设计”为现状；ReFS/Dev Drive 的身份缺口作为 D-1 决策问题单列（是否并入 076 或另立目标） | 4.7.2.4–5；第 8 部分 Q7 | 已验证（微软文档、仓库代码）；碰撞概率未实机 |
| 12 | 4.7.2.3 Linux 行 ① | “casefold 目录标志（`ioctl(FS_IOC_GETFLAGS)` 的 `FS_CASEFOLD_FL`，ext4、f2fs 按目录）” | 确认，补充：tmpfs 自 v6.13 起有 `casefold` 挂载选项；必须对**目录** fd 查询；缓冲区用 32 位；“位未置位 = 区分大小写”只对 ext4、f2fs、tmpfs 成立；Linux v7.2 新增统一只读接口（`FS_CASEFOLD_FL`、`FS_XFLAG_CASEFOLD`），vfat、exfat、ntfs3、cifs（仅目录）、nfs 等开始报告，但旧内核没有，不能依赖 | 位未置位仅对 ext4/f2fs/tmpfs 解释为 `Sensitive`；对其他类型，位已置位可信 `Insensitive`，位未置位不可信 | RS-T62；L-19 | 已验证（内核源码与补丁） |
| 13 | 4.7.2.12 参考对象清单 | Git 起点 `builtin/init-db.c` | Git v2.56.0 中 `create_default_files` 在 `setup.c`；`builtin/init-db.c`（https://raw.githubusercontent.com/git/git/v2.56.0/builtin/init-db.c ，2026-10-18 取回，约 260 行）里只有 `cmd_init_db` 与对 `init_db` 的调用，没有 `ignorecase`、`precompose` 或 `CoNfIg` 探测代码（不区分大小写的 `grep -i` 命中的两处是配置名 `config`，不是探测） | 更正路径为 `setup.c` | 4.7.2.12 三 | 已验证（curl 取回原文 grep） |
| 14 | 4.7.2.4 | “第一版只探测项目根，嵌套挂载点与目录级标志是已知限制” | 确认：没有任何成熟项目对子目录做惰性探测，都是“每个仓库/根一次”；Watchman 在 Linux 上用最长前缀匹配 `/proc/self/mounts` 找所属挂载，是“按路径找挂载点”的现成实现 | 无需改；演进路径保持 | 4.7.2.4 | 已验证（限于所读代码） |
| 15 | 4.7.2.11 / RS-T62 测试四（硬链接盲区） | “探测选取条目时必须要求普通文件且链接数为 1” | 合理且比成熟项目更严格：Git 只做存在性检查，Mercurial 比较整个 stat 结果，没有项目处理硬链接别名。取链接数：Unix `st_nlink`，Windows `BY_HANDLE_FILE_INFORMATION.nNumberOfLinks`（现有 `file_identity.rs` 已调用同一函数，不需新增 feature） | 补充：排除重解析点（junction、符号链接、OneDrive 占位文件），查询不跟随；FUSE、cifs 另见第 7 条 | RS-T62 测试四 | 部分验证（目录与重解析点的链接数未验证） |
| 16 | 4.7.2.10 第 4 项 / 4.7.4 表第 4 行 | “Unicode 折叠选型先限定 simple case folding，NTFS 与 APFS 实机差异待调研” | 没有成熟的 simple folding（C+S）小 crate；`unicase 2.10.0` 与 `caseless 0.2.2` 都是完整折叠（C+F），`caseless` 的数据停在 Unicode 16.0.0（对 Unicode 18 新增的 49 条折叠命中 0/49，`unicase` 49/49）。完整折叠键只会多出“候选相同但身份不同”的情形，被文件身份确认拦住；更细的折叠才会漏掉候选，且漏掉的无法被兜底纠正 | 建议改为“完整折叠（C+F）键 + 合并前必须文件身份确认”，或选 D-1-3 的 ASCII-only 保守方案；见第 5.6 节 | 4.7.2.10 第 4 项 | 部分验证（推断自 4.7.2.5 流程；`unicase` 数据版本号未验证） |
| 17 | 4.7.2.12 四（实机矩阵 W-20、M-19、L-19） | 各位置期望值“调研完成前均为待调研核实的假设” | 多处期望需改写、多个位置需新增，见第 7 部分 | 见第 7 部分 | W-20、M-19、L-19、X-26 | 见第 7 部分 |

### 4.3 “待调研核实”逐行覆盖表（20 行 = grep 命中行数）

<!-- prettier-ignore -->
| # | 主报告行号 | 草案条目摘要 | 处理结果 | 详见 |
| --- | --- | --- | --- | --- |
| 1 | 4917 | 规范化轴：macOS 以外平台默认 `No` 或 `Unknown`，不得凭经验写死 | 确认并修正：macOS 的 APFS/HFS+ 四个变体均 `Yes`；Linux casefold 目录 `Yes`、其余本地类型 `No`（部分验证）；Windows 本地 `No`（部分验证）；远程与未知 `Unknown` | 4.2 第 4 条；4.4–4.7 各分区第一行 |
| 2 | 4918 | NTFS 比较使用卷自己的 upcase 表，不等同标准 Unicode 折叠 | 确认（部分验证）：逐码元一对一、格式化时写入卷、非 BMP 不处理；差异码点见第 5.6 节向量表 | 4.2 第 5 条；4.4 |
| 3 | 4922 | 探测链表前总述：API 名、标志位、类型表、挂载选项均待核实 | 已逐项落实为第 2 部分 24 行总表；结论见各分区处理表 | 第 2 部分；4.4–4.8 |
| 4 | 4926 | macOS：`pathconf(_PC_CASE_SENSITIVE)` 或 `getattrlist` 的 `VOL_CAP_FMT_CASE_SENSITIVE`；规范化轴按卷格式（HFS+ 强制 NFD、APFS 保留但不敏感） | 确认两个 API 名与常量存在；修正：`valid` 位、smbfs、NFS、官方 man 页未收录 `_PC_CASE_SENSITIVE`；规范化轴确认并细化 | 4.2 第 3、4 条；4.5 |
| 5 | 4927 | Windows：卷标志加目录级标志；WSL 场景下按目录开启且可被新建子目录继承 | API 名、信息类、结构、标志值确认（已验证）；判定流程修正（先判远程、查询失败≠0）；继承规则修正为取决于创建方 | 4.2 第 2、9 条；4.4 |
| 6 | 4928 | Linux：casefold 目录标志；已知不敏感类型表；FUSE 魔数；CIFS `nocase`；NFS；ZFS | 逐项确认或修正：删除 ntfs、ntfs3；vfat 改读挂载选项；FUSE、cifs、nfs、zfs 行为探测 | 4.2 第 1、12 条；4.6 |
| 7 | 4930 | 行为探测方式：需与社区实践对照后定稿 | 部分确认：五个成熟项目的对照已完成；Mercurial、Git 同构先例；只翻转 ASCII 字母；FUSE、cifs 身份不可信 | 4.2 第 6、7 条；4.7 |
| 8 | 4944 | 创建与删除文件可能被监听器、构建工具、同步工具看到（待核实影响） | 部分确认：监听器必然看到；杀毒、同步、构建工具的具体影响未验证 | 4.2 第 8 条；4.4–4.7 |
| 9 | 4947 | 与 Git 的做法对照 | 修正：Git 探测属“已有条目换大小写”，不创建文件 | 4.2 第 6 条；4.7 |
| 10 | 5006 | 第 9 项：行为探测两级方式对监听器、构建工具、同步工具的影响 | 同第 8 行：未验证部分列入第 6 部分 | 4.2 第 8 条 |
| 11 | 5019 | 用户补充：macOS 精确到项目所在卷；Windows 与 Linux 理论上以文件系统为准，但要兼容外部卷（如 Linux 的 NTFS 驱动） | 确认并加重：Linux 读 NTFS 有四种形态（ntfs3、新 ntfs、旧 ntfs、ntfs-3g），默认几乎都区分大小写；“简单按 OS”只能作保底默认，VS Code 的相关 issue 长期未解决 | 4.2 第 1 条；4.6；4.7 |
| 12 | 5024 | 大小写属性按卷（同一 APFS 容器不同卷可不同） | 确认（卷超级块标志；`diskutil apfs addVolume` 的 personality 永久） | 4.5 |
| 13 | 5026 | macOS 第二根轴：规范化不敏感（HFS+ NFD，APFS 保留但不敏感） | 确认并细化：APFS 区分大小写变体也规范化不敏感 | 4.2 第 4 条；4.5 |
| 14 | 5028 | NTFS 默认不敏感，但有按目录标志（WSL、继承） | 默认不敏感与按目录标志：确认；继承：修正为取决于创建方，未验证 | 4.2 第 9 条；4.4 |
| 15 | 5030 | 同 4918：NTFS upcase 与标准折叠不等价，折叠函数只能近似，文件身份兜底必须保留 | 确认；兜底必须保留；折叠选型建议见第 5.6 节 | 4.2 第 5、16 条 |
| 16 | 5032 | Linux 不能只靠 `f_type`：FUSE、CIFS、NFS、ZFS、ext4/f2fs casefold | 确认并具体化：类型到所需探测手段的映射表见第 5.4 节 | 4.6；第 5.4 节 |
| 17 | 5036 | 推荐的行为探测方式需与社区实践对照 | 确认：Mercurial、Git 为同构先例；没有项目在工作树根创建专用探测文件 | 4.7 |
| 18 | 5046 | 参考对象清单（均待核实）：Git、VS Code、Watchman、Jujutsu、Mercurial、Apple、Microsoft、Linux 内核、Rust crate | 已全部调研，见第 3 部分 9 个对象小节 | 第 3 部分 |
| 19 | 5061 | 实机卷矩阵：W-20、M-19、L-19、X-26 的期望结果均为待核实假设 | 逐项结论与修订建议见第 7 部分 | 第 7 部分 |
| 20 | 5119 | 4.7.4 表第 9 行：行为探测的两级方式及其影响待调研 | 同第 8 行 | 4.2 第 8 条 |

覆盖行数 20，grep 命中行数 20，两个数字一致。

### 4.4 分区处理表：Windows 与 Microsoft

<!-- prettier-ignore -->
| 草案位置 | 草案原文要点 | 确认/修正为 X/未验证 | 依据 |
| --- | --- | --- | --- |
| 4.7.2.2（约 4917 行） | 非 macOS 平台规范化轴默认 `No` 或 `Unknown`，待核实 | **确认**：Windows 本地 NTFS/exFAT 的规范化轴取 `No`（部分验证）。远程/`\\wsl$` 的规范化轴随服务端，保持 `Unknown` | Kaplan 存档博客“normalization still does not happen”；CompareStringOrdinal 文档“disregards all non-binary equivalences”（Security Considerations 页摘录）；exFAT 规范上只有 up-case 映射、无规范化步骤（推断）。来源 URL 见 B.2。官方文档对 NTFS 无直接“不做规范化”的一句话，所以只标部分验证 |
| 4.7.2.2（约 4918 行）与 4.7.2.12（约 5030 行） | NTFS 比较使用卷自己的 upcase 表，不等同标准 Unicode 大小写折叠，待核实 | **确认**（部分验证）。补充：该表逐 UTF-16 码元一对一、格式化时固定、非 BMP 不处理；与标准简单折叠在 ς、ẞ、K、ǅ、Cherokee 小写等处不同（对应小节的“D. 向量判定”） | MS-FSCC 5.3、FsRtlAreNamesEqual 文档、ntfs3 与 ntfs-3g 源码、Tippet 评论、本机 OS 表对照 Unicode 18.0.0 CaseFolding |
| 4.7.2.3 表 Windows 行（约 4927 行） | `GetVolumeInformationByHandleW` + `NtQueryInformationFile(FileCaseSensitiveInformation)`；“卷不支持则 Insensitive，支持则读目录标志”；NTFS 置位卷标志但默认目录仍不区分，不能只看卷标志 | **API 名、信息类、结构、标志值：确认（已验证）**。**NTFS 置位卷标志但默认不区分：确认（已验证）**。**判定流程需修正**：① 先判远程（`FILE_REMOTE_DEVICE`/`DRIVE_REMOTE`）；远程一律行为探测；② 目录级查询返回失败（如 `STATUS_NOT_SUPPORTED`）不得当作“标志为 0”，应进入行为探测；③ “卷不支持区分大小写搜索则为 Insensitive”只适用于本地 FAT/exFAT 等（MS-FSA 表），对远程不适用 | Microsoft 小节 B.1 问 1、问 2；本机观察：`\\localhost\C$` 卷位被清、`\\wsl$` 卷位置位而目录级查询失败 |
| 4.7.2.3 表 Windows 行（约 4927 行） | “目录级标志在 WSL 场景下按目录开启且可被新建子目录继承” | **修正为**：按目录标志不止 WSL 场景，`fsutil file setCaseSensitiveInfo` 即可在本地 NTFS（及据文档 ReFS）上设置；继承规则官方来源矛盾，取决于创建方，需实机 | Microsoft 小节 B.1 问 3 |
| 4.7.2.3 同表（约 4927 行） | SMB 共享（服务端可能是区分大小写的 Samba）进入行为探测 | **修正为**：默认 Samba 不区分（`case sensitive = auto`，对 Windows 客户端等同 `no`），只有显式 `yes` 才区分；Windows 客户端经 SMB 看到的卷标志不可信（NTFS 服务端被清位；Samba 总是报告置位）。结论同样是行为探测 | smb.conf 手册；Samba `smb2_trans2.c`；本机环回 SMB 观察 |
| 4.7.2.3 同表（约 4927 行） | `\\wsl$`（经 9P 访问 ext4）进入行为探测 | **确认**，并补充：该位置**卷标志置位**但目录级查询不支持，必须由行为探测才能得出 `Sensitive` | WSL 排障页（9P）；本机观察 |
| 4.7.2.3 行为探测（约 4930–4944 行）第 1 条 | “已有条目换大小写（只读）”可用 `symlink_metadata` 加文件身份比较 | **确认在 Windows 可行**（本机观察：NTFS、SMB 环回上 `README.md` 与 `readme.MD` 均存在；`\\wsl$` 上 `ETC` 不存在）。建议补充条件：条目须为非重解析点的普通文件且 `nNumberOfLinks==1`（E.2） | 本机只读观察；GetFileInformationByHandle 文档 |
| 4.7.2.3（约 4944 行） | 创建与删除文件可能被文件监听器、构建工具或同步工具看到（待核实其影响） | **部分确认**：监听器会收到创建/删除通知（官方文档）；Defender/第三方杀毒会在 Dev Drive 上附加过滤器；OneDrive/Dropbox 等同步工具、构建工具的具体影响**未验证**。见 E.5 | ReadDirectoryChangesW 文档；Dev Drive 文档 |
| 4.7.2.3（约 4947 行） | 对照 Git 的实现 | 不在本小节（Git 小节负责）。仅补充：微软员工建议的“创建两个文件再检查”即与 Git 同类的探测，见 Microsoft 小节 B.1 问 5 | Old New Thing 评论 |
| 4.7.2.8（约 5061 行起，卷矩阵）与 4.7.2.12 一节 | Windows：“`fsutil file setCaseSensitiveInfo` 启用目录（部分系统需要先启用相关可选组件）” | **部分确认**：需管理员、权限、目录为空已验证；“需要先启用 WSL 可选组件”**未验证**（官方 fsutil 文档未提；社区 issue 作者称“If WSL is installed”可调用 `NtSetInformationFile`，但未能核到原文）。本机观察到注册表 `NtfsEnableDirCaseSensitivity`=3 存在，含义未验证 | WSL case-sensitivity 页；GitHub issue 3885；UW-4 |
| 4.7.2.12 一（约 5028 行） | NTFS 默认不敏感，但存在按目录标志（WSL 场景，被新建子目录继承，待核实） | 默认不敏感：**确认**；按目录标志：**确认**；继承：**修正为取决于创建方，未验证** | 同上 |
| 4.7.2.12 一（约 5028 行） | 需要考虑的位置：ReFS、exFAT、FAT、Dev Drive、SMB 共享、`\\wsl$` | **确认**，补充：本机映射网络驱动器、subst、挂载的 VHD 也应通过同一流程（远程判定看句柄而非盘符）；见第 5.2 节 | 本仓库 file_cas.rs 的远程判定 |
| 测试规格 RS-T62 测试十（约 3335 行） | Windows 默认 NTFS 目录 → Insensitive；启用后 → Sensitive | **确认**（见总表 ①②）。提示：创建启用目录需要管理员，CI 的 Windows 运行器是否为管理员**未验证**，建议保持 `#[ignore]`，转实机 W-20 | 总表 ① ② |
| 测试规格 W-20（约 4189–4215 行）步骤 1 | NTFS 默认目录 → Insensitive | **确认** | 总表 ① |
| W-20 步骤 2 | `case-cs` 为 Sensitive；`sub` 继承（待核实） | `case-cs`：**确认**；`sub` 继承：**不能预设期望**，改为“记录实际结果（分 `mkdir` 与 WSL 创建两种）” | Microsoft 小节 B.1 问 3 |
| W-20 步骤 3 | ReFS 或 Dev Drive → Insensitive（待核实） | 保持“待核实”，**未验证**；建议同时记录 `fsutil file queryCaseSensitiveInfo` 输出与注册表 `RefsEnableDirCaseSensitivity` | 总表 ③④ |
| W-20 步骤 4 | `\\wsl$` → `Sensitive` 或 `Unknown`；`Insensitive` 即误判 | **确认**，并补充只能由行为探测得出 `Sensitive`；本机观察与此一致 | 总表 ⑦ |
| W-20 步骤 5 | SMB 共享 → `Insensitive` 或 `Unknown`（服务端可能是区分大小写的 Samba） | **确认**（Windows 服务端）；Samba 需另加条目，且默认也不区分 | 总表 ⑥a ⑥b |
| W-20 清理 | `fsutil file setCaseSensitiveInfo <目录> disable`（需目录为空） | **确认**（WSL 页：目录必须为空；含仅大小写不同文件时不能关闭） | Microsoft 小节 B.1 问 2 |
| 4.7.2.10 第 4 项（约 5000 行）与 4.7.4 表第 4 行 | Unicode 折叠选型先限定 simple case folding，NTFS 与 APFS 实机差异待调研确认 | **建议修正**：Windows 的 OS 表与 simple case folding 在 ς、ẞ、K、ǅ、Cherokee 小写、ı 上不同（对应小节的“D. 向量判定”），选用 simple case folding 会在这些码点上误折叠；折叠键相同只能算候选，必须保留文件身份二次确认 | 对应小节的“D. 向量判定” |

### 4.5 分区处理表：macOS 与 Apple

<!-- prettier-ignore -->
| 草案位置 | 草案原文要点 | 处理结果 | 依据 |
| --- | --- | --- | --- |
| 4.7.2.2（`M6-closure-review.md` 约第 4917 行） | 规范化轴 macOS 以外按“待调研核实”，默认 `No`/`Unknown`；`PathKey` 规范化为 NFC | **确认并补充**：macOS 上 APFS（两个变体）与 HFS+（两个变体）规范化轴都应判 `Yes`；macOS 无公开 API 查询规范化轴，按 `f_fstypename` 判定；exFAT/SMB/NFS 见 Apple 小节 E.2 | B.1 问 3.2、3.6、4.3；总表①–⑦ |
| 4.7.2.3 表 macOS 行（约第 4926 行） | 第一步 `pathconf(_PC_CASE_SENSITIVE)` 或 `getattrlist` 的 `VOL_CAP_FMT_CASE_SENSITIVE` | **确认两个 API 名与常量存在**；**修正**：①`getattrlist` 必须同时看 `valid` 位；②`pathconf` 在 APFS 与 exFAT 上的返回值源码不可见，仍要实机；③对 `smbfs` 这个 API 不能当探测（固定 0）；④NFS 可能触发网络 RPC | B.1 问 1、2；总表⑥⑦ |
| 4.7.2.3 表 macOS 行 | “规范化轴按卷格式判定：HFS+ 强制 NFD、APFS 保留但不敏感（待调研核实）” | **确认**：HFS+ 强制 NFD（TN1150 + `buildkey`），APFS “preserves … normalization … normalization-insensitive”（官方 FAQ + APFS 引用） | B.1 问 3.1–3.4、4.1–4.3 |
| 4.7.2.3 末段（约第 4944 行） | “创建与删除文件可能被文件监听器、构建工具或同步工具看到（待调研核实其影响）” | **部分确认**：XNU 在有 FSEvents 订阅者时对任何目录的创建/删除发 `FSE_CREATE_FILE`/`FSE_DELETE`（除 devfs）；Spotlight、Time Machine 的影响未找到来源，未验证 | Apple 小节 E.4 |
| 4.7.2.10 第 9 条 / 第 5119 行 | 行为探测的两级方式对监听器、构建工具、同步工具的影响（待调研核实） | 同上：FSEvents 部分已验证；对 Spotlight/Time Machine/iCloud 同步未验证；“已有条目翻转大小写”属于只读 lookup，源码里 lookup 不产生 FSEvents（`FSE_CREATE_FILE`/`FSE_DELETE` 只在创建/删除路径出现），此条为推断 | Apple 小节 E.4 |
| 4.7.2.12 一（约第 5024 行） | “大小写属性是按卷的（同一个 APFS 容器里的不同卷可以分别设置为区分大小写，待调研核实）” | **确认**：卷超级块标志；`diskutil apfs addVolume` 的 personality 是该卷“permanent” | B.1 问 3.4、总表② |
| 4.7.2.12 一（约第 5026 行） | “macOS 还有第二根轴：Unicode 规范化不敏感（HFS+ 强制 NFD，APFS 保留但不敏感，待调研核实）” | **确认**，并细化：APFS 区分大小写变体也规范化不敏感（官方 FAQ） | B.1 问 3.2 |
| 4.7.2.12 一（约第 5025 行） | 外接盘 APFS、HFS+（可选区分大小写）、exFAT、SMB 与 NFS 共享各不相同 | **确认**；exFAT 的 macOS 驱动 API 返回值未验证；SMB 的 API 只是默认假设；NFS 取决于服务器并可能走网络 | 总表⑤⑥⑦ |
| 4.7.2.10 第 4 条 / 第 5001、5114 行 | “Unicode 折叠选型：先限定 simple case folding，并在 NTFS 与 APFS 上实机验证折叠差异” | **未验证（保持待实机）**：Apple 只给出 Unicode 9.0；社区实现倾向 full folding；HFS+ 是 Apple 自定义表；差异清单见 对应小节的“D. 向量判定”，实机验证步骤见 UM-1 | B.1 问 3.3、3.7；对应小节的“D. 向量判定” |
| 4.7.2.12 三（约第 5051 行） | “Apple：`pathconf(_PC_CASE_SENSITIVE)`、`getattrlist(VOL_CAP_FMT_CASE_SENSITIVE)` 文档” | **已完成调研**：`pathconf(2)` 官方 man 页**未收录** `_PC_CASE_SENSITIVE`（只存在于头文件与内核源码）；`getattrlist(2)` 官方 man 页收录 `VOL_CAP_FMT_CASE_SENSITIVE` | B.1 问 1.2、2.1 |
| 4.7.2.12 四 M-19 表（约第 5065 行） | M-19 位置：默认 APFS、区分大小写 APFS、HFS+（含区分大小写）、exFAT U 盘、SMB | **补充建议**：增加 NFS、macFUSE/第三方挂载、数据卷路径（`/Users/...` 与 `/System/Volumes/Data/...`）、File Provider 目录；SMB 项要区分 AAPL 服务器与 Samba/Windows | UM-6、UM-8、UM-9、UM-10 |
| 测试规格 RS-T62 测试十（`M6-closure-test-spec.md` 第 3335 行） | “macOS 默认 APFS 卷 → `Insensitive`” | **保留为假设**：API 与语义已确认，APFS 返回值未验证；需 M-19 第 1 项实测后才能当期望值 | 总表① |
| M-19 第 3 项（测试规格约第 4379 行） | “HFS+：`hdiutil create -size 64m -fs "HFS+" …`；区分大小写：`-fs "Case-sensitive HFS+"`” | **命令名部分验证**：`hdiutil` 官方 man 页写 `-fs` 取值“such as HFS+, HFS+J (JHFS+), HFSX, JHFS+X, APFS, FAT32, ExFAT, or UDF”，“A full list of supported filesystems can be found in create -help”；`"Case-sensitive HFS+"` 是 `diskutil` 文档里的 canonical personality 名（“nicknames for the canonical forms … such as "Case-sensitive HFS+""），能否直接传给 `hdiutil -fs` 以及新版 macOS 是否还能创建 HFS+ 映像**未验证**，建议用 `hdiutil create -help` 核对并优先用 `HFSX`/`JHFS+X` 这些 man 页明列的名字 | `hdiutil(1)`、`diskutil(8)`（社区镜像，降级）：https://keith.github.io/xcode-man-pages/hdiutil.1.html |
| M-19 第 2 项 | `-fs "Case-sensitive APFS"` | **命令名部分验证**：`diskutil apfs addVolume` 的 `filesystem` 取 `APFS` 或 `Case-sensitive APFS` 已在 man 页验证；`hdiutil -fs` 是否接受该字符串未验证（同上） | `diskutil(8)` |
| M-19 “规范化轴的观察” | `printf 'caf\xc3\xa9.txt'`（NFC）与 `printf 'cafe\xcc\x81.txt'`（NFD） | **方法正确**，期望值可补：APFS（两变体）→ 第二个创建会落到同一目录项（视为同名），`ls` 显示保留首次创建时的规范化形式；HFS+ → 显示为 NFD；其余卷见 Apple 小节 E.2 | B.1 问 3、4 |

### 4.6 分区处理表：Linux 与内核

<!-- prettier-ignore -->
| 草案位置 | 草案原文要点 | 确认/修正为 X/未验证 | 依据 |
| --- | --- | --- | --- |
| 4.7.2.2 第 4917 行 | “macOS 以外的平台通常只有大小写轴有意义，规范化轴……默认 `No` 或 `Unknown`” | **修正为**：Linux 规范化轴是文件系统/目录相关的第二根轴，不是“通常无意义”：ext4/f2fs/tmpfs 的 casefold 目录比较前做 NFD（`Yes`）；ZFS 的 `normalization` 属性非 `none` 时为 `Yes`；vfat、exfat、ntfs3、ntfs-3g、btrfs、ext4 默认目录无规范化（`No`，源码未调用 `linux/unicode.h`，部分验证）；cifs/nfs/其他 FUSE 为 `Unknown`。建议：casefold 目录探测到后直接给 `Yes`，其余类型按表给 `No`/`Unknown`，不用行为探测去测规范化轴。 | Linux 内核小节问 1、问 4；`fs/unicode/utf8-core.c` 的 `utf8_strncasecmp` 用 `UTF8_NFDICF`；`grep` 确认 `fs/fat`、`fs/exfat`、`fs/ntfs3`、`fs/ntfs`、`fs/btrfs` 不含 `linux/unicode.h` |
| 4.7.2.3 第 4928 行（Linux 行）① | “casefold 目录标志（`ioctl(FS_IOC_GETFLAGS)` 的 `FS_CASEFOLD_FL`，ext4、f2fs 按目录，`chattr +F`）” | **确认**，补充：tmpfs（v6.13 起带 `casefold` 挂载选项后也按目录）；必须对**目录** fd 查询（普通文件位被屏蔽）；ioctl 用 32 位缓冲区；v7.2 起 vfat/exfat/ntfs3/cifs/nfs 等也会报告该位（cifs 仅目录），旧内核无。 | Linux 内核小节问 1、问 2 |
| 同上 ② | “已知不敏感类型表（`fstatfs` 的 `f_type`：vfat、exfat、ntfs、ntfs3）” | **修正**：exfat 保留（恒不敏感）；vfat 改为“默认不敏感但受 `check=` 与 `iocharset=` 影响，需读挂载选项”；**ntfs 与 ntfs3 必须从表中删除**（默认敏感，ntfs3 需 `nocase`，v7.1+ 的新 ntfs 驱动默认敏感，≤v6.8 旧 ntfs 驱动默认不敏感，同一 `f_type` 0x5346544e 不能决定）。 | 总表 ④a、④b、⑥ |
| 同上 | “`f_type` 对 FUSE（ntfs-3g、sshfs、exFAT 的 FUSE 实现）统一返回 FUSE 魔数” | **确认**（`fuse_statfs` 路径）；ntfs-3g 默认敏感，sshfs、exfat-fuse 的行为未验证。 | Linux 内核小节问 3；总表 ⑤ 与第 2.2 节说明 2 |
| 同上 | “CIFS 有 `nocase` 挂载选项” | **确认**，补充别名 `ignorecase`；不带 `nocase` 时是否仍可能被服务端折叠，未读到明文，未验证。 | 总表 ⑦ |
| 同上 | “NFS 取决于服务端” | **确认**；v7.2 起客户端暴露 PATHCONF/`FATTR4_CASE_INSENSITIVE` 结果；旧内核无客户端接口。 | 总表 ⑧ |
| 同上 | “ZFS 有 `casesensitivity` 属性” | **确认**：`sensitive` 默认，创建后不可改，Linux `zpl_lookup` 对 `insensitive` 用 `FIGNORECASE`；无 statfs/ioctl 位；`mixed` 不敏感仅限 SMB（手册），Linux 本地行为未实机。 | 总表 ⑨ |
| 同上 | “内核 `ntfs3` 与 `ntfs-3g` 行为也不同” | **确认且更具体**：二者默认都敏感；差异在于 ntfs3 有 `nocase`（v6.2+）、ntfs-3g 没有（仅 `lowntfs-3g` 的 `ignore_case`）；`f_type` 一个是 `0x7366746e`、一个是 FUSE 魔数。 | 总表 ⑤、⑥ |
| 4.7.2.3 第 4930 行 | “行为探测方式……需与社区实践对照后定稿” | **部分确认**：Linux 侧的两条设计约束已查明：(a) 翻转后“找到但身份不同”在 FUSE（无 `use_ino`）与 cifs（`noserverino`）上会因 inode 号按路径生成而误判为 `Sensitive`；(b) vfat 比较逐字节，只翻转 **ASCII 字母**才能得到可靠结论（翻转非 ASCII 会因 `iocharset` 转换失败或表不含而得到假 `Sensitive`）。社区实践部分见 E4（Syncthing 的方案只是提案，Git 部分由 Git 小节负责）。 | E3、E4 |
| 4.7.2.3 第 4944 行 | “创建与删除文件可能被文件监听器、构建工具或同步工具看到（待调研核实其影响）” | **部分确认**：inotify 手册明确 `IN_CREATE`/`IN_DELETE`/`IN_OPEN`/`IN_CLOSE_WRITE` 会被监视目录看到，所以临时文件探测**一定**可被监视该目录的监听器观察到；“已有条目换大小写”只做 `lstat`，手册事件清单里没有 stat/lookup 类事件（部分验证，推断为不产生）。对具体构建工具/同步工具（如 Syncthing、Dropbox、webpack）的实际影响：未找到可靠来源，未验证。 | E4 |
| 4.7.2.10 第 5006 行 | “行为探测的两级方式……对监听器、构建工具、同步工具的影响（待调研核实）” | 同上。 | E4 |
| 4.7.2.12 第 5019 行 | “不排除外部卷的兼容问题（例如 Linux 安装了 NTFS 兼容驱动去读 NTFS 文件）” | **确认并加重**：Linux 读 NTFS 有四种形态（内核 ntfs3、v7.1+ 新 `ntfs`、旧 `ntfs`、FUSE ntfs-3g），默认都敏感（旧 ntfs 除外），所以“NTFS 卷在 Linux 上被当成不敏感”是错误的默认；而同一块盘在 Windows 上是不敏感，**跨系统共享项目目录时两侧结论会不同**。 | 总表 ⑤、⑥ |
| 4.7.2.12 第 5032 行 | 同第 4928 行的 Linux 清单 | 同上各条。 | 同上 |
| 4.7.2.12 第 5046 行 | “Linux 内核：casefold 与 `FS_IOC_GETFLAGS` 文档” 为建议调研对象 | **已调研**：见 Linux 内核小节。要点：官方文档只有 `chattr(1)`、ext4/tmpfs 内核文档与 uapi 头文件注释；`ioctl_iflags(2)` 没写该位。 | Linux 内核小节问 2 |
| 4.7.2.12 第 5061 行 | “期望结果在调研完成前均为待调研核实的假设”（L-19） | **逐项结论**见总表“对规格期望值的影响”列：步骤 6、7 的期望需要改写；步骤 4 需补选项变体；步骤 8、9 保持；建议新增条目见第 6 部分与第 7.3 节。 | 总表 |
| 4.7.2.12 第 5119 行 | “行为探测的两级方式及其对监听器、构建工具、同步工具的影响：方式已采纳，影响待调研” | 同第 4944 行。 | E4 |
| 测试规格 RS-T62 测试四 | “硬链接盲区……探测选取条目时必须要求普通文件且链接数为 1” | **确认合理，但不充分**：见 E3。 | E3 |
| 测试规格 RS-T62 测试十 | “Linux tmpfs → `Sensitive`” | **确认**（默认挂载的 `/dev/shm`）；若以 `casefold` 选项挂载则要对具体目录读位。 | 总表 ③ |
| 测试规格 L-19 前置条件第 3 项 | `mkfs.ext4 -O casefold ext4cf.img` | **部分确认**：`mke2fs(8)` 文档的写法是 `-E encoding=<名称>`（“Enable the casefold feature in the super block”）；`-O casefold` 这一写法本次没在手册里读到，未验证，建议命令改为 `mkfs.ext4 -E encoding=utf8 ...` 并先在实机确认。 | `mke2fs(8)` |
| 测试规格 L-19 | “每个位置都用 `stat -f -c %T <路径>` 记录文件系统类型” | **建议补充**：`stat -f -c %T` 给出名称不是魔数；建议同时记 `findmnt -no FSTYPE,OPTIONS -T <路径>`（挂载选项是 vfat、ntfs3、cifs 的结论依据）和 `uname -r`（是否 ≥7.2）。`findmnt` 本次未查官方手册，仅作为实机记录建议，未验证。 | 推断 |

### 4.7 分区处理表：Git、VS Code、Watchman、Jujutsu、Mercurial

<!-- prettier-ignore -->
| 草案位置 | 草案原文要点 | 确认/修正/未验证 | 依据 |
| --- | --- | --- | --- |
| 4.7.2.3 末尾（约 4947 行）“与 Git 的做法对照” | “`git init` 通过创建配置文件并以不同大小写访问来设置 `core.ignorecase`，是社区已有的‘创建后查询变体’探测实践” | **修正**：Git 的 `core.ignorecase` 探测不创建文件，而是对 init 已写出的 `.git/config` 访问 `CoNfIg`（`access(F_OK)`，只看存在性）。因此它属于“已有条目换大小写”，与我们的首选方案同类，并非“创建后查询变体”。真正“创建文件 + 查询变体”的是仅 macOS 构建的 `core.precomposeunicode` 探测（创建 NFC 名 `ä`，用 NFD 名 `access`，再 `unlink`，目录在 git 目录里）。Git 失败时没有 `Unknown`，一律视为未设置（敏感）；探测一次后写入配置不再重测；探测位置是 git 目录 | Git 小节 ①（`setup.c` 2643–2660 行；`compat/precompose_utf8.c` 50–70 行） |
| 4.7.2.3 行为探测方式段落标题（约 4930 行）“需与社区实践对照后定稿” | 非侵入式优先 | **确认**：同构的先例有 Mercurial `fscasesensitive`（已有 `.hg`，只读，`lstat` 比较）、Git（已有 `.git/config`，`access`）、Git 测试套件（写 `CamelCase` 与 `camelcase` 比内容）、Jujutsu（不探测，用文件身份）、Watchman 与 VS Code（按 OS 常量，Watchman 仅 macOS 问系统）。没有任何一个项目在用户工作树根下创建专用临时探测文件来判定大小写 | Git 小节–Mercurial 小节 |
| 4.7.2.3 第 1 条的判定表 | “能找到且文件身份相同：Insensitive；找不到：Sensitive；找到但身份不同：Sensitive；其他错误：进入下一步或 Unknown” | **确认且比成熟项目更严格**：Mercurial 对 `OSError` 一律返回敏感；Git 对任何失败都不设置；本草案对“其他错误”保留 `Unknown`，在 4.7.2.5 之下不折叠，更安全。Mercurial 比较整个 `stat_result`，Jujutsu 比较 `dev`+`ino`（Windows 为句柄身份），都支持“用身份而不是名字相等”判断 | Jujutsu 小节、Mercurial 小节 |
| 4.7.2.3 第 2 条末项（约 4944 行）“创建与删除文件可能被文件监听器、构建工具或同步工具看到（待调研核实其影响）” | 副作用影响待核实 | **未验证**：没有找到任何以“大小写探测文件”为主题的官方文档、源码注释或 issue。可引用的只有旁证：Watchman 的 cookie 机制（在被监视目录里创建临时文件 `.watchman-cookie-*`，并把它放进 `.git`/`.hg`/`.svn` 目录以免出现在版本控制操作中）说明“带专用前缀的临时文件会被监视器看到”是成熟工具的已知前提，并被它们当作设计约束处理。见 第 5.7 节 | Watchman 小节 来源表、第 5.7 节 |
| 4.7.2.10 第 9 项 与 4.7.4 表第 9 行（约 5006、5119 行）“影响待调研” | 对监听器、构建工具、同步工具的影响 | **未验证**（同上；仅有旁证） | 第 5.7 节 |
| 4.7.2.12 一（Windows，约 5028 行）“Windows 和 Linux 理论上可以简单以系统文件系统为准” | 用户补充，非待核实项，但成熟项目有失败案例 | **修正方向**：VS Code（按 OS 判定）在 macOS 区分大小写卷与 Windows 目录级标志上长期有未解决 issue（#94307、#177925 open，#90983 关闭为 out-of-scope），维护者明确“不支持”；Watchman 也是 OS 常量。因此“可以简单按 OS”只能作为失败时的保底默认，不应当作首选 | VS Code 小节 ① |
| 4.7.2.12 三（约 5046–5053 行）参考对象清单：Git、VS Code、Watchman/Jujutsu/Mercurial | 均待调研核实 | **已落实**：见 Git 小节–Mercurial 小节。要点：Git 两个独立探测、VS Code 按 OS 加提供者声明、Watchman `pathconf` 仅 macOS、Jujutsu 用文件身份、Mercurial `fscasesensitive` | Git 小节–Mercurial 小节 |
| 4.7.2.2 约 4917 行 规范化轴“macOS 以外平台通常只有大小写轴有意义…默认 No 或 Unknown，不得凭经验写死” | 规范化轴待调研 | **VCS 侧的证据**：Git 的 NFC 处理只存在于 macOS 构建（Darwin 的编译开关），其他平台不探测；VS Code 的 NFC 规范化按 `isMacintosh` 判定，不按卷；Mercurial 的 NFD 折叠按 `isdarwin` 判定。三者都是“按 OS 假设”，没有一个按卷探测规范化。其他平台的规范化行为（例如 Linux 的 ext4 casefold 目录会做规范化）不在 VCS 项目里，由内核部分核实 | Git 小节、VS Code 小节、Mercurial 小节 |
| 4.7.2.5 “文件身份兜底”与 4.7.2.4 | 身份比较作为安全网 | **确认**有成熟先例：Git checkout 的碰撞检测同时用 inode（`match_stat_data`）与名字碰撞，但在 Windows（`GIT_WINDOWS_NATIVE`）与 Cygwin 上关闭 inode 信任，源码未说明原因，这提示“Windows 的文件索引是否稳定可信”需要在 Microsoft 部分单独核实，不能照搬 Unix 的假设；Jujutsu 在 Windows 上用 `same_file::Handle` 做身份比较 | Git 小节 ①、Jujutsu 小节 ① |
| RS-T62 测试四 与 4.7.2.11 “硬链接盲区” | 硬链接导致“换大小写访问”仍成功，要求链接数为 1 | **确认设计合理**：Git 的探测只看存在性，不涉及硬链接；Mercurial 比较整个 `stat_result`，同一 inode 的硬链接别名会得到相同结果，没有处理；Jujutsu 的身份比较只与 `.git`/`.jj` 目录比较，目录通常没有硬链接。没有成熟项目处理该盲区，本项目的“普通文件且链接数为 1”是额外的保护。见 第 5.8 节 | 第 5.8 节 |

### 4.8 分区处理表：Rust crate

<!-- prettier-ignore -->
| 草案位置 | 草案原文要点 | 确认/修正为 | 依据 |
| --- | --- | --- | --- |
| 4.7.2.1 / 4.7.2.3（`M6-closure-review.md` 第 4918 行附近）及 4.7.2.2（第 5030 行附近） | “NTFS 的比较使用卷自己的 upcase 表，并不等同于标准 Unicode 大小写折叠（待调研核实）”；“折叠函数只是近似” | 本小节能确认的一半：**crate 层面的折叠只能是近似**。unicase/caseless 都只有 C+F；`str::to_lowercase` 既不是折叠、又对上下文敏感（B8）；没有任何 crate 提供“按卷实际行为”的折叠，仅 `uffs-text` 自称内置 NTFS `$UpCase` 表（自述，未验证，MPL-2.0，不建议）。NTFS upcase 表本身的内容与是否可读取归 Microsoft 小节。 | B3、B4、B8、B9；Rust crate 小节 E.1 的行为表 |
| 4.7.2.4 / 4.7.2.5（第 4952、4958 行附近） | “依赖 3B.5 的 `platform/file_identity` 目标设计，不在本版范围”；“复用 `platform/file_identity` 的目标设计” | **修正**：`platform/file_identity.rs` 已存在并在用（提交 `516cf13`，2026-10-11，`m6-034`；`platform/mod.rs` 第 5 行 `pub mod file_identity;`；被 `platform/file_cas.rs` 第 12 行、`platform/path_identity.rs` 第 95–100 行使用）。导出 `FileIdentity::of(&File)` 与 `of_entry(&Dir, &OsStr)`，Unix 用 `(dev, ino)`，Windows 用 `(dwVolumeSerialNumber, nFileIndexHigh<<32\|nFileIndexLow)`，与 `same-file` 同构，不需要引入 same-file。**需补充的缺口**：ReFS 的 128 位文件 ID（微软文档：“The 64-bit identifier in this structure is not guaranteed to be unique on ReFS.”），现实现不使用 `FILE_ID_INFO`。 | B1；`src-tauri/src/platform/file_identity.rs`；git 日志 |
| 4.7.2.1 / 4.7.2.2（第 4917 行） | “规范化轴为 `Yes` 才先规范化为 NFC” | 确认实现路径可行：NFC 用 `unicode-normalization 0.1.26`（或已在图里的 `icu_normalizer 2.2.0`）。注意“先规范化为 NFC”只是键的形式；当大小写轴为 `Insensitive` 时，按 Unicode D145 的“规范无大小写匹配”应走 `NFD(fold(NFD(x)))`，最终再 NFC 以保持键稳定（调研员已用 unicase+unicode-normalization 实际跑通 13 组（19 个配对）向量，见 E.1）。 | B2、B4；E.1 |
| 4.7.2.12 第 5054 行 | “Rust 生态中已有的相关 crate：要审查许可证与维护状态，不得为此引入未经评估的依赖” | **已评估**：见 B0–B10 与 E 的依赖建议表；检索 21 个关键词未发现专门的目录级大小写敏感性探测 crate。 | B10；`scratchpad/pd10/e_search_summary.txt` |
| 4.7.2.3 表（Windows 行） | 目录级标志 `NtQueryInformationFile` 的 `FileCaseSensitiveInformation`；卷标志 `GetVolumeInformationByHandleW` | 就 crate 侧确认：`windows-sys 0.59.0` 里都有对应绑定，且需要新增 feature `Wdk_Storage_FileSystem`（见 Rust crate 小节 E.3）；微软官方文档确认两者：`GetVolumeInformationByHandleW` 页写 “FILE_CASE_SENSITIVE_SEARCH 0x00000001 The specified volume supports case-sensitive file names.”；ntifs 页写 “The FILE_CASE_SENSITIVE_INFORMATION structure is used to query or set per-directory case-sensitive information.” 与 “FILE_CS_FLAG_CASE_SENSITIVE_DIR 0x00000001 Specifies the directory is case-sensitive.” 其余 Windows 语义归 Microsoft 小节。 | Rust crate 小节 E.3；https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew、https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_case_sensitive_information |
| 4.7.2.3 表（Linux 行） | “`ioctl(FS_IOC_GETFLAGS)` 的 `FS_CASEFOLD_FL`”；“`fstatfs` 的 `f_type`” | 就 crate 侧确认：`libc 0.2.186` 提供 `FS_IOC_GETFLAGS`、`fstatfs`，**不提供** `FS_CASEFOLD_FL` 与 NTFS/exFAT/CIFS 魔数；`rustix 1.1.4/1.1.5` 提供 `fstatfs`、`ioctl_getflags`，但 `IFlags` 无 `CASEFOLD`（可用 `bits()` 自带常量 0x40000000，该值来自 `linux-raw-sys 0.12.1`）。取值语义归 Linux 内核小节核实。 | B5 |
| 4.7.2.3 表（macOS 行） | `pathconf(_PC_CASE_SENSITIVE)` 或 `getattrlist` 的 `VOL_CAP_FMT_CASE_SENSITIVE` | 就 crate 侧确认：`libc 0.2.186` 在 Apple 目标上提供 `_PC_CASE_SENSITIVE`（=11）、`pathconf`/`fpathconf`、`getattrlist`/`fgetattrlist`、`ATTR_VOL_CAPABILITIES`、`VOL_CAP_FMT_CASE_SENSITIVE`、`VOL_CAP_FMT_CASE_PRESERVING`；rustix 不提供。语义归 Apple 小节核实。 | B5 |

## 5. 定稿建议（探测链、PathKey 规则、依赖）

本部分是**建议**，在 D-1 由用户确认前不构成实现依据。每小节对应任务文档 5.4 节的设计问题（2 至 10；第 1 点见第 4 部分，第 11 点见第 7 部分）。事实来源见第 2、3 部分，本部分不重复引文，只标注依赖哪些结论及其验证状态。

### 5.1 探测链总览（定稿伪代码）

设计主线不变（平台 API → 行为探测 → `Unknown`，`Unknown` 不折叠，文件身份兜底）。调研带来的改动是：平台 API 步骤按“位置类型”分流，行为探测只翻转 ASCII 字母，并且在身份不可信的位置把结论降为 `Unknown`。

```text
fn probe_semantics(root: &Dir /* 项目根的目录句柄，不是路径字符串 */) -> PathSemantics {
    // 步骤 A：平台 API，按位置类型分流（5.2 至 5.4）。得到确定结论就返回。
    if let Some(s) = platform_api_step(root) { return s; }
    // 步骤 B：已有条目换大小写（只读，首选的行为探测）
    if let Some(case) = existing_entry_flip_probe(root) { return semantics_with_unknown_norm(case); }
    // 步骤 C：创建临时文件兜底（仅当项目根可写且没有可用的已有条目；整体 2 秒预算）
    if let Some(case) = temp_file_probe(root) { return semantics_with_unknown_norm(case); }
    // 步骤 D：仍无法判定
    PathSemantics { case: Unknown, normalization_insensitive: Unknown }
}

fn existing_entry_flip_probe(root: &Dir) -> Option<Case> {
    // 候选：普通文件（不是目录，不是符号链接或重解析点），链接数为 1，名字含至少一个 ASCII 字母
    let entry = pick_candidate(root)?;                       // 没有候选 → None（进入步骤 C）
    let flipped = flip_ascii_letter_case(&entry.name);       // 只翻转 ASCII 字母，其余字节保持不变
    match symlink_metadata_no_follow(root, &flipped) {
        Err(NotFound)                    => Some(Sensitive),
        Ok(m) if same_identity(&m, &entry) => Some(Insensitive),
        Ok(_) if identity_is_reliable()  => Some(Sensitive), // 找到但身份不同：真实存在仅大小写不同的两个文件
        Ok(_)                            => None,            // FUSE 未开 use_ino、cifs noserverino：身份不可信 → 不下结论
        Err(_)                           => None,            // 其他错误不当作“敏感”（与 Mercurial 不同，保留 Unknown）
    }
}
```

- 本部分的伪代码只表达流程，不是 Rust 实际签名：三个平台函数的返回类型写法不统一（有的返回 `PathSemantics`，有的返回 `Option<PathSemantics>`，`match` 臂里直接写 `Sensitive` 等裸值），类型以 076 的实现为准。
- `pick_candidate` 要求“普通文件、非重解析点、链接数为 1”（5.8）；`identity_is_reliable()` 在 FUSE（未开 `use_ino`）与 cifs（`noserverino`）上为假（5.4、5.7）。
- 临时文件兜底的约束不变：专用前缀 `.clp-case-probe-` 加随机小写字母数字、RAII 守卫立即删除、纳入文件树隐藏规则、崩溃遗留沿用现有残留清理入口；只读项目根不创建。
- 规范化轴**不做行为探测**（5.5），行为探测步骤得到的结果只设置大小写轴，规范化轴保持 `Unknown`。

### 5.2 Windows 判定流程（问题 2）

**结论**：判定流程必须是“先判远程 → 本地读卷标志 → 本地 NTFS/ReFS 读目录级标志”，远程位置与目录级查询失败都进入行为探测。依据：NTFS、ReFS 的 `FILE_CASE_SENSITIVE_SEARCH` 恒置位（MS-FSA 附录 A，已验证），所以卷标志本身不能判断默认目录；SMB 与 `\\wsl$` 的现象为本机只读观察（推断类）。

```text
fn probe_windows(project_root: &Dir) -> PathSemantics {
    let h = reopen_for_attribute_query(project_root)?;          // FILE_READ_ATTRIBUTES + FILE_FLAG_BACKUP_SEMANTICS；失败 → 行为探测
    // 1. 先判远程：任一为真都直接行为探测，不读卷标志、不读目录级标志
    if is_remote(h) { return behavior_probe(project_root); }    // FILE_REMOTE_DEVICE(0x10) 或 GetDriveTypeW==DRIVE_REMOTE(4)；失败 → Unknown
    // 2. 卷标志
    let (fs_flags, fs_name) = GetVolumeInformationByHandleW(h)?;  // 失败 → 行为探测
    if fs_flags & FILE_CASE_SENSITIVE_SEARCH == 0 {
        return PathSemantics { case: Insensitive, normalization_insensitive: No };   // 本地 FAT / exFAT；D-1-2 选 A 时此处写 Unknown（效果相同）
    }
    // 3. 目录级标志（NTFS、ReFS 的卷标志恒置位，必须读）
    match NtQueryInformationFile(h, FileCaseSensitiveInformation /*71*/) {
        Ok(info) if info.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR /*0x1*/ != 0 => Sensitive,
        Ok(_)                                                                  => Insensitive,
        Err(_) /* 如 STATUS_NOT_SUPPORTED(0xC00000BB) */ => behavior_probe(project_root),   // 查询失败 ≠ 标志为 0
    }
}
```

- 本地盘符映射的网络驱动器、`subst` 虚拟盘、挂载的 VHD：以**句柄**判远程比以盘符判远程可靠（`GetDriveTypeW` 对 UNC 根与 `\\wsl$` 根在本机观察均返回 4）。仓库 `src-tauri/src/platform/file_cas.rs` 的 `open_windows_rename_directory` 已有 UNC 前缀加 `GetDriveTypeW` 的同类判断可复用。
- 目录级查询在 Windows 10 1803 之前不可用（官方文档），失败即走行为探测。
- 目录级标志对 Win32 层所有操作生效，与 `FILE_FLAG_POSIX_SEMANTICS` 无关。依据（官方开发博客，2026-10-19 以 `curl` 取回原文）：“For directories that have this flag set, all operations on files in that directory are case sensitive, regardless of whether FILE_FLAG_POSIX_SEMANTICS was specified.”（https://devblogs.microsoft.com/commandline/per-directory-case-sensitivity-and-wsl/ ，官方文档，已验证）。所以翻转大小写的普通 Win32 查询就能反映该目录的真实语义；cap-std 在该类目录里的打开行为另见第 6 部分 UC-4。
- 只探测项目根；子目录可能继承或不继承目录级标志（官方来源矛盾），属 4.7.2.4 已知限制。

### 5.3 macOS：精确到项目所在卷（问题 3）

**结论**：按**句柄**查询，不用路径；`fstatfs` 取类型名、只读与本地标志后按类型分流；API 步骤只在 APFS 与 HFS+ 上直接采信，SMB 不采信，NFS 带预算，其余类型走行为探测。依据：`fpathconf`、`fgetattrlist`、`fstatfs` 都有句柄版（XNU 源码与 `statfs(2)` 官方页，已验证）；`pathconf` 对文件系统而非单个文件生效；内核对非卷根路径会替换为所在挂载的根（xnu-12377 源码，旧版本行为未验证）。

```text
fn probe_macos(fd: BorrowedFd) -> Option<PathSemantics> {
    let st = fstatfs(fd)?;                                   // f_fstypename, f_flags(MNT_RDONLY|MNT_LOCAL), f_fssubtype
    match st.f_fstypename.as_str() {
        "apfs" | "hfs" => {
            let case = match fpathconf(fd, _PC_CASE_SENSITIVE) {
                0          => Insensitive,
                n if n > 0 => Sensitive,
                _          => fgetattrlist_case(fd)?,        // 必须同时检查 valid 位；失败 → None（行为探测）
            };
            Some(PathSemantics { case, normalization_insensitive: Yes })   // 两个变体都是 Yes
        }
        "smbfs" => None,                                     // smbfs 的 pathconf 固定返回 0，API 值不采信
        "nfs"   => budgeted_pathconf_or_none(fd),            // v2 EINVAL；v3/v4 取服务器属性；可能发网络 RPC
        _       => None,                                     // exfat、msdos、macFUSE/FSKit、未知类型 → 行为探测
    }
}
```

- **APFS 卷组与系统卷/数据卷**：用户项目位于数据卷，只要对项目根的句柄查询，得到的就是数据卷自己的属性，无需特殊处理；不能拿系统卷（根 `/`）去推断。系统卷与数据卷是否必须大小写一致，官方未说明，不影响本设计（未验证）。
- **缓存键**：建议 `(f_fsid, f_mntonname)`；`f_fsid` 重新挂载后的稳定性 `statfs(2)` 未承诺（未验证），失效策略沿用草案（项目移除、路径修改、备份恢复、60 秒 `Unknown` 重试）。
- `getattrlist` 与官方 man 页冲突：man 页写“非卷根路径返回 `EINVAL`”，xnu-12377 源码会替换为卷根；采信较新的源码，旧系统失败只会多走一次降级。
- libc 0.2.186 在 Apple 目标上暴露 `pathconf`、`_PC_CASE_SENSITIVE`、`getattrlist`、`ATTR_VOL_CAPABILITIES`、`VOL_CAP_FMT_CASE_SENSITIVE`、`statfs`，不需要改依赖；符号在本项目 macOS 目标上实际编译通过属于 CI 验证项（本机无 darwin 目标）。

### 5.4 Linux 外部卷与类型落点（问题 4）

**结论**：Linux 没有单一 API 能给出“项目根是否大小写敏感”。只有 ext4/f2fs/tmpfs 的目录位是权威的；其余类型由挂载选项（vfat、ntfs3、cifs）、数据集属性（zfs）、服务端（cifs、nfs）、守护进程（FUSE）决定。草案的“已知不敏感类型表”应改为下表“类型 → 需要读哪个挂载选项或用哪种探测”。

<!-- prettier-ignore -->
| 位置类型 | 魔数（`f_type`） | 第一步 | 结论规则 | 必须落到行为探测的情形 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| ext4 / f2fs / tmpfs | 0xEF53 / 0xF2F52010 / 0x01021994 | 对**目录** fd `ioctl(FS_IOC_GETFLAGS)` | `FS_CASEFOLD_FL` 置位 → `Insensitive`（规范化 `Yes`）；未置位 → `Sensitive`（规范化 `No`） | ioctl 失败 | 已验证（源码） |
| btrfs | 0x9123683E | 类型即结论 | `Sensitive`（规范化 `No`） | `f_type` 取不到 | 部分验证 |
| exfat（内核） | 0x2011BAB0 | 类型即结论 | `Insensitive`（规范化 `No`） | 无 | 已验证（源码） |
| vfat / msdos | 0x4d44 | 读 `/proc/self/mountinfo` 的 `check=`、`iocharset=` | `check=s` → `Sensitive`；`iocharset=utf8` → 不折叠 ASCII，交行为探测；其余 → `Insensitive`（仅 ASCII 与 `iocharset` 表内字符折叠） | 读不到选项、`iocharset=utf8` | 部分验证 |
| ntfs3 | 0x7366746e（字面量） | 读 mountinfo 是否含 `nocase` | 含 `nocase` → `Insensitive`；不含 → `Sensitive` | 读不到选项 | 已验证（源码） |
| ntfs（v7.1+ 新驱动 / ≤v6.8 旧驱动） | 0x5346544e（两者相同） | 不可由魔数决定 | 无 | 一律行为探测 | 已验证（魔数相同、默认相反） |
| ntfs-3g（FUSE） | 0x65735546 | 无 | 源码默认 `Sensitive`，但 `lowntfs-3g ignore_case` 可改变 | 一律行为探测（`use_ino` 由 ntfs-3g 自己传入，身份可信） | 部分验证 |
| 其他 FUSE（sshfs、exfat-fuse 等） | 0x65735546 | 无 | 无 | 一律行为探测；未开 `use_ino` 时身份不可信 → `Unknown` | 部分验证 |
| cifs | 0xFF534D42 | 读 mountinfo 是否含 `nocase` | 含 `nocase` → `Insensitive`；不含则语义由服务器决定 → 行为探测 | 不含 `nocase`；`noserverino` 时身份不可信 → `Unknown` | 部分验证 |
| nfs | 0x6969 | 无（客户端不折叠） | 取决于服务端导出 | 一律行为探测 | 部分验证 |
| zfs | 0x2fc12fc1 | 无 ioctl 位；可选 `zfs get casesensitivity <数据集>`（权限未验证） | `insensitive` → `Insensitive`；`sensitive` → `Sensitive` | 默认走行为探测 | 已验证（属性语义）；`zfs get` 权限未验证 |
| 未知类型 | 其余 | 无 | 无 | 行为探测 → `Unknown` | — |

- 内核 v7.2（2026-08-16）新增统一只读接口：`FS_IOC_GETFLAGS` 的 `FS_CASEFOLD_FL` 与 `FS_IOC_FSGETXATTR` 的 `FS_XFLAG_CASEFOLD`，vfat/msdos、exfat、ntfs3、cifs（仅目录）、nfs、xfs、hfs、hfsplus、isofs、vboxsf 开始报告。**旧内核没有，且“位未置位”只对 ext4/f2fs/tmpfs 才等于区分大小写**（旧内核的 vfat 没有 `fileattr_get`，ioctl 会失败；个别实现会“成功返回 0 但不含大小写信息”）。建议：位已置位可信为 `Insensitive`；位未置位只对 ext4/f2fs/tmpfs 解释为 `Sensitive`；设计不得依赖 v7.2（见第 8 部分 Q8）。
- `ioctl` 缓冲区用 32 位（`unsigned int`），不要用 `long`；不支持的文件系统返回 `ENOTTY`（源码推导，未实机）。
- `statmount(2)` 需要 `CAP_SYS_ADMIN`，桌面应用不能用；按 `st_dev` 的 major:minor 匹配 `/proc/self/mountinfo` 取选项。
- `libc` 0.2.186 有 `fstatfs`、`ioctl`、`FS_IOC_GETFLAGS` 与 EXT4、TMPFS、MSDOS、NFS、FUSE、BTRFS、F2FS 魔数；**没有** `FS_CASEFOLD_FL`、EXFAT、CIFS、NTFS（两种）、ZFS 魔数，需在 `platform/` 内本地定义并注明出处（取值见第 2 部分与第 3 部分 Linux 内核小节）。

### 5.5 规范化轴（问题 5）

**结论**：规范化轴不做行为探测（需要创建带非 ASCII 字符的名字，在 vfat 等位置会失败或产生副作用），按类型和目录位推断，推断不了就是 `Unknown`。在 `PathKey` 里 `No` 与 `Unknown` 的效果相同（都“该轴不处理”），区别只在可观测性与日志。下表的 `No` 是对本地类型的**最佳判断（多数为部分验证）**；与 D-1-2 的关系：选 A 时 076 把这些 `No` 记为 `Unknown`（只在“已验证”的位置写 `Yes`），选 B 时 Windows 与 Linux 按表写 `No`，选 C 时全部写 `Unknown`；三种选择下键的计算结果相同。

<!-- prettier-ignore -->
| 位置类型 | 规范化轴 | 依据 | 验证状态 |
| --- | --- | --- | --- |
| macOS APFS（两个变体）、HFS+（两个变体） | `Yes` | 官方 FAQ：APFS 两个变体都 normalization-insensitive；TN1150：HFS+ 强制 NFD；`hfs_catalog.c buildkey` 一律 `UTF_DECOMPOSED` | 已验证 |
| macOS exFAT、SMB、NFS、FUSE | `Unknown` | exFAT 规范只有 up-case 映射、无规范化，Apple 驱动闭源；NFS 默认不规范化；SMB：macOS 客户端总是把名字转 NFC 发出、转 NFD 收回（`smb_converter.c`，已验证），Apple 小节的素材建议按客户端视角记 `Yes`，但服务端是否把 NFC 与 NFD 当同名未验证，存在“服务器上以 NFD 存储的名字无法用 NFC 访问”的风险，所以本记录不采纳，记 `Unknown` | 部分验证 / 未验证 |
| Windows 本地 NTFS、ReFS、exFAT、FAT | `No` | Kaplan 存档博客“normalization still does not happen”；`CompareStringOrdinal` 文档“disregards all non-binary equivalences”；官方文档无一句话直接陈述 | 部分验证 |
| Windows 远程、`\\wsl$` | `Unknown` | 随服务端 | 未验证 |
| Linux ext4 / f2fs / tmpfs 的 casefold 目录 | `Yes` | `utf8_strncasecmp` 用 `UTF8_NFDICF`（NFD 加完整折叠，Unicode 12.1.0） | 已验证 |
| Linux ext4 默认、btrfs、tmpfs 默认、vfat、exfat、ntfs3、ntfs-3g | `No` | 这些驱动不含 Unicode 规范化调用（只做了字符串搜索，未逐文件读完） | 部分验证 |
| Linux zfs | 取决于 `normalization` 属性（`none\|formC\|formD\|formKC\|formKD`） | OpenZFS man；读属性的权限未验证 | `Unknown`（不读属性） |
| Linux cifs、nfs、其他 FUSE | `Unknown` | 服务端或守护进程决定 | 未验证 |

- 不能把 Linux 统一固定为 `No`：casefold 目录上 NFC 与 NFD 同名，固定 `No` 会漏折叠（影响只是多出一个文档，文件身份兜底会拦住）。
- macOS 以外的 VCS 经验：Git 的 NFC 处理只存在于 macOS 构建，VS Code 的 `normalizeNFC` 按 `isMacintosh`，Mercurial 的 NFD 折叠按 `isdarwin`，三者都是“按 OS 假设”，没有一个按卷探测规范化。

#### 依据：成熟项目是否把规范化与大小写分成两根轴

<!-- prettier-ignore -->
| 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- |
| Git 分成两个独立配置项与两个独立探测：`core.ignorecase`（大小写，`access("CoNfIg")`，所有平台）与 `core.precomposeUnicode`（规范化，创建 `ä` 的 NFC 名再用 NFD 名访问，仅 macOS 构建）。后者解决的是 macOS 把名字存成 NFD、readdir 返回 NFD 的问题，文档：“This option is only used by Mac OS implementation of Git.” 所以 precomposeunicode 对应的是**规范化轴**，不是大小写轴 | Git 小节 ① | 2026-10-19 | 官方文档 + 项目源码 | 已验证 |
| VS Code 也分成两处：大小写由 `PathCaseSensitive` 能力位（按 OS）；规范化由 `normalizeNFC`（按 `isMacintosh`，读目录和监视事件时转 NFC） | VS Code 小节 ① | 2026-10-19 | 项目源码 | 已验证 |
| Mercurial **没有**分轴：macOS 的 `normcase` 把 NFD 与小写合并，只有一个“是否折叠”的开关（来自 `fscasesensitive` 的结果） | Mercurial 小节 ① | 2026-10-19 | 项目源码 | 已验证 |
| Watchman 的文档把“按 Unicode 数据库折叠”和“使用文件系统创建时写入的折叠表”列为不同的正确度等级，并未涉及规范化；代码里无规范化处理 | Watchman 小节 ① | 2026-10-19 | 官方文档 + 项目源码 | 已验证 |
| Jujutsu：不处理大小写也不处理规范化，统一用文件身份 | Jujutsu 小节 ① | 2026-10-19 | 项目源码 | 已验证 |

### 5.6 大小写折叠函数选型与向量（问题 6）

#### 5.6.1 事实摘要

- 没有单一函数与所有文件系统一致：NTFS/exFAT 是逐 UTF-16 码元一对一的 upcase 表（格式化时写入卷，非 BMP 不处理）；HFS+ 是 Apple 自定义表（基于 Unicode 3.2）；APFS 官方只说 Unicode 9.0，未说明 simple 还是 full folding，社区重新实现倾向 full folding（降级证据，真实 APFS 未验证）；ext4 casefold 是 NFD 加完整折叠（C+F，Unicode 12.1.0）；vfat 是 `iocharset` 单字节小写表逐字节比较。
- 标准库 `str::to_lowercase`/`to_uppercase` 不是折叠（Unicode 17.0.0 的 `Lowercase_Mapping`/`Uppercase_Mapping`，词尾 Σ 受上下文影响），无论取小写还是大写都会在不同输入上漏判，不能替代折叠。
- 成熟项目都用近似（Git 的 `strcasecmp`/`strihash` 仅 ASCII；VS Code 的 `toLowerCase()`；Mercurial 在 posix 上仅 ASCII，Windows 用 `upper()`；Watchman 不折叠，文档把完整折叠分成四级正确度并选择不做；Jujutsu 完全用文件身份），没有任何一个使用“按卷探测出的 Unicode 完整折叠”。

#### 5.6.2 建议的键拼法（供 D-1-3）

```text
fn path_key(relative: &str, s: &PathSemantics) -> String {
    let fold_on = s.case == Insensitive;                 // Sensitive 或 Unknown 永不折叠
    let norm_on = s.normalization_insensitive == Yes;    // No 或 Unknown 不规范化
    match (fold_on, norm_on) {
        (true,  true)  => nfc(nfd(fold(nfd(relative)))), // 规范无大小写匹配（Unicode D145），再 NFC 保持键稳定
        (true,  false) => fold(relative),
        (false, true)  => nfc(relative),
        (false, false) => relative.to_owned(),
    }
}
// fold = unicase 2.10.0 的 UniCase::unicode(s).to_folded_case()（完整折叠 C+F，无 T）
```

- 键相同只表示“候选相同”：合并前必须用文件身份确认（4.7.2.5）。完整折叠（C+F）比 NTFS、exFAT、vfat、HFS+ 都“折得更多”（见 5.6.3 表的“键与文件系统的关系”列）：多折的情形会产生“候选相同但身份不同”，被身份确认拦住，不会造成静默合并；而折得更少才会漏掉候选，漏掉的无法被兜底纠正，只会多出一个文档，保存时由 CAS 的文件身份复核报冲突。
- 风险点（须用户知情）：当任一路径取不到文件身份（例如文件已被删除）时，草案规定按 flag 判定；此时完整折叠在 NTFS/vfat/HFS+ 上可能把文件系统视为不同名的两个路径合并（例如 `Straße` 与 `STRASSE`、开尔文符号与 `k`）。可选缓解（第 8 部分 Q3 的选项 B）：身份不可取时，仅当两个相对路径只在 ASCII 字母大小写上不同才合并，否则保持为两个文档。
- ext4 casefold 还会去掉 `Default_Ignorable_Code_Point`（如 U+200D、U+00AD、U+FE0F），仅这类码点不同的名字也被视为同名；建议键不去除这些码点，由此多出的文档由身份兜底与 CAS 处理（已验证为内核注释，未实机）。

#### 5.6.3 向量表（13 组）：三种文件系统的判定

各单元格的依据与来源在第 3 部分对应小节的“D. 向量判定”表（Microsoft：NTFS、ReFS、exFAT、FAT；Apple：APFS、HFS+；Linux 内核：ext4 casefold、vfat、exFAT），含逐格来源类别；ReFS、FAT、HFS+ 区分大小写、ntfs3 `nocase`、cifs、ZFS 的判定也在这些表里，其中多数为“未验证”。

约定：“折叠”表示两个名字在该文件系统上被视为同一个名字；状态缩写 V=已验证、P=部分验证、U=未验证；NTFS 列是本机 OS 当前大小写表的对照（推断类，旧卷的 `$UpCase` 可能不同），exFAT 规范推荐表可交叉但校验和未能复现，因此不计已验证。

<!-- prettier-ignore -->
| # | 输入 | NTFS | APFS 不区分大小写 | ext4 casefold 目录 | 完整折叠键（本机运行）与文件系统的关系 |
| --- | --- | --- | --- | --- | --- |
| 1 | `README` 与 `readme` | 折叠（V） | 折叠（V） | 折叠（P） | 键相等；三者一致 |
| 2 | `Straße` 与 `STRASSE` | 不折叠（P） | 未验证（full folding 则折叠，simple 则不折叠；社区实现折叠）（U） | 折叠（P，`ß→ss`） | 键相等；对 NTFS 多折 |
| 3 | `ß`（U+00DF）与 `ẞ`（U+1E9E） | 不折叠（P） | 折叠（P，两种假设下都同名） | 折叠（P） | 键相等；对 NTFS 多折 |
| 4 | `i` 与 `İ`（U+0130） | 不折叠（P） | 不折叠（P） | 不折叠（P） | 键不等；三者一致 |
| 5 | `I` 与 `ı`（U+0131） | 不折叠（P；Windows 表刻意不采用 UnicodeData 的简单大写） | 不折叠（P） | 不折叠（P） | 键不等；三者一致 |
| 6 | `σ`、`ς`（U+03C2）与 `Σ` | `σ` 与 `Σ` 折叠；`ς` 与二者的关系未验证（OS 表与 exFAT 推荐表冲突）（U） | 三者折叠（P） | 三者折叠（P） | 键相等；`ς` 对 NTFS 可能多折 |
| 7 | `é`（U+00E9）与 `e`+U+0301 | 不折叠（P） | 折叠（V，规范化轴） | 折叠（P，规范化轴） | 规范化轴为 `Yes` 时键相等，`No`/`Unknown` 时不等；取决于规范化轴是否正确 |
| 8 | `É`（U+00C9）与 `é`（U+00E9） | 折叠（P） | 折叠（P） | 折叠（P） | 键相等；三者一致 |
| 9 | `Ａ`（U+FF21）与 `a`/`A` | 与 `a`/`A` 不折叠；与 `ａ`（U+FF41）折叠（P） | 与 `a`/`A` 不折叠（P） | 与 `a`/`A` 不折叠；与 `ａ` 折叠（P） | 与 `a`/`A` 键不等；与 `ａ` 键相等；一致 |
| 10 | `ǅ`（U+01C5）、`ǆ`（U+01C6）、`Ǆ`（U+01C4） | `ǆ` 与 `Ǆ` 折叠，`ǅ` 与二者不折叠（P） | 三者折叠（P） | 三者折叠（P） | 三者键相等；`ǅ` 对 NTFS 多折 |
| 11 | `K`（U+212A 开尔文符号）与 `k`/`K` | 不折叠（P） | 与 `k`、`K` 都同名（P；经规范分解再折叠） | 折叠（P） | 键相等；对 NTFS 多折 |
| 12 | `ﬃ`（U+FB03）与 `ffi` | 不折叠（P） | 未验证（full folding 则折叠）（U） | 折叠（P） | 键相等；对 NTFS 多折 |
| 13 | Cherokee `Ꭰ`（U+13A0）与 `ꭰ`（U+AB70） | 不折叠（P；随卷格式化时的 Unicode 版本变化，真实卷未验证） | 折叠（P） | 折叠（P） | 键相等；对 NTFS 多折 |

<!-- prettier-ignore -->
| # | exFAT（内核默认 upcase 表） | vfat 默认（`iocharset=iso8859-1`） | HFS+ 不区分大小写 | APFS 区分大小写 |
| --- | --- | --- | --- | --- |
| 1 | 折叠（P） | 折叠（P） | 折叠（V） | 不折叠（V） |
| 2 | 不折叠（P） | 不折叠（P） | 不折叠（P） | 不折叠（V） |
| 3 | 不折叠（P） | 不折叠（P） | 不折叠（P） | 不折叠（V） |
| 4 | 不折叠（P） | 不折叠（P） | 不折叠（P） | 不折叠（V） |
| 5 | 不折叠（P） | 不折叠（P） | 不折叠（P） | 不折叠（V） |
| 6 | 三者折叠（P） | 不折叠（P） | `σ` 与 `Σ` 折叠，`ς` 不同名（P） | 不折叠（V） |
| 7 | 不折叠（P） | 不折叠（P） | 折叠（V，规范化轴） | 折叠（V，规范化轴） |
| 8 | 折叠（P） | 不折叠（P，非 ASCII 字节不被表折叠） | 折叠（P） | 不折叠（V） |
| 9 | 与 `a`/`A` 不折叠；与 `ａ` 折叠（P） | 不折叠（P） | 与 `a`/`A` 不折叠（P） | 不折叠（V） |
| 10 | `ǆ` 与 `Ǆ` 折叠，`ǅ` 不折叠（P） | 不折叠（P） | 三者折叠（P） | 不折叠（V） |
| 11 | 不折叠（P） | 不折叠（P） | 不同名（P；U+2000–U+2FFF 不分解且表不折叠它） | 与 `K`（U+004B）同名（规范化），与 `k` 不同名（P） |
| 12 | 不折叠（P） | 不折叠（P） | 不折叠（P） | 不折叠（V） |
| 13 | 不折叠（P） | 不折叠（P） | 不折叠（P；表基于早期 Unicode） | 不折叠（V） |

ReFS、FAT、HFS+ 区分大小写、ntfs3 `nocase`、cifs、ZFS 的向量判定见第 3 部分 Microsoft、Apple、Linux 内核小节的“D. 向量判定”，其中多数为“未验证”。

#### 依据：各项目使用的比较或折叠函数

<!-- prettier-ignore -->
| 项目 | 折叠函数 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- | --- |
| Git | ASCII 级：`strcasecmp`（libc）与自定义 `strihash`（只处理 `a`–`z`）；不做规范化比较（规范化靠 precompose 在读取时统一为 NFC） | https://raw.githubusercontent.com/git/git/v2.56.0/dir.c、hashmap.c | 2026-10-19 | 项目源码 | 已验证 |
| VS Code | `String.prototype.toLowerCase()`（JavaScript 的 Unicode 小写，不是完整 case folding，不做规范化）；规范化在读入口统一为 NFC（仅 macOS） | https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/common/resources.ts（`getComparisonKey`）；src/vs/base/node/pfs.ts | 2026-10-19 | 项目源码 | 已验证（`toLowerCase` 的 Unicode 语义由语言规范保证，此处未另取 ECMAScript 原文，故“Unicode 小写”一项为部分验证） |
| Mercurial | posix：`bytes.lower()` 仅 ASCII；Windows：`encoding.upper()`，注释 “NTFS compares via upper()”；macOS：NFD + `.lower()` + 删除 HFS+ 忽略字符 | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/posix.py、windows.py | 2026-10-19 | 项目源码 + 官方文档 | 已验证 |
| Watchman | 不折叠；文档把折叠交给客户端，并承认完整折叠有四级正确度 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/website/docs/casefolding.md | 2026-10-19 | 官方文档 | 已验证 |
| Jujutsu | 不折叠；用文件身份 | Jujutsu 小节 | 2026-10-19 | 项目源码 | 已验证 |

#### 5.6.4 键函数向量建议（供 076 的 `path-key-vectors` 夹具；期望值由键拼法与本机运行推得，不是文件系统事实）

<!-- prettier-ignore -->
| # | a | b | `(Insensitive, Yes)` | `(Insensitive, No\|Unknown)` | `(Sensitive\|Unknown, Yes)` | `(Sensitive\|Unknown, No\|Unknown)` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `README` | `readme` | 相等 | 相等 | 不等 | 不等 |
| 2 | `Straße` | `STRASSE` | 相等 | 相等 | 不等 | 不等 |
| 3 | `ß` | `ẞ` | 相等 | 相等 | 不等 | 不等 |
| 4 | `i` | `İ` | 不等 | 不等 | 不等 | 不等 |
| 5 | `I` | `ı` | 不等 | 不等 | 不等 | 不等 |
| 6 | `σ`（U+03C3）、`ς`（U+03C2）、`Σ`（U+03A3）两两 | | 相等 | 相等 | 不等 | 不等 |
| 7 | `é`（U+00E9） | `e`+U+0301 | 相等 | 不等 | 相等 | 不等 |
| 8 | `É` | `é` | 相等 | 相等 | 不等 | 不等 |
| 9 | `Ａ`（U+FF21） | `a`、`A` | 不等 | 不等 | 不等 | 不等 |
| 10 | `ǅ`、`ǆ`、`Ǆ` 两两 | | 相等 | 相等 | 不等 | 不等 |
| 11 | `K`（U+212A） | `k` | 相等 | 相等 | 不等 | 不等 |
| 12 | `ﬃ` | `ffi` | 相等 | 相等 | 不等 | 不等 |
| 13 | `Ꭰ`（U+13A0） | `ꭰ`（U+AB70） | 相等 | 相等 | 不等 | 不等 |

补充：开尔文符号 U+212A 与拉丁大写 `K` 在 `(Sensitive|Unknown, Yes)` 下相等（NFC 把 U+212A 映射为 `K`），在 `(Insensitive, *)` 下与 `k`、`K` 都相等。第 7 行在 `(Insensitive, No|Unknown)` 下不等，是因为键不做规范化。

#### 5.6.5 保守替代方案

若用户希望第一版零新增 crate：折叠只做 ASCII 大小写，非 ASCII 字符按字面比较，规范化轴固定 `Unknown`（D-1-2 选 C 加 D-1-3 选 C）。代价：macOS 上 NFC 与 NFD 写法的同一文件、德语 ß 等在大小写不敏感卷上会保持为两个文档，保存时由 CAS 的文件身份复核报冲突，不会静默覆盖。向量表中除第 1 组外其余均“不等”。

### 5.7 行为探测的副作用（问题 7）

- **监听器必然看到创建与删除**：`ReadDirectoryChangesW`（官方文档：创建、删除、重命名都会返回通知）、inotify（`IN_CREATE`/`IN_DELETE`/`IN_OPEN`/`IN_CLOSE_WRITE`）、FSEvents（XNU 在有订阅者时对创建与删除发 `FSE_CREATE_FILE`/`FSE_DELETE`）都已验证；所以“临时文件兜底”必然被监视项目根的工具看到。
- **“已有条目换大小写”只读**：只做 `lstat`/`symlink_metadata`，事件清单里没有 stat 类事件，推断不产生创建与删除通知（部分验证，来自事件清单的缺席；macOS 未逐项核对 `lstat` 对 atime 的影响）。
- **杀毒、云同步（OneDrive、Dropbox）、Spotlight、Time Machine、构建工具、Syncthing 的具体反应：没有找到任何官方文档、源码注释或 issue**，保持“未验证”（第 6 部分），4.7.4 表第 9 行继续标待调研。Dev Drive 默认附加杀毒过滤器（Defender 性能模式，异步扫描）是唯一有官方说明的相关事实。
- **成熟项目的做法**：五个项目的正常运行路径里都没有在用户工作树根创建大小写探测临时文件。Git 的 `ignorecase` 探测只访问 git 目录里已有的 `config`；precompose 探测在 git 目录里创建并立即删除 `ä`；Mercurial 的 `fscasesensitive` 只做两次 `lstat`，其 `checkexec`/`checklink` 的探测文件放在 `.hg/wcache`，只有该目录不存在时才回退到工作树根；Jujutsu 在检出时的创建属于安全检查，立即删除。Watchman 的 cookie 先例：临时文件固定前缀 `.watchman-cookie-`，并放进 `.git`/`.hg`/`.svn` 目录以免出现在版本控制操作中。
- **对本项目的建议**：保持“已有条目换大小写优先”；临时文件仅最后手段，用专用前缀 `.clp-case-probe-` 并纳入文件树隐藏规则；缓存按项目为单位；只读项目根不创建；是否把探测文件放进已被忽略的位置（如项目根下的 `.git`）是可评审选项，但 `.git` 与根可能不在同一文件系统且属于对用户 Git 目录的写入，未经验证，不建议第一版采用。
- **身份可信度**：FUSE（libfuse 高层 API 未开 `use_ino`）与 cifs（`noserverino`）上同一文件的两个名字会得到不同 inode，“找到但身份不同”不得判为 `Sensitive`，映射为 `Unknown`（部分验证：代码事实已验证，行为后果为源码推导）；ntfs-3g 自己传 `-ouse_ino`，不受此影响。代码事实（2026-10-19 以 `curl` 取回原文 `grep`）：libfuse `include/fuse.h` 第 204–211 行（https://raw.githubusercontent.com/libfuse/libfuse/master/include/fuse.h ，项目源码）“use_ino” 选项及其“If use_ino option is not given, still try to fill in the …”注释；Linux `fs/smb/client/inode.c` 第 1129–1133 行 `if (!(cifs_sb_flags(cifs_sb) & CIFS_MOUNT_SERVER_INUM)) { … fattr->cf_uniqueid = iunique(sb, ROOT_I);`（https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/smb/client/inode.c?id=v7.2 ，项目源码）；ntfs-3g `src/ntfs-3g.c` 第 4259、4268、4272 行 `-ouse_ino,kernel_cache`（https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/src/ntfs-3g.c ，项目源码）。

#### 依据：五个成熟项目的探测副作用与监视器先例（Git、VS Code、Watchman、Jujutsu、Mercurial 小节的横向对照）

<!-- prettier-ignore -->
| 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- |
| 五个项目的正常运行路径里，没有一个为了判定大小写而在用户工作树根下创建临时文件：Git 的 `ignorecase` 探测不创建文件，只访问 git 目录中已有的 `config`；Mercurial 的 `fscasesensitive` 只做两次 `lstat`；Jujutsu、VS Code 不探测；Watchman 不创建文件。唯一的例外是 Mercurial 的调试命令 `hg debugfsinfo`（见下一行） | Git 小节–Mercurial 小节 各来源（`setup.c`、`util.py`、`FSDetect.cpp` 等） | 2026-10-19 | 项目源码 | 已验证（限于所读文件） |
| 创建文件的探测都放在工具自己的私有目录里：Git 的 `core.symlinks` 探测在 git 目录里 `xmkstemp("tXXXXXX")` 后删除；Git 的 precompose 探测在 git 目录里创建并 `unlink` 一个 `ä` 文件；Mercurial 的 `checkexec`/`checklink` 优先在 `.hg/wcache` 里创建 `hg-checkexec-*`/`checklink-*` 临时文件并把结果留成 `checkisexec`、`checklink` 标记文件，作为下次的只读快速路径（“try fast path, read only”），只有 `.hg/wcache` 不存在时才回退到在工作树根（传入路径）里建 `hg-checkexec-`、`hg-checklink-` 前缀的临时文件，用后删除；`checknlink` 在传入路径所在目录建 `.` 开头的临时文件；Jujutsu 的可执行位探测在 `.jj` 的状态目录里 `tempfile_in`。只有 Mercurial 的 `hg debugfsinfo` 与 Jujutsu 的检出（`can_create_new_file`）会在用户目录里创建临时文件，前者是调试命令，后者是为了安全检查，且立即删除 | https://raw.githubusercontent.com/git/git/v2.56.0/setup.c（约 2643–2652 行）；compat/precompose_utf8.c；https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/posix.py（`checkexec`、`checklink`，约 234–350 行）、util.py（`checknlink`）、debugcommands.py（`debugfsinfo`）；https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/core/src/file_util.rs、lib/src/local_working_copy.rs（`can_create_new_file`） | 2026-10-19 | 项目源码 | 已验证 |
| 成熟监视器的先例：Watchman 的“cookie”是在被监视目录里创建的临时文件，前缀固定为 `.watchman-cookie-`（`kCookiePrefix`）；文档说明“如果找到版本控制目录（`.git`、`.hg` 或 `.svn`），cookie 就创建在那里，因为不希望 cookie 出现在版本控制操作中”；默认配置 `ignore_vcs` 为 `[".git", ".hg", ".svn", ".jj"]`，文档称其 “mildly abuse the version control directories to store its query cookie files”。这是“专用前缀 + 放进已被忽略的目录”的先例，对应我们的 `.clp-case-probe-` 前缀与“纳入文件树隐藏规则” | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/website/docs/cookies.md；website/docs/config.md（`ignore_vcs` 一节）；watchman/Cookie.h（`kCookiePrefix`）；watchman/root/init.cpp（`computeCookieDir`） | 2026-10-19 | 官方文档 + 项目源码 | 已验证（作为旁证，不是针对大小写探测） |
| 杀毒软件、云同步工具对这类临时探测文件的反应：没有找到官方文档、源码注释或 issue（做过两次通用检索，仅得到与本问题无关的结果） | 无 | 2026-10-19 | 无 | 未验证 |
| 只读目录的处理：Mercurial 的 `fscasesensitive` 本身不写所以不受影响；Git 对只读 git 目录的 precompose 探测是静默跳过，`git init` 整体需要可写；Jujutsu 的可执行位探测出错时记录 warn 并默认 `Respect`；Mercurial 的 `debugfsinfo` 出错时输出 `(unknown)` | Git 小节、Jujutsu 小节、Mercurial 小节 各来源 | 2026-10-19 | 项目源码 | 已验证（Git 只读目录的行为是读码所得，未实测，故 Git 一项为部分验证） |

### 5.8 硬链接盲区（问题 8）

- **Git、Mercurial 的探测都没有处理硬链接**：Git 只做 `access(F_OK)`，依赖“`.git` 刚创建”这一前提；Mercurial 比较整个 `lstat` 结果，同一 inode 的硬链接别名会得到相同结果，实际中因对象是目录而几乎不触发；Jujutsu 的身份比较只对 `.git`、`.jj` 目录。没有成熟项目显式处理“探测条目恰有硬链接别名”（推断，限于所读代码）。
- **“普通文件且链接数为 1”合理，建议保留并补充**：在区分大小写的目录里，翻转大小写的名字可能恰好是同一文件的另一个硬链接名，文件身份相同会被误判为 `Insensitive`；链接数为 1 排除了这种可能。补充条件：① 排除符号链接与重解析点（junction、OneDrive 占位文件等），查询不跟随；② 目录条目不作探测对象（目录的 `nNumberOfLinks` 官方未说明）；③ 项目根下只有目录和多链接文件时，降级到临时文件兜底或 `Unknown`。
- **取链接数**：Unix 用 `st_nlink`；Windows 用 `GetFileInformationByHandle` 的 `BY_HANDLE_FILE_INFORMATION.nNumberOfLinks`（官方文档：FAT 恒为 1，NTFS 可大于 1），现有 `file_identity.rs` 已调用同一函数，**不需要新增 Cargo feature**。部分 FUSE 与网络文件系统可能一律报告 1（未验证）。

#### 依据：成熟项目如何看待硬链接盲区

<!-- prettier-ignore -->
| 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- |
| Git 的 `ignorecase` 探测只做 `access(F_OK)`，不比较身份，也不考虑硬链接；它依赖“`.git` 刚创建，里面没有名为 `CoNfIg` 的独立条目”这一前提（`copy_templates` 在探测之前执行，若模板目录里恰有名为 `CoNfIg` 的文件，会得到“不敏感”的误判；这是推断，没有看到源码对此的注释或 issue） | https://raw.githubusercontent.com/git/git/v2.56.0/setup.c（`create_default_files` 先 `copy_templates`，后探测） | 2026-10-19 | 项目源码（顺序）；推断（后果） | 顺序已验证，后果为推断 |
| Mercurial 比较整个 `os.lstat` 结果，没有显式处理硬链接。如果一个名字的大小写变体是同一文件的另一个硬链接（同一 inode，`st_nlink` 相同），两次 `lstat` 结果相等，会被判为“不敏感”。对它的实际调用对象是目录（`.hg`、工作树根），多数文件系统不允许普通用户对目录建硬链接，所以实际中几乎不触发；这是推断 | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/util.py（`fscasesensitive`） | 2026-10-19 | 项目源码（比较方式）；推断（后果） | 比较方式已验证，后果为推断 |
| Jujutsu 的身份比较只与同父目录下的 `.git`、`.jj` 比较；两者是目录，所以硬链接别名不构成误判来源；文件的硬链接并未在此处理 | https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/lib/src/local_working_copy.rs（`reject_reserved_existing_file_identity`） | 2026-10-19 | 项目源码 | 已验证（比较对象）；“硬链接不构成误判”为推断 |
| 结论：没有找到任何成熟项目显式处理“探测用的条目恰有硬链接别名”。规格 RS-T62 测试四要求选取“普通文件且链接数为 1”，是比成熟项目更严格的做法；它依赖各平台能取到链接数（Unix `st_nlink`；Windows 的链接数取得方式留给 Microsoft 部分/Rust 实现核实） | 无直接来源 | 2026-10-19 | 推断 | 未验证（缺：Windows 取链接数的方法与实机验证） |

- **与文件身份兜底的关联**：Windows 的 64 位文件索引在 ReFS 上不保证唯一（微软文档），应使用 `GetFileInformationByHandleEx(FileIdInfo)` 的 128 位 `FILE_ID_INFO`，`windows-sys 0.59` 在已启用的 `Win32_Storage_FileSystem` 下就有，补缺口不需要新增 feature（第 8 部分 Q7）。

### 5.9 嵌套挂载点与目录级标志（问题 9）

- 所有被读的成熟项目都是“每个仓库或根一次”的粒度，没有任何一个对子目录做惰性探测（Git 在 init 时对 git 目录探测一次并持久化；Mercurial 探测 `.hg` 或工作树根；Watchman 在构造 `Root` 时对根路径取一次；VS Code 与 Jujutsu 不探测）。目录级差异的实际应对是人工配置（Git 可按 worktree 覆盖 `core.ignorecase`，前提 `extensions.worktreeConfig`，仅社区博客佐证）。
- 惰性探测的成本与收益没有任何已读项目提供实测数据；VS Code 不处理目录级标志的后果是“文件在资源管理器里不显示”（issue #90983、#177925）。成本与收益的量化是设计判断，标未验证。
- Watchman 在 Linux 上读 `/proc/self/mounts`，用最长前缀匹配取路径所属挂载与类型，是“按路径找挂载点”的现成实现，成本是读取并解析整个挂载表。

#### 依据：成熟项目对嵌套挂载点与目录级标志的处理

<!-- prettier-ignore -->
| 结论 | 来源 | 访问日期 | 证据类型 | 验证状态 |
| --- | --- | --- | --- | --- |
| 所有被读的项目都是“每个仓库/根一次”的粒度，没有任何一个对子目录做惰性探测：Git 在 init 时对 git 目录探测一次并持久化；Mercurial 探测 `.hg` 或工作树根；Watchman 在构造 `Root` 时对根路径取一次；VS Code 与 Jujutsu 不探测 | Git 小节–Mercurial 小节 | 2026-10-19 | 项目源码 | 已验证（限于所读代码） |
| 目录级差异的实际应对是人工配置：Git 允许 `core.ignorecase` 按 worktree 覆盖（`git config --worktree core.ignorecase false`，前提 `extensions.worktreeConfig`），社区文章用它在 Windows 的大小写敏感目录里做 worktree；官方文档只说它是“内部变量，改动可能带来意外行为” | https://blog.nerdbank.net/2026/04/16/case-sensitive-git-worktrees-on-windows/；https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/config/core.adoc | 2026-10-19 | 社区讨论（降级）+ 官方文档 | 部分验证（缺：Git 官方对 `extensions.worktreeConfig` 下该键的说明未核实） |
| 挂载点感知的先例：Watchman 在 Linux 上读 `/proc/self/mounts`，用最长前缀匹配取路径所在的挂载点与类型；用途是识别不应监视的网络/远程文件系统，不用于大小写。这是“按路径找所属挂载”的现成实现，但成本是读取并解析整个挂载表 | https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FSDetect.cpp（`find_fstype_in_linux_proc_mounts`） | 2026-10-19 | 项目源码 | 已验证 |
| 探测结果缓存到私有目录的先例：Mercurial 的 `checkexec`/`checklink` 把探测结果落成 `.hg/wcache` 下的标记文件，下次先走只读快速路径；`.hg/wcache` 不可写时（`PermissionError`）当作只读文件系统处理。这与草案“按目录 id + 路径快照缓存”不同：它缓存在磁盘而不是内存，没有失效策略 | https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/posix.py（`checkexec`、`checklink`） | 2026-10-19 | 项目源码 | 已验证 |
| 惰性探测的成本与收益：没有任何已读项目提供实测数据；VS Code 的 issue 显示不处理目录级标志的后果是“文件在资源管理器里不显示”（#90983、#177925）。成本与收益的量化为设计判断 | 见 VS Code 小节 | 2026-10-19 | 推断 | 未验证 |

- **建议**：与草案 4.7.2.4 一致，第一版只探测项目根，把嵌套挂载点与目录级标志写成已知限制；演进路径按“父目录句柄加设备 id（Windows 为卷序列号）”惰性探测并缓存。

### 5.10 依赖建议（问题 10；写成建议，等待用户在 D-1 批准）

不修改 `Cargo.toml`。项目事实：`edition = "2021"`，无 `rust-version`，CI 用 stable；项目许可证 MIT；仓库没有 `deny.toml`，CI 没有 cargo-deny，`THIRD_PARTY_NOTICES.md` 只列字体不列 Rust crate。

<!-- prettier-ignore -->
| crate 或 feature | 建议 | 版本策略 | 许可证（SPDX） | 最近发布日期与维护状态 | 在 `Cargo.lock` | 需新增 Cargo feature | 是否新增依赖 | 理由 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `unicode-normalization` | 采用（仅用于 NFC/NFD） | 写 `"0.1"`，锁定 0.1.26（刚发布 2 天，评审时确认无回退）；升级经 `cargo update -p` 显式进行 | `(MIT OR Apache-2.0) AND Unicode-3.0` | 0.1.26，2026-10-16；活跃，近 90 天下载约 1.2 亿 | 否（其传递依赖 `tinyvec 1.11.0` 已在锁文件） | 否（默认 `std`） | 是（新增直接依赖） | NFC/NFD 的事实标准 crate；Unicode 18 数据；纯 Rust；MSRV 1.36；与 MIT 兼容（Unicode-3.0 对分发声明的要求待确认，见第 6 部分） |
| `unicase` | 采用（完整折叠 C+F 的键函数） | 写 `"2"`，锁定 2.10.0 | `MIT OR Apache-2.0` | 2.10.0，2026-10-05；活跃，近 90 天下载约 1.07 亿 | 否 | 否（不要开 `nightly`） | 是（无传递依赖） | 完整折叠（C+F），数据最新（对 Unicode 18 新增的 49 条折叠命中 49/49，版本号未明文），`no_std`；无规范化与区域设置逻辑 |
| `windows-sys` 的 feature `Wdk_Storage_FileSystem` | 采用 | 保持 `"0.59"` | `MIT OR Apache-2.0` | 项目锁 0.59.0（2024-07-30）；最新 0.61.2（2025-10-06）；活跃 | 是（0.59.0，另有 0.45.0、0.52.0、0.60.2、0.61.2 并存） | 新增 `Wdk_Storage_FileSystem`（提供 `NtQueryInformationFile`、`FileCaseSensitiveInformation`、`FILE_CASE_SENSITIVE_INFORMATION`；`Win32_System_IO` 已有） | 否（不新增 crate） | 取得带类型绑定；备选是像 `file_cas.rs` 对 `NtSetInformationFile` 那样手写 FFI 声明（项目先例） |
| `windows-sys` 的 feature `Win32_System_SystemServices` | 不批准（改为在 `platform/` 内本地定义常量并注明出处） | — | 同上 | 同上 | 是（当前被 `winx` 间接启用） | 若显式声明则新增 | 否 | `FILE_CASE_SENSITIVE_SEARCH`(1)、`FILE_CASE_PRESERVED_NAMES`(2)、`FILE_CS_FLAG_CASE_SENSITIVE_DIR`(1) 值固定且有官方文档，本地定义可避免多开 feature |
| `windows-sys` 的 feature `Wdk_System_SystemServices`、`Win32_Globalization`、`Win32_System_WindowsProgramming` | 不批准 | — | 同上 | 同上 | 是 | 不需要 | 否 | 远程判定沿用 `file_cas.rs` 的 UNC 前缀加 `GetDriveTypeW` 做法（`DRIVE_REMOTE_TYPE` 已本地定义），或本地定义 `FILE_FS_DEVICE_INFORMATION`；`CompareStringOrdinal` 仅在选用 OS 大写表时才需要 |
| `libc`（unix 目标，已有直接依赖） | 沿用，不改 | `"0.2"`，已锁 0.2.186 | `MIT OR Apache-2.0` | 已是依赖，不属本次评估对象 | 是 | 不需要 | 否 | 覆盖 `fstatfs`、`ioctl`、`FS_IOC_GETFLAGS`、macOS 的 `pathconf`/`getattrlist`/`statfs`；缺的魔数与 `FS_CASEFOLD_FL` 本地定义 |
| `same-file` | 不采用 | — | `Unlicense/MIT`（旧式写法） | 1.0.6，2020-01-11；稳定、功能完成、低频维护（仓库 2025-10-17 仍有推送，未归档） | 是（1.0.6，经 `walkdir` 传递） | 无 | 否 | `platform/file_identity.rs` 已覆盖其全部能力且更适合目录句柄；同样有 ReFS 128 位缺口 |
| `caseless` | 不采用 | — | `MIT` | 0.2.2，2024-12-30；其后无发布 | 否 | 无 | 否 | 数据停在 Unicode 16.0.0，对 Unicode 18 新增的 49 条折叠命中 0/49 |
| `rustix` | 仅评估，不新增直接依赖 | 如要用：`"1"` 加 `["fs"]`，仅 `cfg(unix)` | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 1.1.5，2026-09-16；已锁 1.1.4（2026-02-22）；活跃 | 是（1.1.4，经 `cap-primitives` 传递，已启用 `fs`） | 不需要 | 否（要直接用需新增声明） | 缺 `FS_CASEFOLD_FL` 与 macOS 的 `pathconf`/`getattrlist`；项目已有 `libc` 全覆盖。`ioctl_getflags` 的缓冲区封装更省心，但不值得新增直接依赖 |
| `cap-primitives` | 不采用（不直接依赖） | — | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 4.0.3，2026-08-20；活跃 | 是（4.0.3，经 `cap-std` 传递） | 不需要 | 否 | 不提供任何大小写探测能力，只借 `cap_std::fs::Dir` 句柄；其在 Windows“目录级区分大小写”目录里的打开行为未验证（第 6 部分） |
| `icu_normalizer` | 仅评估 | 若用：`"2"`，跟随锁定的 2.2.0 | `Unicode-3.0` | 2.3.0，2026-08-13；锁 2.2.0；活跃 | 是（2.2.0，经 `url`/`idna` 传递，`compiled_data` 已启用） | 需新增直接声明 | 否（已在图内） | NFC 的零新增 crate 备选；MSRV 1.86、edition 2024、API 较重，数据的 Unicode 版本号未查到 |
| `icu_casemap` | 不采用 | — | `Unicode-3.0` | 2.3.0，2026-08-13 | 否 | `compiled_data`（默认） | 是 | 唯一成熟的简单折叠（C+S，`simple_fold`），但依赖 icu_provider/zerovec，体积与编译成本大，MSRV 1.88 |
| `casefold` | 不采用 | — | `MIT` | 0.1.0，2026-07-09（唯一版本） | 否 | 无 | 是 | C+S 且体积小，但单版本、新、下载量小（近 90 天约 9 千） |
| `whichdisk` | 不采用 | — | `MIT OR Apache-2.0` | 0.7.0，2026-10-01（共 9 个版本，近 90 天约 1.5 万下载） | 否 | 无 | 是 | 卷级能力解析；Windows、Linux 仅按文件系统类型推断，故意忽略目录级标志（`src/linux.rs` 注释明言），且体量巨大 |
| `normalized-path` | 不采用（仅作测试向量参考） | — | `MIT OR Apache-2.0` | 0.2.0，2026-08-16 | 否 | 无 | 是 | 故意过度折叠（全角转 ASCII、土耳其 İ/ı 并入 i 等），不适合当作文件系统真实行为的近似键 |
| 其余检索命中者（`focaccia`、`unicode-casefold`、`cageforge-path`、`infinitier_fs`（GPL-3.0-or-later，与 MIT 分发不兼容）、`uffs-text`（MPL-2.0））| 不采用 | — | 见第 3 部分 Rust crate 小节 | — | 否 | — | 是 | 数据过时、仅按 OS 静态规则、许可证不兼容或自述未验证；检索 21 个关键词未发现专门做目录级大小写敏感性探测的 crate |

- 评估的 crate 数：7 个必选（`same-file`、`unicode-normalization`、`caseless`、`unicase`、`rustix`、`windows-sys`、`cap-primitives`）加 `icu_normalizer`、`icu_casemap`、`casefold`、`whichdisk`、`normalized-path`、`focaccia`、`unicode-casefold`、`cageforge-path`、`infinitier_fs`、`uffs-text`，共 17 个；标准库 `str::to_lowercase` 另列。
- 新增直接依赖建议共 2 个 crate（`unicode-normalization`、`unicase`）加 1 个 `windows-sys` feature；`Cargo.lock` 预计新增 2 个包（未实际构建验证，按依赖图推断）。

## 6. 未验证项清单

本部分汇总各区域草稿里所有“未验证”的子结论，共 **66** 项（Windows 14、macOS 14、Linux 17、Git 等项目 9、Rust crate 12；Windows 区草稿里一条已撤销的编号不再列出）。“怎样验证”引用 W-20、M-19、L-19 的条目编号，或标明“建议新增”。第 3 部分各小节里“F-n”形式的引用与这里的编号对应：UW-n、UM-n、UL-n、UV-n、UC-n。

<!-- prettier-ignore -->
| 编号 | 内容 | 为什么未验证 | 怎样验证 | 不验证的风险 |
| --- | --- | --- | --- | --- |
| UW-1 | NTFS 目录级标志对新建子目录的继承（WSL 创建 vs Win32 创建），官方来源互相矛盾 | 需要在已启用标志的目录里建子目录；本次约束为只读，且设置需管理员 | W-20 步骤 2：管理员 PowerShell 建空目录、`fsutil file setCaseSensitiveInfo … enable`，分别用 `mkdir` 与 WSL 的 `mkdir` 建子目录，逐个 `queryCaseSensitiveInfo` | 把根目录的结果推广到子目录会判错；本草案只探测项目根，影响限于已知限制 4.7.2.4，但 W-20 的期望不能预设 |
| UW-2 | ReFS 与 Dev Drive：默认是否不区分大小写；`RefsEnableDirCaseSensitivity` 取值含义；Dev Drive 上 `fsutil` 是否可设置目录标志；ReFS 的比较表 | 本机没有 ReFS/Dev Drive 卷，创建需要磁盘映像和管理员；官方只有一句“supports per-directory case sensitivity” | 在 VHDX 上格式化 ReFS 或 `Format-Volume -DevDrive`，跑 W-20 步骤 3，保存 `fsutil` 输出与注册表值 | ReFS/Dev Drive 用户（开发者人群中比例不低）可能被判错；有文件身份兜底，后果限于多出或缺失一个文档 |
| UW-4 | `fsutil file setCaseSensitiveInfo` 是否需要先启用 WSL 可选组件（草案括号语） | 官方文档未提；`Get-WindowsOptionalFeature` 需提升权限，本次无法查询 | 管理员会话里在未装 WSL 的干净系统上直接执行 | W-20/RS-T62 测试十在无 WSL 的环境里可能不可用，需要记“阻塞” |
| UW-5 | Samba 且 `case sensitive = yes` 时，Windows 客户端的卷标志与换大小写探测结果 | 没有 Samba 服务端可用，也不能建文件 | 起一个 Samba 容器或 Linux 主机，配置 `case sensitive = yes`，从 Windows 跑 W-20 步骤 5 | ⑥b 行只能依赖服务端源码与手册，客户端表现未测 |
| UW-6 | Windows 服务端上存在大小写敏感目录时，经 SMB 访问的行为 | 只有 GitHub issue（社区）；设置标志需管理员 | 在服务端建一个启用标志的目录并共享，从另一台 Windows 客户端访问并记录 | 这种配置罕见；落入 `Unknown`/行为探测即可 |
| UW-7 | 真实卷的 `$UpCase` 内容（旧卷、不同 Windows 版本格式化的卷）与本机 OS 表的差异 | 读取 `$UpCase` 需要管理员做原始卷访问，约束为只读且不提权 | 管理员下用 `fsutil`/原始读取工具导出 `$UpCase` 并与 Unicode 数据对照；或在不同 Windows 版本的 VHD 上格式化后比较 | 对应小节的“D. 向量判定” NTFS 列非 ASCII 行只是“OS 当前表”的推断，旧卷可能不同；不影响“文件身份兜底必须保留”的结论 |
| UW-8 | FAT（含 FAT32）的非 ASCII 名称比较规则 | 未找到 Microsoft FAT 规范的原文（`fatgen103`），Windows FAT 驱动是否使用同一 OS 表未核 | 找到 FAT 规范页；或在 FAT32 VHD 上实机测试 | 对应小节的“D. 向量判定” FAT 列大多为“未验证” |
| UW-9 | ReFS 的文件名比较表（是否与 NTFS 相同、是否逐卷存储） | 未查到 | 同 UW-2，增加向量组的实机创建测试 | 对应小节的“D. 向量判定” ReFS 列大多为“未验证” |
| UW-10 | `NtQueryInformationFile(FileCaseSensitiveInformation)` 在 FAT、exFAT、ReFS（无标志）、CDFS、UDF 上返回的 NTSTATUS | 只观察了 NTFS（成功）、SMB 与 9P（`STATUS_NOT_SUPPORTED`）；其他卷本机没有 | 实机在对应卷上调用并记录；或查 Windows 内核符号/源码 | 流程里把“任何失败”都落入行为探测即可规避，风险低 |
| UW-11 | 目录与重解析点的 `nNumberOfLinks`；OneDrive 占位文件等特殊条目作为探测对象的表现 | 官方文档只写了 FAT=1、NTFS 可大于 1 | 实机观察 | 通过“只用普通非重解析点文件”规避 |
| UW-12 | Defender/OneDrive/Dropbox/构建工具对临时探测文件的反应（E.5 最后一行） | 未检索到可靠来源 | 实机在被这些工具监控的目录里放探测文件并观察事件/告警 | “临时文件兜底”的副作用无法量化，已被限定为最后手段 |
| UW-13 | `GetVolumeInformationByHandleW` 文档称 SMB 3.0 不支持，但本机环回调用返回成功 | 两处冲突无法由文档裁决 | 在真实远程服务器上重复观察 | 无影响：远程位置不使用该 API 的结果 |
| UW-14 | 本机观察 `\\wsl$` 的发行版 `docker-desktop` 的根文件系统类型 | 未取得（只读观察没有给出类型） | 在 WSL 内 `stat -f -c %T /etc` | 影响 ⑦ 行“ext4”这一说法的本机佐证；官方文档对 ext4 默认区分大小写已有说明 |
| UW-15 | 注册表 `NtfsEnableDirCaseSensitivity`、`RefsEnableDirCaseSensitivity`、`obcaseinsensitive` 的取值含义与默认值（本机值分别为 3、3、1） | 官方页只提到 ReFS 那一项的名字与读取位置 | 查 Windows 内部文档或实机改值前后对比（需管理员，超出本次约束） | 仅影响对“为什么某机器上标志不可设置”的解释，不影响探测逻辑 |
| UM-1 | 真实 APFS（不区分大小写）上 `ß`/`ss`、`ﬃ`/`ffi` 是否同名（full 还是 simple folding）、`ı`、`İ`、Kelvin、Cherokee 的实际行为 | APFS 内核闭源，Apple 只说“Unicode 9.0” | M-19 第 1 项卷上用 `touch` 依次创建 `Straße` 与 `STRASSE`、`ﬃ` 与 `ffi`、`ǅ`/`ǆ`、`Ꭰ`/`ꭰ`、Kelvin/`k` 并 `ls -li` 比较 inode；可参考 `apfsfold.py` 的社区预测值对照 | 误折叠（把本不同名的两个文件当同名）会让其中一个文件在应用里打不开 |
| UM-2 | APFS（及 exFAT）对 `fpathconf(_PC_CASE_SENSITIVE)` 与 `getattrlist` 的 `valid` 位的实际返回 | 实现闭源 | M-19 第 1、2、4 项：对每个卷记录 `fpathconf` 返回值（含 -1/`errno`）、`capabilities`、`valid`、`f_fstypename`（`stat -f %T` 也可看类型） | API 失败时降级到行为探测，影响探测成本 |
| UM-3 | `getattrlist` 对非卷根路径是否在旧 macOS 上也替换为卷根（man 页写 `EINVAL`，xnu-12377 源码替换） | 只读到了一个源码标签，旧版本未查 | 在项目支持的最低 macOS 上对子目录调用 `getattrlist` 带 `ATTR_VOL_INFO\|ATTR_VOL_CAPABILITIES` | 旧系统上该 API 失败，只会多走一次降级，风险低 |
| UM-4 | `f_fsid` 作为缓存键的稳定性 | `statfs(2)` 未承诺 | 重新挂载同一卷后比较 `f_fsid`；或改用 `f_mntonname` + 卷 UUID（`ATTR_VOL_UUID`） | 缓存可能误命中或不命中 |
| UM-5 | 临时文件创建/删除对 Spotlight、Time Machine、iCloud/File Provider 同步的影响 | 没找到官方或源码级来源 | 在被 Spotlight 索引、被 Time Machine 备份、位于 iCloud Drive 的目录中做探测，观察 `fs_usage`、`mdutil`/`mdfind` 与 `tmutil` 记录 | 临时文件可能被索引或上传；已有“只读翻转大小写优先”的设计可缓解 |
| UM-6 | 数据卷路径：`/Users/...` 与 `/System/Volumes/Data/...` 两个入口查询结果一致 | 只读到 `synthetic.conf` 与 APFS 引用的描述 | M-19 新增一项：对同一目录分别用两种路径打开并查询 | 低 |
| UM-7 | macOS 对 exFAT 卷的规范化行为与 Up-case 表、API 返回值 | Apple exFAT 驱动闭源 | M-19 第 4 项：创建 NFC/NFD 的 `café.txt`、`a.txt`/`A.txt`、`ß`/`ẞ` 并记录；用 macOS 的 `newfs_exfat` 与 Windows 格式化的 U 盘各测一次 | 规范化轴判错会漏折叠或误折叠 |
| UM-8 | SMB：Samba（区分大小写）与 Windows（NTFS）服务器上的行为，以及服务器上 NFD 存储名的访问问题 | 草案 M-19 第 5 项只测本机 macOS 共享 | 新增：Linux Samba 共享（`case sensitive = yes`）与 Windows 共享各测 `a.txt`/`A.txt` 与 NFC/NFD | 对 `smbfs` 的 API 固定返回“不区分”，若直接采信会误折叠 |
| UM-9 | NFS：v3 与 v4 各一次，服务器分别是 Linux ext4 导出和 macOS 自带 NFS 导出 | M-19 无 NFS 项 | 新增 M-19 第 6 项：`sudo nfsd enable` + `/etc/exports`，`mount -t nfs -o vers=3`/`vers=4`；记录 `fpathconf` 返回值（含 `EINVAL`）与耗时 | NFS 上的 API 可能阻塞，未设预算会卡住调用线程 |
| UM-10 | macFUSE/FSKit 卷与 File Provider 目录（`~/Library/CloudStorage`）上 `fpathconf` 的返回 | 内核扩展闭源，无官方说明 | 新增：macFUSE + `sshfs`（或 `ntfs-3g`）、FSKit 示例卷、一个 File Provider 目录各测一次 | 此类位置只能靠行为探测或 `Unknown` |
| UM-11 | `hdiutil create -fs "Case-sensitive APFS"` / `-fs "Case-sensitive HFS+"` 这两个字符串是否被 `hdiutil` 接受；新版 macOS 是否还能创建 HFS+ 映像 | man 页只明列 `HFSX`、`JHFS+X`、`APFS`、`ExFAT` 等；“full list in create -help” | 在 macOS 上执行 `hdiutil create -help` 核对；必要时改用 `diskutil apfs addVolume <容器> "Case-sensitive APFS" <卷名>` 在一个 APFS 容器内新增卷（`diskutil(8)` 明列此 personality 名） | 实机清单命令不可执行，M-19 无法按文执行 |
| UM-12 | 系统卷与数据卷在同一卷组内是否必须大小写一致 | 官方文档没找到 | 不需要验证（设计只查项目所在卷） | 无 |
| UM-13 | Spotlight 之外：`lstat` 翻转大小写探测是否对 FSEvents 或 atime 有副作用 | 未逐项核对 | 在订阅了目录的 `fswatch` 下对已有文件执行翻转大小写 `lstat`，观察是否有事件 | 低 |
| UM-14 | libc 符号在本项目 macOS 目标上实际编译通过 | 本机是 Windows，未安装 darwin 目标 | CI 的 macOS 任务（`cargo check --locked`）或本地 `rustup target add aarch64-apple-darwin` 后 `cargo check --target`（会改本机工具链，故本次未做） | 低 |
| UL-1 | vfat 在 `iocharset=utf8` 下 `README` 与 `readme` 是否真的互不匹配、能否共存 | 只读到源码（恒等表 + `nls_strnicmp`），没有 Linux 环境 | L-19 新增项：`mount -t vfat -o loop,iocharset=utf8 v.img ...`，创建 `a.txt`、`A.txt` 观察 | 把 vfat 一律当 `Insensitive` 会在该选项下误折叠 |
| UL-2 | vfat 默认选项下非 ASCII（如 `é`/`É`）确实不折叠 | 同上，是对字节表的推导 | 同上，`utf8=1`、默认 `iocharset` 各测一次 | 影响 `PathKey` 的折叠集合选择 |
| UL-3 | exfat 卷自带 upcase 表与内核默认表是否一致（mkfs.exfat / Windows / macOS 写入的表） | 需要真实镜像与读取工具 | 用 `exfatprogs` 的 `dump.exfat` 或 `hexdump` 读 upcase 表条目，与 `uni_def_upcase` 对比 | 对应小节的“D. 向量判定” exFAT 列可能与实机不符 |
| UL-4 | ntfs3 `nocase` 下具体折叠集合（`$UpCase` 表）与 Windows 的差异 | 未复算 | L-19 ntfs3 `-o nocase` 项，对 13 组向量逐一实测 | 折叠集合未知，只能靠身份兜底 |
| UL-5 | cifs 不带 `nocase` 时，对 Windows/Samba 服务器翻转大小写能否找到文件、`serverino` 与 `noserverino` 下 inode 是否一致 | 源码只读了客户端；服务端行为属于实机 | L-19 步骤 8 加 `serverino`/`noserverino` 变体与 Windows、Samba（`case sensitive = yes/no/auto`）两种服务端 | cifs 上可能把不敏感的共享误判为 `Sensitive` |
| UL-6 | FUSE（sshfs、exfat-fuse）翻转大小写后的 `st_ino` 行为 | 只读到 libfuse 文档与 `fuse.c` 函数，没读 sshfs 的 getattr | L-19 新增 sshfs 项 | 同上 |
| UL-7 | ZFS `casesensitivity=insensitive` 在 Linux 上的实际 lookup 行为、`zfs get` 的权限需求、`normalization` 对 Linux 路径比较的实际效果 | 只读到 `zpl_lookup` 与 man | 在装有 OpenZFS 的机器上创建 `-o casesensitivity=insensitive` 数据集，实测，并以非 root 运行 `zfs get` | zfs 位置只能 `Unknown` |
| UL-8 | 不支持的文件系统上 `ioctl(FS_IOC_GETFLAGS)` 的 errno 是否确为 `ENOTTY`；旧内核 vfat 上是否如推导 | 源码推导（`vfs_fileattr_get` → `-ENOIOCTLCMD` → `vfs_ioctl` → `-ENOTTY`），未实机 | 在 vfat、ntfs-3g、cifs 上跑小程序打印 `errno` | 误把 `ENOTTY` 之外的 errno 当成致命错误，或相反 |
| UL-9 | 发行版/内核版本分布：用户机器上是否已有 ≥7.2、≥6.2（ntfs3 `nocase`）、≥6.13（tmpfs casefold） | 内核版本到发行版的映射不在本次范围 | 由 L-19 记录 `uname -r` | 无法估计“v7.2 新接口”的覆盖面，故设计不得依赖它 |
| UL-10 | 监听器/构建工具/同步工具对临时文件探测的实际影响（Syncthing、Dropbox、webpack、VS Code watcher） | 未找到可靠来源 | 在实机上用 `inotifywait -m` 观察探测期间事件，并用目标工具各跑一次 | 只能如实写“影响未验证”，缓解措施靠设计保守 |
| UL-11 | `mkfs.ext4 -O casefold` 写法是否有效 | `mke2fs(8)` 里读到的是 `-E encoding=` | 在 Linux 上执行并 `dumpe2fs -h` 检查特性 | L-19 创建步骤可能失败 |
| UL-12 | btrfs 全树是否有 casefold 相关代码 | 只读了 `inode.c`、`ioctl.c`、`super.c` | 对 `fs/btrfs` 全目录 `grep -ri casefold` | 小；L-19 可实测 |
| UL-13 | f2fs casefold 的 `lookup_mode`（文档新增选项）对非 casefold 名字的影响，以及 `mkfs.f2fs` 的启用参数 | 文档只读到 `lookup_mode` 说明；`mkfs.f2fs(8)` 在 man7.org 上 404 | 查 f2fs-tools 手册；实机测 | f2fs 位置的建议暂时只依赖目录位 |
| UL-14 | 新 `fs/ntfs` 驱动（v7.1+）是否实现了 `FS_CASEFOLD_FL` 的报告，以及 `nocase` 的比较函数细节 | 只读了 `super.c`、`dir.c` 片段，没读 `file.c` | 读 `fs/ntfs/file.c` 的 `fileattr_get`；实机 | ntfs 位置对 v7.1+ 只能依赖 mountinfo 选项或行为探测 |
| UL-15 | `/proc/self/mountinfo` 里 ntfs-3g 与其他 FUSE 的类型串（`fuseblk` / `fuse.ntfs-3g`） | 手册只说明格式 `type[.subtype]`，没有各驱动的实际字符串 | L-19 记录 `findmnt` 输出 | 区分 FUSE 子类型的方案没有依据 |
| UL-16 | xfs 的 ascii-ci 模式在 v7.2 之前是否报告大小写语义、从哪个版本起报告 | 只读到 v7.2 统一接口补丁说明，未逐版本核对 | 读 xfs 各版本的 `fileattr_get`；或在对应内核实机 `xfs_io -c lsattr` | 旧内核上 xfs ascii-ci 卷可能被误判；设计已规定“位未置位”只对 ext4/f2fs/tmpfs 解释为 Sensitive |
| UL-17 | fanotify 的创建、删除、查找类事件完整清单（只读 `lstat` 是否产生事件） | `fanotify(7)` 已下载但未逐条核对 `FAN_*` 事件 | 读 `fanotify(7)` 事件表；实机用 fanotify 监视目录并执行只读 `lstat` | “只读 `lstat` 不产生事件”目前只对 inotify 成立，且来自事件清单的缺席 |
| UV-1 | Git for Windows 在“按目录开启区分大小写”的目录里 `git init`，`core.ignorecase` 实际得到什么 | 源码层面 `access("CoNfIg")` 取决于 `.git` 所在目录是否继承标志（Microsoft 文档/博客对继承规则有冲突说法，不在本部分范围）；只有社区博客提供旁证 | 在 Windows 上对开启标志的目录执行 `git init` 并读取 `git config core.ignorecase`（W-20 增补步骤） | 误以为 Git 的结果可以作为目录级标志的参照 |
| UV-2 | Linux ext4 casefold 目录里 `git init` 的结果；`.git` 是否继承 `+F` | 未检索到相关来源；需要 root 与 casefold 文件系统 | L-19 增补：在 `chattr +F` 目录里 `git init` 并读取配置 | 同上 |
| UV-3 | 杀毒、云同步、文件监听器对探测临时文件的实际反应 | 没有找到任何以此为主题的官方文档或 issue | 实机清单增补：在受监视的目录（OneDrive、Dropbox、Defender 实时保护）里运行探测并观察事件与延迟 | 无法给出“影响”结论，4.7.4 第 9 项继续标待调研 |
| UV-4 | Git 对只读 git 目录的 precompose 探测行为 | 只有读码结论，未实测；`git init` 在只读目录里本身失败，难以构造 | 在可写的 git 目录里把目录权限改为只读后运行 `git init --reinit` 观察（reinit 不探测）；意义有限 | 低 |
| UV-5 | Watchman 的 macOS 分支在 `pathconf` 返回 -1 时被判为“区分大小写”这一后果 | `-1` 是 `pathconf` 出错返回值的约定，需 Apple 部分核实后才算已验证；也没有实机复现 | 对不支持该选项的卷（SMB、exFAT 等）运行 `pathconf(_PC_CASE_SENSITIVE)` 并查看返回值 | 误把 Watchman 当作“错误处理”的参照 |
| UV-6 | VS Code `toLowerCase` 的 Unicode 小写语义与具体映射（如 `İ`、`ẞ`） | 本部分未取 ECMAScript 规范原文 | 取 ECMAScript `String.prototype.toLowerCase` 条款与 Unicode `SpecialCasing.txt`；向量表由其他部分负责 | 低（本项目折叠函数在 Rust 侧实现，不依赖 VS Code） |
| UV-7 | Git 官方对 `extensions.worktreeConfig` 与 `core.ignorecase` 按 worktree 覆盖的说明 | 只有社区博客 | 读 `git-worktree`、`git-config` 文档中 `extensions.worktreeConfig` 一节 | 低 |
| UV-8 | Windows 上 Git 关闭 inode 信任（`trust_ino = 0`）的原因 | 源码没有注释，未检索到提交说明 | 用 `git log -S"trust_ino"` 追溯引入提交，读其说明 | 若照搬“Windows 文件索引可信”可能与 Git 的经验相反，需在 Microsoft 部分和实机上单独验证 |
| UV-9 | Windows 上取得文件链接数（用于 RS-T62 测试四的 `nlink == 1`）的具体 API 与 Rust 可用性 | 不在本小节，且没有成熟项目样例 | 查 `GetFileInformationByHandle` 的 `nNumberOfLinks` 与 Rust 标准库/`windows-sys` 暴露情况 | 硬链接盲区在 Windows 上无保护 |
| UC-1 | `unicase 2.10.0` 数据对应的 Unicode 版本号 | 作者没有在文档或源码常量里写版本号，只能从“49/49 新增项折叠正确”反推至少含 18.0.0 的新增项 | 读上游 `scripts/CaseFolding.txt` 的头部（crate 包 `exclude = ["scripts/*"]` 未打入包内，需在仓库中看）；或在 PR 里加一个单测固定几条 Unicode 18 新增映射 | 低；升级 unicase 后数据可能变化，需单测固定向量 |
| UC-2 | `icu_normalizer 2.2.0` 数据的 Unicode 版本号 | `icu_normalizer_data` README 只写 “CLDR version 48.2.0, ICU version release-78.1rc”，未写 Unicode 版本号 | 查 ICU 78 发布说明或 ICU4X 2.2 数据生成配置 | 仅影响把它作为 NFC 备选时的数据新旧判断 |
| UC-3 | `rustix` 在 macOS 目标上启用的 feature 集 | 本机 `cargo tree --target aarch64-apple-darwin` 离线失败（缺 `base64 v0.21.7` 包） | 联网执行 `cargo tree --target aarch64-apple-darwin -e features -i rustix`，或在 macOS CI 上 | 低；macOS 路径本评估建议用 `libc`，不依赖 rustix |
| UC-4 | `cap-primitives` 在 Windows“目录级区分大小写”目录中打开 `a.txt`/`A.txt` 的行为 | 本机没有区分大小写目录，且按规则不得创建/修改目录属性；`create_file_at_w.rs` 第 145–150 行的条件方向可疑，只能读源码 | 实机清单 W-20 增加一项：在已启用目录级区分大小写的目录里，用 cap-std `Dir::open` 分别打开两个仅大小写不同的文件 | 中；若 cap-std 实际强制按不敏感匹配，则“目录标志置位为 Sensitive”的探测结论与文件服务实际行为可能不一致 |
| UC-5 | ReFS（含 Dev Drive）上 `FileIdentity` 的碰撞风险 | 已有微软官方文档支持“64 位索引在 ReFS 上不保证唯一”；但项目是否会遇到、概率多大需要实机 | 在 Dev Drive/ReFS 卷创建多个文件，比对 `BY_HANDLE_FILE_INFORMATION` 的索引与 `FILE_ID_INFO` | 中；身份兜底可能误判两个不同文件为同一文件（会错误合并文档或误报冲突） |
| UC-6 | `libc` 缺失的魔数（NTFS、exFAT、CIFS、SMB2）的取值与来源 | 本小节只核实了 libc 里没有，取值要从内核头文件取证，归 Linux 内核小节 | 读 Linux `include/uapi/linux/magic.h` 并与 `linux-raw-sys` 对照 | 中；写错魔数会使类型表失效 |
| UC-7 | `focaccia` 是否导出折叠键字符串 | 只读了 README，未读其源码 API | 读 `focaccia-2.5.0/src/lib.rs` | 低；本评估未选用它 |
| UC-8 | HFS+ 的 NFD 与 Unicode 标准 NFD 的差异对 `unicode-normalization` 键的影响 | 属 Apple 小节范围；本小节只能说 crate 实现的是标准 NFC/NFD | 对照 Apple TN1150 的分解排除区间与 crate 输出 | 中；macOS 上键与实际文件系统规范化可能有极少数字符不一致，靠文件身份兜底 |
| UC-9 | Unicode-3.0 数据许可对分发声明的要求，以及 `caseless` 未带该声明是否合规 | 未研读 Unicode 使用条款 | 阅读 https://www.unicode.org/terms_of_use.html 与 `LICENSE-UNICODE` 全文；由项目决定 `THIRD_PARTY_NOTICES.md` 是否列 Rust crate | 低；新增 `unicode-normalization` 时需在评审中确认声明做法 |
| UC-10 | 未对 `unicode-normalization` 做 Unicode 官方 `NormalizationTest.txt` 全量对照 | 仅做了 13 组（19 个配对）向量的行为观察 | 在 PR 里引入少量官方向量作为固定测试 | 低 |
| UC-11 | `uffs-text` 自述“NTFS-bit-exact case folding via the `$UpCase` table” | 仅 README 自述；新、下载量小、MPL-2.0；未读源码 | 读其源码与测试，与真实 `$UpCase` 对照（见 UW-7） | 无（已判定不采用） |
| UC-12 | `unicode-casefold 0.2.0` 的 API 细节与数据版本 | 2016 年后无发布，只读了元数据，未读 API | 读 docs.rs 与源码 | 无（已判定不采用，数据过时） |

## 7. 实机卷矩阵修订建议

本部分对测试规格的 W-20（`M6-closure-test-spec.md` 约 4189–4215 行）、M-19（约 4373–4390 行）、L-19（约 4552–4570 行）、X-26（约 4623 行）给出增、删、改建议。每个期望值都带来源或“未验证”；总表行号指第 2 部分。实机验证统一放 M6 最终验收（H-3），不在 075、076 内执行。**不修改测试规格本身**，修订由 076 或用户在 D-1 决定后处理。

### 7.1 W-20（Windows）

<!-- prettier-ignore -->
| 条目 | 现状 | 建议 | 期望值与来源 |
| --- | --- | --- | --- |
| 步骤 1 NTFS 默认目录 | 期望 `Insensitive`（待核实） | 保留；证据里加 `fsutil file queryCaseSensitiveInfo` 输出 | `Insensitive`（总表 W①，已验证） |
| 步骤 2 按目录启用 | 期望 `case-cs` 为 `Sensitive`，`sub` 继承（待核实）；括号语“部分系统需要先启用 WSL 相关可选组件” | `case-cs` 保留；`sub` 的期望**改为“记录实际结果”**，分别用 `mkdir`（Win32）与 WSL 内 `mkdir` 各建一个子目录并各自 `queryCaseSensitiveInfo`；“需先启用 WSL 组件”未验证，保留“不可用记阻塞”；需管理员、目录为空 | `case-cs`：`Sensitive`（已验证）；`sub`：未验证（官方来源矛盾，总表 W②） |
| 步骤 3 ReFS 或 Dev Drive | 期望 `Insensitive`（待核实） | 保留为假设；证据加 `fsutil` 输出与注册表 `RefsEnableDirCaseSensitivity`；Dev Drive 创建命令采用官方写法 `Format-Volume -DriveLetter D -DevDrive` 或 `Format D: /DevDrv /Q`；Home 版可能不支持 ReFS 记阻塞（保留） | 未验证（总表 W③④） |
| 步骤 4 `\\wsl$` | 期望 `Sensitive` 或 `Unknown`，`Insensitive` 即误判 | 保留；补充：预期**不会**由平台 API 直接得到 `Sensitive`，只能由行为探测得出；要先启动 WSL 实例；证据加卷标志、目录级查询返回码 | `Sensitive` 或 `Unknown`（部分验证，总表 W⑦） |
| 步骤 5 SMB | 期望 `Insensitive` 或 `Unknown`（服务端可能是区分大小写的 Samba） | Windows 服务端保持；**另增** Samba 条目（Linux 主机或容器，分别 `case sensitive = no`、`yes`）；改写括号语：Samba 默认不区分，只有显式 `yes` 才区分 | Windows 服务端 `Insensitive` 或 `Unknown`；Samba `yes`：未验证（总表 W⑥） |
| 新增 exFAT/FAT | 无 | VHD 格式化为 exFAT 与 FAT32 各一，期望 `Insensitive` | `Insensitive`（部分验证，总表 W⑤） |
| 新增诊断项 | 无 | ① 在已启用目录级标志的目录里 `git init`，读 `git config core.ignorecase`（Git 官方未处理目录级标志）；② 用 cap-std `Dir::open` 分别打开仅大小写不同的两个文件，确认文件服务的实际行为与探测一致（`cap-primitives` 的 Windows 分支条件方向可疑，只能读源码）；③ 记录 `NtQueryInformationFile(71)` 在 FAT、exFAT、ReFS 上的返回码 | 未验证（第 6 部分对应编号） |
| 清理 | `setCaseSensitiveInfo disable` 需目录为空 | 保留；含仅大小写不同文件的目录不能关闭 | 已验证（WSL 页） |

### 7.2 M-19（macOS）

<!-- prettier-ignore -->
| 条目 | 现状 | 建议 | 期望值与来源 |
| --- | --- | --- | --- |
| 步骤 1 默认 APFS 卷 | 期望 `Insensitive` | 保留；**每个卷同时记录** `fpathconf(_PC_CASE_SENSITIVE)` 返回值（含 -1 与 `errno`）、`getattrlist` 的 `capabilities` 与 `valid`、`f_fstypename`（`stat -f %T`）；规范化轴期望 `Yes` | 大小写 `Insensitive`（部分验证，总表 M①）；规范化 `Yes`（已验证） |
| 步骤 2 区分大小写 APFS | 命令 `hdiutil create -fs "Case-sensitive APFS"`；期望 `Sensitive` | 期望保留，**规范化轴期望 `Yes`**（官方 FAQ）；命令名 `hdiutil -fs "Case-sensitive APFS"` 是否被接受未验证，建议先 `hdiutil create -help`，或改用 `diskutil apfs addVolume <容器> "Case-sensitive APFS" <卷名>`（man 页明列） | `Sensitive`（部分验证，总表 M②） |
| 步骤 3 HFS+ | `-fs "HFS+"` 与 `-fs "Case-sensitive HFS+"`；期望分别 `Insensitive`、`Sensitive`，规范化待测 | 期望保留，规范化轴期望 **`Yes`**（两个变体）；`hdiutil -fs` 的 man 页明列 `HFS+`、`HFS+J`、`HFSX`、`JHFS+X`，建议优先用 `HFSX`/`JHFS+X`；新系统是否仍能创建 HFS+ 映像未验证；记录 `f_fssubtype` | `Insensitive`、`Sensitive`（已验证，总表 M③④） |
| 步骤 4 exFAT | `-fs ExFAT`；期望 `Insensitive` | 保留；macOS 驱动的 API 返回值与规范化行为**必须实机记录**；分别用 macOS `newfs_exfat` 与 Windows 格式化的 U 盘各测一次 | `Insensitive`（规范语义已验证；macOS 驱动未验证，总表 M⑤） |
| 步骤 5 SMB | `smb://localhost/<共享名>`；期望 `Insensitive` 或 `Unknown` | **改**：该项测的是 macOS 自作服务器（AAPL 扩展生效），不代表其他服务器；期望改为“对 `smbfs` 固定走行为探测，API 值不采信”；**另增** Samba（`case sensitive = yes`）与 Windows 共享各一，各测 `a.txt`/`A.txt` 与 NFC/NFD | 已验证（客户端源码）；服务端未验证（总表 M⑥） |
| 新增 NFS | 无 | v3 与 v4 各一次，服务端分别为 Linux ext4 导出与 macOS 自带 NFS；`sudo nfsd enable`、`/etc/exports`、`mount -t nfs -o vers=3`/`vers=4`；记录 `fpathconf` 返回值（含 `EINVAL`）与耗时 | 取决于服务端；API 可能发网络 RPC（已验证，总表 M⑦） |
| 新增第三方挂载 | 无 | macFUSE（`sshfs` 或 `ntfs-3g`）、FSKit 示例卷、File Provider 目录（`~/Library/CloudStorage`）各一；记录 `fpathconf` 返回 | 未验证 |
| 新增路径入口 | 无 | 对同一目录分别用 `/Users/...` 与 `/System/Volumes/Data/...` 打开并查询，结果应一致 | 未验证 |
| 新增向量实测 | 规范化观察只有 `café` | 追加：`Straße`/`STRASSE`、`ﬃ`/`ffi`、`ǅ`/`ǆ`、`Ꭰ`/`ꭰ`、开尔文符号/`k` 用 `touch` 依次创建并比较 inode，核对 APFS 的 full 或 simple folding | 未验证（第 6 部分对应编号） |

### 7.3 L-19（Linux）

<!-- prettier-ignore -->
| 条目 | 现状 | 建议 | 期望值与来源 |
| --- | --- | --- | --- |
| 总则 | 每个位置记 `stat -f -c %T <路径>` | **增记** `uname -r`（是否 ≥7.2）与 `findmnt -no FSTYPE,OPTIONS -T <路径>`（挂载选项是 vfat、ntfs3、cifs 结论的依据；`findmnt` 本次未查官方手册，仅作记录建议） | — |
| 步骤 1 tmpfs | 期望 `Sensitive` | 保留 | `Sensitive`（已验证，总表 L③） |
| 步骤 2 ext4 家目录 | 期望 `Sensitive` | 保留 | `Sensitive`（已验证，总表 L①） |
| 步骤 3 ext4 casefold | `mkfs.ext4 -O casefold`；期望 `Insensitive` | 期望保留并**补规范化轴 `Yes`**（NFC 与 NFD 同名）；`mke2fs(8)` 文档的写法是 `-E encoding=<名称>`，`-O casefold` 本次没读到出处，建议改为 `mkfs.ext4 -E encoding=utf8` 并先在实机确认；证据加 `lsattr -d`、`dumpe2fs -h` | `Insensitive`（已验证，总表 L②）；命令写法未验证 |
| 步骤 4 vfat | 期望 `Insensitive` | **拆变体**：默认（期望 `Insensitive`，仅 ASCII 与 `iocharset` 表内字符折叠）、`-o check=strict`（期望 `Sensitive`）、`-o iocharset=utf8`（期望按字节比较，ASCII 也不折叠，待实机） | 默认 `Insensitive`（部分验证，总表 L④） |
| 步骤 5 exfat | 期望 `Insensitive` | 保留；卷自带 upcase 表以卷表为准（可用 `exfatprogs` 的 `dump.exfat` 对比） | `Insensitive`（已验证，总表 L④） |
| 步骤 6 ntfs-3g | 期望 `Insensitive` 或 `Unknown` | **改**：期望 `Sensitive`（源码默认），保留“依赖行为探测”；另测 `lowntfs-3g -o ignore_case` | `Sensitive`（部分验证，总表 L⑤） |
| 步骤 7 内核 ntfs3 | 期望 `Insensitive` | **改并拆两项**：默认挂载期望 `Sensitive`；`-o nocase` 期望 `Insensitive`；记录内核版本（`nocase` 自 v6.2 起）；v7.1+ 新 `fs/ntfs` 驱动另记 | 默认 `Sensitive`、`nocase` `Insensitive`（已验证，总表 L⑥） |
| 步骤 8 cifs | 带与不带 `nocase`；期望 `Unknown` 或行为探测得出 | 保留；**增变体** `serverino`/`noserverino`，服务端增 Windows 与 Samba（`case sensitive = yes\|no\|auto`）两种；`noserverino` 下“找到但身份不同”期望得 `Unknown` | 部分验证（总表 L⑦） |
| 步骤 9 nfs | 期望取决于服务端 | 保留；记录内核版本（v7.2 起客户端暴露 `FS_CASEFOLD_FL`） | 部分验证（总表 L⑧） |
| 新增 zfs | 无 | `casesensitivity=insensitive` 数据集与默认数据集各一；记录非特权下 `zfs get casesensitivity` 是否可用；无环境记阻塞 | 未验证（总表 L⑨） |
| 新增 btrfs | 无 | `mkfs.btrfs` 回环镜像；期望 `Sensitive` | 部分验证（总表 L⑩） |
| 新增 f2fs / tmpfs casefold | 无 | f2fs casefold 目录（`mkfs.f2fs` 启用参数本次未查到）；tmpfs `-o casefold`（内核 v6.13+）加 `chattr +F` | 未验证 / 已验证（tmpfs 源码） |
| 新增 FUSE | 无 | `sshfs` 到 Windows OpenSSH 服务器与到 Linux 服务器各一；验证未开 `use_ino` 时“找到但身份不同”确实不可信 | 未验证 |
| 新增副作用与诊断 | 无 | ① 受监视目录里运行探测，用 `inotifywait -m` 观察事件；② 在 `chattr +F` 目录里 `git init` 并读 `core.ignorecase`；③ 不支持的文件系统上 `ioctl(FS_IOC_GETFLAGS)` 的 `errno` 是否确为 `ENOTTY` | 未验证 |
| 只读挂载 | 期望没有含字母条目时得 `Unknown` 且不创建文件 | 保留 | 设计要求，非来源结论 |

### 7.4 X-26（hydrate 合并）

X-26 依赖 076 的实现，本次调研不改其步骤。仅建议：位置选择应覆盖一个 `Insensitive`（含 NFC 与 NFD 变体各一）、一个 `Sensitive`、一个 `Unknown`（只读挂载或 FUSE）位置。其余随 076 完成后再修订。

### 7.5 汇总

- 新增位置或变体共约 20 项（Windows 约 4、macOS 约 6、Linux 约 10）；需要改期望值的有 W-20 步骤 2；M-19 步骤 2、3、5 的规范化轴与 SMB 语义；L-19 步骤 3（规范化轴）、4、6、7。
- 需要特殊环境的项（Samba 服务端、ZFS、NFS 服务端、macFUSE、ReFS/Dev Drive、f2fs）无法保证每个都能执行，按规格的做法记“阻塞”并写原因；是否缩减由 D-1-6 决定。

## 8. 待用户决策项（供 D-1）

共 9 个决策问题，覆盖任务文档要求的 6 类必选问题（探测矩阵 Q1、规范化轴 Q2、折叠选型与向量 Q3、依赖批准 Q4、未验证项处理 Q5、授权 076 Q9）：Q1 至 Q6 与 `tmp/goals/human-gates/d-1-pd10-research-confirmation.md` 的 D-1-1 至 D-1-6 一一对应（Q6 是实机卷矩阵范围，D-1-6）；Q7、Q8 是调研新发现、需要你表态的两项，在 D-1 模板里没有对应栏位，可并入 D-1-1 的“修改为：”一栏；Q9 对应 D-1 第 5 节的最终勾选。D-1-7（076 的三处实现形态）与 D-1-8（Rust 合并规则仅供测试）不来自本调研，不在此列。

**调研推荐的整体口径**：总表 24 行已把调研修正并入（先判远程、删除 ntfs/ntfs3、smbfs 不采信 API 等），无整行“未验证”，建议整体采纳；所有“未验证”子结论只做保守降级，实机验证放 M6 最终验收。

### Q1 探测矩阵（对应 D-1-1）

- 问题：是否采纳第 2 部分的 24 行总表（及第 4 部分对草案的修正）作为 076 的探测矩阵。
- 选项（与 D-1-1 相同）：A 全部采纳；B 采纳但有修改（逐行写明）；C 只采纳“已验证”与“部分验证”的行，“未验证”的行一律直接 `Unknown`（本表没有整行未验证，所以 C 在效果上等同 A）；D 推迟。
- 调研推荐：**A**。
- 依据：24 行里已验证 9 行、部分验证 15 行、未验证 0 行；与草案的 17 项差异（第 4.2 节）已并入各行；行内“未验证”的子结论都有保守降级（行为探测，最终 `Unknown`）。
- 不决策的后果：076 无法确定平台适配器的分支，不能开工。

### Q2 规范化轴（对应 D-1-2）

- 问题：Unicode 规范化轴取什么值。
- 选项：A 只在“已验证”的位置设 `Yes`（macOS 的 APFS/HFS+ 四个变体；Linux ext4/f2fs/tmpfs 的 casefold 目录），其余一律 `Unknown`；B macOS 按卷格式、Windows 与 Linux 固定 `No`；C 全部 `Unknown`（第一版不规范化）；D 推迟。
- 调研推荐：**A**。
- 依据：`Yes` 的两类位置有官方文档或内核源码；Windows 与 Linux 的 `No` 只有部分验证（官方文档无一句话直接陈述，Linux 是“驱动不含规范化调用”的字符串搜索），而在 `PathKey` 里 `No` 与 `Unknown` 效果相同，写 `Unknown` 更诚实；规范化轴不做行为探测。
- 不决策的后果：076 的 `decode` 无法确定规范化轴取值，且 P1 向量里规范化向量（第 7 组）的期望无法固定。
- 备注：选 A 或 B 要求批准 `unicode-normalization`（Q4）；选 C 则不需要。

### Q3 折叠函数与向量（对应 D-1-3）

- 问题：大小写折叠用什么函数，向量表用哪一版。
- 选项（与 D-1-3 相同）：A 采纳第 5.6.2 节的键拼法（`unicase` 完整折叠 C+F，合并前须文件身份确认）与第 5.6.4 节的 13 组向量（标“未验证”的向量只作注释，不进断言）；B 采纳折叠函数，但向量表有修改（写明增删哪些组及期望）；C 折叠只做 ASCII 大小写，非 ASCII 字面比较（零新增 crate，见第 5.6.5 节）；D 推迟。
- 调研推荐：**A**。若你更看重“任何情况下都不误合并”，可选 B 并在“修改为：”里写明一条附加规则：文件身份取不到时，只有两个相对路径仅在 ASCII 字母大小写上不同才合并，其余保持两个文档（第 5.6.2 节风险点的缓解），并同步调整向量表中受影响的期望。
- 依据：没有任何成熟项目使用按卷探测的完整 Unicode 折叠，都是近似加兜底；完整折叠（C+F）比 NTFS、exFAT、vfat、HFS+ 折得更多，多折的情形被文件身份确认拦住；折得更少才会漏掉候选且无法纠正；`unicase` 数据最新、`no_std`、无区域设置逻辑；`caseless` 数据停在 Unicode 16.0.0。代价与风险见第 5.6.2 节。
- 不决策的后果：076 无法固定 `PathKey::of` 的折叠函数与夹具内容。
- 备注：D-1-3 与 076 文档把向量夹具放在 `contracts/fixtures/path-key-vectors.json`，但该目录受 Rust 的 `golden_fixtures_match_serialized_dtos`（目录里的 `*.json` 必须恰为 35 个映射文件）和前端 `EXPECTED_FIXTURES` 断言约束，新增文件会使这两处测试失败。这是 076 的实现细节而非调研结论，建议在 076 的偏差表里改放独立子目录（例如 `contracts/path-key/`），由 076 向你确认。

### Q4 依赖批准（对应 D-1-4）

- 问题：逐个批准或否决第 5.10 节依赖表里的 crate 与 Cargo feature。
- 选项：逐项填“批准/不批准”（D-1-4 的表格形式，不在表内的依赖 076 不得新增）。
- 调研推荐（逐项）：**批准** `unicode-normalization`（`"0.1"`，锁 0.1.26）、`unicase`（`"2"`，锁 2.10.0）、`windows-sys` 的 feature `Wdk_Storage_FileSystem`；**不批准** `windows-sys` 的 `Win32_System_SystemServices`/`Wdk_System_SystemServices`/`Win32_Globalization`/`Win32_System_WindowsProgramming`（改用本地常量）、`same-file`、`caseless`、`cap-primitives`、`rustix`（不新增直接声明）、`icu_normalizer`、`icu_casemap`、`casefold`、`whichdisk`、`normalized-path`、`focaccia`、`unicode-casefold`、`cageforge-path`、`infinitier_fs`、`uffs-text`。
- 依据：见第 5.10 节逐行理由；新增直接依赖 2 个 crate，`Cargo.lock` 预计新增 2 个包（`unicode-normalization`、`unicase`），其传递依赖 `tinyvec` 已在锁文件；两者许可证为 MIT/Apache-2.0（`unicode-normalization` 另含 Unicode-3.0 数据许可）。
- 不决策的后果：076 不得改 `Cargo.toml`；需要新依赖时会停下向你提问。
- 备注：若 Q2、Q3 分别选 C，则无需批准 `unicode-normalization` 与 `unicase`；`windows-sys` 的 feature 也可改为手写 FFI 声明（项目在 `file_cas.rs` 已有 `NtSetInformationFile` 的先例），此时一个新依赖或 feature 都不需要。Unicode-3.0 数据许可对分发声明的要求、是否在 `THIRD_PARTY_NOTICES.md` 列 Rust crate，见第 6 部分对应编号，请在批准时一并决定。

### Q5 未验证项的处理（对应 D-1-5）

- 问题：第 6 部分的“未验证”子结论如何处理。
- 选项：A 076 对所有“未验证”项只实现保守降级（行为探测或 `Unknown`），并登记为 H-3 实机验收观察项；B 先验证再实现（你指定项，结果写回本记录，走修订流程）；C 个别项按假设直接实现（逐项写编号与理由）。
- 调研推荐：**A**。
- 依据：第 6 部分共 66 项，绝大多数需要真实卷或特殊环境（Samba、ZFS、NFS、macFUSE、ReFS/Dev Drive、f2fs、旧 Windows 版本的 `$UpCase`）；保守降级的最坏后果是漏折叠（多出一个文档，保存时由 CAS 报冲突），不会静默覆盖。
- 不决策的后果：076 无法判定哪些分支要实现。

### Q6 实机卷矩阵范围（对应 D-1-6）

- 问题：是否采纳第 7 部分对 W-20、M-19、L-19 的修订。
- 选项：A 采纳修订建议，H-3 按修订后的矩阵执行；B 缩减为你指定的位置，其余在 H-3 标“不适用”并登记理由；C 推迟。
- 调研推荐：**A**，但承认部分项（Samba 服务端、ZFS、NFS 服务端、macFUSE、f2fs、Dev Drive）依赖特殊环境，执行时可按规格记“阻塞”；若 H-3 时间有限，优先级建议：Windows 的 NTFS 默认目录、`fsutil` 启用目录、`\\wsl$`、SMB；macOS 的默认 APFS、区分大小写 APFS、HFS+；Linux 的 ext4 casefold、vfat 三变体、ntfs3 默认与 `nocase`。
- 依据：这些位置正是草案与调研结论发生分歧的位置（第 4.2 节），也是误判后果最重的位置（误折叠会让仅大小写不同的两个真实文件中的一个打不开）。
- 不决策的后果：H-3 的实机清单无法定稿。

### Q7 ReFS / Dev Drive 的文件身份缺口

- 问题：现有 `platform/file_identity.rs` 的 Windows 分支使用 64 位文件索引，微软文档写明在 ReFS 上不保证唯一；Dev Drive 默认就是 ReFS。文件身份是 PD-10 的安全网，缺口会让身份兜底在 ReFS/Dev Drive 上可能误判。是否并入 076，还是另立目标？
- 选项：A 并入 076（改用 `GetFileInformationByHandleEx(FileIdInfo)` 的 128 位 `FILE_ID_INFO`，不需要新增 feature，需改既有 `file_identity.rs` 及其测试，属范围扩大）；B 另立候选目标（登记到 STATUS 候选清单），076 不动；C 暂不处理，仅在 076 的已知限制里记录。
- 调研推荐：**B**。
- 依据：微软文档已验证；缺口影响所有使用 `FileIdentity` 的路径（CAS、`ProjectRootIdentity` 等），不止 PD-10；碰撞概率与实际影响需要 ReFS/Dev Drive 实机（未验证）。
- 不决策的后果：建议 076 按 C 处理（在已知限制里记录），并在 076 的偏差表里登记这一默认。

### Q8 Linux 内核 ≥ 7.2 新接口的使用方式

- 问题：Linux 7.2 新增的 `FS_CASEFOLD_FL`/`FS_XFLAG_CASEFOLD` 统一报告接口如何使用。
- 选项：A 位已置位可信为 `Insensitive`，位未置位只对 ext4/f2fs/tmpfs 解释为 `Sensitive`，其余类型按第 5.4 节规则（不依赖 7.2）；B 完全不用 7.2 新接口，只用 ext4/f2fs/tmpfs 的目录位加挂载选项加行为探测；C 在检测到内核 ≥7.2 时对所有类型都信任该位（“未置位=区分大小写”）。
- 调研推荐：**A**。
- 依据：旧内核没有该接口；个别实现会“成功返回 0 但不含大小写信息”，产生假的 `Sensitive`；NFS 的“服务端说否”与“服务端未答复”不可区分；该接口来自 2026-06 合并的补丁系列，覆盖面与发行版内核版本分布未估计（第 6 部分）。
- 不决策的后果：建议 076 按 A 处理，并在 076 的偏差表里登记这一默认。

### Q9 授权 076 实现（对应 D-1 第 5 节的最终勾选）

- 问题：在你完成 D-1 第 3 节全部决策项、第 4 节至少 5 项抽查之后，是否授权目标 076 按你的选择实现。
- 选项：A 通过（授权 076 按 D-1 的选择实现）；B 要求修订（在 D-1 第 5 节写明修订要求，由新会话只修改本记录与主报告 4.7.2.12 的回写小节，提交标题前缀 `docs(m6-075):`，修订完成后重新确认）。
- 调研推荐：Q1 至 Q8 都已表态、抽查未发现与来源不一致之后选 **A**；若对第 6 部分的未验证项数量或第 5.6 节的折叠取舍不放心，选 B。
- 依据：本记录没有整行未验证的位置类型；所有未验证子结论都有保守降级；与草案的差异已逐条列出；076 只认 D-1 的填写结果与 `STATUS.md` 中 D-1 的状态。
- 不决策的后果：076 不得开始，PD-10 保持“设计已评审、实现待调研确认”的状态。

## 9. 来源索引

按对象分组列出本记录引用的全部 URL（访问日期 2026-10-18 至 2026-10-19；每条来源的逐条日期、证据类型、关键句见第 3 部分各对象小节的来源表）。

**Microsoft、Windows 与 Samba**（33 条）

- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/ebc7e6e5-4650-4e54-b17c-cf60f6fbeeaa
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63
- https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_case_sensitive_information
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ne-wdm-_file_information_class
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryinformationfile
- https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity
- https://devblogs.microsoft.com/commandline/per-directory-case-sensitivity-and-wsl/
- https://devblogs.microsoft.com/commandline/improved-per-directory-case-sensitivity-support-in-wsl/
- https://learn.microsoft.com/en-us/windows-server/storage/refs/refs-registry-values
- https://learn.microsoft.com/en-us/windows/dev-drive/
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/b04c3bd0-79dc-4e58-b8ed-74f19fc2ea0a
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-_fsrtl_advanced_fcb_header-fsrtlarenamesequal
- https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-comparestringordinal
- https://learn.microsoft.com/en-us/windows/win32/intl/security-considerations--international-features
- https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification
- https://devblogs.microsoft.com/oldnewthing/20200804-00/?p=104040
- https://archives.miloush.net/michkap/archive/2006/09/24/769540.html
- https://archives.miloush.net/michkap/archive/2005/08/20/454071.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/upcase.c?h=v6.12
- https://raw.githubusercontent.com/tuxera/ntfs-3g/2022.10.3/libntfs-3g/unistr.c
- https://learn.microsoft.com/en-us/windows/wsl/troubleshooting
- https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
- https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ns-wdm-_device_object
- https://github.com/microsoft/WSL/issues/3885
- https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html
- https://raw.githubusercontent.com/samba-team/samba/master/source3/smbd/smb2_trans2.c
- https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw

**Apple、macOS**（37 条）

- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/unistd.h
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/pathconf.2.html
- https://keith.github.io/xcode-man-pages/pathconf.2.html
- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_syscalls.c
- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_vnops.c
- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/kern/kern_descrip.c
- https://www.rfc-editor.org/rfc/rfc1813.txt
- https://raw.githubusercontent.com/emacs-mirror/emacs/master/src/fileio.c
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html
- https://raw.githubusercontent.com/apple-oss-distributions/NFS/NFS-343.100.5/kext/nfs_vfsops.c
- https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html
- https://developer.apple.com/support/downloads/Apple-File-System-Reference.pdf
- https://raw.githubusercontent.com/linux-apfs/linux-apfs-rw/master/unicode.c
- https://developer.apple.com/library/archive/technotes/tn/tn1150.html
- https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html
- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/sys/attr.h
- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_attrlist.c
- https://keith.github.io/xcode-man-pages/getattrlist.2.html
- https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vnops.c
- https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vfsops.c
- https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_vfsutils.c
- https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/hfs_catalog.c
- https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/UCStringCompareData.h
- https://raw.githubusercontent.com/apple-oss-distributions/hfs/hfs-715.120.4/core/UnicodeWrappers.c
- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_utfconv.c
- https://raw.githubusercontent.com/apple-oss-distributions/SMBClient/SMBClient-538.121.1/kernel/smbfs/smbfs_vnops.c
- https://raw.githubusercontent.com/apple-oss-distributions/NFS/NFS-343.100.5/kext/nfs_vnops.c
- https://keith.github.io/xcode-man-pages/mount_nfs.8.html
- https://raw.githubusercontent.com/apple-oss-distributions/msdosfs/msdosfs-788.100.31/msdosfs.kextproj/msdosfs.kmodproj/msdosfs_lookup.c
- https://arxiv.org/pdf/2211.16735
- https://keith.github.io/xcode-man-pages/diskutil.8.html
- https://keith.github.io/xcode-man-pages/synthetic.conf.5.html
- https://raw.githubusercontent.com/macfuse/library/master/include/fuse_common.h
- https://developer.apple.com/tutorials/data/documentation/fskit/fsvolume/caseformat.json
- https://raw.githubusercontent.com/apple-oss-distributions/xnu/xnu-12377.121.6/bsd/vfs/vfs_fsevents.c
- https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/Introduction/Introduction.html
- https://keith.github.io/xcode-man-pages/hdiutil.1.html

**Linux 内核与文件系统**（56 条）

- https://docs.kernel.org/admin-guide/ext4.html
- https://man7.org/linux/man-pages/man1/chattr.1.html
- https://man7.org/linux/man-pages/man8/mke2fs.8.html
- https://man7.org/linux/man-pages/man2/ioctl_iflags.2.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/uapi/linux/fs.h?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/uapi/linux/magic.h?id=v7.2
- https://man7.org/linux/man-pages/man2/statfs.2.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/file_attr.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ioctl.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ext4/ioctl.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ext4/ext4.h?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/unicode.h?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/unicode/mkutf8data.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/unicode/README.utf8data?id=v7.2
- https://www.unicode.org/Public/12.1.0/ucd/CaseFolding.txt
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/unicode/tests/utf8_kunit.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fat/namei_vfat.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fat/dir.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/nls.h?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/nls/nls_utf8.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/nls/nls_iso8859-1.c?id=v7.2
- https://docs.kernel.org/filesystems/vfat.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=c92db2ca726fe61a66580d30ecff8c192a791935
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/exfat/namei.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/exfat/nls.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=27e0b573dd4aa927670fbfd84732e569fde72078
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/super.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs3/index.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=eeb7b37b9700f0dbb3e6fe7b9e910b466ac190dd
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/log/fs/ntfs3/namei.c?id=v6.6
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/ntfs/super.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/Documentation/filesystems/ntfs.rst?id=v6.8
- https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/libntfs-3g/dir.c
- https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/libntfs-3g/volume.c
- https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/src/ntfs-3g.8.in
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/smb/client/cifsfs.c?id=v7.2
- https://man7.org/linux/man-pages/man8/mount.cifs.8.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=e50bc12f5a3653c0ab1bbb80b427efd96eb6208d
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=92d67628a1a91c0585e004ffce8975c7898f9ed1
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/patch/?id=3035e4454142327ec5faee2ff57ab7cb1e9fc712
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/log/?id=v7.2&qt=grep&q=case+sensitiv
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=v7.2
- https://docs.kernel.org/filesystems/tmpfs.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/mm/shmem.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/f2fs/file.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fuse/inode.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/btrfs/inode.c?id=v7.2
- https://raw.githubusercontent.com/openzfs/zfs/master/man/man7/zfsprops.7
- https://raw.githubusercontent.com/openzfs/zfs/master/include/sys/fs/zfs.h
- https://raw.githubusercontent.com/openzfs/zfs/master/module/os/linux/zfs/zpl_inode.c
- https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/fat/inode.c?id=v7.2
- https://man7.org/linux/man-pages/man2/statmount.2.html
- https://man7.org/linux/man-pages/man7/inotify.7.html
- https://docs.syncthing.net/advanced/folder-caseSensitiveFS.html
- https://github.com/syncthing/syncthing/wiki/Filesystem-Case-Sensitivity

**Git、VS Code、Watchman、Jujutsu、Mercurial**（51 条）

- https://raw.githubusercontent.com/git/git/v2.56.0/setup.c
- https://raw.githubusercontent.com/git/git/v2.56.0/environment.c
- https://raw.githubusercontent.com/git/git/v2.56.0/t/t0050-filesystem.sh
- https://raw.githubusercontent.com/git/git/v2.56.0/Documentation/config/core.adoc
- https://git-scm.com/docs/git-config
- https://raw.githubusercontent.com/git/git/v2.56.0/compat/precompose_utf8.c
- https://raw.githubusercontent.com/git/git/v2.56.0/git-compat-util.h
- https://raw.githubusercontent.com/git/git/v2.56.0/config.mak.uname
- https://github.com/git/git/commit/76759c7dff53e8c84e975b88cb8245587c14c7ba.patch
- https://raw.githubusercontent.com/git/git/v2.56.0/dir.c
- https://raw.githubusercontent.com/git/git/v2.56.0/hashmap.c
- https://raw.githubusercontent.com/git/git/v2.56.0/entry.c
- https://raw.githubusercontent.com/git/git/v2.56.0/t/test-lib.sh
- https://blog.nerdbank.net/2026/04/16/case-sensitive-git-worktrees-on-windows/
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/common/files.ts
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vscode-dts/vscode.d.ts
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/node/diskFileSystemProvider.ts
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/uriIdentity/common/uriIdentityService.ts
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/common/resources.ts
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/node/watcher/nodejs/nodejsWatcherLib.ts
- https://github.com/microsoft/vscode/issues/94307
- https://github.com/microsoft/vscode/issues/101267
- https://github.com/microsoft/vscode/issues/90983
- https://github.com/microsoft/vscode/issues/177925
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/base/node/pfs.ts
- https://github.com/microsoft/vscode/issues/106879
- https://github.com/microsoft/vscode/issues/139709
- https://raw.githubusercontent.com/microsoft/vscode/1.142.0/src/vs/platform/files/common/fileService.ts
- https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FSDetect.cpp
- https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/root/init.cpp
- https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/website/docs/casefolding.md
- https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FileSystem.cpp
- https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/root/iothread.cpp
- https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/watchman/fs/FileDescriptor.h
- https://raw.githubusercontent.com/facebook/watchman/v2026.10.12.00/website/docs/cookies.md
- https://github.com/jj-vcs/jj/archive/refs/tags/v0.46.0.tar.gz
- https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/core/src/file_util.rs
- https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/lib/src/local_working_copy.rs
- https://raw.githubusercontent.com/jj-vcs/jj/v0.46.0/CHANGELOG.md
- https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/util.py
- https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/debugcommands.py
- https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/dirstate.py
- https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/merge.py
- https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/posix.py
- https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/windows.py
- https://docs.python.org/3/library/stdtypes.html
- https://www.mercurial-scm.org/wiki/CaseFolding
- https://foss.heptapod.net/mercurial/mercurial-devel/-/raw/7.2.4/mercurial/pathutil.py
- https://raw.githubusercontent.com/libfuse/libfuse/master/include/fuse.h
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/smb/client/inode.c?id=v7.2
- https://raw.githubusercontent.com/tuxera/ntfs-3g/edge/src/ntfs-3g.c

**Rust crate 与 Unicode 数据**（40 条）

- https://crates.io/api/v1/crates/same-file
- https://raw.githubusercontent.com/BurntSushi/same-file/HEAD/COPYING
- https://api.github.com/repos/BurntSushi/same-file
- https://static.crates.io/crates/same-file/same-file-1.0.6.crate
- https://raw.githubusercontent.com/BurntSushi/same-file/HEAD/LICENSE-MIT
- https://crates.io/api/v1/crates/unicode-normalization
- https://raw.githubusercontent.com/unicode-rs/unicode-normalization/HEAD/Cargo.toml
- https://raw.githubusercontent.com/unicode-rs/unicode-normalization/HEAD/LICENSE-UNICODE
- https://api.github.com/repos/unicode-rs/unicode-normalization
- https://docs.rs/unicode-normalization/0.1.26/
- https://static.crates.io/crates/unicode-normalization/unicode-normalization-0.1.26.crate
- https://static.crates.io/crates/unicode-normalization/unicode-normalization-0.1.25.crate
- https://crates.io/api/v1/crates/caseless
- https://raw.githubusercontent.com/unicode-rs/rust-caseless/HEAD/LICENSE
- https://static.crates.io/crates/caseless/caseless-0.2.2.crate
- https://api.github.com/repos/unicode-rs/rust-caseless
- https://www.unicode.org/terms_of_use.html
- https://crates.io/api/v1/crates/unicase
- https://raw.githubusercontent.com/seanmonstar/unicase/HEAD/LICENSE-MIT
- https://api.github.com/repos/seanmonstar/unicase
- https://raw.githubusercontent.com/seanmonstar/unicase/master/scripts/mapgen.py
- https://static.crates.io/crates/unicase/unicase-2.10.0.crate
- https://crates.io/api/v1/crates/rustix
- https://raw.githubusercontent.com/bytecodealliance/rustix/HEAD/LICENSE-MIT
- https://api.github.com/repos/bytecodealliance/rustix
- https://static.crates.io/crates/rustix/rustix-1.1.5.crate
- https://crates.io/api/v1/crates/windows-sys
- https://raw.githubusercontent.com/microsoft/windows-rs/HEAD/license-mit
- https://api.github.com/repos/microsoft/windows-rs
- https://static.crates.io/crates/windows-sys/windows-sys-0.59.0.crate
- https://crates.io/api/v1/crates/cap-primitives
- https://raw.githubusercontent.com/bytecodealliance/cap-std/HEAD/LICENSE-MIT
- https://github.com/bytecodealliance/cap-std
- https://api.github.com/repos/bytecodealliance/cap-std
- https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/core/src/char/methods.rs
- https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/alloc/src/str.rs
- https://raw.githubusercontent.com/rust-lang/rust/1.95.0/library/core/src/unicode/unicode_data.rs
- https://crates.io/api/v1/crates?q=
- https://crates.io/api/v1/crates?q=case+sensitive+filesystem
- https://static.crates.io/crates/whichdisk/whichdisk-0.7.0.crate

**本记录第 2、4、5 部分另引**（8 条）

- https://crates.io/api/v1/crates/unicode-normalization：
- https://keith.github.io/xcode-man-pages/mount_exfat.8.html
- https://raw.githubusercontent.com/apple-oss-distributions/SMBClient/SMBClient-538.121.1/kernel/smbfs/smbfs_vfsops.c
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/nfs/super.c?id=v7.2
- https://man7.org/linux/man-pages/man5/nfs.5.html
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/btrfs/super.c?id=v7.2
- https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/fs/btrfs/ioctl.c?id=v7.2
- https://raw.githubusercontent.com/git/git/v2.56.0/builtin/init-db.c
