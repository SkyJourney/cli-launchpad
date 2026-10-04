use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::services::{cache_service, file_service, file_service::ProjectFileKind};

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
    let Some(cached) = cache_service::get_fresh::<CachedWorkspaceFileIndex>(
        connection,
        &cache_key(directory_id),
        WORKSPACE_FILE_INDEX_TTL_MS,
    )?
    else {
        return Ok(None);
    };
    let canonical_root = canonical_root(root)?;
    if cached.root_fingerprint != root_fingerprint(&canonical_root) {
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
    let canonical_root = canonical_root(root)?;
    cache_service::put(
        connection,
        &cache_key(directory_id),
        &CachedWorkspaceFileIndex {
            root_fingerprint: root_fingerprint(&canonical_root),
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
    let canonical_root = canonical_root(root)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut pending = vec![(PathBuf::new(), 0usize)];

    while let Some((relative_directory, depth)) = pending.pop() {
        let absolute_directory = canonical_root.join(&relative_directory);
        let mut children = Vec::new();
        for child in fs::read_dir(&absolute_directory)
            .with_context(|| format!("无法读取工作区目录：{}", relative_directory.display()))?
        {
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
            let metadata = fs::symlink_metadata(child.path()).context("无法读取文件属性")?;
            let symbolic_link = metadata.file_type().is_symlink();
            let kind = if symbolic_link {
                ProjectFileKind::Other
            } else if metadata.is_dir() {
                ProjectFileKind::Directory
            } else if metadata.is_file() {
                ProjectFileKind::File
            } else {
                ProjectFileKind::Other
            };
            let relative_path = relative_directory.join(&name);
            let ignored = file_service::is_ignored_name(&name);
            if kind == ProjectFileKind::Directory && !ignored {
                if depth < max_depth {
                    pending.push((relative_path.clone(), depth + 1));
                } else {
                    truncated = true;
                }
            }
            let extension = child
                .path()
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

fn canonical_root(root: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(root).context("项目目录不存在或无法访问")?;
    anyhow::ensure!(canonical.is_dir(), "项目路径不是目录");
    Ok(canonical)
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
}
