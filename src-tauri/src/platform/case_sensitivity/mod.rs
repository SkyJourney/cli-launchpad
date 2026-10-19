//! Case and Unicode-normalization semantics of the location a project lives on
//! (PD-10).
//!
//! The probe chain is: platform API (per adapter) -> an existing entry with its
//! ASCII letters flipped (read-only) -> a temporary probe file (last resort)
//! -> `Unknown`. `Unknown` never folds; a file-identity check stays the safety
//! net for every merge. Probing is synchronous: the caller owns the time
//! budget (2 seconds, `spawn_blocking` plus a timeout) and maps a timeout to
//! `PathSemantics::UNKNOWN`.

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::time::{Duration, SystemTime};

use cap_std::fs::{Dir, MetadataExt, OpenOptions};
use serde::{Deserialize, Serialize};

use super::file_identity::of_entry;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux::{identity_is_reliable, platform_api_step};
#[cfg(target_os = "macos")]
use macos::{identity_is_reliable, platform_api_step};
#[cfg(windows)]
use windows::{identity_is_reliable, platform_api_step};

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_api_step(_root: &Dir) -> Option<PathSemantics> {
    None
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn identity_is_reliable(_root: &Dir) -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaseSensitivity {
    Sensitive,
    Insensitive,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tri {
    Yes,
    No,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSemantics {
    pub case: CaseSensitivity,
    pub normalization_insensitive: Tri,
}

impl PathSemantics {
    pub const UNKNOWN: PathSemantics = PathSemantics {
        case: CaseSensitivity::Unknown,
        normalization_insensitive: Tri::Unknown,
    };
}

pub trait CaseSensitivityProbe: Send + Sync {
    fn probe(&self, root: &Dir) -> PathSemantics;
}

pub struct NativeCaseSensitivityProbe;

impl CaseSensitivityProbe for NativeCaseSensitivityProbe {
    fn probe(&self, root: &Dir) -> PathSemantics {
        probe_with_steps(
            root,
            &ProbeSteps {
                platform_api: &platform_api_step,
                existing_entry_flip: &existing_entry_flip_step,
                temp_file: &temp_file_step,
            },
        )
    }
}

/// Test double with a call counter (the counter is why this is a struct and not
/// a tuple struct).
#[cfg(test)]
pub struct FixedCaseSensitivityProbe {
    pub semantics: PathSemantics,
    pub calls: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl FixedCaseSensitivityProbe {
    pub fn new(semantics: PathSemantics) -> Self {
        Self {
            semantics,
            calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
impl CaseSensitivityProbe for FixedCaseSensitivityProbe {
    fn probe(&self, _root: &Dir) -> PathSemantics {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.semantics
    }
}

pub struct ProbeSteps<'a> {
    /// Step 1: platform API. `Some` is a conclusion (an adapter may leave one axis
    /// `Unknown`); `None` means "cannot tell", move on to the next step.
    pub platform_api: &'a dyn Fn(&Dir) -> Option<PathSemantics>,
    /// Step 2a: an existing entry with its ASCII letters flipped (read-only).
    pub existing_entry_flip: &'a dyn Fn(&Dir) -> Option<CaseSensitivity>,
    /// Step 2b: create a temporary file and look up its flipped name (last resort).
    pub temp_file: &'a dyn Fn(&Dir) -> Option<CaseSensitivity>,
}

pub fn probe_with_steps(root: &Dir, steps: &ProbeSteps) -> PathSemantics {
    clean_stale_probe_files(root);
    if let Some(semantics) = (steps.platform_api)(root) {
        return semantics;
    }
    // Behaviour cannot decide the normalization axis, so it stays `Unknown`.
    if let Some(case) = (steps.existing_entry_flip)(root) {
        return behavioral(case);
    }
    if let Some(case) = (steps.temp_file)(root) {
        return behavioral(case);
    }
    PathSemantics::UNKNOWN
}

fn behavioral(case: CaseSensitivity) -> PathSemantics {
    PathSemantics {
        case,
        normalization_insensitive: Tri::Unknown,
    }
}

/// Prefix of the temporary files this module creates; hidden from file listings.
pub const CASE_PROBE_PREFIX: &str = ".clp-case-probe-";
const STALE_PROBE_AGE: Duration = Duration::from_secs(60);
const MAX_ENTRIES_SCANNED: usize = 2000;

pub fn is_case_probe_residue_name(name: &str) -> bool {
    name.starts_with(CASE_PROBE_PREFIX)
}

/// Removes probe files a crashed run left behind. Fresh files are kept because
/// another probe may still be using them. Errors are ignored.
fn clean_stale_probe_files(root: &Dir) {
    let Ok(entries) = root.entries() else {
        return;
    };
    for entry in entries.take(MAX_ENTRIES_SCANNED).flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !is_case_probe_residue_name(name) {
            continue;
        }
        let Ok(metadata) = root.symlink_metadata(&file_name) else {
            continue;
        };
        if !metadata.is_file() || link_count(root, &file_name, &metadata) != Some(1) {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .map(|modified| modified.into_std())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > STALE_PROBE_AGE);
        if stale {
            if let Err(error) = root.remove_file(&file_name) {
                log::debug!("无法清理大小写探测残留 {name}: {error}");
            }
        }
    }
}

/// Number of names the entry has. On Windows the metadata of a directory listing
/// does not carry it, so the file is opened (only called for entries that are
/// not reparse points).
fn link_count(root: &Dir, name: &OsStr, metadata: &cap_std::fs::Metadata) -> Option<u64> {
    #[cfg(unix)]
    {
        let _ = (root, name);
        Some(metadata.nlink())
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        windows_link_count(root, name)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (root, name, metadata);
        None
    }
}

#[cfg(windows)]
fn windows_link_count(root: &Dir, name: &OsStr) -> Option<u64> {
    use std::os::windows::io::AsRawHandle;

    use cap_std::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    // Attribute access only: no data is read and nothing is recalled from the cloud.
    let mut options = OpenOptions::new();
    options.read(true);
    options.access_mode(FILE_READ_ATTRIBUTES);
    options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    let file = root.open_with(name, &options).ok()?.into_std();
    // SAFETY: `BY_HANDLE_FILE_INFORMATION` is plain old data and `file` is an open handle.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
        return None;
    }
    Some(u64::from(information.nNumberOfLinks))
}

/// A regular file, not a link or reparse point (cloud placeholders are reparse
/// points and must not be opened), with exactly one name.
fn is_probe_candidate(root: &Dir, name: &OsStr, metadata: &cap_std::fs::Metadata) -> bool {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        // Reparse points, offline files and cloud placeholders must not be opened.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
        const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
        const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
        const UNSAFE_TO_OPEN: u32 = FILE_ATTRIBUTE_REPARSE_POINT
            | FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_RECALL_ON_OPEN
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
        if metadata.file_attributes() & UNSAFE_TO_OPEN != 0 {
            return false;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if macos::is_dataless(root, name) {
            return false;
        }
    }
    link_count(root, name, metadata) == Some(1)
}

fn flip_ascii_case(name: &str) -> String {
    name.chars()
        .map(|character| {
            if character.is_ascii_lowercase() {
                character.to_ascii_uppercase()
            } else {
                character.to_ascii_lowercase()
            }
        })
        .collect()
}

/// Looks `flipped` up next to `original` and decides from what the lookup finds.
fn case_from_flipped_lookup(
    root: &Dir,
    original: &OsStr,
    flipped: &OsStr,
) -> Option<CaseSensitivity> {
    match root.symlink_metadata(flipped) {
        Err(error) if error.kind() == ErrorKind::NotFound => Some(CaseSensitivity::Sensitive),
        Err(_) => None,
        Ok(_) => {
            let original_identity = of_entry(root, original).ok()?;
            let flipped_identity = of_entry(root, flipped).ok()?;
            if original_identity == flipped_identity {
                Some(CaseSensitivity::Insensitive)
            } else if identity_is_reliable(root) {
                log::debug!("存在仅大小写不同的两个文件，按区分大小写处理");
                Some(CaseSensitivity::Sensitive)
            } else {
                // FUSE without `use_ino` and cifs `noserverino` can hand out
                // different inodes for two names of one file.
                None
            }
        }
    }
}

fn existing_entry_flip_step(root: &Dir) -> Option<CaseSensitivity> {
    let entries = root.entries().ok()?;
    for entry in entries.take(MAX_ENTRIES_SCANNED).flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if is_case_probe_residue_name(name) {
            continue;
        }
        let flipped = flip_ascii_case(name);
        if flipped == name {
            continue;
        }
        let Ok(metadata) = root.symlink_metadata(&file_name) else {
            continue;
        };
        if !is_probe_candidate(root, &file_name, &metadata) {
            continue;
        }
        return case_from_flipped_lookup(root, &file_name, OsStr::new(&flipped));
    }
    None
}

/// Deletes the probe file on every exit path, including a panic.
struct ProbeFileGuard<'a> {
    root: &'a Dir,
    name: String,
}

impl Drop for ProbeFileGuard<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.root.remove_file(&self.name) {
            log::debug!("无法删除大小写探测文件 {}: {error}", self.name);
        }
    }
}

fn random_probe_name() -> String {
    for _ in 0..8 {
        let simple = uuid::Uuid::new_v4().simple().to_string();
        let suffix = &simple[..16];
        if suffix
            .chars()
            .any(|character| character.is_ascii_lowercase())
        {
            return format!("{CASE_PROBE_PREFIX}{suffix}");
        }
    }
    // Eight all-digit draws in a row cannot realistically happen; keep a letter anyway.
    format!(
        "{CASE_PROBE_PREFIX}a{}",
        &uuid::Uuid::new_v4().simple().to_string()[..15]
    )
}

fn temp_file_step(root: &Dir) -> Option<CaseSensitivity> {
    probe_with_temp_file(root, &random_probe_name(), &|root, original, flipped| {
        case_from_flipped_lookup(root, OsStr::new(original), OsStr::new(flipped))
    })
}

/// `query` runs after the file exists; the guard removes the file whether it
/// returns, fails or panics. A file that cannot be created (read-only root,
/// name already taken) is left alone and yields `None`.
fn probe_with_temp_file(
    root: &Dir,
    name: &str,
    query: &dyn Fn(&Dir, &str, &str) -> Option<CaseSensitivity>,
) -> Option<CaseSensitivity> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    root.open_with(name, &options).ok()?;
    let _guard = ProbeFileGuard {
        root,
        name: name.to_owned(),
    };
    let flipped = flip_ascii_case(name);
    query(root, name, &flipped)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::time::{Duration, SystemTime};

    use cap_std::fs::Dir;
    use serde_json::json;

    use super::{
        clean_stale_probe_files, existing_entry_flip_step, is_case_probe_residue_name,
        probe_with_steps, probe_with_temp_file, CaseSensitivity, PathSemantics, ProbeSteps, Tri,
        CASE_PROBE_PREFIX,
    };

    fn directory() -> (tempfile::TempDir, Dir) {
        let root = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        (root, dir)
    }

    fn names(root: &tempfile::TempDir) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn insensitive_no() -> PathSemantics {
        PathSemantics {
            case: CaseSensitivity::Insensitive,
            normalization_insensitive: Tri::No,
        }
    }

    #[test]
    fn path_semantics_serializes_as_camel_case_strings() {
        let value = serde_json::to_value(insensitive_no()).unwrap();
        assert_eq!(
            value,
            json!({ "case": "insensitive", "normalizationInsensitive": "no" })
        );
        assert!(value.get("normalization_insensitive").is_none());
        assert_eq!(
            serde_json::to_value(PathSemantics::UNKNOWN).unwrap(),
            json!({ "case": "unknown", "normalizationInsensitive": "unknown" })
        );
        for semantics in [insensitive_no(), PathSemantics::UNKNOWN] {
            let round_trip: PathSemantics =
                serde_json::from_value(serde_json::to_value(semantics).unwrap()).unwrap();
            assert_eq!(round_trip, semantics);
        }
    }

    #[test]
    fn probe_chain_short_circuits_in_order() {
        // 1. The platform API decides: the other steps never run and nothing is created.
        let (root, dir) = directory();
        fs::write(root.path().join("Readme.md"), b"x").unwrap();
        let before = names(&root);
        let flip_calls = Cell::new(0);
        let temp_calls = Cell::new(0);
        let decided = probe_with_steps(
            &dir,
            &ProbeSteps {
                platform_api: &|_| Some(insensitive_no()),
                existing_entry_flip: &|_| {
                    flip_calls.set(flip_calls.get() + 1);
                    None
                },
                temp_file: &|_| {
                    temp_calls.set(temp_calls.get() + 1);
                    None
                },
            },
        );
        assert_eq!(decided, insensitive_no());
        assert_eq!((flip_calls.get(), temp_calls.get()), (0, 0));
        assert_eq!(names(&root), before);

        // 2. No platform answer, a candidate exists: the read-only flip decides, no file is created.
        let temp_calls = Cell::new(0);
        let flipped = probe_with_steps(
            &dir,
            &ProbeSteps {
                platform_api: &|_| None,
                existing_entry_flip: &existing_entry_flip_step,
                temp_file: &|_| {
                    temp_calls.set(temp_calls.get() + 1);
                    None
                },
            },
        );
        assert!(matches!(
            flipped.case,
            CaseSensitivity::Sensitive | CaseSensitivity::Insensitive
        ));
        // Reverse assertion: behavioural probing never decides the normalization axis.
        assert_eq!(flipped.normalization_insensitive, Tri::Unknown);
        assert_eq!(temp_calls.get(), 0);
        assert_eq!(names(&root), before);

        // 3. An empty root: the flip has no candidate, the real temporary file step runs
        //    and leaves the root empty again.
        let (empty_root, empty) = directory();
        let from_temp = probe_with_steps(
            &empty,
            &ProbeSteps {
                platform_api: &|_| None,
                existing_entry_flip: &existing_entry_flip_step,
                temp_file: &super::temp_file_step,
            },
        );
        assert!(matches!(
            from_temp.case,
            CaseSensitivity::Sensitive | CaseSensitivity::Insensitive
        ));
        assert_eq!(from_temp.normalization_insensitive, Tri::Unknown);
        assert!(names(&empty_root).is_empty());

        // 4. A read-only root with no entry that has a letter: nothing can be created.
        #[cfg(unix)]
        read_only_root_without_candidates_is_unknown();

        // 5. Nothing answers: Unknown.
        let nothing = probe_with_steps(
            &dir,
            &ProbeSteps {
                platform_api: &|_| None,
                existing_entry_flip: &|_| None,
                temp_file: &|_| None,
            },
        );
        assert_eq!(nothing, PathSemantics::UNKNOWN);
    }

    #[cfg(unix)]
    fn read_only_root_without_candidates_is_unknown() {
        use std::os::unix::fs::PermissionsExt;
        // A superuser can write anywhere; the premise of this case does not hold for it.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (root, dir) = directory();
        fs::write(root.path().join("123"), b"x").unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let result = probe_with_steps(
            &dir,
            &ProbeSteps {
                platform_api: &|_| None,
                existing_entry_flip: &existing_entry_flip_step,
                temp_file: &super::temp_file_step,
            },
        );
        let listing = names(&root);
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result, PathSemantics::UNKNOWN);
        assert_eq!(listing, vec!["123".to_owned()]);
    }

    #[test]
    fn temp_probe_leaves_no_file_on_any_path() {
        let (root, dir) = directory();
        let probe_files = |root: &tempfile::TempDir| -> Vec<String> {
            names(root)
                .into_iter()
                .filter(|name| name.starts_with(CASE_PROBE_PREFIX))
                .collect()
        };

        // Success: the lookup of the flipped name runs against the real file system.
        let seen = Cell::new(false);
        let outcome = probe_with_temp_file(
            &dir,
            &format!("{CASE_PROBE_PREFIX}abcdef0123456789"),
            &|root, original, flipped| {
                seen.set(true);
                assert!(
                    root.symlink_metadata(original).is_ok(),
                    "file must exist while querying"
                );
                super::case_from_flipped_lookup(
                    root,
                    std::ffi::OsStr::new(original),
                    std::ffi::OsStr::new(flipped),
                )
            },
        );
        assert!(seen.get());
        assert!(outcome.is_some());
        assert!(probe_files(&root).is_empty());

        // The query fails after the file was created.
        let failed = probe_with_temp_file(
            &dir,
            &format!("{CASE_PROBE_PREFIX}0123456789abcdef"),
            &|_, _, _| None,
        );
        assert_eq!(failed, None);
        assert!(probe_files(&root).is_empty());

        // The query panics: the guard still removes the file while unwinding.
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            probe_with_temp_file(
                &dir,
                &format!("{CASE_PROBE_PREFIX}fedcba9876543210"),
                &|_, _, _| panic!("query failed"),
            )
        }));
        assert!(panicked.is_err());
        assert!(probe_files(&root).is_empty());

        // A file that already exists is not ours: nothing is created and it is not deleted.
        let taken = format!("{CASE_PROBE_PREFIX}1111111111111111");
        fs::write(root.path().join(&taken), b"other").unwrap();
        assert_eq!(
            probe_with_temp_file(&dir, &taken, &|_, _, _| Some(CaseSensitivity::Sensitive)),
            None
        );
        assert_eq!(probe_files(&root), vec![taken]);
    }

    #[test]
    fn stale_probe_residue_is_removed_by_the_next_probe() {
        let (root, dir) = directory();
        let stale = root
            .path()
            .join(format!("{CASE_PROBE_PREFIX}abcdef0123456789"));
        let fresh = root
            .path()
            .join(format!("{CASE_PROBE_PREFIX}0123456789abcdef"));
        fs::write(&stale, b"x").unwrap();
        fs::write(&fresh, b"x").unwrap();
        fs::write(root.path().join("keep.txt"), b"x").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&fresh)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(5))
            .unwrap();

        probe_with_steps(
            &dir,
            &ProbeSteps {
                platform_api: &|_| Some(PathSemantics::UNKNOWN),
                existing_entry_flip: &|_| None,
                temp_file: &|_| None,
            },
        );

        assert!(!stale.exists(), "stale residue must be removed");
        assert!(fresh.exists(), "a fresh probe file may still be in use");
        assert!(root.path().join("keep.txt").exists());
        // Cleaning on its own does not touch fresh files either.
        clean_stale_probe_files(&dir);
        assert!(fresh.exists());
        assert!(is_case_probe_residue_name(".clp-case-probe-x"));
        assert!(!is_case_probe_residue_name("clp-case-probe-x"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn existing_entry_flip_uses_file_identity() {
        // Linux temporary directories are case sensitive.
        let (root, dir) = directory();
        fs::write(root.path().join("Readme.md"), b"x").unwrap();
        assert_eq!(
            existing_entry_flip_step(&dir),
            Some(CaseSensitivity::Sensitive)
        );

        // Two independent files that differ only in case: still sensitive.
        let (root, dir) = directory();
        fs::write(root.path().join("a.txt"), b"1").unwrap();
        fs::write(root.path().join("A.TXT"), b"2").unwrap();
        assert_eq!(
            existing_entry_flip_step(&dir),
            Some(CaseSensitivity::Sensitive)
        );

        // Hard-link blind spot: the only candidates have two names, so there is no candidate.
        let (root, dir) = directory();
        fs::write(root.path().join("a.txt"), b"x").unwrap();
        fs::hard_link(root.path().join("a.txt"), root.path().join("A.txt")).unwrap();
        assert_eq!(existing_entry_flip_step(&dir), None);

        // No entry with a letter in its name.
        let (root, dir) = directory();
        fs::write(root.path().join("123"), b"x").unwrap();
        assert_eq!(existing_entry_flip_step(&dir), None);
    }
}
