use std::ffi::OsStr;
use std::fs::File;
use std::io;

use cap_std::fs::{Dir, OpenOptions};

/// Volume/device plus file index/inode: the only file identity in the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileIdentity {
    pub volume_or_device: u64,
    pub index_or_inode: u64,
}

impl FileIdentity {
    pub fn of(file: &File) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = file.metadata()?;
            Ok(Self {
                volume_or_device: metadata.dev(),
                index_or_inode: metadata.ino(),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            };
            let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                volume_or_device: u64::from(information.dwVolumeSerialNumber),
                index_or_inode: (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow),
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = file;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "当前平台尚未实现文件身份",
            ))
        }
    }

    /// Stable string form stored in residue previews.
    pub fn token(&self) -> String {
        #[cfg(unix)]
        {
            format!("unix:{}:{}", self.volume_or_device, self.index_or_inode)
        }
        #[cfg(windows)]
        {
            format!("windows:{}:{}", self.volume_or_device, self.index_or_inode)
        }
        #[cfg(not(any(unix, windows)))]
        {
            format!("fallback:{}:{}", self.volume_or_device, self.index_or_inode)
        }
    }
}

/// Identity of the entry `name` inside `directory`, opened without following
/// a final symbolic link on Unix.
pub fn of_entry(directory: &Dir, name: &OsStr) -> io::Result<FileIdentity> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    let file = directory.open_with(name, &options)?.into_std();
    FileIdentity::of(&file)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::fs::{self, File};
    use std::io::ErrorKind;

    use cap_std::fs::Dir;

    use super::{of_entry, FileIdentity};

    fn directory() -> (tempfile::TempDir, Dir) {
        let root = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        (root, dir)
    }

    #[test]
    fn identity_of_two_handles_to_the_same_file_is_equal() -> std::io::Result<()> {
        let (root, _dir) = directory();
        let path = root.path().join("a.txt");
        fs::write(&path, b"a")?;
        let first = FileIdentity::of(&File::open(&path)?)?;
        let second = FileIdentity::of(&File::open(&path)?)?;
        assert_eq!(first, second);
        assert_eq!(first.token(), second.token());
        Ok(())
    }

    #[test]
    fn identity_differs_for_different_files() -> std::io::Result<()> {
        let (root, _dir) = directory();
        fs::write(root.path().join("a.txt"), b"a")?;
        fs::write(root.path().join("b.txt"), b"b")?;
        let a = FileIdentity::of(&File::open(root.path().join("a.txt"))?)?;
        let b = FileIdentity::of(&File::open(root.path().join("b.txt"))?)?;
        assert_ne!(a, b);
        Ok(())
    }

    #[test]
    fn identity_changes_when_the_path_is_atomically_replaced() -> std::io::Result<()> {
        let (root, dir) = directory();
        fs::write(root.path().join("note.txt"), b"before")?;
        let before = of_entry(&dir, OsStr::new("note.txt"))?;
        fs::write(root.path().join(".r.tmp"), b"after")?;
        fs::rename(root.path().join(".r.tmp"), root.path().join("note.txt"))?;
        let after = of_entry(&dir, OsStr::new("note.txt"))?;
        assert_ne!(before, after);
        assert_eq!(of_entry(&dir, OsStr::new("note.txt"))?, after);
        Ok(())
    }

    #[test]
    fn identity_token_has_a_platform_prefix_and_two_numeric_parts() -> std::io::Result<()> {
        let (root, _dir) = directory();
        fs::write(root.path().join("a.txt"), b"a")?;
        let token = FileIdentity::of(&File::open(root.path().join("a.txt"))?)?.token();
        let prefix = if cfg!(unix) { "unix:" } else { "windows:" };
        assert!(token.starts_with(prefix), "{token}");
        let parts: Vec<&str> = token.split(':').collect();
        assert_eq!(parts.len(), 3, "{token}");
        assert!(parts[1].parse::<u64>().is_ok(), "{token}");
        assert!(parts[2].parse::<u64>().is_ok(), "{token}");
        Ok(())
    }

    #[test]
    fn of_entry_matches_the_identity_of_an_open_file() -> std::io::Result<()> {
        let (root, dir) = directory();
        fs::write(root.path().join("a.txt"), b"a")?;
        let opened = FileIdentity::of(&File::open(root.path().join("a.txt"))?)?;
        assert_eq!(of_entry(&dir, OsStr::new("a.txt"))?, opened);
        let missing = of_entry(&dir, OsStr::new("missing")).unwrap_err();
        assert_eq!(missing.kind(), ErrorKind::NotFound);
        Ok(())
    }
}
