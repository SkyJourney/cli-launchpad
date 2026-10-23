//! macOS adapter. Everything is queried through the directory descriptor of the
//! project root, never through a path: `fstatfs` names the file system, then
//! `fpathconf(_PC_CASE_SENSITIVE)` and `fgetattrlist(VOL_CAP_FMT_CASE_SENSITIVE)`
//! are trusted only on APFS and HFS+ (and NFS, which may need a network round trip
//! and is bounded by the caller's time budget). smbfs always answers "insensitive"
//! to `pathconf` and is therefore never trusted; every other type is decided by
//! behaviour.

use std::ffi::CStr;
use std::os::fd::AsRawFd;

use cap_std::fs::Dir;

use super::{CaseSensitivity, PathSemantics, Tri};

/// The reply buffer for `ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES`: a length word
/// followed by the capability and valid sets.
#[repr(C)]
struct VolumeCapabilitiesReply {
    length: u32,
    capabilities: libc::vol_capabilities_attr_t,
}

/// `SF_DATALESS` of `sys/stat.h`: the file's data lives in the cloud (iCloud Drive and other
/// File Provider volumes) and opening it may download it.
const SF_DATALESS: u32 = 0x4000_0000;

pub(super) fn flags_mark_dataless(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

/// Whether the entry is dataless. A failed lookup counts as dataless: the entry is then not
/// used for probing.
pub(super) fn is_dataless(root: &Dir, name: &std::ffi::OsStr) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(name) = std::ffi::CString::new(name.as_bytes()) else {
        return true;
    };
    // SAFETY: `stat` is plain old data; an all-zero value is valid.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: the descriptor stays open for the call, `name` is NUL-terminated and `stat` is
    // writable.
    let status = unsafe {
        libc::fstatat(
            root.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    status != 0 || flags_mark_dataless(stat.st_flags)
}

/// What the system said about the file system of the project root.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RawFacts {
    /// `statfs.f_fstypename`, for example `apfs`, `hfs`, `smbfs`, `nfs`, `exfat`.
    fs_type: String,
    /// `fpathconf(_PC_CASE_SENSITIVE)`: 0 insensitive, > 0 sensitive, `None` on any error
    /// (`EINVAL` means "not implemented").
    pathconf: Option<i64>,
    /// `VOL_CAP_FMT_CASE_SENSITIVE`, only when its bit is set in the `valid` mask.
    volume_case_sensitive: Option<bool>,
}

fn case_from_facts(facts: &RawFacts) -> Option<CaseSensitivity> {
    match facts.pathconf {
        Some(0) => Some(CaseSensitivity::Insensitive),
        Some(value) if value > 0 => Some(CaseSensitivity::Sensitive),
        _ => facts.volume_case_sensitive.map(|sensitive| {
            if sensitive {
                CaseSensitivity::Sensitive
            } else {
                CaseSensitivity::Insensitive
            }
        }),
    }
}

fn decode(facts: &RawFacts) -> Option<PathSemantics> {
    match facts.fs_type.as_str() {
        // Both APFS variants and both HFS+ variants are normalization insensitive.
        "apfs" | "hfs" => case_from_facts(facts).map(|case| PathSemantics {
            case,
            normalization_insensitive: Tri::Yes,
        }),
        "nfs" => case_from_facts(facts).map(|case| PathSemantics {
            case,
            normalization_insensitive: Tri::Unknown,
        }),
        // smbfs (pathconf is constant), exfat, msdos, macFUSE/FSKit, unknown types.
        _ => None,
    }
}

pub(super) fn platform_api_step(root: &Dir) -> Option<PathSemantics> {
    collect_facts(root).and_then(|facts| decode(&facts))
}

/// macFUSE, FUSE-T and osxfuse are libfuse based: without `use_ino` two names of
/// one file can show different inodes, so "found but different identity" proves nothing.
pub(super) fn identity_is_reliable(root: &Dir) -> bool {
    file_system_type_name(root.as_raw_fd())
        .is_some_and(|name| !name.to_ascii_lowercase().contains("fuse"))
}

fn file_system_type_name(fd: libc::c_int) -> Option<String> {
    // SAFETY: `statfs` is plain old data; an all-zero value is valid.
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: `fd` stays open for the call and `stat` is a writable `statfs`.
    if unsafe { libc::fstatfs(fd, &mut stat) } != 0 {
        return None;
    }
    // SAFETY: `f_fstypename` is a NUL-terminated array filled in by `fstatfs`.
    Some(
        unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
    )
}

fn collect_facts(root: &Dir) -> Option<RawFacts> {
    let fd = root.as_raw_fd();
    let fs_type = file_system_type_name(fd)?;
    // Only these types are asked: the calls below can cost a network round trip on
    // other network volumes (smbfs, afp, webdav) and their answers are not trusted.
    if !matches!(fs_type.as_str(), "apfs" | "hfs" | "nfs") {
        return Some(RawFacts {
            fs_type,
            pathconf: None,
            volume_case_sensitive: None,
        });
    }

    // SAFETY: `fd` is open; `fpathconf` writes nothing through pointers.
    let value = unsafe { libc::fpathconf(fd, libc::_PC_CASE_SENSITIVE) };
    let pathconf = (value != -1).then_some(i64::from(value));

    Some(RawFacts {
        fs_type,
        pathconf,
        volume_case_sensitive: volume_case_sensitive(fd),
    })
}

fn volume_case_sensitive(fd: libc::c_int) -> Option<bool> {
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut reply = VolumeCapabilitiesReply {
        length: 0,
        capabilities: libc::vol_capabilities_attr_t {
            capabilities: [0; 4],
            valid: [0; 4],
        },
    };
    // SAFETY: `list` and `reply` are writable, `reply` is large enough for the requested
    // attributes (a length word plus two 16-byte capability sets) and `fd` is open.
    let status = unsafe {
        libc::fgetattrlist(
            fd,
            (&mut list as *mut libc::attrlist).cast(),
            (&mut reply as *mut VolumeCapabilitiesReply).cast(),
            std::mem::size_of::<VolumeCapabilitiesReply>(),
            0,
        )
    };
    if status != 0 {
        return None;
    }
    // The bit means something only when the file system declared it valid.
    let format = libc::VOL_CAPABILITIES_FORMAT;
    if reply.capabilities.valid[format] & libc::VOL_CAP_FMT_CASE_SENSITIVE == 0 {
        return None;
    }
    Some(reply.capabilities.capabilities[format] & libc::VOL_CAP_FMT_CASE_SENSITIVE != 0)
}

#[cfg(test)]
mod tests {
    use super::{decode, CaseSensitivity, PathSemantics, RawFacts, Tri};

    fn facts(fs_type: &str, pathconf: Option<i64>, volume: Option<bool>) -> RawFacts {
        RawFacts {
            fs_type: fs_type.to_owned(),
            pathconf,
            volume_case_sensitive: volume,
        }
    }

    fn semantics(case: CaseSensitivity, normalization: Tri) -> Option<PathSemantics> {
        Some(PathSemantics {
            case,
            normalization_insensitive: normalization,
        })
    }

    #[test]
    fn adapter_decoding_matches_the_confirmed_matrix() {
        use CaseSensitivity::{Insensitive, Sensitive};
        // Row 1: APFS, case insensitive (the default volume).
        assert_eq!(
            decode(&facts("apfs", Some(0), Some(false))),
            semantics(Insensitive, Tri::Yes)
        );
        // Row 2: APFS, case sensitive; the normalization axis stays `Yes`.
        assert_eq!(
            decode(&facts("apfs", Some(1), Some(true))),
            semantics(Sensitive, Tri::Yes)
        );
        // Row 3: HFS+ case insensitive (journaled).
        assert_eq!(
            decode(&facts("hfs", Some(0), None)),
            semantics(Insensitive, Tri::Yes)
        );
        // Row 4: HFS+ case sensitive (HFSX).
        assert_eq!(
            decode(&facts("hfs", Some(1), None)),
            semantics(Sensitive, Tri::Yes)
        );
        // Row 5: exFAT: the driver is closed source, its answers are not trusted.
        assert_eq!(decode(&facts("exfat", Some(0), Some(false))), None);
        // Row 6: smbfs answers 0 for everything: never trusted.
        assert_eq!(decode(&facts("smbfs", Some(0), Some(false))), None);
        // Row 7: NFS: trusted only when the server answered; version 2 returns EINVAL.
        assert_eq!(
            decode(&facts("nfs", Some(0), None)),
            semantics(Insensitive, Tri::Unknown)
        );
        assert_eq!(decode(&facts("nfs", None, None)), None);

        // pathconf failed but the volume capabilities are valid.
        assert_eq!(
            decode(&facts("apfs", None, Some(true))),
            semantics(Sensitive, Tri::Yes)
        );
        assert_eq!(
            decode(&facts("apfs", None, Some(false))),
            semantics(Insensitive, Tri::Yes)
        );
        // Both sources failed (the `valid` bit was unset): behavioural probing decides.
        assert_eq!(decode(&facts("apfs", None, None)), None);
        // Other types and macFUSE/FSKit mounts.
        assert_eq!(decode(&facts("msdos", Some(0), None)), None);
        assert_eq!(decode(&facts("macfuse", Some(1), None)), None);
    }

    #[test]
    fn dataless_flag_is_recognised() {
        use super::flags_mark_dataless;
        assert!(flags_mark_dataless(0x4000_0000));
        assert!(flags_mark_dataless(0x4000_0000 | 0x20));
        // Reverse: other flags (hidden, immutable, compressed) do not make a file dataless.
        assert!(!flags_mark_dataless(0));
        assert!(!flags_mark_dataless(
            0x0000_8000 | 0x0000_0002 | 0x0020_0000
        ));
    }

    #[test]
    #[ignore = "需特殊卷，转实机 W-20/M-19/L-19"]
    fn native_probe_on_a_special_volume() {
        use crate::platform::case_sensitivity::{CaseSensitivityProbe, NativeCaseSensitivityProbe};
        let root = tempfile::tempdir().unwrap();
        let dir =
            cap_std::fs::Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        // The default APFS volume is case insensitive.
        assert_eq!(
            NativeCaseSensitivityProbe.probe(&dir).case,
            CaseSensitivity::Insensitive
        );
    }
}
