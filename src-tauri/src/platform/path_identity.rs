//! Path identity: two layers (m6-057)
//! - `ProjectPathKey`: stored project paths and snapshots of them. Pure lexical comparison, never
//!   touches the filesystem, safe under the database lock or on the main thread.
//! - `paths_equal`: a path from an external source (CLI session files, executables) versus a stored
//!   path. Canonicalizes, so it answers "is it the same directory on disk". Never call it under a lock.
//! - `ProjectRootIdentity`: the identity of an opened directory handle; answers "is this still the
//!   directory that was opened". Used to re-verify a project right before a PTY is spawned.

use std::path::{Path, PathBuf};

pub fn paths_equal(left: &str, right: &str) -> bool {
    match (canonical_path(left), canonical_path(right)) {
        (Some(left), Some(right)) => platform_paths_equal(&left, &right),
        _ => lexical_paths_equal(left, right),
    }
}

fn canonical_path(value: &str) -> Option<PathBuf> {
    std::fs::canonicalize(value).ok()
}

#[cfg(windows)]
fn platform_paths_equal(left: &Path, right: &Path) -> bool {
    windows_lexical(&left.display().to_string()) == windows_lexical(&right.display().to_string())
}

#[cfg(not(windows))]
fn platform_paths_equal(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(windows)]
fn lexical_paths_equal(left: &str, right: &str) -> bool {
    windows_lexical(left) == windows_lexical(right)
}

#[cfg(windows)]
fn windows_lexical(value: &str) -> String {
    let normalized = value.replace('/', "\\");
    let trimmed = normalized.trim_end_matches('\\');
    if trimmed.is_empty() {
        normalized.to_lowercase()
    } else {
        trimmed.to_lowercase()
    }
}

#[cfg(not(windows))]
fn lexical_paths_equal(left: &str, right: &str) -> bool {
    unix_lexical(left) == unix_lexical(right)
}

#[cfg(not(windows))]
fn unix_lexical(value: &str) -> &str {
    let trimmed = value.trim_end_matches('/');
    if trimmed.is_empty() && value.starts_with('/') {
        "/"
    } else {
        trimmed
    }
}

#[cfg(any(windows, test))]
pub(crate) fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProjectPathKey(String);

impl ProjectPathKey {
    /// The only place that decides when two stored project root paths are "the same": the
    /// platform's lexical rule, never touching the filesystem. PD-10 (case folding) applies to
    /// project-relative paths only (m6-076) and does not change this key.
    pub fn of(path: &str) -> Self {
        #[cfg(windows)]
        {
            let stripped = strip_windows_verbatim_prefix(path);
            Self(windows_lexical(&stripped))
        }
        #[cfg(not(windows))]
        {
            Self(unix_lexical(path).to_string())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProjectRootIdentity(crate::platform::file_identity::FileIdentity);

impl ProjectRootIdentity {
    pub fn of(dir: &cap_std::fs::Dir) -> std::io::Result<Self> {
        let file = dir.try_clone()?.into_std_file();
        Ok(Self(crate::platform::file_identity::FileIdentity::of(
            &file,
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_paths_ignore_case_and_separator_style() {
        assert!(paths_equal("C:/Projects/Demo", "c:\\projects\\demo\\"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_paths_preserve_case_and_ignore_trailing_separator() {
        assert!(paths_equal("/tmp/Demo/", "/tmp/Demo"));
        assert!(!paths_equal("/tmp/Demo", "/tmp/demo"));
        assert!(paths_equal("/", "/"));
    }

    #[test]
    fn canonical_paths_resolve_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        std::fs::create_dir(&target).unwrap();

        #[cfg(unix)]
        {
            let link = directory.path().join("link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(paths_equal(
                &target.display().to_string(),
                &link.display().to_string()
            ));
        }
    }

    #[test]
    fn project_path_key_matches_the_platform_lexical_rule() {
        use std::collections::HashSet;

        // Paths that do not exist: the key must not depend on the filesystem.
        #[cfg(windows)]
        let (equal, different, plain): (&[(&str, &str)], &[(&str, &str)], &[(&str, &str)]) = (
            &[
                ("C:/Projects/Demo", "c:\\projects\\demo\\"),
                (r"\\?\C:\Projects\Demo", r"C:\Projects\Demo"),
                (r"\\?\UNC\server\share\demo", r"\\server\share\demo"),
            ],
            &[(r"C:\Projects\Demo", r"C:\Projects\Other")],
            // Pairs without a verbatim prefix: `paths_equal` falls back to the same lexical rule.
            &[
                ("C:/Projects/Demo", "c:\\projects\\demo\\"),
                (r"C:\Projects\Demo", r"C:\Projects\Other"),
            ],
        );
        #[cfg(not(windows))]
        let (equal, different, plain): (&[(&str, &str)], &[(&str, &str)], &[(&str, &str)]) = (
            &[("/tmp/Demo/", "/tmp/Demo"), ("/", "/")],
            &[("/tmp/Demo", "/tmp/demo")],
            &[("/tmp/Demo/", "/tmp/Demo"), ("/tmp/Demo", "/tmp/demo")],
        );

        for (a, b) in equal {
            assert_eq!(
                ProjectPathKey::of(a),
                ProjectPathKey::of(b),
                "{a} should equal {b}"
            );
            let set: HashSet<ProjectPathKey> = [ProjectPathKey::of(a), ProjectPathKey::of(b)]
                .into_iter()
                .collect();
            assert_eq!(set.len(), 1, "Hash must agree with Eq for {a} / {b}");
        }
        for (a, b) in different {
            assert_ne!(
                ProjectPathKey::of(a),
                ProjectPathKey::of(b),
                "{a} should differ from {b}"
            );
            let set: HashSet<ProjectPathKey> = [ProjectPathKey::of(a), ProjectPathKey::of(b)]
                .into_iter()
                .collect();
            assert_eq!(set.len(), 2);
        }
        for (a, b) in plain {
            assert_eq!(
                paths_equal(a, b),
                ProjectPathKey::of(a) == ProjectPathKey::of(b),
                "{a} / {b}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn project_path_key_does_not_resolve_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let target = target.display().to_string();
        let link = link.display().to_string();

        assert_ne!(ProjectPathKey::of(&link), ProjectPathKey::of(&target));
        // The disk-identity comparison keeps its own semantics.
        assert!(paths_equal(&link, &target));
    }

    #[test]
    fn project_root_identity_is_stable_and_differs_between_directories() {
        use cap_std::ambient_authority;
        use cap_std::fs::Dir;

        let directory = tempfile::tempdir().unwrap();
        let a = directory.path().join("a");
        let b = directory.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let first = Dir::open_ambient_dir(&a, ambient_authority()).unwrap();
        let second = Dir::open_ambient_dir(&a, ambient_authority()).unwrap();
        let other = Dir::open_ambient_dir(&b, ambient_authority()).unwrap();

        let identity = ProjectRootIdentity::of(&first).unwrap();
        assert_eq!(identity, ProjectRootIdentity::of(&first).unwrap());
        assert_eq!(identity, ProjectRootIdentity::of(&second).unwrap());
        assert_ne!(identity, ProjectRootIdentity::of(&other).unwrap());
    }
}
