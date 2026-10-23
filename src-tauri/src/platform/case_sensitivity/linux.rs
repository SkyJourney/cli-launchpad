//! Linux adapter. No single API answers "is the project root case sensitive":
//! only ext4, f2fs and tmpfs carry an authoritative per-directory bit
//! (`FS_CASEFOLD_FL` through `FS_IOC_GETFLAGS`). Other types are decided by their
//! mount options (vfat, ntfs3, cifs) or by their type alone (btrfs, exfat); FUSE,
//! the two ntfs drivers that share one magic number, nfs and zfs fall through to
//! behavioural probing. A set `FS_CASEFOLD_FL` is trusted on every type (kernel
//! 7.2 reports it widely); an unset bit means "case sensitive" only on ext4,
//! f2fs and tmpfs, and the design never depends on kernel 7.2.

use std::fs;
use std::os::fd::AsRawFd;

use cap_std::fs::{Dir, MetadataExt, OpenOptions};

use super::{CaseSensitivity, PathSemantics, Tri};

// `f_type` magic numbers. libc lacks some of them; values are from
// `include/uapi/linux/magic.h` (v7.2) and the file system sources.
const EXT4_SUPER_MAGIC: u64 = 0xEF53;
const F2FS_SUPER_MAGIC: u64 = 0xF2F5_2010;
const TMPFS_MAGIC: u64 = 0x0102_1994;
const BTRFS_SUPER_MAGIC: u64 = 0x9123_683E;
const EXFAT_SUPER_MAGIC: u64 = 0x2011_BAB0;
const MSDOS_SUPER_MAGIC: u64 = 0x4d44;
const NTFS3_SUPER_MAGIC: u64 = 0x7366_746e;
const FUSE_SUPER_MAGIC: u64 = 0x6573_5546;
const CIFS_SUPER_MAGIC: u64 = 0xFF53_4D42;
/// SMB2 and SMB3 mounts of the cifs client report this value (`fs/smb/client/smb2ops.c`,
/// `smb2_statfs`), not `CIFS_SUPER_MAGIC`.
const SMB2_SUPER_MAGIC: u64 = 0xFE53_4D42;
/// `FS_CASEFOLD_FL` of `include/uapi/linux/fs.h`; libc does not define it.
const FS_CASEFOLD_FL: u32 = 0x4000_0000;

/// Super-block options of the mount that holds the project root
/// (`/proc/self/mountinfo`, last field).
type MountOptions = Vec<String>;

/// What the kernel said about the file system of the project root.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RawFacts {
    /// `statfs.f_type`.
    fs_type: u64,
    /// `FS_CASEFOLD_FL` from `FS_IOC_GETFLAGS`; `None` when the ioctl failed.
    casefold: Option<bool>,
    /// `None` when the options could not be read or identified.
    mount_options: Option<MountOptions>,
}

fn has_option(options: &MountOptions, name: &str) -> bool {
    options
        .iter()
        .any(|option| option == name || option.starts_with(&format!("{name}=")))
}

fn option_value<'a>(options: &'a MountOptions, name: &str) -> Option<&'a str> {
    options
        .iter()
        .find_map(|option| option.strip_prefix(&format!("{name}=")))
}

fn decode(facts: &RawFacts) -> Option<PathSemantics> {
    use CaseSensitivity::{Insensitive, Sensitive};
    // The normalization axis is `Yes` only where it is verified: casefold directories.
    let case_only = |case| PathSemantics {
        case,
        normalization_insensitive: Tri::Unknown,
    };
    match facts.fs_type {
        EXT4_SUPER_MAGIC | F2FS_SUPER_MAGIC | TMPFS_MAGIC => match facts.casefold? {
            true => Some(PathSemantics {
                case: Insensitive,
                normalization_insensitive: Tri::Yes,
            }),
            false => Some(case_only(Sensitive)),
        },
        // Every other type: a set bit is trusted, an unset bit proves nothing.
        _ if facts.casefold == Some(true) => Some(case_only(Insensitive)),
        BTRFS_SUPER_MAGIC => Some(case_only(Sensitive)),
        EXFAT_SUPER_MAGIC => Some(case_only(Insensitive)),
        MSDOS_SUPER_MAGIC => {
            let options = facts.mount_options.as_ref()?;
            if option_value(options, "check") == Some("s") {
                Some(case_only(Sensitive))
            } else if option_value(options, "iocharset") == Some("utf8") {
                // ASCII is not folded either; behaviour decides.
                None
            } else {
                Some(case_only(Insensitive))
            }
        }
        NTFS3_SUPER_MAGIC => {
            let options = facts.mount_options.as_ref()?;
            Some(case_only(if has_option(options, "nocase") {
                Insensitive
            } else {
                Sensitive
            }))
        }
        CIFS_SUPER_MAGIC | SMB2_SUPER_MAGIC => {
            let options = facts.mount_options.as_ref()?;
            if has_option(options, "nocase") || has_option(options, "ignorecase") {
                Some(case_only(Insensitive))
            } else {
                // Without `nocase` the server decides.
                None
            }
        }
        // ntfs (the new and the old driver share 0x5346544e), FUSE, nfs, zfs, unknown types.
        _ => None,
    }
}

pub(super) fn platform_api_step(root: &Dir) -> Option<PathSemantics> {
    collect_facts(root).and_then(|facts| decode(&facts))
}

/// Two names of one file can show different inodes on FUSE without `use_ino` and
/// on cifs with `noserverino`, so "found but different identity" proves nothing there.
pub(super) fn identity_is_reliable(root: &Dir) -> bool {
    !matches!(
        file_system_type(root.as_raw_fd()),
        Some(FUSE_SUPER_MAGIC) | Some(CIFS_SUPER_MAGIC) | Some(SMB2_SUPER_MAGIC) | None
    )
}

fn file_system_type(fd: libc::c_int) -> Option<u64> {
    // SAFETY: `statfs` is plain old data; an all-zero value is valid.
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: `fd` stays open for the call and `stat` is a writable `statfs`.
    if unsafe { libc::fstatfs(fd, &mut stat) } != 0 {
        return None;
    }
    // `f_type` is signed or 32-bit on some targets; every magic number fits in 32 bits.
    Some(u64::from(stat.f_type as u32))
}

fn collect_facts(root: &Dir) -> Option<RawFacts> {
    // cap-std opens directories with `O_PATH`, which `ioctl` rejects with `EBADF`:
    // ask through a plain read-only descriptor of the same directory.
    let mut options = OpenOptions::new();
    options.read(true);
    let readable = root.open_with(".", &options).ok()?;
    let fd = readable.as_raw_fd();
    let fs_type = file_system_type(fd)?;

    // A 32-bit buffer: the kernel writes an `unsigned int`, not a `long`.
    let mut flags: u32 = 0;
    // SAFETY: `fd` is an open directory and `flags` is a writable 4-byte buffer.
    let ioctl_status =
        unsafe { libc::ioctl(fd, libc::FS_IOC_GETFLAGS as _, &mut flags as *mut u32) };
    let casefold = (ioctl_status == 0).then_some(flags & FS_CASEFOLD_FL != 0);

    // Only these types are decided by their mount options.
    let needs_options = matches!(
        fs_type,
        MSDOS_SUPER_MAGIC | NTFS3_SUPER_MAGIC | CIFS_SUPER_MAGIC | SMB2_SUPER_MAGIC
    );
    Some(RawFacts {
        fs_type,
        casefold,
        mount_options: if needs_options {
            mount_options_of(root)
        } else {
            None
        },
    })
}

fn mount_options_of(root: &Dir) -> Option<MountOptions> {
    let device = root.dir_metadata().ok()?.dev();
    let text = fs::read_to_string("/proc/self/mountinfo").ok()?;
    let (major, minor) = (libc::major(device), libc::minor(device));
    parse_mountinfo(&text, major, minor)
}

/// Super-block options of the mount(s) of device `major:minor`. Several lines for one
/// device (bind mounts) are accepted only when their super-block options agree; per-mount
/// options such as `ro` are not what decides case handling.
fn parse_mountinfo(text: &str, major: u32, minor: u32) -> Option<MountOptions> {
    let wanted = format!("{major}:{minor}");
    let mut found: Option<MountOptions> = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // `id parent major:minor root mount-point mount-options [optional...] - type source super-options`
        if fields.len() < 10 || fields[2] != wanted {
            continue;
        }
        let Some(separator) = fields.iter().position(|field| *field == "-") else {
            continue;
        };
        if fields.len() < separator + 4 {
            continue;
        }
        let mut options: MountOptions = fields[separator + 3]
            .split(',')
            .filter(|option| !option.is_empty())
            .map(str::to_owned)
            .collect();
        options.sort();
        match &found {
            None => found = Some(options),
            Some(previous) if *previous == options => {}
            Some(_) => return None,
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::{
        decode, parse_mountinfo, CaseSensitivity, PathSemantics, RawFacts, Tri, BTRFS_SUPER_MAGIC,
        CIFS_SUPER_MAGIC, EXFAT_SUPER_MAGIC, EXT4_SUPER_MAGIC, F2FS_SUPER_MAGIC, FUSE_SUPER_MAGIC,
        MSDOS_SUPER_MAGIC, NTFS3_SUPER_MAGIC, SMB2_SUPER_MAGIC, TMPFS_MAGIC,
    };

    fn facts(fs_type: u64, casefold: Option<bool>, options: Option<&[&str]>) -> RawFacts {
        RawFacts {
            fs_type,
            casefold,
            mount_options: options
                .map(|options| options.iter().map(|option| (*option).to_owned()).collect()),
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
        use CaseSensitivity::{Insensitive, Sensitive};
        // Row 1: ext4 default (the casefold bit is clear).
        assert_eq!(
            decode(&facts(EXT4_SUPER_MAGIC, Some(false), None)),
            case_only(Sensitive)
        );
        // Row 2: ext4 casefold directory (and f2fs): insensitive, NFC and NFD are one name.
        let casefold = Some(PathSemantics {
            case: Insensitive,
            normalization_insensitive: Tri::Yes,
        });
        assert_eq!(decode(&facts(EXT4_SUPER_MAGIC, Some(true), None)), casefold);
        assert_eq!(decode(&facts(F2FS_SUPER_MAGIC, Some(true), None)), casefold);
        // The ioctl failed: not "sensitive"; behaviour decides.
        assert_eq!(decode(&facts(EXT4_SUPER_MAGIC, None, None)), None);
        // Row 3: tmpfs.
        assert_eq!(
            decode(&facts(TMPFS_MAGIC, Some(false), None)),
            case_only(Sensitive)
        );
        assert_eq!(decode(&facts(TMPFS_MAGIC, Some(true), None)), casefold);
        // Row 4a: vfat: default is insensitive, `check=s` is strict, `iocharset=utf8` is left to behaviour.
        assert_eq!(
            decode(&facts(
                MSDOS_SUPER_MAGIC,
                None,
                Some(&["rw", "iocharset=iso8859-1"])
            )),
            case_only(Insensitive)
        );
        assert_eq!(
            decode(&facts(MSDOS_SUPER_MAGIC, None, Some(&["rw", "check=s"]))),
            case_only(Sensitive)
        );
        assert_eq!(
            decode(&facts(
                MSDOS_SUPER_MAGIC,
                None,
                Some(&["rw", "iocharset=utf8"])
            )),
            None
        );
        assert_eq!(decode(&facts(MSDOS_SUPER_MAGIC, None, None)), None);
        // Row 4b: the in-kernel exfat driver is insensitive by type.
        assert_eq!(
            decode(&facts(EXFAT_SUPER_MAGIC, None, None)),
            case_only(Insensitive)
        );
        // Row 5: ntfs-3g runs on FUSE; the magic number tells nothing, behaviour decides.
        assert_eq!(decode(&facts(FUSE_SUPER_MAGIC, Some(false), None)), None);
        // Row 6: ntfs3 is sensitive unless mounted with `nocase`. The shared ntfs magic 0x5346544e is not decodable.
        assert_eq!(
            decode(&facts(NTFS3_SUPER_MAGIC, None, Some(&["rw"]))),
            case_only(Sensitive)
        );
        assert_eq!(
            decode(&facts(NTFS3_SUPER_MAGIC, None, Some(&["rw", "nocase"]))),
            case_only(Insensitive)
        );
        assert_eq!(decode(&facts(NTFS3_SUPER_MAGIC, None, None)), None);
        assert_eq!(decode(&facts(0x5346_544e, None, Some(&["rw"]))), None);
        // Row 7: cifs: `nocase` makes the client insensitive, otherwise the server decides.
        assert_eq!(
            decode(&facts(CIFS_SUPER_MAGIC, None, Some(&["rw", "nocase"]))),
            case_only(Insensitive)
        );
        assert_eq!(decode(&facts(CIFS_SUPER_MAGIC, None, Some(&["rw"]))), None);
        // SMB2 and SMB3 mounts use their own magic number and follow the same rule.
        assert_eq!(
            decode(&facts(SMB2_SUPER_MAGIC, None, Some(&["rw", "nocase"]))),
            case_only(Insensitive)
        );
        assert_eq!(decode(&facts(SMB2_SUPER_MAGIC, None, Some(&["rw"]))), None);
        // Row 8: nfs: the client does not fold; the server decides.
        assert_eq!(decode(&facts(0x6969, Some(false), None)), None);
        // Row 9: zfs has no ioctl bit: behaviour decides.
        assert_eq!(decode(&facts(0x2fc1_2fc1, Some(false), None)), None);
        // Row 10: btrfs is sensitive by type.
        assert_eq!(
            decode(&facts(BTRFS_SUPER_MAGIC, None, None)),
            case_only(Sensitive)
        );

        // Kernel 7.2: a set bit is trusted on any type, an unset bit proves nothing.
        assert_eq!(
            decode(&facts(0x6969, Some(true), None)),
            case_only(Insensitive)
        );
        assert_eq!(
            decode(&facts(NTFS3_SUPER_MAGIC, Some(true), Some(&["rw"]))),
            case_only(Insensitive)
        );
        assert_eq!(
            decode(&facts(CIFS_SUPER_MAGIC, Some(false), Some(&["rw"]))),
            None
        );
        // Unknown types.
        assert_eq!(decode(&facts(0x1234, None, None)), None);
    }

    #[test]
    fn the_casefold_ioctl_works_on_the_temporary_directory() {
        // Regression: the directory handle of cap-std is `O_PATH` and `ioctl` fails on it, which
        // used to turn every casefold answer into `None`.
        let root = tempfile::tempdir().unwrap();
        let dir =
            cap_std::fs::Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let facts = super::collect_facts(&dir).expect("statfs must work");
        if matches!(
            facts.fs_type,
            EXT4_SUPER_MAGIC | TMPFS_MAGIC | F2FS_SUPER_MAGIC
        ) {
            assert_eq!(facts.casefold, Some(false), "{facts:?}");
            assert_eq!(
                super::platform_api_step(&dir).map(|semantics| semantics.case),
                Some(CaseSensitivity::Sensitive)
            );
        }
    }

    #[test]
    fn mountinfo_options_are_read_per_device() {
        let text = "\
36 35 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro
40 36 7:0 / /mnt/usb rw,nosuid master:2 - vfat /dev/loop0 rw,check=s,iocharset=utf8
41 36 7:0 /dir /mnt/bind rw,nosuid master:2 - vfat /dev/loop0 rw,check=n
50 36 7:1 / /mnt/ro ro,nosuid - ntfs3 /dev/loop1 rw,nocase
51 36 7:1 /sub /mnt/ro2 rw,relatime - ntfs3 /dev/loop1 rw,nocase
";
        let root = parse_mountinfo(text, 8, 1).unwrap();
        assert!(root.contains(&"errors=remount-ro".to_owned()));
        // Per-mount options are not part of the result.
        assert!(!root.contains(&"relatime".to_owned()));
        // Two lines for one device that disagree: the options are not trusted.
        assert_eq!(parse_mountinfo(text, 7, 0), None);
        // Bind mounts that differ only in per-mount options still agree.
        assert_eq!(
            parse_mountinfo(text, 7, 1),
            Some(vec!["nocase".to_owned(), "rw".to_owned()])
        );
        // Unknown device.
        assert_eq!(parse_mountinfo(text, 9, 9), None);
    }

    #[test]
    #[ignore = "需特殊卷，转实机 W-20/M-19/L-19"]
    fn native_probe_on_a_special_volume() {
        use crate::platform::case_sensitivity::{CaseSensitivityProbe, NativeCaseSensitivityProbe};
        let root = tempfile::tempdir().unwrap();
        let dir =
            cap_std::fs::Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        // The result depends on the volume; it must be one of the three states and not panic.
        let semantics = NativeCaseSensitivityProbe.probe(&dir);
        assert!(matches!(
            semantics.case,
            CaseSensitivity::Sensitive | CaseSensitivity::Insensitive | CaseSensitivity::Unknown
        ));
    }
}
