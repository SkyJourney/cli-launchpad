//! Windows adapter. Order matters: remote locations are decided by behaviour
//! alone; a local volume without `FILE_CASE_SENSITIVE_SEARCH` (FAT, exFAT) is
//! case insensitive; on NTFS and ReFS that volume flag is always set, so the
//! per-directory flag decides. A failed directory query is never read as
//! "flag 0": it falls back to behavioural probing.

use std::fs::File;
use std::os::windows::io::{AsRawHandle, FromRawHandle};

use cap_std::fs::Dir;
use windows_sys::Wdk::Storage::FileSystem::NtQueryInformationFile;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, GetFinalPathNameByHandleW, GetVolumeInformationByHandleW,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

use super::{CaseSensitivity, PathSemantics, Tri};
use crate::platform::file_identity::FileIdentity;

/// `FILE_CASE_SENSITIVE_SEARCH`: set on every NTFS and ReFS volume (MS-FSA appendix A).
const FILE_CASE_SENSITIVE_SEARCH: u32 = 0x0000_0001;
/// `FILE_CS_FLAG_CASE_SENSITIVE_DIR` in `FILE_CASE_SENSITIVE_INFORMATION.Flags`.
const FILE_CS_FLAG_CASE_SENSITIVE_DIR: u32 = 0x0000_0001;
/// `FileCaseSensitiveInformation` in `FILE_INFORMATION_CLASS`.
const FILE_CASE_SENSITIVE_INFORMATION_CLASS: i32 = 71;
/// `DRIVE_REMOTE` from `GetDriveTypeW`.
const DRIVE_REMOTE_TYPE: u32 = 4;

/// What the Windows APIs said about the project root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RawFacts {
    /// UNC path or a drive that `GetDriveTypeW` reports as remote.
    remote: bool,
    /// `lpFileSystemFlags` of `GetVolumeInformationByHandleW`; 0 when `remote`.
    volume_flags: u32,
    /// `FILE_CASE_SENSITIVE_INFORMATION.Flags`; `None` when the query was not made
    /// or failed (for example `STATUS_NOT_SUPPORTED`).
    directory_flags: Option<u32>,
}

fn decode(facts: &RawFacts) -> Option<PathSemantics> {
    if facts.remote {
        return None;
    }
    // The normalization axis is only set where it is verified (D-1-2 A): never on Windows.
    let semantics = |case| PathSemantics {
        case,
        normalization_insensitive: Tri::Unknown,
    };
    if facts.volume_flags & FILE_CASE_SENSITIVE_SEARCH == 0 {
        return Some(semantics(CaseSensitivity::Insensitive));
    }
    let directory_flags = facts.directory_flags?;
    Some(semantics(
        if directory_flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0 {
            CaseSensitivity::Sensitive
        } else {
            CaseSensitivity::Insensitive
        },
    ))
}

pub(super) fn platform_api_step(root: &Dir) -> Option<PathSemantics> {
    collect_facts(root).and_then(|facts| decode(&facts))
}

/// Windows entries are compared by file index only; ReFS does not guarantee it is
/// unique (a known limit, tracked outside PD-10).
pub(super) fn identity_is_reliable(_root: &Dir) -> bool {
    true
}

fn collect_facts(root: &Dir) -> Option<RawFacts> {
    let original = root.try_clone().ok()?.into_std_file();
    let mut path = vec![0u16; 32768];
    // SAFETY: `original` stays open for the call and `path` holds `path.len()` u16 values.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            original.as_raw_handle() as _,
            path.as_mut_ptr(),
            path.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if length == 0 || length as usize >= path.len() {
        return None;
    }
    path.truncate(length as usize);
    path.push(0);

    let is_unc = path.starts_with(&"\\\\?\\UNC\\".encode_utf16().collect::<Vec<_>>());
    let remote = is_unc || drive_is_remote(&path);
    if remote {
        return Some(RawFacts {
            remote: true,
            volume_flags: 0,
            directory_flags: None,
        });
    }

    let handle = reopen_for_attribute_query(&path)?;
    // The reopened path must still be the directory the caller holds.
    if FileIdentity::of(&original).ok()? != FileIdentity::of(&handle).ok()? {
        return None;
    }

    let mut volume_flags = 0u32;
    // SAFETY: the handle is open with FILE_READ_ATTRIBUTES; the optional buffers are null with length 0.
    let queried = unsafe {
        GetVolumeInformationByHandleW(
            handle.as_raw_handle() as _,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut volume_flags,
            std::ptr::null_mut(),
            0,
        )
    };
    if queried == 0 {
        return None;
    }

    // FAT and exFAT do not report the case-sensitive search flag and have no per-directory flag.
    let directory_flags = if volume_flags & FILE_CASE_SENSITIVE_SEARCH == 0 {
        None
    } else {
        query_directory_flags(&handle)
    };
    Some(RawFacts {
        remote: false,
        volume_flags,
        directory_flags,
    })
}

fn drive_is_remote(path: &[u16]) -> bool {
    // `\\?\C:\...`: a drive root is the four characters starting at index 4.
    let prefix: Vec<u16> = "\\\\?\\".encode_utf16().collect();
    if path.len() >= 7
        && path.starts_with(&prefix)
        && path[5] == u16::from(b':')
        && path[6] == u16::from(b'\\')
    {
        let root = [path[4], u16::from(b':'), u16::from(b'\\'), 0];
        // SAFETY: `root` is a NUL-terminated wide string.
        return unsafe { GetDriveTypeW(root.as_ptr()) } == DRIVE_REMOTE_TYPE;
    }
    false
}

fn reopen_for_attribute_query(path: &[u16]) -> Option<File> {
    // SAFETY: `path` is NUL-terminated; FILE_FLAG_BACKUP_SEMANTICS is required to open a directory.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    // SAFETY: `handle` was just returned by CreateFileW and is owned by nobody else.
    Some(unsafe { File::from_raw_handle(handle as _) })
}

/// `FILE_CASE_SENSITIVE_INFORMATION { ULONG Flags }`; `None` on any failure.
fn query_directory_flags(handle: &File) -> Option<u32> {
    let mut flags = 0u32;
    let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // SAFETY: `flags` is a 4-byte buffer and the length passed is 4; the handle has FILE_READ_ATTRIBUTES.
    let status = unsafe {
        NtQueryInformationFile(
            handle.as_raw_handle() as _,
            &mut status_block,
            (&mut flags as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
            FILE_CASE_SENSITIVE_INFORMATION_CLASS,
        )
    };
    (status >= 0).then_some(flags)
}

#[cfg(test)]
mod tests {
    use super::{decode, CaseSensitivity, PathSemantics, RawFacts, Tri};

    fn local(volume_flags: u32, directory_flags: Option<u32>) -> RawFacts {
        RawFacts {
            remote: false,
            volume_flags,
            directory_flags,
        }
    }

    fn remote() -> RawFacts {
        RawFacts {
            remote: true,
            volume_flags: 0,
            directory_flags: None,
        }
    }

    fn case_only(case: CaseSensitivity) -> Option<PathSemantics> {
        Some(PathSemantics {
            case,
            normalization_insensitive: Tri::Unknown,
        })
    }

    #[test]
    fn adapter_decoding_matches_the_confirmed_matrix() {
        // Row 1: NTFS default directory (volume flag always set, directory flag 0).
        assert_eq!(
            decode(&local(1, Some(0))),
            case_only(CaseSensitivity::Insensitive)
        );
        // Row 2: NTFS directory with per-directory case sensitivity enabled.
        assert_eq!(
            decode(&local(1, Some(1))),
            case_only(CaseSensitivity::Sensitive)
        );
        // Row 3: ReFS reads the same facts as NTFS (partly verified; adopted as inferred).
        assert_eq!(
            decode(&local(1, Some(0))),
            case_only(CaseSensitivity::Insensitive)
        );
        // Row 4: Dev Drive is a ReFS volume.
        assert_eq!(
            decode(&local(1, Some(0))),
            case_only(CaseSensitivity::Insensitive)
        );
        // Row 5: FAT and exFAT: no case-sensitive search flag, no directory query.
        assert_eq!(
            decode(&local(0, None)),
            case_only(CaseSensitivity::Insensitive)
        );
        assert_eq!(
            decode(&local(6, None)),
            case_only(CaseSensitivity::Insensitive)
        );
        // Row 6: SMB share (remote): behaviour decides, whatever the volume says.
        assert_eq!(decode(&remote()), None);
        assert_eq!(
            decode(&RawFacts {
                remote: true,
                volume_flags: 1,
                directory_flags: Some(0)
            }),
            None
        );
        // Row 7: `\\wsl$` (remote, 9P): same.
        assert_eq!(decode(&remote()), None);

        // A failed directory query is not "flag 0": it must fall back to behavioural probing.
        assert_eq!(decode(&local(1, None)), None);

        // Reverse assertion: no fact set yields a verdict for both axes.
        for facts in [
            local(1, Some(0)),
            local(1, Some(1)),
            local(0, None),
            remote(),
        ] {
            if let Some(semantics) = decode(&facts) {
                assert_eq!(semantics.normalization_insensitive, Tri::Unknown);
            }
        }
    }

    #[test]
    #[ignore = "需特殊卷，转实机 W-20/M-19/L-19"]
    fn native_probe_on_a_special_volume() {
        use crate::platform::case_sensitivity::{CaseSensitivityProbe, NativeCaseSensitivityProbe};
        let root = tempfile::tempdir().unwrap();
        let dir =
            cap_std::fs::Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        // The default NTFS directory is case insensitive.
        assert_eq!(
            NativeCaseSensitivityProbe.probe(&dir).case,
            CaseSensitivity::Insensitive
        );
    }
}
