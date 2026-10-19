use std::ffi::OsStr;
use std::fs::File;
use std::io;

use cap_std::fs::{Dir, OpenOptions};

/// Volume/device plus file index/inode: the only file identity in the app.
///
/// The index is 128 bits wide so that Windows can use `FILE_ID_INFO`: ReFS (and with it
/// Dev Drive) does not guarantee that the 64-bit index of `BY_HANDLE_FILE_INFORMATION` is
/// unique. NTFS stores the same 64 bits in the low half of the 128-bit id and zero in the
/// high half, so the file number of an NTFS file is unchanged (the volume serial number is
/// the 64-bit one of `FILE_ID_INFO`, wider than the 32 bits of the older call); Unix inodes
/// are widened as they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileIdentity {
    pub volume_or_device: u64,
    pub index_or_inode: u128,
}

/// The identity a `FILE_ID_INFO` stands for. An all-zero file id means the file system has no
/// 128-bit ids (the field must then be ignored): that is `None`, so the caller falls back
/// instead of giving every file of the volume the same identity.
#[cfg(windows)]
pub(crate) fn identity_from_file_id_info(
    info: &windows_sys::Win32::Storage::FileSystem::FILE_ID_INFO,
) -> Option<FileIdentity> {
    let id = info.FileId.Identifier;
    (id != [0u8; 16]).then(|| identity_from_parts(info.VolumeSerialNumber, Some(id), 0))
}

/// Builds the identity from what the Windows API reported. `file_id` is the 16 bytes of
/// `FILE_ID_128.Identifier` (little endian); without it (`FileIdInfo` unsupported, for
/// example on FAT) the 64-bit index of the older call is used.
#[cfg(windows)]
pub(crate) fn identity_from_parts(
    volume_serial: u64,
    file_id: Option<[u8; 16]>,
    legacy_index: u64,
) -> FileIdentity {
    FileIdentity {
        volume_or_device: volume_serial,
        index_or_inode: match file_id {
            Some(bytes) => u128::from_le_bytes(bytes),
            None => u128::from(legacy_index),
        },
    }
}

impl FileIdentity {
    pub fn of(file: &File) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = file.metadata()?;
            Ok(Self {
                volume_or_device: metadata.dev(),
                index_or_inode: u128::from(metadata.ino()),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
                BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO,
            };
            let handle = file.as_raw_handle() as _;

            // The 128-bit file id first.
            let mut id_info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
            // SAFETY: `handle` stays open for the call; the buffer is a writable `FILE_ID_INFO`
            // and the size passed is the size of that structure.
            let have_file_id = unsafe {
                GetFileInformationByHandleEx(
                    handle,
                    FileIdInfo,
                    (&mut id_info as *mut FILE_ID_INFO).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            } != 0;
            if have_file_id {
                if let Some(identity) = identity_from_file_id_info(&id_info) {
                    return Ok(identity);
                }
            }

            // File systems without `FileIdInfo` keep the 64-bit index.
            let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            // SAFETY: `handle` stays open for the call and `information` is a writable structure.
            if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(identity_from_parts(
                u64::from(information.dwVolumeSerialNumber),
                None,
                (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow),
            ))
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
        assert!(parts[2].parse::<u128>().is_ok(), "{token}");
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

    #[cfg(windows)]
    #[test]
    fn windows_identity_uses_the_128_bit_file_id() -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
        };

        let (root, _dir) = directory();
        fs::write(root.path().join("a.txt"), b"a")?;
        fs::write(root.path().join("b.txt"), b"b")?;
        fs::hard_link(root.path().join("a.txt"), root.path().join("hard.txt"))?;

        // The expectation comes from a direct call of the Windows API, not from the code under test.
        let file = File::open(root.path().join("a.txt"))?;
        let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as _,
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        };
        assert_ne!(queried, 0, "FileIdInfo must be available on this volume");

        let identity = FileIdentity::of(&file)?;
        assert_eq!(
            identity.index_or_inode,
            u128::from_le_bytes(info.FileId.Identifier)
        );
        // Where the high half is zero (NTFS), the low half is the 64-bit index of the older call.
        if identity.index_or_inode >> 64 == 0 {
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            };
            let mut legacy: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut legacy) },
                0
            );
            assert_eq!(
                identity.index_or_inode,
                (u128::from(legacy.nFileIndexHigh) << 32) | u128::from(legacy.nFileIndexLow)
            );
        }
        assert_eq!(identity.volume_or_device, info.VolumeSerialNumber);
        assert_eq!(
            identity,
            FileIdentity::of(&File::open(root.path().join("hard.txt"))?)?
        );
        assert_ne!(
            identity,
            FileIdentity::of(&File::open(root.path().join("b.txt"))?)?
        );
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn windows_identity_falls_back_to_the_64_bit_index_without_a_file_id() {
        use super::identity_from_parts;

        let legacy = 0x0000_0001_0000_0002_u64;
        assert_eq!(
            identity_from_parts(7, None, legacy).index_or_inode,
            u128::from(legacy)
        );
        assert_eq!(identity_from_parts(7, None, legacy).volume_or_device, 7);
        // Reverse: with a file id the legacy index plays no part.
        let id = 0x1234_5678_9abc_def0_u128.to_le_bytes();
        assert_eq!(
            identity_from_parts(7, Some(id), 99),
            identity_from_parts(7, Some(id), 12345)
        );
        assert_eq!(
            identity_from_parts(7, Some(id), 99).index_or_inode,
            0x1234_5678_9abc_def0_u128
        );
    }

    #[cfg(windows)]
    #[test]
    fn file_ids_that_differ_only_in_the_high_64_bits_are_different_identities() {
        use super::identity_from_parts;

        // The shape of a ReFS collision: the low 64 bits are equal, the high 64 bits are not.
        let low = 5_u128;
        let first = identity_from_parts(7, Some(low.to_le_bytes()), 0);
        let second = identity_from_parts(7, Some(((1_u128 << 64) | low).to_le_bytes()), 0);
        assert_ne!(first, second);
        assert_ne!(first.token(), second.token());
    }

    #[cfg(windows)]
    #[test]
    fn windows_identity_ignores_an_all_zero_file_id_and_keeps_the_high_half() {
        use super::identity_from_file_id_info;
        use windows_sys::Win32::Storage::FileSystem::{FILE_ID_128, FILE_ID_INFO};

        let info = |bytes: [u8; 16]| FILE_ID_INFO {
            VolumeSerialNumber: 0x10901b34_901b2030,
            FileId: FILE_ID_128 { Identifier: bytes },
        };
        // A file system without 128-bit ids reports success with an all-zero id: not an identity.
        assert_eq!(identity_from_file_id_info(&info([0; 16])), None);

        // The whole 128 bits and the 64-bit volume serial survive (NTFS never has a high half,
        // so only this synthetic value can show that nothing is cut to 64 bits).
        let id = (0xabcd_u128 << 64) | 0x1234_5678_9abc_def0_u128;
        let identity = identity_from_file_id_info(&info(id.to_le_bytes())).unwrap();
        assert_eq!(identity.index_or_inode, id);
        assert_eq!(identity.volume_or_device, 0x10901b34_901b2030);
    }

    #[test]
    fn index_field_holds_the_full_native_value() -> std::io::Result<()> {
        let (root, _dir) = directory();
        fs::write(root.path().join("a.txt"), b"a")?;
        let file = File::open(root.path().join("a.txt"))?;
        let identity = FileIdentity::of(&file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(identity.index_or_inode, u128::from(file.metadata()?.ino()));
            assert_eq!(
                identity.token(),
                format!(
                    "unix:{}:{}",
                    identity.volume_or_device,
                    file.metadata()?.ino()
                )
            );
        }
        #[cfg(windows)]
        {
            let token = identity.token();
            let third = token.split(':').nth(2).expect("a third token part");
            assert_eq!(third.parse::<u128>().unwrap(), identity.index_or_inode);
        }
        Ok(())
    }
}
