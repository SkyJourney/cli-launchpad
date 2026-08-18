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
}
