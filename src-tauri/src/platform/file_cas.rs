use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use cap_std::fs::{Dir, OpenOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareAndSwapOutcome {
    Written,
    Conflict,
}

const MAX_IDENTITY_RETRIES: usize = 8;
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(10);

/// OS-specific operations behind the shared revision compare-and-swap flow.
/// Implementations receive a retained directory capability and a relative
/// target, so platform adapters cannot silently fall back to ambient paths.
pub trait FileCasAdapter {
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
    ) -> Result<()>;
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
    ) -> Result<()> {
        // The caller keeps this handle alive through commit to retain the CAS lock.
        let _ = locked_target;
        #[cfg(windows)]
        {
            if let Some(permissions) = permissions {
                temporary_file
                    .as_ref()
                    .context("临时文件句柄已关闭")?
                    .set_permissions(permissions)
                    .context("无法恢复 Windows 文件属性")?;
            }
            temporary_file.take();
            replace_windows_anchored(directory, destination, temporary)
                .context("无法原子替换项目文件")?;
            Ok(())
        }
        #[cfg(unix)]
        {
            directory
                .rename(temporary, directory, destination)
                .context("无法原子替换项目文件")?;
            if let Some(permissions) = permissions {
                temporary_file
                    .as_ref()
                    .context("替换文件句柄已关闭")?
                    .set_permissions(permissions)?;
            }
            temporary_file.take();
            Ok(())
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
    let canonical = root
        .canonicalize(relative_destination)
        .context("项目文件不存在或无法访问")?;
    let (parent, destination) = parent_and_name(root, &canonical)?;
    let mut temporary = create_temporary(adapter, &parent, replacement)?;
    temporary.finish_writing()?;

    for _ in 0..MAX_IDENTITY_RETRIES {
        let locked = adapter.lock_current(&parent, &destination)?;
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
        temporary.commit(adapter, &destination, Some(&locked), Some(permissions))?;
        return Ok(CompareAndSwapOutcome::Written);
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
    let mut temporary = create_temporary(&NativeFileCasAdapter, &directory, bytes)?;
    temporary.finish_writing()?;
    temporary.commit(&NativeFileCasAdapter, Path::new(name), None, None)
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
                if error.kind() == std::io::ErrorKind::NotFound && Instant::now() < deadline =>
            {
                // A concurrent Windows ReplaceFileW can briefly make the
                // destination unavailable while its pathname is being swapped.
                thread::sleep(LOCK_RETRY_INTERVAL);
            }
            Err(error) => return Err(error).context("无法打开待保存文件"),
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
    ) -> Result<()> {
        adapter.commit(
            &self.directory,
            destination,
            &self.name,
            &mut self.file,
            locked_target,
            permissions,
        )?;
        self.committed = true;
        Ok(())
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
fn replace_windows_anchored(
    directory: &Dir,
    destination: &Path,
    temporary: &Path,
) -> std::io::Result<()> {
    use std::os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::AsRawHandle,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, ReplaceFileW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let handle = directory.try_clone()?.into_std_file();
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            handle.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err(std::io::Error::last_os_error());
    }
    buffer.truncate(length as usize);
    let base = std::ffi::OsString::from_wide(&buffer);
    let destination = Path::new(&base).join(destination);
    let temporary = Path::new(&base).join(temporary);
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let destination = wide(&destination);
    let temporary = wide(&temporary);
    if unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            temporary.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error);
        }
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        if unsafe {
            MoveFileExW(
                temporary.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

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
        ) -> Result<()> {
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
        ) -> Result<()> {
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

    const WORKER_GATE: &str = "CLI_LAUNCHPAD_PROJECT_CAS_GATE";
    const WORKER_ROOT: &str = "CLI_LAUNCHPAD_PROJECT_CAS_ROOT";
    const WORKER_REVISION: &str = "CLI_LAUNCHPAD_PROJECT_CAS_REVISION";
    const WORKER_PAYLOAD: &str = "CLI_LAUNCHPAD_PROJECT_CAS_PAYLOAD";
    const WORKER_RESULT: &str = "CLI_LAUNCHPAD_PROJECT_CAS_RESULT";

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
        )
        .unwrap();
        std::fs::write(result_path, format!("{outcome:?}")).unwrap();
    }

    #[test]
    fn separate_processes_using_same_revision_allow_only_one_winner() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("note.txt"), "original").unwrap();
        let expected = revision(b"original");
        let gate = root.path().join("start");

        let workers = ["process-a", "process-b"].map(|payload| {
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
                .spawn()
                .unwrap()
        });

        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(&gate, "go").unwrap();
        for worker in workers {
            let output = worker.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "CAS worker failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let outcomes = ["process-a", "process-b"].map(|payload| {
            std::fs::read_to_string(root.path().join(format!("{payload}.result"))).unwrap()
        });
        assert_eq!(
            outcomes.iter().filter(|value| *value == "Written").count(),
            1
        );
        assert_eq!(
            outcomes.iter().filter(|value| *value == "Conflict").count(),
            1
        );
        assert!(matches!(
            std::fs::read_to_string(root.path().join("note.txt"))
                .unwrap()
                .as_str(),
            "process-a" | "process-b"
        ));
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
