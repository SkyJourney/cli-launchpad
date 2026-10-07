use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use cap_std::fs::{Dir, OpenOptions};

/// Returns a stable, platform-specific identifier for a file reached through
/// a retained directory capability. Services use this when they need to
/// compare a previewed file with the file currently at the same relative path.
pub fn file_identity(
    directory: &Dir,
    name: &str,
    _metadata: &cap_std::fs::Metadata,
) -> Result<String> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let _ = (directory, name);
        Ok(format!("unix:{}:{}", _metadata.dev(), _metadata.ino()))
    }

    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };

        let file = directory.open(name)?.into_std();
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let file_index =
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
        Ok(format!(
            "windows:{}:{file_index}",
            information.dwVolumeSerialNumber
        ))
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (directory, name);
        Ok(format!("fallback:{}", _metadata.len()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareAndSwapOutcome {
    Written,
    WrittenWithPermissionWarning,
    Conflict,
}

const MAX_IDENTITY_RETRIES: usize = 8;
/// Budget for re-resolving a stale destination (m6-002). It is separate from
/// `MAX_IDENTITY_RETRIES` because stale resolutions come in bursts when the
/// resolving thread is preempted next to a tight external replacement loop.
const MAX_RESOLUTION_RETRIES: usize = 32;
const RESOLUTION_YIELD_ATTEMPTS: usize = 4;
const RESOLUTION_BACKOFF: Duration = Duration::from_millis(1);
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// OS-specific operations behind the shared revision compare-and-swap flow.
/// Implementations receive a retained directory capability and a relative
/// target, so platform adapters cannot silently fall back to ambient paths.
pub trait FileCasAdapter {
    /// Resolves the requested project-relative path to the relative path that
    /// the shared flow locks. The default delegates to the capability's
    /// canonicalization; tests inject stale results through this seam.
    fn resolve_destination(&self, root: &Dir, relative: &Path) -> Result<PathBuf> {
        Ok(root.canonicalize(relative)?)
    }

    fn lock_current(&self, directory: &Dir, path: &Path) -> Result<File>;
    fn path_matches_locked_file(&self, directory: &Dir, path: &Path, locked: &File)
        -> Result<bool>;
    fn create_private_temporary(&self, directory: &Dir, path: &Path) -> std::io::Result<File>;
    fn commit(
        &self,
        directory: &Dir,
        destination: &Path,
        temporary: &Path,
        temporary_file: &mut Option<File>,
        locked_target: Option<&File>,
        permissions: Option<std::fs::Permissions>,
    ) -> Result<bool>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NativeFileCasAdapter;

impl FileCasAdapter for NativeFileCasAdapter {
    fn lock_current(&self, directory: &Dir, path: &Path) -> Result<File> {
        lock_current(directory, path)
    }

    fn path_matches_locked_file(
        &self,
        directory: &Dir,
        path: &Path,
        locked: &File,
    ) -> Result<bool> {
        same_file(directory, path, locked)
    }

    fn create_private_temporary(&self, directory: &Dir, path: &Path) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(windows)]
        {
            use cap_std::fs::OpenOptionsExt;
            use windows_sys::Win32::{
                Foundation::{GENERIC_READ, GENERIC_WRITE},
                Storage::FileSystem::{
                    DELETE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
                    FILE_WRITE_ATTRIBUTES, READ_CONTROL, WRITE_DAC,
                },
            };
            options
                .access_mode(
                    GENERIC_READ
                        | GENERIC_WRITE
                        | DELETE
                        | READ_CONTROL
                        | WRITE_DAC
                        | FILE_WRITE_ATTRIBUTES,
                )
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
        }
        let file = directory.open_with(path, &options)?.into_std();
        #[cfg(windows)]
        restrict_to_current_user(&file)?;
        Ok(file)
    }

    fn commit(
        &self,
        directory: &Dir,
        destination: &Path,
        temporary: &Path,
        temporary_file: &mut Option<File>,
        locked_target: Option<&File>,
        permissions: Option<std::fs::Permissions>,
    ) -> Result<bool> {
        // The caller keeps this handle alive through commit to retain the CAS lock.
        #[cfg(windows)]
        {
            if let Some(permissions) = permissions {
                temporary_file
                    .as_ref()
                    .context("临时文件句柄已关闭")?
                    .set_permissions(permissions)
                    .context("无法恢复 Windows 文件属性")?;
            }
            if let Some(target) = locked_target {
                if !same_file(directory, destination, target)? {
                    bail!("待保存文件在应用原 ACL 前已被替换");
                }
                preserve_windows_dacl(
                    target,
                    temporary_file.as_ref().context("临时文件句柄已关闭")?,
                )
                .context("无法保留项目文件 ACL")?;
            }
            replace_windows_anchored(
                directory,
                destination,
                temporary_file.as_ref().context("临时文件句柄已关闭")?,
                locked_target,
            )
            .context("无法原子替换项目文件")?;
            temporary_file.take();
            let _ = temporary;
            Ok(false)
        }
        #[cfg(unix)]
        {
            directory
                .rename(temporary, directory, destination)
                .context("无法原子替换项目文件")?;
            let permission_warning = if let Some(permissions) = permissions {
                let restore_result = temporary_file
                    .as_ref()
                    .map(|file| file.set_permissions(permissions))
                    .unwrap_or_else(|| Err(std::io::Error::other("替换文件句柄已关闭")));
                post_commit_permission_warning(destination, restore_result)
            } else {
                false
            };
            temporary_file.take();
            Ok(permission_warning)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (
                directory,
                destination,
                temporary,
                temporary_file,
                locked_target,
                permissions,
            );
            bail!("当前平台尚未实现文件 CAS 适配")
        }
    }
}

#[cfg(unix)]
fn post_commit_permission_warning(destination: &Path, result: std::io::Result<()>) -> bool {
    match result {
        Ok(()) => false,
        Err(error) => {
            log::warn!(
                "file was replaced but original permissions could not be restored path={} error={error}",
                destination.display()
            );
            true
        }
    }
}

/// Performs a revision CAS entirely relative to a retained project directory
/// capability. The temporary is created beside the target and replaced while
/// the target handle remains locked.
pub fn compare_and_swap_in_directory<R, Revision>(
    root: &Dir,
    relative_destination: &Path,
    replacement: &[u8],
    expected_revision: &R,
    max_current_bytes: u64,
    revision_of: Revision,
) -> Result<CompareAndSwapOutcome>
where
    R: PartialEq,
    Revision: Fn(&[u8]) -> R,
{
    compare_and_swap_with_adapter(
        &NativeFileCasAdapter,
        root,
        relative_destination,
        replacement,
        expected_revision,
        max_current_bytes,
        revision_of,
    )
}

fn destination_names_match(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    if cfg!(target_os = "linux") {
        left == right
    } else {
        left == right
            || left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    }
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .root_cause()
        .downcast_ref::<std::io::Error>()
        .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
}

/// Returns whether `resolved` can be trusted as the destination for
/// `requested`. `Ok(false)` means the resolution is stale and must be redone.
pub(crate) fn validate_resolved_destination(
    root: &Dir,
    requested: &Path,
    resolved: &Path,
) -> Result<bool> {
    match root.symlink_metadata(resolved) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("无法检查解析后的目标文件：{}", resolved.display()))
        }
    }
    let (Some(requested_name), Some(resolved_name)) = (requested.file_name(), resolved.file_name())
    else {
        // 没有可比较的最后组件（例如请求以 `..` 结尾）：只做存在性校验，
        // 其余错误由 parent_and_name 按原有文案报告。
        return Ok(true);
    };
    if destination_names_match(requested_name, resolved_name) {
        return Ok(true);
    }
    let metadata = match root.symlink_metadata(requested) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("无法检查请求的目标文件：{}", requested.display()))
        }
    };
    if !metadata.file_type().is_symlink() {
        return Ok(false);
    }
    let target = match root.read_link(requested) {
        Ok(target) => target,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error).with_context(|| format!("无法读取符号链接：{}", requested.display()))
        }
    };
    Ok(target
        .file_name()
        .is_some_and(|name| destination_names_match(name, resolved_name)))
}

pub(crate) fn resolve_cas_destination_with(
    adapter: &impl FileCasAdapter,
    root: &Dir,
    relative: &Path,
) -> Result<PathBuf> {
    for attempt in 0..MAX_RESOLUTION_RETRIES {
        let resolved = adapter
            .resolve_destination(root, relative)
            .context("项目文件不存在或无法访问")?;
        if validate_resolved_destination(root, relative, &resolved)? {
            return Ok(resolved);
        }
        // A stale resolution usually means this thread was preempted between
        // the two steps of the capability's canonicalization while another
        // process replaced the file. Immediate retries tend to be preempted
        // the same way, so give the replacer room before resolving again.
        if attempt < RESOLUTION_YIELD_ATTEMPTS {
            thread::yield_now();
        } else {
            thread::sleep(RESOLUTION_BACKOFF);
        }
    }
    bail!("待保存文件在并发替换期间持续变化，请重试")
}

/// SEAM-12 的无 adapter 入口，只供测试直接调用；生产路径使用
/// `resolve_cas_destination_with`。
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn resolve_cas_destination(root: &Dir, relative: &Path) -> Result<PathBuf> {
    resolve_cas_destination_with(&NativeFileCasAdapter, root, relative)
}

pub fn compare_and_swap_with_adapter<R, Revision>(
    adapter: &impl FileCasAdapter,
    root: &Dir,
    relative_destination: &Path,
    replacement: &[u8],
    expected_revision: &R,
    max_current_bytes: u64,
    revision_of: Revision,
) -> Result<CompareAndSwapOutcome>
where
    R: PartialEq,
    Revision: Fn(&[u8]) -> R,
{
    let mut canonical = resolve_cas_destination_with(adapter, root, relative_destination)?;
    let (parent, mut destination) = parent_and_name(root, &canonical)?;
    let mut temporary = create_temporary(adapter, &parent, replacement)?;
    temporary.finish_writing()?;

    for _ in 0..MAX_IDENTITY_RETRIES {
        let locked = match adapter.lock_current(&parent, &destination) {
            Ok(locked) => locked,
            Err(error) if !cfg!(windows) && is_not_found(&error) => {
                let fresh = resolve_cas_destination_with(adapter, root, relative_destination)?;
                if fresh.parent() != canonical.parent() {
                    bail!("待保存文件所在目录在保存期间发生变化，请重试");
                }
                destination = PathBuf::from(fresh.file_name().context("文件路径不能为空")?);
                canonical = fresh;
                continue;
            }
            Err(error) => return Err(error),
        };
        if !adapter.path_matches_locked_file(&parent, &destination, &locked)? {
            drop(locked);
            continue;
        }

        let current = read_bounded(&locked, max_current_bytes)?;
        if revision_of(&current) != *expected_revision {
            return Ok(CompareAndSwapOutcome::Conflict);
        }
        // A non-cooperating editor can replace the pathname after the first
        // identity check while this handle remains locked. Recheck immediately
        // before commit so that such a replacement is retried against its new
        // revision instead of being overwritten with stale content.
        if !adapter.path_matches_locked_file(&parent, &destination, &locked)? {
            drop(locked);
            continue;
        }
        let permissions = locked.metadata()?.permissions();
        let permission_warning =
            temporary.commit(adapter, &destination, Some(&locked), Some(permissions))?;
        return Ok(if permission_warning {
            CompareAndSwapOutcome::WrittenWithPermissionWarning
        } else {
            CompareAndSwapOutcome::Written
        });
    }

    bail!("待保存文件在并发替换期间持续变化，请重试")
}

pub fn replace_file(destination: &Path, bytes: &[u8]) -> Result<()> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = destination.file_name().context("目标文件名无效")?;
    let directory = Dir::open_ambient_dir(parent, cap_std::ambient_authority())
        .context("无法打开目标文件所在目录")?;
    #[cfg(windows)]
    let target = match open_target_for_replacement_metadata(&directory, Path::new(name)) {
        Ok(target) => Some(target),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("无法读取目标文件安全属性"),
    };
    #[cfg(not(windows))]
    let target: Option<File> = None;
    let permissions = target
        .as_ref()
        .map(File::metadata)
        .transpose()?
        .map(|metadata| metadata.permissions());
    let mut temporary = create_temporary(&NativeFileCasAdapter, &directory, bytes)?;
    temporary.finish_writing()?;
    let permission_warning = temporary.commit(
        &NativeFileCasAdapter,
        Path::new(name),
        target.as_ref(),
        permissions,
    )?;
    if permission_warning {
        log::warn!("file was replaced but target permissions could not be restored");
    }
    Ok(())
}

fn parent_and_name(root: &Dir, destination: &Path) -> Result<(Dir, PathBuf)> {
    let mut components = destination.components();
    let mut parts = Vec::new();
    for component in &mut components {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_owned()),
            _ => bail!("文件路径必须是规范的项目内相对路径"),
        }
    }
    let name = parts.pop().context("文件路径不能为空")?;
    let parent = if parts.is_empty() {
        root.try_clone()?
    } else {
        root.open_dir(parts.iter().collect::<PathBuf>())?
    };
    Ok((parent, PathBuf::from(name)))
}

fn lock_current(directory: &Dir, path: &Path) -> Result<File> {
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let file = loop {
        match open_target(directory, path) {
            Ok(file) => break file.into_std(),
            Err(error)
                if cfg!(windows)
                    && error.kind() == std::io::ErrorKind::NotFound
                    && Instant::now() < deadline =>
            {
                // Windows only: a concurrent atomic replacement can briefly make the
                // destination unavailable while its pathname is swapped. Unix rename
                // never hides the name, so NotFound there means the resolution is
                // stale and the shared flow re-resolves.
                thread::sleep(LOCK_RETRY_INTERVAL);
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("无法打开待保存文件：{}", path.display()))
            }
        }
    };
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    bail!("待保存文件正被其他程序占用，请稍后重试");
                }
                thread::sleep(LOCK_RETRY_INTERVAL);
            }
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(error).context("无法锁定待保存文件");
            }
        }
    }
}

fn same_file(directory: &Dir, path: &Path, locked: &File) -> Result<bool> {
    let current = open_target(directory, path)?.into_std();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let locked = locked.metadata()?;
        let current = current.metadata()?;
        Ok(locked.dev() == current.dev() && locked.ino() == current.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        fn identity(file: &File) -> Result<(u32, u64)> {
            let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) }
                == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok((
                information.dwVolumeSerialNumber,
                (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow),
            ))
        }
        Ok(identity(locked)? == identity(&current)?)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = current;
        bail!("当前平台尚未实现文件身份比较适配")
    }
}

fn open_target(directory: &Dir, path: &Path) -> std::io::Result<cap_std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    directory.open_with(path, &options)
}

#[cfg(windows)]
fn open_target_for_replacement_metadata(directory: &Dir, path: &Path) -> std::io::Result<File> {
    use cap_std::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL,
    };

    let mut options = OpenOptions::new();
    options
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    directory
        .open_with(path, &options)
        .map(cap_std::fs::File::into_std)
}

fn read_bounded(file: &File, maximum_bytes: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(maximum_bytes.min(64 * 1024) as usize);
    file.try_clone()?
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum_bytes {
        bail!("文件读取大小超过允许上限");
    }
    Ok(bytes)
}

struct TemporaryReplacement {
    name: PathBuf,
    directory: Dir,
    file: Option<File>,
    committed: bool,
}

impl Drop for TemporaryReplacement {
    fn drop(&mut self) {
        if !self.committed {
            self.file.take();
            let _ = self.directory.remove_file(&self.name);
        }
    }
}

impl TemporaryReplacement {
    fn finish_writing(&mut self) -> Result<()> {
        let file = self.file.as_mut().context("临时文件句柄已关闭")?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    }

    fn commit(
        mut self,
        adapter: &impl FileCasAdapter,
        destination: &Path,
        locked_target: Option<&File>,
        permissions: Option<std::fs::Permissions>,
    ) -> Result<bool> {
        let warning = adapter.commit(
            &self.directory,
            destination,
            &self.name,
            &mut self.file,
            locked_target,
            permissions,
        )?;
        self.committed = true;
        Ok(warning)
    }
}

fn create_temporary(
    adapter: &impl FileCasAdapter,
    directory: &Dir,
    bytes: &[u8],
) -> Result<TemporaryReplacement> {
    for _ in 0..8 {
        let name = PathBuf::from(format!(".{}.writing", uuid::Uuid::new_v4().simple()));
        match adapter.create_private_temporary(directory, &name) {
            Ok(file) => {
                let mut temporary = TemporaryReplacement {
                    name,
                    directory: directory.try_clone()?,
                    file: Some(file),
                    committed: false,
                };
                if let Err(error) = temporary
                    .file
                    .as_mut()
                    .context("临时文件句柄已关闭")?
                    .write_all(bytes)
                {
                    return Err(error.into());
                }
                return Ok(temporary);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).context("无法创建项目内临时文件"),
        }
    }
    bail!("无法创建唯一的临时文件")
}

#[cfg(windows)]
struct WindowsRenameDirectory {
    handle: File,
    path: Vec<u16>,
    is_remote: bool,
}

#[cfg(windows)]
fn open_windows_rename_directory(directory: &Dir) -> std::io::Result<WindowsRenameDirectory> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetDriveTypeW, GetFinalPathNameByHandleW, FILE_ADD_FILE, FILE_DELETE_CHILD,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_NAME_NORMALIZED,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
        OPEN_EXISTING, SYNCHRONIZE, VOLUME_NAME_DOS,
    };

    let original = directory.try_clone()?.into_std_file();
    let mut path = vec![0u16; 32768];
    let path_length = unsafe {
        GetFinalPathNameByHandleW(
            original.as_raw_handle() as _,
            path.as_mut_ptr(),
            path.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if path_length == 0 || path_length as usize >= path.len() {
        return Err(std::io::Error::last_os_error());
    }
    path.truncate(path_length as usize);
    path.push(0);
    let is_unc = windows_path_is_unc(&path);
    const DRIVE_REMOTE_TYPE: u32 = 4;
    let is_mapped_remote_drive = windows_drive_root(&path)
        .is_some_and(|root| unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE_TYPE });
    let is_remote = is_unc || is_mapped_remote_drive;
    let directory_access = if is_remote {
        FILE_READ_ATTRIBUTES
    } else {
        FILE_ADD_FILE
            | FILE_DELETE_CHILD
            | FILE_LIST_DIRECTORY
            | FILE_READ_ATTRIBUTES
            | FILE_TRAVERSE
            | SYNCHRONIZE
    };
    let reopened = unsafe {
        CreateFileW(
            path.as_ptr(),
            directory_access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if reopened == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let reopened = unsafe { File::from_raw_handle(reopened as _) };

    fn identity(file: &File) -> std::io::Result<(u32, u64)> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((
            information.dwVolumeSerialNumber,
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        ))
    }

    if identity(&original)? != identity(&reopened)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "重新打开的目标目录与保留的目录能力不一致",
        ));
    }
    Ok(WindowsRenameDirectory {
        handle: reopened,
        path,
        is_remote,
    })
}

#[cfg(windows)]
fn windows_path_is_unc(path: &[u16]) -> bool {
    path.starts_with(&"\\\\?\\UNC\\".encode_utf16().collect::<Vec<_>>())
}

#[cfg(windows)]
fn windows_drive_root(path: &[u16]) -> Option<[u16; 4]> {
    let prefix = "\\\\?\\".encode_utf16().collect::<Vec<_>>();
    if path.len() >= 7
        && path.starts_with(&prefix)
        && path[5] == ':' as u16
        && path[6] == '\\' as u16
    {
        Some([path[4], ':' as u16, '\\' as u16, 0])
    } else {
        None
    }
}

#[cfg(windows)]
fn windows_remote_destination(path: &[u16], file_name: &[u16]) -> Vec<u16> {
    let mut destination = path.to_vec();
    if destination.last() == Some(&0) {
        destination.pop();
    }
    if destination.last() != Some(&('\\' as u16)) {
        destination.push('\\' as u16);
    }
    destination.extend_from_slice(file_name);
    destination
}

#[cfg(windows)]
fn replace_windows_anchored(
    directory: &Dir,
    destination: &Path,
    temporary: &File,
    locked_target: Option<&File>,
) -> std::io::Result<()> {
    use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
    use windows_sys::Win32::{
        Storage::FileSystem::{
            FileRenameInfoEx, SetFileInformationByHandle, FILE_RENAME_INFO, FILE_RENAME_INFO_0,
        },
        System::IO::IO_STATUS_BLOCK,
    };
    const FILE_RENAME_INFORMATION_EX_CLASS: i32 = 65;
    const FILE_RENAME_REPLACE_IF_EXISTS: u32 = 0x0000_0001;
    const FILE_RENAME_POSIX_SEMANTICS: u32 = 0x0000_0002;
    const FILE_RENAME_IGNORE_READONLY_ATTRIBUTE: u32 = 0x0000_0040;
    #[link(name = "ntdll")]
    extern "system" {
        #[link_name = "NtSetInformationFile"]
        fn nt_set_information_file(
            file_handle: windows_sys::Win32::Foundation::HANDLE,
            io_status_block: *mut IO_STATUS_BLOCK,
            file_information: *mut std::ffi::c_void,
            length: u32,
            file_information_class: i32,
        ) -> i32;
        #[link_name = "RtlNtStatusToDosError"]
        fn rtl_nt_status_to_dos_error(status: i32) -> u32;
    }

    if let Some(target) = locked_target {
        if !same_file(directory, destination, target)
            .map_err(|error| std::io::Error::other(error.to_string()))?
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "待保存文件在原子替换前已被替换",
            ));
        }
    }

    let mut components = destination.components();
    let Some(std::path::Component::Normal(name)) = components.next() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "目标文件名必须是单个相对路径分量",
        ));
    };
    if components.next().is_some() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "目标文件名必须是单个相对路径分量",
        ));
    }
    let file_name = name.encode_wide().collect::<Vec<_>>();
    let directory_handle = open_windows_rename_directory(directory)?;
    let rename_name = if directory_handle.is_remote {
        windows_remote_destination(&directory_handle.path, &file_name)
    } else {
        file_name
    };
    let file_name_bytes = rename_name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标文件名过长"))?;
    let file_name_length = u32::try_from(file_name_bytes)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标文件名过长"))?;
    let file_name_offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let buffer_length = std::mem::size_of::<FILE_RENAME_INFO>()
        .checked_add(file_name_bytes)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标文件名过长"))?;
    let buffer_length_u32 = u32::try_from(buffer_length)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标文件名过长"))?;
    let mut storage = vec![0u64; buffer_length.div_ceil(std::mem::size_of::<u64>())];
    let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let rename_flags = FILE_RENAME_REPLACE_IF_EXISTS
        | FILE_RENAME_POSIX_SEMANTICS
        | FILE_RENAME_IGNORE_READONLY_ATTRIBUTE;
    unsafe {
        information.write(FILE_RENAME_INFO {
            Anonymous: FILE_RENAME_INFO_0 {
                Flags: rename_flags,
            },
            RootDirectory: if directory_handle.is_remote {
                std::ptr::null_mut()
            } else {
                directory_handle.handle.as_raw_handle() as _
            },
            FileNameLength: file_name_length,
            FileName: [0],
        });
        std::ptr::copy_nonoverlapping(
            rename_name.as_ptr(),
            (information.cast::<u8>().add(file_name_offset)).cast::<u16>(),
            rename_name.len(),
        );
    }
    let mut io_status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // Local filesystems use a relative RootDirectory handle to retain
    // directory-capability semantics. Network redirectors require a null root,
    // so that branch supplies the verified canonical absolute destination path.
    // POSIX replacement also permits the locked destination handle to remain open.
    let status = if directory_handle.is_remote {
        if unsafe {
            SetFileInformationByHandle(
                temporary.as_raw_handle() as _,
                FileRenameInfoEx,
                information.cast(),
                buffer_length_u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        0
    } else {
        unsafe {
            nt_set_information_file(
                temporary.as_raw_handle() as _,
                &mut io_status,
                information.cast(),
                buffer_length_u32,
                FILE_RENAME_INFORMATION_EX_CLASS,
            )
        }
    };
    if status < 0 {
        let error = unsafe { rtl_nt_status_to_dos_error(status) };
        return Err(std::io::Error::new(
            std::io::Error::from_raw_os_error(error as i32).kind(),
            format!("相对文件重命名失败（NTSTATUS 0x{:08X}）", status as u32),
        ));
    }
    let completion_status = if directory_handle.is_remote {
        0
    } else {
        unsafe { io_status.Anonymous.Status }
    };
    if completion_status < 0 {
        let error = unsafe { rtl_nt_status_to_dos_error(completion_status) };
        return Err(std::io::Error::new(
            std::io::Error::from_raw_os_error(error as i32).kind(),
            format!(
                "相对文件重命名完成失败（NTSTATUS 0x{:08X}）",
                completion_status as u32
            ),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn restrict_to_current_user(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, HANDLE},
        Security::Authorization::{SetSecurityInfo, SE_FILE_OBJECT},
        Security::{
            AddAccessAllowedAce, GetTokenInformation, InitializeAcl, ACL, ACL_REVISION,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    const TOKEN_USER_CLASS: i32 = 1;
    const INSUFFICIENT_BUFFER: u32 = 122;
    const FILE_ALL_ACCESS: u32 = 0x001f_01ff;
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    let _token = Token(token);
    let mut length = 0u32;
    unsafe {
        GetTokenInformation(
            token,
            TOKEN_USER_CLASS,
            std::ptr::null_mut(),
            0,
            &mut length,
        )
    };
    if unsafe { GetLastError() } != INSUFFICIENT_BUFFER || length == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut token_user_storage = vec![0u64; length.div_ceil(8) as usize];
    if unsafe {
        GetTokenInformation(
            token,
            TOKEN_USER_CLASS,
            token_user_storage.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let token_user = unsafe { &*token_user_storage.as_ptr().cast::<TOKEN_USER>() };
    let sid_length =
        unsafe { windows_sys::Win32::Security::GetLengthSid(token_user.User.Sid) } as usize;
    if sid_length == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let acl_bytes = std::mem::size_of::<ACL>() + 8 + sid_length;
    let mut acl_storage = vec![0u64; acl_bytes.div_ceil(8)];
    let acl = acl_storage.as_mut_ptr().cast::<ACL>();
    if unsafe { InitializeAcl(acl, acl_bytes as u32, ACL_REVISION) } == 0
        || unsafe { AddAccessAllowedAce(acl, ACL_REVISION, FILE_ALL_ACCESS, token_user.User.Sid) }
            == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle() as _,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

#[cfg(windows)]
fn preserve_windows_dacl(target: &File, replacement: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Authorization::{GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT},
        Security::{
            AddAce, GetAce, GetSecurityDescriptorControl, InitializeAcl, ACE_HEADER, ACL,
            DACL_SECURITY_INFORMATION, INHERITED_ACE, PROTECTED_DACL_SECURITY_INFORMATION,
            SE_DACL_PROTECTED, UNPROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    let mut dacl = std::ptr::null_mut::<ACL>();
    let mut descriptor = std::ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            target.as_raw_handle() as _,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }

    let result = (|| {
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let dacl_is_protected = control & SE_DACL_PROTECTED != 0;
        let (dacl_to_apply, security_information, _filtered_acl) = if dacl_is_protected {
            (
                dacl as *const ACL,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
            )
        } else if dacl.is_null() {
            (
                std::ptr::null(),
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                None,
            )
        } else {
            let source_acl = unsafe { &*dacl };
            let acl_size = source_acl.AclSize as usize;
            let mut storage = vec![0u64; acl_size.div_ceil(std::mem::size_of::<u64>())];
            let filtered_acl = storage.as_mut_ptr().cast::<ACL>();
            if unsafe {
                InitializeAcl(filtered_acl, acl_size as u32, source_acl.AclRevision as u32)
            } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            for ace_index in 0..source_acl.AceCount as u32 {
                let mut ace = std::ptr::null_mut();
                if unsafe { GetAce(dacl, ace_index, &mut ace) } == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let header = unsafe { &*ace.cast::<ACE_HEADER>() };
                if header.AceFlags & INHERITED_ACE as u8 == 0
                    && unsafe {
                        AddAce(
                            filtered_acl,
                            source_acl.AclRevision as u32,
                            u32::MAX,
                            ace,
                            header.AceSize as u32,
                        )
                    } == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            (
                filtered_acl as *const ACL,
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                Some(storage),
            )
        };
        let status = unsafe {
            SetSecurityInfo(
                replacement.as_raw_handle() as _,
                SE_FILE_OBJECT,
                security_information,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl_to_apply,
                std::ptr::null_mut(),
            )
        };
        drop(_filtered_acl);
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    })();
    unsafe { LocalFree(descriptor) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::process::{Child, Command, Output, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

    #[cfg(unix)]
    #[test]
    fn permission_restore_failure_after_rename_is_a_warning_not_a_save_error() {
        let directory = tempdir().unwrap();
        let temporary = directory.path().join(".temporary.writing");
        let destination = directory.path().join("saved.txt");
        std::fs::write(&temporary, "saved content").unwrap();
        std::fs::rename(&temporary, &destination).unwrap();

        let warning = post_commit_permission_warning(
            &destination,
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "simulated chmod failure",
            )),
        );

        assert!(warning);
        assert_eq!(
            std::fs::read_to_string(destination).unwrap(),
            "saved content"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_network_rename_paths_are_classified_and_built_without_root_handle() {
        let unc_path = "\\\\?\\UNC\\server\\share\\project"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        assert!(windows_path_is_unc(&unc_path));
        assert_eq!(windows_drive_root(&unc_path), None);

        let mapped_path = "\\\\?\\Z:\\project"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        assert!(!windows_path_is_unc(&mapped_path));
        assert_eq!(
            windows_drive_root(&mapped_path),
            Some(['Z' as u16, ':' as u16, '\\' as u16, 0])
        );

        let destination = windows_remote_destination(
            &unc_path,
            &"layout.json".encode_utf16().collect::<Vec<_>>(),
        );
        assert_eq!(
            String::from_utf16(&destination).unwrap(),
            "\\\\?\\UNC\\server\\share\\project\\layout.json"
        );
    }

    #[derive(Default)]
    struct CountingAdapter {
        native: NativeFileCasAdapter,
        locks: AtomicUsize,
        identities: AtomicUsize,
        temporaries: AtomicUsize,
        commits: AtomicUsize,
    }

    struct ReplaceOnFirstIdentityAdapter {
        native: NativeFileCasAdapter,
        root: PathBuf,
        identities: AtomicUsize,
    }

    impl FileCasAdapter for ReplaceOnFirstIdentityAdapter {
        fn lock_current(&self, directory: &Dir, path: &Path) -> Result<File> {
            self.native.lock_current(directory, path)
        }

        fn path_matches_locked_file(
            &self,
            directory: &Dir,
            path: &Path,
            locked: &File,
        ) -> Result<bool> {
            let matches = self
                .native
                .path_matches_locked_file(directory, path, locked)?;
            if self.identities.fetch_add(1, Ordering::Relaxed) == 0 {
                let destination = self.root.join(path);
                let replacement = self.root.join("replacement.txt");
                std::fs::remove_file(&destination)?;
                std::fs::rename(replacement, destination)?;
            }
            Ok(matches)
        }

        fn create_private_temporary(&self, directory: &Dir, path: &Path) -> std::io::Result<File> {
            self.native.create_private_temporary(directory, path)
        }

        fn commit(
            &self,
            directory: &Dir,
            destination: &Path,
            temporary: &Path,
            temporary_file: &mut Option<File>,
            locked_target: Option<&File>,
            permissions: Option<std::fs::Permissions>,
        ) -> Result<bool> {
            self.native.commit(
                directory,
                destination,
                temporary,
                temporary_file,
                locked_target,
                permissions,
            )
        }
    }

    impl FileCasAdapter for CountingAdapter {
        fn lock_current(&self, directory: &Dir, path: &Path) -> Result<File> {
            self.locks.fetch_add(1, Ordering::Relaxed);
            self.native.lock_current(directory, path)
        }

        fn path_matches_locked_file(
            &self,
            directory: &Dir,
            path: &Path,
            locked: &File,
        ) -> Result<bool> {
            self.identities.fetch_add(1, Ordering::Relaxed);
            self.native
                .path_matches_locked_file(directory, path, locked)
        }

        fn create_private_temporary(&self, directory: &Dir, path: &Path) -> std::io::Result<File> {
            self.temporaries.fetch_add(1, Ordering::Relaxed);
            self.native.create_private_temporary(directory, path)
        }

        fn commit(
            &self,
            directory: &Dir,
            destination: &Path,
            temporary: &Path,
            temporary_file: &mut Option<File>,
            locked_target: Option<&File>,
            permissions: Option<std::fs::Permissions>,
        ) -> Result<bool> {
            self.commits.fetch_add(1, Ordering::Relaxed);
            self.native.commit(
                directory,
                destination,
                temporary,
                temporary_file,
                locked_target,
                permissions,
            )
        }
    }

    struct DeletedAliasOnceAdapter {
        native: NativeFileCasAdapter,
        resolutions: AtomicUsize,
    }

    impl FileCasAdapter for DeletedAliasOnceAdapter {
        fn resolve_destination(&self, root: &Dir, relative: &Path) -> Result<PathBuf> {
            if self.resolutions.fetch_add(1, Ordering::Relaxed) == 0 {
                return Ok(PathBuf::from("note.txt (deleted)"));
            }
            self.native.resolve_destination(root, relative)
        }

        fn lock_current(&self, directory: &Dir, path: &Path) -> Result<File> {
            self.native.lock_current(directory, path)
        }

        fn path_matches_locked_file(
            &self,
            directory: &Dir,
            path: &Path,
            locked: &File,
        ) -> Result<bool> {
            self.native
                .path_matches_locked_file(directory, path, locked)
        }

        fn create_private_temporary(&self, directory: &Dir, path: &Path) -> std::io::Result<File> {
            self.native.create_private_temporary(directory, path)
        }

        fn commit(
            &self,
            directory: &Dir,
            destination: &Path,
            temporary: &Path,
            temporary_file: &mut Option<File>,
            locked_target: Option<&File>,
            permissions: Option<std::fs::Permissions>,
        ) -> Result<bool> {
            self.native.commit(
                directory,
                destination,
                temporary,
                temporary_file,
                locked_target,
                permissions,
            )
        }
    }

    struct StaleAliasAdapter {
        native: NativeFileCasAdapter,
        stale_resolutions: usize,
        resolutions: AtomicUsize,
    }

    impl FileCasAdapter for StaleAliasAdapter {
        fn resolve_destination(&self, root: &Dir, relative: &Path) -> Result<PathBuf> {
            if self.resolutions.fetch_add(1, Ordering::Relaxed) < self.stale_resolutions {
                return Ok(PathBuf::from("note.txt (deleted)"));
            }
            self.native.resolve_destination(root, relative)
        }

        fn lock_current(&self, directory: &Dir, path: &Path) -> Result<File> {
            self.native.lock_current(directory, path)
        }

        fn path_matches_locked_file(
            &self,
            directory: &Dir,
            path: &Path,
            locked: &File,
        ) -> Result<bool> {
            self.native
                .path_matches_locked_file(directory, path, locked)
        }

        fn create_private_temporary(&self, directory: &Dir, path: &Path) -> std::io::Result<File> {
            self.native.create_private_temporary(directory, path)
        }

        fn commit(
            &self,
            directory: &Dir,
            destination: &Path,
            temporary: &Path,
            temporary_file: &mut Option<File>,
            locked_target: Option<&File>,
            permissions: Option<std::fs::Permissions>,
        ) -> Result<bool> {
            self.native.commit(
                directory,
                destination,
                temporary,
                temporary_file,
                locked_target,
                permissions,
            )
        }
    }

    #[cfg(target_os = "linux")]
    struct ResolveCountingAdapter {
        native: NativeFileCasAdapter,
        resolutions: AtomicUsize,
    }

    #[cfg(target_os = "linux")]
    impl FileCasAdapter for ResolveCountingAdapter {
        fn resolve_destination(&self, root: &Dir, relative: &Path) -> Result<PathBuf> {
            self.resolutions.fetch_add(1, Ordering::Relaxed);
            self.native.resolve_destination(root, relative)
        }

        fn lock_current(&self, directory: &Dir, path: &Path) -> Result<File> {
            self.native.lock_current(directory, path)
        }

        fn path_matches_locked_file(
            &self,
            directory: &Dir,
            path: &Path,
            locked: &File,
        ) -> Result<bool> {
            self.native
                .path_matches_locked_file(directory, path, locked)
        }

        fn create_private_temporary(&self, directory: &Dir, path: &Path) -> std::io::Result<File> {
            self.native.create_private_temporary(directory, path)
        }

        fn commit(
            &self,
            directory: &Dir,
            destination: &Path,
            temporary: &Path,
            temporary_file: &mut Option<File>,
            locked_target: Option<&File>,
            permissions: Option<std::fs::Permissions>,
        ) -> Result<bool> {
            self.native.commit(
                directory,
                destination,
                temporary,
                temporary_file,
                locked_target,
                permissions,
            )
        }
    }

    const WORKER_GATE: &str = "CLI_LAUNCHPAD_PROJECT_CAS_GATE";
    const WORKER_ROOT: &str = "CLI_LAUNCHPAD_PROJECT_CAS_ROOT";
    const WORKER_REVISION: &str = "CLI_LAUNCHPAD_PROJECT_CAS_REVISION";
    const WORKER_PAYLOAD: &str = "CLI_LAUNCHPAD_PROJECT_CAS_PAYLOAD";
    const WORKER_RESULT: &str = "CLI_LAUNCHPAD_PROJECT_CAS_RESULT";
    const CAS_ROUNDS_ENV: &str = "CLI_LAUNCHPAD_CAS_ROUNDS";
    const WORKER_WAIT_LIMIT: Duration = Duration::from_secs(30);
    const WORKER_NAMES: [&str; 2] = ["process-a", "process-b"];

    fn cas_rounds() -> usize {
        match std::env::var(CAS_ROUNDS_ENV) {
            Ok(value) => match value.parse::<usize>() {
                Ok(rounds) if rounds >= 1 => rounds,
                _ => panic!("{CAS_ROUNDS_ENV} 必须是不小于 1 的整数，实际为 {value:?}"),
            },
            Err(_) => 1,
        }
    }

    fn describe_outputs(outputs: &[Output; 2]) -> String {
        WORKER_NAMES
            .iter()
            .zip(outputs)
            .map(|(name, output)| {
                format!(
                    "[{name}] 退出状态：{}\n[{name}] stdout：\n{}\n[{name}] stderr：\n{}",
                    output.status,
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr),
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn read_worker_results(root: &Path) -> [String; 2] {
        WORKER_NAMES.map(|payload| {
            std::fs::read_to_string(root.join(format!("{payload}.result")))
                .unwrap_or_else(|error| format!("<无结果文件：{error}>"))
        })
    }

    fn wait_for_workers(mut workers: [Child; 2], root: &Path, round: usize) -> [Output; 2] {
        let deadline = Instant::now() + WORKER_WAIT_LIMIT;
        loop {
            let finished = workers
                .iter_mut()
                .all(|worker| worker.try_wait().unwrap().is_some());
            if finished {
                return workers.map(|worker| worker.wait_with_output().unwrap());
            }
            if Instant::now() >= deadline {
                for worker in workers.iter_mut() {
                    let _ = worker.kill();
                }
                let outputs = workers.map(|worker| worker.wait_with_output().unwrap());
                let results = read_worker_results(root);
                panic!(
                    "第 {round} 轮：CAS worker 未在 {WORKER_WAIT_LIMIT:?} 内结束，已强制终止\nprocess-a 结果：{}\nprocess-b 结果：{}\n{}",
                    results[0],
                    results[1],
                    describe_outputs(&outputs)
                );
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn revision(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn cross_process_cas_worker() {
        let Ok(payload) = std::env::var(WORKER_PAYLOAD) else {
            return;
        };
        let root = PathBuf::from(std::env::var(WORKER_ROOT).unwrap());
        let expected = std::env::var(WORKER_REVISION).unwrap();
        let result_path = PathBuf::from(std::env::var(WORKER_RESULT).unwrap());
        let gate = PathBuf::from(std::env::var(WORKER_GATE).unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        while !gate.exists() {
            assert!(Instant::now() < deadline, "CAS worker gate timed out");
            std::thread::sleep(Duration::from_millis(5));
        }

        let directory = Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
        let outcome = compare_and_swap_in_directory(
            &directory,
            Path::new("note.txt"),
            payload.as_bytes(),
            &expected,
            1024,
            revision,
        );
        let text = match outcome {
            Ok(outcome) => format!("{outcome:?}"),
            Err(error) => format!("Error: {error:#}"),
        };
        std::fs::write(result_path, text).unwrap();
    }

    fn run_cas_round(round: usize) {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "original").unwrap();
        let expected = revision(b"original");
        let gate = root.path().join("start");

        let workers = WORKER_NAMES.map(|payload| {
            let result_path = root.path().join(format!("{payload}.result"));
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "platform::file_cas::tests::cross_process_cas_worker",
                    "--nocapture",
                ])
                .env(WORKER_GATE, &gate)
                .env(WORKER_ROOT, root.path())
                .env(WORKER_REVISION, &expected)
                .env(WORKER_PAYLOAD, payload)
                .env(WORKER_RESULT, result_path)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        });

        thread::sleep(Duration::from_millis(100));
        std::fs::write(&gate, "go").unwrap();
        let outputs = wait_for_workers(workers, root.path(), round);

        let results = read_worker_results(root.path());
        let report = format!(
            "第 {round} 轮\nprocess-a 结果：{}\nprocess-b 结果：{}\n{}",
            results[0],
            results[1],
            describe_outputs(&outputs),
        );

        for (payload, output) in WORKER_NAMES.into_iter().zip(&outputs) {
            assert!(
                output.status.success(),
                "CAS worker {payload} 异常退出\n{report}"
            );
        }
        assert_eq!(
            results.iter().filter(|value| *value == "Written").count(),
            1,
            "必须恰好一个 Written\n{report}"
        );
        assert_eq!(
            results.iter().filter(|value| *value == "Conflict").count(),
            1,
            "必须恰好一个 Conflict\n{report}"
        );
        let note = std::fs::read_to_string(root.path().join("note.txt")).unwrap();
        assert!(
            matches!(note.as_str(), "process-a" | "process-b"),
            "note.txt 内容异常：{note:?}\n{report}"
        );
        let leftovers: Vec<String> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".writing"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "存在 .writing 残留：{leftovers:?}\n{report}"
        );
    }

    #[test]
    fn separate_processes_using_same_revision_allow_only_one_winner() {
        for round in 1..=cas_rounds() {
            run_cas_round(round);
        }
    }

    #[test]
    fn compare_and_swap_replaces_file_relative_to_project_capability() {
        let root = tempdir().unwrap();
        let path = root.path().join("note.txt");
        std::fs::write(&path, "before").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        let outcome = compare_and_swap_in_directory(
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        )
        .unwrap();

        assert_eq!(outcome, CompareAndSwapOutcome::Written);
        assert_eq!(std::fs::read(path).unwrap(), b"after");
    }

    #[test]
    fn shared_cas_coordinator_routes_all_platform_operations_through_adapter() {
        let root = tempdir().unwrap();
        let path = root.path().join("note.txt");
        std::fs::write(&path, "before").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let adapter = CountingAdapter::default();

        let outcome = compare_and_swap_with_adapter(
            &adapter,
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        )
        .unwrap();

        assert_eq!(outcome, CompareAndSwapOutcome::Written);
        assert_eq!(adapter.locks.load(Ordering::Relaxed), 1);
        assert_eq!(adapter.identities.load(Ordering::Relaxed), 2);
        assert_eq!(adapter.temporaries.load(Ordering::Relaxed), 1);
        assert_eq!(adapter.commits.load(Ordering::Relaxed), 1);
        assert_eq!(std::fs::read(path).unwrap(), b"after");
    }

    #[test]
    fn stale_revision_is_a_conflict_and_leaves_no_temporary_file() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "current").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        let outcome = compare_and_swap_in_directory(
            &dir,
            Path::new("note.txt"),
            b"replacement",
            &revision(b"stale"),
            1024,
            revision,
        )
        .unwrap();

        assert_eq!(outcome, CompareAndSwapOutcome::Conflict);
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.txt")).unwrap(),
            "current"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn temporary_names_are_unique_and_uncommitted_files_are_removed() {
        let root = tempdir().unwrap();
        let directory = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let first = create_temporary(&NativeFileCasAdapter, &directory, b"first").unwrap();
        let second = create_temporary(&NativeFileCasAdapter, &directory, b"second").unwrap();
        assert_ne!(first.name, second.name);
        assert_eq!(first.file.as_ref().unwrap().metadata().unwrap().len(), 5);
        assert_eq!(second.file.as_ref().unwrap().metadata().unwrap().len(), 6);
        let first_name = first.name.clone();
        let second_name = second.name.clone();

        drop(first);
        drop(second);

        assert!(directory.symlink_metadata(first_name).is_err());
        assert!(directory.symlink_metadata(second_name).is_err());
    }

    #[test]
    fn replacement_of_locked_identity_is_detected_before_writing() {
        let root = tempdir().unwrap();
        let destination = root.path().join("note.txt");
        let replacement = root.path().join("replacement.txt");
        std::fs::write(&destination, "original").unwrap();
        std::fs::write(&replacement, "external").unwrap();
        let directory = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let locked = lock_current(&directory, Path::new("note.txt")).unwrap();
        std::fs::rename(&replacement, &destination).unwrap();

        assert!(!same_file(&directory, Path::new("note.txt"), &locked).unwrap());
        assert_eq!(std::fs::read_to_string(destination).unwrap(), "external");
    }

    #[test]
    fn replacement_after_initial_identity_check_is_retried_before_commit() {
        let root = tempdir().unwrap();
        let destination = root.path().join("note.txt");
        std::fs::write(&destination, "original").unwrap();
        std::fs::write(root.path().join("replacement.txt"), "external").unwrap();
        let directory = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let adapter = ReplaceOnFirstIdentityAdapter {
            native: NativeFileCasAdapter,
            root: root.path().to_path_buf(),
            identities: AtomicUsize::new(0),
        };

        let outcome = compare_and_swap_with_adapter(
            &adapter,
            &directory,
            Path::new("note.txt"),
            b"ours",
            &revision(b"original"),
            1024,
            revision,
        )
        .unwrap();

        assert_eq!(outcome, CompareAndSwapOutcome::Conflict);
        assert_eq!(std::fs::read_to_string(destination).unwrap(), "external");
        assert!(adapter.identities.load(Ordering::Relaxed) >= 3);
    }

    #[test]
    fn file_lock_wait_is_bounded() {
        use std::sync::mpsc;
        use std::thread;
        use std::time::{Duration, Instant};

        let root = tempdir().unwrap();
        let path = root.path().join("note.txt");
        std::fs::write(&path, "before").unwrap();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let lock_path = path.clone();
        let holder = thread::spawn(move || {
            let file = File::open(lock_path).unwrap();
            file.lock().unwrap();
            locked_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        locked_rx.recv().unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let started = Instant::now();
        let result = compare_and_swap_in_directory(
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        );
        let elapsed = started.elapsed();
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("占用"));
        assert!(elapsed < LOCK_TIMEOUT + Duration::from_secs(5));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "before");
    }

    #[cfg(windows)]
    #[test]
    fn lock_current_retries_a_temporary_missing_path() {
        let root = tempdir().unwrap();
        let path = root.path().join("note.txt");
        let moved_path = root.path().join("note.txt.replacement");
        std::fs::write(&path, "before").unwrap();
        std::fs::rename(&path, &moved_path).unwrap();
        let restore_path = path.clone();
        let restore_from = moved_path.clone();
        let restore = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            std::fs::rename(restore_from, restore_path).unwrap();
        });

        let directory = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let locked = lock_current(&directory, Path::new("note.txt")).unwrap();
        restore.join().unwrap();
        drop(locked);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "before");
    }

    fn file_names(root: &Path) -> Vec<String> {
        std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn cas_retries_when_resolved_destination_is_a_deleted_alias() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "before").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let adapter = DeletedAliasOnceAdapter {
            native: NativeFileCasAdapter,
            resolutions: AtomicUsize::new(0),
        };

        let started = Instant::now();
        let outcome = compare_and_swap_with_adapter(
            &adapter,
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        );
        let elapsed = started.elapsed();

        assert!(
            matches!(&outcome, Ok(CompareAndSwapOutcome::Written)),
            "实际结果：{outcome:?}"
        );
        assert_eq!(adapter.resolutions.load(Ordering::Relaxed), 2);
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.txt")).unwrap(),
            "after"
        );
        let names = file_names(root.path());
        assert!(
            !names.iter().any(|name| name.ends_with(".writing")),
            "存在 .writing 残留：{names:?}"
        );
        assert!(
            !names.iter().any(|name| name == "note.txt (deleted)"),
            "不应出现别名文件：{names:?}"
        );
        assert!(
            elapsed < Duration::from_secs(1),
            "耗时 {elapsed:?}，不得走 2 秒锁超时"
        );
    }

    #[test]
    fn cas_never_targets_a_real_file_named_like_a_deleted_alias() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "before").unwrap();
        std::fs::write(root.path().join("note.txt (deleted)"), "decoy").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let adapter = DeletedAliasOnceAdapter {
            native: NativeFileCasAdapter,
            resolutions: AtomicUsize::new(0),
        };

        let outcome = compare_and_swap_with_adapter(
            &adapter,
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        );

        assert!(
            matches!(&outcome, Ok(CompareAndSwapOutcome::Written)),
            "实际结果：{outcome:?}"
        );
        assert_eq!(adapter.resolutions.load(Ordering::Relaxed), 2);
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.txt")).unwrap(),
            "after"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.txt (deleted)")).unwrap(),
            "decoy",
            "诱饵文件必须保持原样"
        );
    }

    #[test]
    fn resolve_cas_destination_survives_many_consecutive_stale_resolutions() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let adapter = StaleAliasAdapter {
            native: NativeFileCasAdapter,
            stale_resolutions: 20,
            resolutions: AtomicUsize::new(0),
        };

        let resolved = resolve_cas_destination_with(&adapter, &dir, Path::new("note.txt"));

        assert_eq!(
            resolved.as_ref().ok(),
            Some(&PathBuf::from("note.txt")),
            "实际结果：{resolved:?}"
        );
        assert_eq!(adapter.resolutions.load(Ordering::Relaxed), 21);
    }

    #[test]
    fn resolve_cas_destination_gives_up_when_resolutions_never_stabilize() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let adapter = StaleAliasAdapter {
            native: NativeFileCasAdapter,
            stale_resolutions: usize::MAX,
            resolutions: AtomicUsize::new(0),
        };

        let started = Instant::now();
        let error = resolve_cas_destination_with(&adapter, &dir, Path::new("note.txt"))
            .expect_err("永不稳定的解析必须报错");
        let elapsed = started.elapsed();

        assert!(
            format!("{error:#}").contains("持续变化"),
            "实际错误：{error:#}"
        );
        assert_eq!(
            adapter.resolutions.load(Ordering::Relaxed),
            MAX_RESOLUTION_RETRIES
        );
        assert_eq!(
            file_names(root.path()),
            vec!["note.txt".to_string()],
            "解析阶段不得创建任何文件"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "放弃前的退避总耗时 {elapsed:?} 过长"
        );
    }

    #[test]
    fn lock_current_error_names_the_requested_path() {
        let root = tempdir().unwrap();
        let directory = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        let error = lock_current(&directory, Path::new("missing-note.txt")).unwrap_err();

        let message = format!("{error:#}");
        assert!(
            message.contains("无法打开待保存文件：missing-note.txt"),
            "错误文本必须带相对路径，实际为：{message}"
        );
        let root_kind = error
            .root_cause()
            .downcast_ref::<std::io::Error>()
            .map(std::io::Error::kind);
        assert_eq!(
            root_kind,
            Some(std::io::ErrorKind::NotFound),
            "根因必须保留为 NotFound，实际为：{message}"
        );
        assert!(
            !root.path().join("missing-note.txt").exists(),
            "lock_current 不得创建目标文件"
        );
    }

    #[test]
    fn validate_resolved_destination_accepts_an_existing_file_with_the_requested_name() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        assert!(
            validate_resolved_destination(&dir, Path::new("note.txt"), Path::new("note.txt"))
                .unwrap()
        );
    }

    #[test]
    fn validate_resolved_destination_rejects_a_missing_resolved_path() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        assert!(!validate_resolved_destination(
            &dir,
            Path::new("note.txt"),
            Path::new("note.txt (deleted)")
        )
        .unwrap());
        assert!(
            !validate_resolved_destination(&dir, Path::new("note.txt"), Path::new("gone.txt"))
                .unwrap()
        );
        assert!(
            !validate_resolved_destination(&dir, Path::new("gone.txt"), Path::new("gone.txt"))
                .unwrap(),
            "不存在的解析结果即使名字一致也不可信"
        );
    }

    #[test]
    fn validate_resolved_destination_rejects_an_existing_decoy_with_a_different_name() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        std::fs::write(root.path().join("note.txt (deleted)"), "decoy").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        assert!(!validate_resolved_destination(
            &dir,
            Path::new("note.txt"),
            Path::new("note.txt (deleted)")
        )
        .unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn validate_resolved_destination_accepts_the_symlink_target_name() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("real.txt"), "x").unwrap();
        std::fs::write(root.path().join("other.txt"), "y").unwrap();
        std::os::unix::fs::symlink("real.txt", root.path().join("link.txt")).unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        assert!(
            validate_resolved_destination(&dir, Path::new("link.txt"), Path::new("real.txt"))
                .unwrap()
        );
        assert!(
            !validate_resolved_destination(&dir, Path::new("link.txt"), Path::new("other.txt"))
                .unwrap(),
            "符号链接指向 real.txt 时，other.txt 不是可信的解析结果"
        );
    }

    #[test]
    fn validate_resolved_destination_treats_requests_without_a_file_name_as_existence_only() {
        let root = tempdir().unwrap();
        std::fs::create_dir(root.path().join("sub")).unwrap();
        std::fs::write(root.path().join("sub").join("a.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        assert!(
            validate_resolved_destination(&dir, Path::new("sub/.."), Path::new("sub")).unwrap()
        );
        assert!(
            !validate_resolved_destination(&dir, Path::new("sub/.."), Path::new("missing"))
                .unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn validate_resolved_destination_ignores_case_differences_on_windows() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        assert!(
            validate_resolved_destination(&dir, Path::new("NOTE.TXT"), Path::new("note.txt"))
                .unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn lock_current_does_not_spin_on_unix_when_the_path_is_missing() {
        let root = tempdir().unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();

        let started = Instant::now();
        let error = lock_current(&dir, Path::new("missing.txt")).unwrap_err();
        let elapsed = started.elapsed();

        let kind = error
            .root_cause()
            .downcast_ref::<std::io::Error>()
            .map(std::io::Error::kind);
        assert_eq!(
            kind,
            Some(std::io::ErrorKind::NotFound),
            "实际为：{error:#}"
        );
        assert!(
            elapsed < Duration::from_millis(500),
            "耗时 {elapsed:?}，Unix 上不得自旋等待 2 秒"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolve_cas_destination_never_returns_a_deleted_alias_under_concurrent_replacement() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let replacer = {
            let stop = Arc::clone(&stop);
            let base = root.path().to_path_buf();
            thread::spawn(move || {
                let temporary = base.join(".r.tmp");
                let target = base.join("note.txt");
                while !stop.load(Ordering::Relaxed) {
                    std::fs::write(&temporary, "x").unwrap();
                    std::fs::rename(&temporary, &target).unwrap();
                }
            })
        };
        let adapter = ResolveCountingAdapter {
            native: NativeFileCasAdapter,
            resolutions: AtomicUsize::new(0),
        };

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut iterations = 0_usize;
        let mut failures = Vec::new();
        while iterations < 200_000 && Instant::now() < deadline && failures.len() < 5 {
            iterations += 1;
            match resolve_cas_destination_with(&adapter, &dir, Path::new("note.txt")) {
                Ok(resolved) if resolved == Path::new("note.txt") => {}
                other => failures.push(format!("{other:?}")),
            }
        }
        stop.store(true, Ordering::Relaxed);
        replacer.join().unwrap();

        let resolutions = adapter.resolutions.load(Ordering::Relaxed);
        eprintln!(
            "iterations={iterations} resolutions={resolutions} retries={}",
            resolutions.saturating_sub(iterations)
        );
        assert!(failures.is_empty(), "解析结果异常：{failures:?}");
        assert!(
            iterations >= 100,
            "循环次数过少（{iterations}），测试没有真正施压"
        );
        assert_eq!(
            resolve_cas_destination(&dir, Path::new("note.txt")).unwrap(),
            PathBuf::from("note.txt")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "刻画上游 cap-primitives 竞态，仅在 flaky 探针中运行"]
    fn cap_std_canonicalize_can_return_deleted_suffix_under_concurrent_replacement() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "x").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let replacer = {
            let stop = Arc::clone(&stop);
            let base = root.path().to_path_buf();
            thread::spawn(move || {
                let temporary = base.join(".r.tmp");
                let target = base.join("note.txt");
                while !stop.load(Ordering::Relaxed) {
                    std::fs::write(&temporary, "x").unwrap();
                    std::fs::rename(&temporary, &target).unwrap();
                }
            })
        };

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen_deleted_suffix = false;
        while Instant::now() < deadline && !seen_deleted_suffix {
            if let Ok(resolved) = dir.canonicalize("note.txt") {
                seen_deleted_suffix = resolved.to_string_lossy().ends_with(" (deleted)");
            }
        }
        stop.store(true, Ordering::Relaxed);
        replacer.join().unwrap();

        assert!(
            seen_deleted_suffix,
            "5 秒内没有观察到 canonicalize 返回 ` (deleted)` 后缀"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cas_survives_tight_external_atomic_replacement_loop() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "same").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let replacer = {
            let stop = Arc::clone(&stop);
            let base = root.path().to_path_buf();
            thread::spawn(move || {
                let temporary = base.join(".r.tmp");
                let target = base.join("note.txt");
                while !stop.load(Ordering::Relaxed) {
                    std::fs::write(&temporary, "same").unwrap();
                    std::fs::rename(&temporary, &target).unwrap();
                    thread::sleep(Duration::from_millis(1));
                }
            })
        };

        let started = Instant::now();
        let mut failures = Vec::new();
        for round in 0..300 {
            let outcome = compare_and_swap_in_directory(
                &dir,
                Path::new("note.txt"),
                b"same",
                &revision(b"same"),
                1024,
                revision,
            );
            match outcome {
                Ok(CompareAndSwapOutcome::Written) => {}
                Ok(other) => failures.push(format!("第 {round} 轮：非预期结果 {other:?}")),
                Err(error) => {
                    let message = format!("{error:#}");
                    if !message.contains("持续变化") {
                        failures.push(format!("第 {round} 轮：{message}"));
                    }
                }
            }
        }
        let elapsed = started.elapsed();
        stop.store(true, Ordering::Relaxed);
        replacer.join().unwrap();

        assert!(failures.is_empty(), "保存结果异常：{failures:?}");
        let leftovers: Vec<String> = file_names(root.path())
            .into_iter()
            .filter(|name| name.ends_with(".writing"))
            .collect();
        assert!(leftovers.is_empty(), "存在 .writing 残留：{leftovers:?}");
        assert!(
            elapsed < Duration::from_secs(20),
            "300 轮耗时 {elapsed:?}，超过 20 秒"
        );
    }

    #[cfg(unix)]
    #[test]
    fn replacement_preserves_mode_and_starts_with_private_temporary_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempdir().unwrap();
        let path = root.path().join("note.txt");
        std::fs::write(&path, "before").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let temporary = create_temporary(&NativeFileCasAdapter, &dir, b"after").unwrap();
        assert_eq!(
            temporary
                .file
                .as_ref()
                .unwrap()
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(temporary);

        compare_and_swap_in_directory(
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        )
        .unwrap();
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(windows)]
    #[test]
    fn temporary_acl_is_private_and_replacement_preserves_inherited_target_acl() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            Security::{
                GetAce, GetSecurityDescriptorControl, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
                INHERITED_ACE, SE_DACL_PROTECTED,
            },
        };
        fn dacl(file: &File) -> (Vec<u8>, u16, u16, bool) {
            let mut dacl = std::ptr::null_mut::<ACL>();
            let mut descriptor = std::ptr::null_mut();
            let result = unsafe {
                GetSecurityInfo(
                    file.as_raw_handle() as _,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut dacl,
                    std::ptr::null_mut(),
                    &mut descriptor,
                )
            };
            assert_eq!(result, 0);
            let mut control = 0;
            let mut revision = 0;
            assert_eq!(
                unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
                1
            );
            let protected = control & SE_DACL_PROTECTED != 0;
            if dacl.is_null() {
                unsafe { LocalFree(descriptor) };
                return (Vec::new(), 0, 0, protected);
            }
            let count = unsafe { (*dacl).AceCount };
            let length = unsafe { (*dacl).AclSize } as usize;
            let bytes = unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), length) }.to_vec();
            let mut inherited_count = 0;
            for ace_index in 0..count as u32 {
                let mut ace = std::ptr::null_mut();
                assert_eq!(unsafe { GetAce(dacl, ace_index, &mut ace) }, 1);
                if unsafe { (*ace.cast::<ACE_HEADER>()).AceFlags } & INHERITED_ACE as u8 != 0 {
                    inherited_count += 1;
                }
            }
            unsafe { LocalFree(descriptor) };
            (bytes, count, inherited_count, protected)
        }

        let root = tempdir().unwrap();
        let path = root.path().join("note.txt");
        std::fs::write(&path, "before").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let temporary = create_temporary(&NativeFileCasAdapter, &dir, b"after").unwrap();
        let (_, private_ace_count, _, private_acl_is_protected) =
            dacl(temporary.file.as_ref().unwrap());
        assert_eq!(private_ace_count, 1);
        assert!(private_acl_is_protected);
        drop(temporary);
        let target = dir.open("note.txt").unwrap().into_std();
        let (expected_acl, _, inherited_ace_count, target_acl_is_protected) = dacl(&target);
        assert!(!target_acl_is_protected);
        assert!(
            inherited_ace_count > 0,
            "fixture must inherit its directory DACL"
        );
        drop(target);

        compare_and_swap_in_directory(
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        )
        .unwrap();
        let replacement = dir.open("note.txt").unwrap().into_std();
        let (actual_acl, _, _, replacement_acl_is_protected) = dacl(&replacement);
        assert_eq!(actual_acl, expected_acl);
        assert!(!replacement_acl_is_protected);
        drop(replacement);

        replace_file(&path, b"replaced without CAS").unwrap();
        let unconditional_replacement = dir.open("note.txt").unwrap().into_std();
        let (unconditional_acl, _, _, unconditional_acl_is_protected) =
            dacl(&unconditional_replacement);
        assert_eq!(unconditional_acl, expected_acl);
        assert!(!unconditional_acl_is_protected);
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "replaced without CAS"
        );
    }

    #[cfg(windows)]
    #[test]
    fn unconditional_replacement_preserves_readonly_attribute() {
        let root = tempdir().unwrap();
        let path = root.path().join("readonly.txt");
        std::fs::write(&path, "before").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();

        replace_file(&path, b"after").unwrap();

        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "after");
        assert!(metadata.permissions().readonly());
    }

    #[cfg(windows)]
    #[test]
    fn replacement_preserves_protected_target_acl() {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::{
            Foundation::{GENERIC_READ, GENERIC_WRITE},
            Storage::FileSystem::{READ_CONTROL, WRITE_DAC},
        };

        let root = tempdir().unwrap();
        let path = root.path().join("note.txt");
        std::fs::write(&path, "before").unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .access_mode(GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC);
        let target = dir.open_with("note.txt", &options).unwrap().into_std();
        restrict_to_current_user(&target).unwrap();
        let (expected_acl, _, inherited_ace_count, target_acl_is_protected) = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::LocalFree,
                Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
                Security::{
                    GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
                },
            };
            let mut dacl = std::ptr::null_mut::<ACL>();
            let mut descriptor = std::ptr::null_mut();
            let result = unsafe {
                GetSecurityInfo(
                    target.as_raw_handle() as _,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut dacl,
                    std::ptr::null_mut(),
                    &mut descriptor,
                )
            };
            assert_eq!(result, 0);
            let mut control = 0;
            let mut revision = 0;
            assert_eq!(
                unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
                1
            );
            let protected = control & SE_DACL_PROTECTED != 0;
            let length = unsafe { (*dacl).AclSize } as usize;
            let bytes = unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), length) }.to_vec();
            unsafe { LocalFree(descriptor) };
            (bytes, 1, 0, protected)
        };
        assert!(target_acl_is_protected);
        assert_eq!(inherited_ace_count, 0);
        drop(target);

        compare_and_swap_in_directory(
            &dir,
            Path::new("note.txt"),
            b"after",
            &revision(b"before"),
            1024,
            revision,
        )
        .unwrap();
        let replacement = dir.open("note.txt").unwrap().into_std();
        let mut dacl = std::ptr::null_mut::<ACL>();
        let mut descriptor = std::ptr::null_mut();
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            Security::{
                GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
            },
        };
        let result = unsafe {
            GetSecurityInfo(
                replacement.as_raw_handle() as _,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(result, 0);
        let length = unsafe { (*dacl).AclSize } as usize;
        let actual_acl = unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), length) }.to_vec();
        let mut control = 0;
        let mut revision = 0;
        assert_eq!(
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
            1
        );
        let replacement_acl_is_protected = control & SE_DACL_PROTECTED != 0;
        unsafe { LocalFree(descriptor) };
        assert_eq!(actual_acl, expected_acl);
        assert!(replacement_acl_is_protected);
    }
}
