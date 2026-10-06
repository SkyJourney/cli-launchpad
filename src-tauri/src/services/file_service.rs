use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::project_directory::ProjectDirectory;

pub const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_IMAGE_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_PROJECT_DIRECTORY_ENTRIES: usize = 5_000;
const MAX_FILE_CAS_RESIDUE_SCAN_ENTRIES: usize = 50_000;
const MAX_FILE_CAS_RESIDUE_SCAN_DEPTH: usize = 32;
const MAX_FILE_CAS_RESIDUE_RESULTS: usize = 500;
const FILE_CAS_RESIDUE_MIN_AGE_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: ProjectFileKind,
    pub size: u64,
    pub hidden: bool,
    pub ignored: bool,
    pub symbolic_link: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectFileKind {
    Directory,
    File,
    Other,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTextFile {
    pub content: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectTextFileSaveResult {
    Saved {
        content: String,
        revision: String,
        warning: Option<ProjectTextFileSaveWarning>,
    },
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectTextFileSaveWarning {
    PermissionsNotRestored,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImagePreview {
    pub mime_type: String,
    pub base64_data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectFileOpenResult {
    Text {
        content: String,
        revision: String,
    },
    Image {
        mime_type: String,
        base64_data: String,
    },
    Unsupported {
        reason: ProjectFileUnsupportedReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectFileUnsupportedReason {
    Binary,
    TooLarge,
    InvalidImage,
    UnsupportedImage,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryListing {
    pub entries: Vec<ProjectFileEntry>,
    pub truncated: bool,
    pub skipped_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileCasResidue {
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_at_ms: u64,
    pub file_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileCasResidueListing {
    pub entries: Vec<ProjectFileCasResidue>,
    pub truncated: bool,
    pub skipped_count: usize,
}

pub(crate) fn list_file_cas_residues_in(
    root: &ProjectDirectory,
) -> Result<ProjectFileCasResidueListing> {
    let now_ms = system_time_to_ms(SystemTime::now()).context("无法读取当前时间")?;
    let mut listing = ProjectFileCasResidueListing {
        entries: Vec::new(),
        truncated: false,
        skipped_count: 0,
    };
    let mut scanned = 0;
    scan_file_cas_residues(root.dir(), "", 0, now_ms, &mut scanned, &mut listing, true)?;
    Ok(listing)
}

pub(crate) fn remove_file_cas_residue_in(
    root: &ProjectDirectory,
    residue: &ProjectFileCasResidue,
) -> Result<()> {
    let now_ms = system_time_to_ms(SystemTime::now()).context("无法读取当前时间")?;
    remove_file_cas_residue_with_time(root, residue, now_ms)
}

fn scan_file_cas_residues(
    directory: &cap_std::fs::Dir,
    relative_directory: &str,
    depth: usize,
    now_ms: u64,
    scanned: &mut usize,
    listing: &mut ProjectFileCasResidueListing,
    is_root: bool,
) -> Result<()> {
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) if is_root => return Err(error.into()),
        Err(_) => {
            listing.skipped_count += 1;
            return Ok(());
        }
    };
    for entry in entries {
        if *scanned >= MAX_FILE_CAS_RESIDUE_SCAN_ENTRIES
            || listing.entries.len() >= MAX_FILE_CAS_RESIDUE_RESULTS
        {
            listing.truncated = true;
            break;
        }
        *scanned += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                listing.skipped_count += 1;
                continue;
            }
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            listing.skipped_count += 1;
            continue;
        };
        if ProjectDirectory::validate_entry_name(&name).is_err() {
            listing.skipped_count += 1;
            continue;
        }
        let relative_path = if relative_directory.is_empty() {
            name.clone()
        } else {
            format!("{relative_directory}/{name}")
        };
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(_) => {
                listing.skipped_count += 1;
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if depth >= MAX_FILE_CAS_RESIDUE_SCAN_DEPTH {
                listing.truncated = true;
                continue;
            }
            match directory.open_dir(&name) {
                Ok(child) => scan_file_cas_residues(
                    &child,
                    &relative_path,
                    depth + 1,
                    now_ms,
                    scanned,
                    listing,
                    false,
                )?,
                Err(_) => listing.skipped_count += 1,
            }
            continue;
        }
        if !metadata.is_file() || !is_file_cas_temporary_name(&name) {
            continue;
        }
        let Some(modified_at_ms) = metadata
            .modified()
            .ok()
            .and_then(|modified| system_time_to_ms(modified.into_std()).ok())
        else {
            listing.skipped_count += 1;
            continue;
        };
        if now_ms.saturating_sub(modified_at_ms) < FILE_CAS_RESIDUE_MIN_AGE_MS {
            continue;
        }
        let identity = match crate::platform::file_cas::file_identity(directory, &name, &metadata) {
            Ok(identity) => identity,
            Err(_) => {
                listing.skipped_count += 1;
                continue;
            }
        };
        listing.entries.push(ProjectFileCasResidue {
            relative_path,
            size_bytes: metadata.len(),
            modified_at_ms,
            file_identity: identity,
        });
    }
    Ok(())
}

fn remove_file_cas_residue_with_time(
    root: &ProjectDirectory,
    residue: &ProjectFileCasResidue,
    now_ms: u64,
) -> Result<()> {
    let relative_path = ProjectDirectory::path(&residue.relative_path)?;
    let Some(name) = relative_path.file_name().and_then(|name| name.to_str()) else {
        bail!("临时文件路径无效");
    };
    if !is_file_cas_temporary_name(name) {
        bail!("只允许清理 Launchpad 文件保存临时文件");
    }
    let parent_path = relative_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty());
    let parent = match parent_path {
        Some(path) => root.dir().open_dir(path).context("临时文件目录已变化")?,
        None => root.dir().try_clone()?,
    };
    let metadata = parent
        .symlink_metadata(name)
        .context("临时文件已不存在或无法访问")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("目标不再是普通临时文件");
    }
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| system_time_to_ms(modified.into_std()).ok())
        .context("无法读取临时文件修改时间")?;
    if now_ms.saturating_sub(modified_at_ms) < FILE_CAS_RESIDUE_MIN_AGE_MS
        || metadata.len() != residue.size_bytes
        || modified_at_ms != residue.modified_at_ms
        || crate::platform::file_cas::file_identity(&parent, name, &metadata)?
            != residue.file_identity
    {
        bail!("临时文件在预览后发生变化；请重新扫描确认");
    }
    parent.remove_file(name).context("无法删除已确认的临时文件")
}

fn is_file_cas_temporary_name(name: &str) -> bool {
    let Some(identifier) = name
        .strip_prefix('.')
        .and_then(|name| name.strip_suffix(".writing"))
    else {
        return false;
    };
    identifier.len() == 32
        && identifier
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn system_time_to_ms(time: SystemTime) -> Result<u64> {
    Ok(u64::try_from(time.duration_since(UNIX_EPOCH)?.as_millis())?)
}

#[cfg(test)]
pub fn list_directory(root: &Path, relative_path: &str) -> Result<ProjectDirectoryListing> {
    let root = ProjectDirectory::open(root)?;
    list_directory_in(&root, relative_path)
}

pub(crate) fn list_directory_in(
    root: &ProjectDirectory,
    relative_path: &str,
) -> Result<ProjectDirectoryListing> {
    list_directory_with_limit(root, relative_path, MAX_PROJECT_DIRECTORY_ENTRIES)
}

fn list_directory_with_limit(
    root: &ProjectDirectory,
    relative_path: &str,
    max_entries: usize,
) -> Result<ProjectDirectoryListing> {
    let directory_path = ProjectDirectory::path(relative_path)?;
    if !relative_path.is_empty() && !root.dir().metadata(&directory_path)?.is_dir() {
        bail!("所选项目路径不是目录");
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    let mut skipped_count = 0;
    let mut scanned_count = 0;
    let read_dir = if relative_path.is_empty() {
        root.dir().entries()
    } else {
        root.dir().read_dir(&directory_path)
    }
    .context("无法读取项目目录")?;
    for item in read_dir {
        if scanned_count >= max_entries || entries.len() >= max_entries {
            truncated = true;
            break;
        }
        scanned_count += 1;
        let item = match item {
            Ok(item) => item,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            skipped_count += 1;
            continue;
        };
        if ProjectDirectory::validate_entry_name(&name).is_err() {
            skipped_count += 1;
            continue;
        }
        if is_file_cas_temporary_name(&name) {
            continue;
        }
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        let metadata = match ProjectDirectory::path(&child_relative)
            .and_then(|path| root.dir().symlink_metadata(&path).map_err(Into::into))
        {
            Ok(metadata) => metadata,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        let symbolic_link = match item.file_type() {
            Ok(file_type) => file_type.is_symlink(),
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        let kind = if symbolic_link {
            ProjectFileKind::Other
        } else if metadata.is_dir() {
            ProjectFileKind::Directory
        } else if metadata.is_file() {
            ProjectFileKind::File
        } else {
            ProjectFileKind::Other
        };
        entries.push(ProjectFileEntry {
            hidden: name.starts_with('.'),
            ignored: is_ignored_name(&name),
            name,
            relative_path: child_relative,
            kind,
            size: metadata.len(),
            symbolic_link,
        });
    }
    entries.sort_by(|left, right| {
        let left_dir = left.kind == ProjectFileKind::Directory;
        let right_dir = right.kind == ProjectFileKind::Directory;
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(ProjectDirectoryListing {
        entries,
        truncated,
        skipped_count,
    })
}

#[cfg(test)]
fn read_text_file(root: &Path, relative_path: &str) -> Result<ProjectTextFile> {
    let root = ProjectDirectory::open(root)?;
    read_text_file_in(&root, relative_path)
}

#[cfg(test)]
fn read_text_file_in(root: &ProjectDirectory, relative_path: &str) -> Result<ProjectTextFile> {
    match open_file_in(root, relative_path)? {
        ProjectFileOpenResult::Text { content, revision } => {
            Ok(ProjectTextFile { content, revision })
        }
        _ => bail!("该文件不支持文本编辑"),
    }
}

#[cfg(test)]
pub fn open_file(root: &Path, relative_path: &str) -> Result<ProjectFileOpenResult> {
    let root = ProjectDirectory::open(root)?;
    open_file_in(&root, relative_path)
}

pub(crate) fn open_file_in(
    root: &ProjectDirectory,
    relative_path: &str,
) -> Result<ProjectFileOpenResult> {
    let path = ProjectDirectory::path(relative_path)?;
    let path_metadata = root
        .dir()
        .symlink_metadata(&path)
        .context("项目文件不存在或无法访问")?;
    if !path_metadata.is_file() {
        bail!("只能打开普通文件");
    }

    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = root
        .dir()
        .open_with(&path, &options)
        .context("项目文件不存在或无法访问")?;
    let metadata = file.metadata().context("无法读取文件属性")?;
    if !metadata.is_file() {
        bail!("只能打开普通文件");
    }
    let extension = Path::new(relative_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
    ) {
        if metadata.len() > MAX_IMAGE_PREVIEW_BYTES {
            return Ok(ProjectFileOpenResult::Unsupported {
                reason: ProjectFileUnsupportedReason::TooLarge,
            });
        }
        let bytes = read_bounded(file, MAX_IMAGE_PREVIEW_BYTES).context("无法读取图片")?;
        return Ok(match image_preview_from_bytes(&extension, &bytes) {
            Some(image) => ProjectFileOpenResult::Image {
                mime_type: image.mime_type,
                base64_data: image.base64_data,
            },
            None => ProjectFileOpenResult::Unsupported {
                reason: ProjectFileUnsupportedReason::InvalidImage,
            },
        });
    }
    if matches!(
        extension.as_str(),
        "svg" | "tif" | "tiff" | "avif" | "heic" | "heif"
    ) {
        return Ok(ProjectFileOpenResult::Unsupported {
            reason: ProjectFileUnsupportedReason::UnsupportedImage,
        });
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Ok(ProjectFileOpenResult::Unsupported {
            reason: ProjectFileUnsupportedReason::TooLarge,
        });
    }
    let bytes = read_bounded(file, MAX_TEXT_FILE_BYTES).context("无法读取文件")?;
    if !is_plain_text(&bytes) {
        return Ok(ProjectFileOpenResult::Unsupported {
            reason: ProjectFileUnsupportedReason::Binary,
        });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ProjectFileOpenResult::Text {
            revision: content_revision(content.as_bytes()),
            content,
        }),
        Err(_) => Ok(ProjectFileOpenResult::Unsupported {
            reason: ProjectFileUnsupportedReason::Binary,
        }),
    }
}

fn is_plain_text(bytes: &[u8]) -> bool {
    !bytes
        .iter()
        .any(|byte| *byte < 0x20 && !matches!(*byte, b'\t' | b'\n' | b'\r'))
        && std::str::from_utf8(bytes).is_ok()
}

fn image_preview_from_bytes(extension: &str, bytes: &[u8]) -> Option<ProjectImagePreview> {
    let (mime_type, matches_signature): (&str, fn(&[u8]) -> bool) = match extension {
        "png" => ("image/png", |bytes| bytes.starts_with(b"\x89PNG\r\n\x1a\n")),
        "jpg" | "jpeg" => ("image/jpeg", |bytes| bytes.starts_with(&[0xff, 0xd8, 0xff])),
        "gif" => ("image/gif", |bytes| {
            bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
        }),
        "webp" => ("image/webp", |bytes| {
            bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
        }),
        "bmp" => ("image/bmp", |bytes| bytes.starts_with(b"BM")),
        _ => return None,
    };
    if !matches_signature(bytes) {
        return None;
    }
    use base64::Engine;
    Some(ProjectImagePreview {
        mime_type: mime_type.to_string(),
        base64_data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[cfg(test)]
pub fn save_text_file(
    root: &Path,
    relative_path: &str,
    content: &str,
    expected_revision: &str,
) -> Result<ProjectTextFileSaveResult> {
    let root = ProjectDirectory::open(root)?;
    save_text_file_in(&root, relative_path, content, expected_revision)
}

pub(crate) fn save_text_file_in(
    root: &ProjectDirectory,
    relative_path: &str,
    content: &str,
    expected_revision: &str,
) -> Result<ProjectTextFileSaveResult> {
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        bail!("文件超过 2 MiB 文本编辑限制");
    }
    if !is_plain_text(content.as_bytes()) {
        bail!("只能保存 UTF-8 文本文件");
    }
    let path = ProjectDirectory::path(relative_path)?;
    let file = root.dir().open(&path).context("项目文件不存在或无法访问")?;
    let metadata = file.metadata().context("无法读取文件属性")?;
    if !metadata.is_file() {
        bail!("只能保存普通文本文件");
    }
    let current = read_bounded(file, MAX_TEXT_FILE_BYTES).context("无法读取文件")?;
    if !is_plain_text(&current) {
        bail!("只能保存 UTF-8 文本文件");
    }
    if content_revision(&current) != expected_revision {
        return Ok(ProjectTextFileSaveResult::Conflict);
    }
    let outcome =
        replace_file_if_revision(root, relative_path, content.as_bytes(), expected_revision)
            .context("无法安全保存文件")?;
    let warning = match outcome {
        crate::platform::file_cas::CompareAndSwapOutcome::Written => None,
        crate::platform::file_cas::CompareAndSwapOutcome::WrittenWithPermissionWarning => {
            Some(ProjectTextFileSaveWarning::PermissionsNotRestored)
        }
        crate::platform::file_cas::CompareAndSwapOutcome::Conflict => {
            return Ok(ProjectTextFileSaveResult::Conflict)
        }
    };
    Ok(ProjectTextFileSaveResult::Saved {
        content: content.to_string(),
        revision: content_revision(content.as_bytes()),
        warning,
    })
}

fn read_bounded(file: impl Read, maximum_bytes: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(maximum_bytes.min(64 * 1024) as usize);
    file.take(maximum_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum_bytes {
        bail!("文件读取大小超过允许上限");
    }
    Ok(bytes)
}

pub(crate) fn is_ignored_name(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".venv"
    )
}

fn content_revision(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn replace_file(destination: &Path, bytes: &[u8]) -> Result<()> {
    crate::platform::file_cas::replace_file(destination, bytes)
}

fn replace_file_if_revision(
    root: &ProjectDirectory,
    relative_path: &str,
    bytes: &[u8],
    expected_revision: &str,
) -> Result<crate::platform::file_cas::CompareAndSwapOutcome> {
    use crate::platform::file_cas::compare_and_swap_in_directory;

    compare_and_swap_in_directory(
        root.dir(),
        Path::new(relative_path),
        bytes,
        &expected_revision.to_owned(),
        MAX_TEXT_FILE_BYTES,
        content_revision,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn replaces_existing_file_with_complete_payload() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("export.json");
        fs::write(&destination, "old").unwrap();
        replace_file(&destination, b"new").unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "new");
    }

    #[test]
    fn atomically_creates_missing_destination() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("new-export.json");

        replace_file(&destination, b"created").unwrap();

        assert_eq!(fs::read_to_string(destination).unwrap(), "created");
    }

    #[cfg(unix)]
    #[test]
    fn atomically_replaces_write_only_destination() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let destination = directory.path().join("write-only-export.json");
        fs::write(&destination, "old").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o200)).unwrap();

        replace_file(&destination, b"new").unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new");
    }

    #[test]
    fn lists_files_and_marks_hidden_ignored_and_symlink_entries() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("src")).unwrap();
        fs::create_dir(directory.path().join("node_modules")).unwrap();
        fs::write(directory.path().join(".env"), "secret").unwrap();
        fs::write(
            directory
                .path()
                .join(format!(".{}.writing", "a".repeat(32))),
            "temporary",
        )
        .unwrap();
        fs::write(directory.path().join("readme.md"), "hello").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            directory.path().join("readme.md"),
            directory.path().join("link"),
        )
        .unwrap();

        let entries = list_directory(directory.path(), "").unwrap().entries;
        assert_eq!(entries[0].name, "node_modules");
        assert!(entries
            .iter()
            .any(|entry| entry.name == ".env" && entry.hidden));
        assert!(!entries
            .iter()
            .any(|entry| is_file_cas_temporary_name(&entry.name)));
        assert!(entries
            .iter()
            .any(|entry| entry.name == "node_modules" && entry.ignored));
        #[cfg(unix)]
        assert!(entries
            .iter()
            .any(|entry| entry.name == "link" && entry.symbolic_link));
    }

    #[test]
    fn file_cas_residue_cleanup_requires_strict_stale_file_identity() {
        let directory = tempdir().unwrap();
        let residue_name = format!(".{}.writing", "a".repeat(32));
        let residue_path = directory.path().join(&residue_name);
        fs::write(&residue_path, "stale temporary content").unwrap();
        fs::write(directory.path().join(".short.writing"), "keep").unwrap();
        fs::write(
            directory
                .path()
                .join(format!(".{}.writing", "g".repeat(32))),
            "keep",
        )
        .unwrap();
        #[cfg(unix)]
        let (linked_directory, linked_residue_name, linked_residue_path) = {
            use std::os::unix::fs::symlink;

            let linked_directory = tempdir().unwrap();
            let linked_residue_name = format!(".{}.writing", "b".repeat(32));
            let linked_residue_path = directory.path().join(&linked_residue_name);
            fs::write(
                linked_directory.path().join("outside-project.txt"),
                "keep outside project",
            )
            .unwrap();
            symlink(linked_directory.path(), &linked_residue_path).unwrap();
            (linked_directory, linked_residue_name, linked_residue_path)
        };

        let root = ProjectDirectory::open(directory.path()).unwrap();
        let now_ms = system_time_to_ms(SystemTime::now()).unwrap();
        let recent = scan_file_cas_residues_at(&root, now_ms).unwrap();
        assert!(recent.entries.is_empty());

        let stale_now_ms = now_ms + FILE_CAS_RESIDUE_MIN_AGE_MS + 1;
        let stale = scan_file_cas_residues_at(&root, stale_now_ms).unwrap();
        assert_eq!(stale.entries.len(), 1);
        let preview = &stale.entries[0];
        assert_eq!(preview.relative_path, residue_name);

        let mut replaced_preview = preview.clone();
        replaced_preview.file_identity.push_str(":replaced");
        assert!(remove_file_cas_residue_with_time(&root, &replaced_preview, stale_now_ms).is_err());
        assert!(residue_path.exists());

        remove_file_cas_residue_with_time(&root, preview, stale_now_ms).unwrap();
        assert!(!residue_path.exists());
        assert!(directory.path().join(".short.writing").exists());
        assert!(directory
            .path()
            .join(format!(".{}.writing", "g".repeat(32)))
            .exists());
        #[cfg(unix)]
        {
            assert_eq!(
                scan_file_cas_residues_at(&root, stale_now_ms)
                    .unwrap()
                    .entries
                    .len(),
                0,
                "a matching-name symlink must not be listed as a residue"
            );
            assert!(remove_file_cas_residue_with_time(
                &root,
                &ProjectFileCasResidue {
                    relative_path: linked_residue_name,
                    size_bytes: 0,
                    modified_at_ms: 0,
                    file_identity: String::new(),
                },
                stale_now_ms,
            )
            .is_err());
            assert!(linked_residue_path.is_symlink());
            assert!(linked_directory.path().join("outside-project.txt").exists());
        }
    }

    #[test]
    fn saved_file_permission_warning_is_serialized_for_the_frontend() {
        let result = ProjectTextFileSaveResult::Saved {
            content: "saved".to_string(),
            revision: "revision".to_string(),
            warning: Some(ProjectTextFileSaveWarning::PermissionsNotRestored),
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({
                "kind": "saved",
                "content": "saved",
                "revision": "revision",
                "warning": "permissionsNotRestored"
            })
        );
    }

    fn scan_file_cas_residues_at(
        root: &ProjectDirectory,
        now_ms: u64,
    ) -> Result<ProjectFileCasResidueListing> {
        let mut listing = ProjectFileCasResidueListing {
            entries: Vec::new(),
            truncated: false,
            skipped_count: 0,
        };
        let mut scanned = 0;
        scan_file_cas_residues(root.dir(), "", 0, now_ms, &mut scanned, &mut listing, true)?;
        Ok(listing)
    }

    #[cfg(unix)]
    #[test]
    fn unix_lists_and_opens_colon_backslash_and_unicode_file_names() {
        let directory = tempdir().unwrap();
        for name in ["report:final.txt", r"folder\name.txt", "项目说明.txt"] {
            fs::write(directory.path().join(name), format!("contents: {name}")).unwrap();
        }

        let listing = list_directory(directory.path(), "").unwrap();
        for name in ["report:final.txt", r"folder\name.txt", "项目说明.txt"] {
            assert!(listing.entries.iter().any(|entry| entry.name == name));
            assert!(matches!(
                open_file(directory.path(), name).unwrap(),
                ProjectFileOpenResult::Text { content, .. } if content == format!("contents: {name}")
            ));
        }
        assert_eq!(listing.skipped_count, 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn listing_skips_non_utf8_names_and_reports_the_count() {
        use std::os::unix::ffi::OsStringExt;

        let directory = tempdir().unwrap();
        fs::write(
            directory
                .path()
                .join(std::ffi::OsString::from_vec(vec![b'b', b'a', b'd', 0xff])),
            "hidden from the UI",
        )
        .unwrap();
        fs::write(directory.path().join("visible.txt"), "visible").unwrap();

        let listing = list_directory(directory.path(), "").unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "visible.txt");
        assert_eq!(listing.skipped_count, 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn listing_scan_budget_covers_entries_skipped_for_unreadable_names() {
        use std::os::unix::ffi::OsStringExt;

        let directory = tempdir().unwrap();
        for index in 0..8_u8 {
            let name = std::ffi::OsString::from_vec(vec![b'x', index + 1, 0xff]);
            fs::write(directory.path().join(name), "hidden from the UI").unwrap();
        }
        fs::write(directory.path().join("visible.txt"), "visible").unwrap();

        let root = ProjectDirectory::open(directory.path()).unwrap();
        let listing = list_directory_with_limit(&root, "", 2).unwrap();

        assert!(listing.truncated);
        assert!(listing.entries.len() + listing.skipped_count <= 2);
    }

    #[test]
    fn directory_listing_is_bounded_and_reports_truncation() {
        let directory = tempdir().unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(directory.path().join(name), "x").unwrap();
        }

        let root = ProjectDirectory::open(directory.path()).unwrap();
        let listing = list_directory_with_limit(&root, "", 2).unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.truncated);

        let complete = list_directory_with_limit(&root, "", 3).unwrap();
        assert_eq!(complete.entries.len(), 3);
        assert!(!complete.truncated);
    }

    #[test]
    fn text_file_save_uses_revision_and_refuses_external_changes() {
        let directory = tempdir().unwrap();
        let file = directory.path().join("note.txt");
        fs::write(&file, "first").unwrap();
        let opened = read_text_file(directory.path(), "note.txt").unwrap();
        let saved = save_text_file(directory.path(), "note.txt", "second", &opened.revision)
            .unwrap_or_else(|error| panic!("{error:#}"));
        let ProjectTextFileSaveResult::Saved {
            content,
            revision,
            warning,
        } = saved
        else {
            panic!("first write must save");
        };
        assert_eq!(content, "second");
        assert_eq!(warning, None);

        fs::write(&file, "external").unwrap();
        assert_eq!(
            save_text_file(directory.path(), "note.txt", "ours", &revision).unwrap(),
            ProjectTextFileSaveResult::Conflict
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "external");
    }

    #[test]
    fn concurrent_text_file_saves_with_same_revision_have_one_winner() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempdir().unwrap();
        let file = directory.path().join("note.txt");
        fs::write(&file, "original").unwrap();
        let opened = read_text_file(directory.path(), "note.txt").unwrap();
        let barrier = Arc::new(Barrier::new(3));

        let writers = ["writer-a", "writer-b"].map(|content| {
            let root = directory.path().to_path_buf();
            let revision = opened.revision.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                save_text_file(&root, "note.txt", content, &revision)
            })
        });

        barrier.wait();
        let results = writers.map(|writer| writer.join().unwrap());
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Ok(ProjectTextFileSaveResult::Saved { .. })))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Ok(ProjectTextFileSaveResult::Conflict)))
                .count(),
            1
        );
        assert!(matches!(
            fs::read_to_string(file).unwrap().as_str(),
            "writer-a" | "writer-b"
        ));
    }

    #[test]
    fn text_file_save_rejects_control_characters() {
        let directory = tempdir().unwrap();
        let file = directory.path().join("note.txt");
        fs::write(&file, "first").unwrap();
        let opened = read_text_file(directory.path(), "note.txt").unwrap();

        assert!(save_text_file(
            directory.path(),
            "note.txt",
            "invalid\0text",
            &opened.revision,
        )
        .is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "first");
    }

    #[test]
    fn content_revision_uses_sha256() {
        assert_eq!(
            content_revision(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[cfg(unix)]
    #[test]
    fn text_file_save_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let file = directory.path().join("script.sh");
        fs::write(&file, "echo before\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        let opened = read_text_file(directory.path(), "script.sh").unwrap();

        save_text_file(
            directory.path(),
            "script.sh",
            "echo after\n",
            &opened.revision,
        )
        .unwrap();

        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn rejects_path_traversal_binary_and_large_text() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("binary.bin"), [b'x', 1, 2]).unwrap();
        fs::write(
            directory.path().join("large.txt"),
            vec![b'x'; MAX_TEXT_FILE_BYTES as usize + 1],
        )
        .unwrap();

        assert!(read_text_file(directory.path(), "../escape").is_err());
        assert!(read_text_file(directory.path(), r"C:\Windows\win.ini").is_err());
        assert!(read_text_file(directory.path(), r"\\server\share\file.txt").is_err());
        assert!(read_text_file(directory.path(), "binary.bin").is_err());
        assert!(read_text_file(directory.path(), "large.txt").is_err());
    }

    #[test]
    fn opens_utf8_text_and_reports_binary_files_as_unsupported() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("source.rs"), "fn main() {}\n").unwrap();
        fs::write(directory.path().join("archive.bin"), [b'x', 1, 2]).unwrap();

        assert!(matches!(
            open_file(directory.path(), "source.rs").unwrap(),
            ProjectFileOpenResult::Text { content, .. } if content == "fn main() {}\n"
        ));
        assert_eq!(
            open_file(directory.path(), "archive.bin").unwrap(),
            ProjectFileOpenResult::Unsupported {
                reason: ProjectFileUnsupportedReason::Binary
            }
        );
        let binary_revision = content_revision(&[b'x', 1, 2]);
        assert!(
            save_text_file(directory.path(), "archive.bin", "text", &binary_revision)
                .unwrap_err()
                .to_string()
                .contains("UTF-8 文本")
        );
    }

    #[cfg(unix)]
    #[test]
    fn opening_a_fifo_returns_without_waiting_for_a_writer() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::sync::mpsc;
        use std::time::Duration;

        let directory = tempdir().unwrap();
        let fifo_path = directory.path().join("stream.pipe");
        let fifo_name = CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);

        let project_path = directory.path().to_path_buf();
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            sender
                .send(open_file(&project_path, "stream.pipe").map(|_| ()))
                .unwrap();
        });

        let returned_without_writer = match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(result) => {
                assert!(result.is_err());
                true
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Release a regression that opens the FIFO in blocking mode so
                // the test can fail without leaving a blocked worker thread.
                let writer = fs::OpenOptions::new().write(true).open(&fifo_path).unwrap();
                let result = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
                assert!(result.is_err());
                drop(writer);
                false
            }
            Err(error) => panic!("FIFO reader thread exited unexpectedly: {error}"),
        };

        reader.join().unwrap();
        assert!(
            returned_without_writer,
            "opening a FIFO blocked for a writer"
        );
    }

    #[test]
    fn previews_only_signature_checked_bounded_raster_images() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("pixel.png"),
            b"\x89PNG\r\n\x1a\nimage-bytes",
        )
        .unwrap();
        fs::write(directory.path().join("fake.png"), b"not an image").unwrap();
        fs::write(
            directory.path().join("large.png"),
            vec![0; MAX_IMAGE_PREVIEW_BYTES as usize + 1],
        )
        .unwrap();

        assert!(matches!(
            open_file(directory.path(), "pixel.png").unwrap(),
            ProjectFileOpenResult::Image { mime_type, .. } if mime_type == "image/png"
        ));
        assert_eq!(
            open_file(directory.path(), "fake.png").unwrap(),
            ProjectFileOpenResult::Unsupported {
                reason: ProjectFileUnsupportedReason::InvalidImage
            }
        );
        assert_eq!(
            open_file(directory.path(), "large.png").unwrap(),
            ProjectFileOpenResult::Unsupported {
                reason: ProjectFileUnsupportedReason::TooLarge
            }
        );
    }

    #[test]
    fn refuses_symbolic_link_escape() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("private.txt"), "private").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(outside.path(), root.path().join("escape")).is_err() {
            return;
        }

        assert!(read_text_file(root.path(), "escape/private.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn retained_project_capability_survives_root_path_replacement() {
        let root = tempdir().unwrap();
        let root_path = root.path().to_path_buf();
        fs::write(root_path.join("note.txt"), "original root").unwrap();
        let capability = ProjectDirectory::open(&root_path).unwrap();
        let detached_path = root_path.with_extension("detached");
        fs::rename(&root_path, &detached_path).unwrap();
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("note.txt"), "replacement directory").unwrap();

        let opened = read_text_file_in(&capability, "note.txt").unwrap();
        assert_eq!(opened.content, "original root");
        assert!(list_directory_with_limit(&capability, "", 10)
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.name == "note.txt"));
        let saved = save_text_file_in(
            &capability,
            "note.txt",
            "saved through retained handle",
            &opened.revision,
        )
        .unwrap();
        assert!(matches!(saved, ProjectTextFileSaveResult::Saved { .. }));
        assert_eq!(
            fs::read_to_string(detached_path.join("note.txt")).unwrap(),
            "saved through retained handle"
        );
        assert_eq!(
            fs::read_to_string(root_path.join("note.txt")).unwrap(),
            "replacement directory"
        );
        fs::remove_dir_all(detached_path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retained_project_handle_prevents_root_directory_replacement() {
        let root = tempdir().unwrap();
        let root_path = root.path().to_path_buf();
        fs::write(root_path.join("note.txt"), "original root").unwrap();
        let capability = ProjectDirectory::open(&root_path).unwrap();
        let replacement_path = root_path.with_extension("replacement");

        assert!(fs::rename(&root_path, &replacement_path).is_err());
        assert_eq!(
            read_text_file_in(&capability, "note.txt").unwrap().content,
            "original root"
        );
    }
}
