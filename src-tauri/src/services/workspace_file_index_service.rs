use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use cap_std::fs::ReadDir;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::services::{
    cache_service, file_service, file_service::ProjectFileKind, project_directory::ProjectDirectory,
};

pub const WORKSPACE_FILE_INDEX_TTL_MS: i64 = 5 * 60 * 1000;
pub const MAX_WORKSPACE_FILE_INDEX_ENTRIES: usize = 50_000;
pub const MAX_WORKSPACE_INDEX_DIRECTORY_ENTRIES: usize = 5_000;
pub const MAX_WORKSPACE_INDEX_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileMetadata {
    pub relative_path: String,
    pub kind: ProjectFileKind,
    pub extension: Option<String>,
    pub size: u64,
    pub modified_at_ms: Option<u64>,
    pub hidden: bool,
    pub ignored: bool,
    pub symbolic_link: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileIndex {
    pub entries: Vec<WorkspaceFileMetadata>,
    pub truncated: bool,
    pub scanned_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct CachedWorkspaceFileIndex {
    root_fingerprint: String,
    index: WorkspaceFileIndex,
}

pub fn cache_key(directory_id: i64) -> String {
    format!("workspace-file-index:{directory_id}")
}

pub fn cache_prefix(directory_id: i64) -> String {
    cache_key(directory_id)
}

pub fn get_fresh_cached_index(
    connection: &Connection,
    directory_id: i64,
    root: &Path,
) -> Result<Option<WorkspaceFileIndex>> {
    // Keep the pre-capability behavior: a cached view must not make a deleted
    // project appear available. The index itself remains metadata-only.
    let _root_capability = ProjectDirectory::open(root)?;
    let Some(cached) = cache_service::get_fresh::<CachedWorkspaceFileIndex>(
        connection,
        &cache_key(directory_id),
        WORKSPACE_FILE_INDEX_TTL_MS,
    )?
    else {
        return Ok(None);
    };
    if cached.root_fingerprint != root_fingerprint(root) {
        return Ok(None);
    }
    Ok(Some(cached.index))
}

pub fn save_cached_index(
    connection: &Connection,
    directory_id: i64,
    root: &Path,
    index: &WorkspaceFileIndex,
) -> Result<()> {
    cache_service::put(
        connection,
        &cache_key(directory_id),
        &CachedWorkspaceFileIndex {
            root_fingerprint: root_fingerprint(root),
            index: index.clone(),
        },
    )
}

pub fn scan_workspace(root: &Path) -> Result<WorkspaceFileIndex> {
    scan_workspace_with_limits(
        root,
        MAX_WORKSPACE_FILE_INDEX_ENTRIES,
        MAX_WORKSPACE_INDEX_DIRECTORY_ENTRIES,
        MAX_WORKSPACE_INDEX_DEPTH,
    )
}

fn scan_workspace_with_limits(
    root: &Path,
    max_entries: usize,
    max_directory_entries: usize,
    max_depth: usize,
) -> Result<WorkspaceFileIndex> {
    let root = ProjectDirectory::open(root)?;
    scan_workspace_cap(&root, max_entries, max_directory_entries, max_depth)
}

fn scan_workspace_cap(
    root: &ProjectDirectory,
    max_entries: usize,
    max_directory_entries: usize,
    max_depth: usize,
) -> Result<WorkspaceFileIndex> {
    scan_workspace_cap_with_limits(root, max_entries, max_directory_entries, max_depth)
}

fn scan_workspace_cap_with_limits(
    root: &ProjectDirectory,
    max_entries: usize,
    max_directory_entries: usize,
    max_depth: usize,
) -> Result<WorkspaceFileIndex> {
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut pending = vec![(PathBuf::new(), 0usize)];

    while let Some((relative_directory, depth)) = pending.pop() {
        let mut children = Vec::new();
        let read_dir: ReadDir = if relative_directory.as_os_str().is_empty() {
            root.dir().entries()
        } else {
            root.dir().read_dir(&relative_directory)
        }
        .with_context(|| format!("无法读取工作区目录：{}", relative_directory.display()))?;
        for child in read_dir {
            if children.len() == max_directory_entries {
                truncated = true;
                break;
            }
            children.push(child.context("无法读取工作区文件条目")?);
        }
        children.sort_by_key(|child| child.file_name().to_string_lossy().to_lowercase());

        for child in children {
            if entries.len() == max_entries {
                truncated = true;
                break;
            }
            let Some(name) = child.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let relative_path = relative_directory.join(&name);
            let metadata = root
                .dir()
                .symlink_metadata(&relative_path)
                .context("无法读取文件属性")?;
            let symbolic_link = child.file_type().context("无法读取文件属性")?.is_symlink();
            let kind = if symbolic_link {
                ProjectFileKind::Other
            } else if metadata.is_dir() {
                ProjectFileKind::Directory
            } else if metadata.is_file() {
                ProjectFileKind::File
            } else {
                ProjectFileKind::Other
            };
            let ignored = file_service::is_ignored_name(&name);
            if kind == ProjectFileKind::Directory && !ignored {
                if depth < max_depth {
                    pending.push((relative_path.clone(), depth + 1));
                } else {
                    truncated = true;
                }
            }
            let extension = Path::new(&name)
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase);
            entries.push(WorkspaceFileMetadata {
                relative_path: relative_path.to_string_lossy().replace('\\', "/"),
                kind,
                extension,
                size: metadata.len(),
                modified_at_ms: metadata
                    .modified()
                    .ok()
                    .map(cap_std::time::SystemTime::into_std)
                    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                    .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
                hidden: name.starts_with('.'),
                ignored,
                symbolic_link,
            });
        }
        if entries.len() == max_entries {
            truncated = true;
            break;
        }
    }

    entries.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    Ok(WorkspaceFileIndex {
        entries,
        truncated,
        scanned_at_ms: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64,
    })
}

fn root_fingerprint(root: &Path) -> String {
    let value = root.to_string_lossy();
    let hash = value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::cache_connection;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn indexes_relative_metadata_and_skips_recursing_into_ignored_directories() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("src/App.tsx"), "source").unwrap();
        fs::write(root.path().join("node_modules/dependency.js"), "ignored").unwrap();
        fs::write(root.path().join(".env"), "secret").unwrap();

        let index = scan_workspace(root.path()).unwrap();
        assert!(index.entries.iter().any(|entry| {
            entry.relative_path == "src/App.tsx"
                && entry.extension.as_deref() == Some("tsx")
                && entry.kind == ProjectFileKind::File
        }));
        assert!(index
            .entries
            .iter()
            .any(|entry| { entry.relative_path == "node_modules" && entry.ignored }));
        assert!(!index
            .entries
            .iter()
            .any(|entry| entry.relative_path == "node_modules/dependency.js"));
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.relative_path == ".env" && entry.hidden));
        let serialized = serde_json::to_string(&index).unwrap();
        assert!(!serialized.contains(&root.path().to_string_lossy().to_string()));
    }

    #[test]
    fn index_respects_global_entry_limit_and_reports_truncation() {
        let root = tempdir().unwrap();
        for index in 0..4 {
            fs::write(root.path().join(format!("{index:05}.txt")), "x").unwrap();
        }

        let index = scan_workspace_with_limits(root.path(), 3, 10, 2).unwrap();
        assert_eq!(index.entries.len(), 3);
        assert!(index.truncated);
    }

    #[test]
    fn index_respects_per_directory_and_depth_limits() {
        let root = tempdir().unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("a.txt"), "a").unwrap();
        fs::write(nested.join("b.txt"), "b").unwrap();
        fs::write(nested.join("c.txt"), "c").unwrap();
        fs::write(root.path().join("root.txt"), "root").unwrap();

        let per_directory = scan_workspace_with_limits(root.path(), 100, 2, 10).unwrap();
        assert!(per_directory.truncated);

        let depth = scan_workspace_with_limits(root.path(), 100, 100, 0).unwrap();
        assert!(depth.truncated);
        assert!(!depth
            .entries
            .iter()
            .any(|entry| entry.relative_path.starts_with("nested/")));
    }

    #[test]
    fn index_does_not_follow_symbolic_links() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("private.txt"), "private").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(outside.path(), root.path().join("escape")).is_err() {
            return;
        }

        let index = scan_workspace(root.path()).unwrap();
        assert!(index.entries.iter().any(|entry| {
            entry.relative_path == "escape"
                && entry.symbolic_link
                && entry.kind == ProjectFileKind::Other
        }));
        assert!(!index
            .entries
            .iter()
            .any(|entry| entry.relative_path == "escape/private.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn index_remains_anchored_when_the_root_path_is_replaced() {
        let root = tempdir().unwrap();
        let root_path = root.path().to_path_buf();
        fs::write(root_path.join("original.txt"), "inside").unwrap();
        let capability = ProjectDirectory::open(&root_path).unwrap();
        let detached_path = root_path.with_extension("detached-index");
        fs::rename(&root_path, &detached_path).unwrap();
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("outside.txt"), "outside").unwrap();

        let index = scan_workspace_cap(&capability, 100, 100, 2).unwrap();
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.relative_path == "original.txt"));
        assert!(!index
            .entries
            .iter()
            .any(|entry| entry.relative_path == "outside.txt"));
        fs::remove_dir_all(detached_path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retained_project_handle_prevents_index_root_replacement() {
        let root = tempdir().unwrap();
        let root_path = root.path().to_path_buf();
        fs::write(root_path.join("original.txt"), "inside").unwrap();
        let capability = ProjectDirectory::open(&root_path).unwrap();
        let replacement_path = root_path.with_extension("replacement-index");

        assert!(fs::rename(&root_path, replacement_path).is_err());
        assert!(scan_workspace_cap(&capability, 100, 100, 2)
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.relative_path == "original.txt"));
    }

    #[test]
    fn fresh_cache_is_reused_for_the_same_root_but_rejected_after_root_change() {
        let cache = cache_connection::init_ephemeral_cache().unwrap();
        let first_root = tempdir().unwrap();
        let second_root = tempdir().unwrap();
        let index = scan_workspace(first_root.path()).unwrap();
        save_cached_index(&cache, 7, first_root.path(), &index).unwrap();

        assert_eq!(
            get_fresh_cached_index(&cache, 7, first_root.path())
                .unwrap()
                .unwrap(),
            index
        );
        assert!(get_fresh_cached_index(&cache, 7, second_root.path())
            .unwrap()
            .is_none());

        cache
            .execute(
                "update cache_entries set created_at_ms = 0 where key = ?1",
                [&cache_key(7)],
            )
            .unwrap();
        assert!(get_fresh_cached_index(&cache, 7, first_root.path())
            .unwrap()
            .is_none());
    }

    #[test]
    fn fresh_cache_is_not_returned_after_the_project_root_is_removed() {
        let cache = cache_connection::init_ephemeral_cache().unwrap();
        let root = tempdir().unwrap();
        let index = scan_workspace(root.path()).unwrap();
        save_cached_index(&cache, 12, root.path(), &index).unwrap();
        let root_path = root.keep();
        fs::remove_dir_all(&root_path).unwrap();

        assert!(get_fresh_cached_index(&cache, 12, &root_path).is_err());
    }
}
