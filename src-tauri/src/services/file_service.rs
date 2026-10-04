use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_IMAGE_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_PROJECT_DIRECTORY_ENTRIES: usize = 5_000;

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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextFile {
    pub content: String,
    pub revision: String,
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
}

pub fn list_directory(root: &Path, relative_path: &str) -> Result<ProjectDirectoryListing> {
    list_directory_with_limit(root, relative_path, MAX_PROJECT_DIRECTORY_ENTRIES)
}

fn list_directory_with_limit(
    root: &Path,
    relative_path: &str,
    max_entries: usize,
) -> Result<ProjectDirectoryListing> {
    let canonical_root = canonical_root(root)?;
    let directory = resolve_existing(&canonical_root, relative_path)?;
    if !directory.is_dir() {
        bail!("所选项目路径不是目录");
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    for item in fs::read_dir(&directory)
        .context("无法读取项目目录")?
        .take(max_entries.saturating_add(1))
    {
        if entries.len() == max_entries {
            truncated = true;
            break;
        }
        let item = item.context("无法读取项目条目")?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).context("无法读取文件属性")?;
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
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        validate_relative_path(&child_relative)?;
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
    Ok(ProjectDirectoryListing { entries, truncated })
}

pub fn read_text_file(root: &Path, relative_path: &str) -> Result<ProjectTextFile> {
    let canonical_root = canonical_root(root)?;
    let path = resolve_existing(&canonical_root, relative_path)?;
    let metadata = fs::metadata(&path).context("无法读取文件属性")?;
    if !metadata.is_file() {
        bail!("只能打开普通文本文件");
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        bail!("文件超过 2 MiB 文本编辑限制");
    }
    let bytes = read_bounded(&path, MAX_TEXT_FILE_BYTES).context("无法读取文件")?;
    if !is_plain_text(&bytes) {
        bail!("该文件包含二进制内容，不能作为文本编辑");
    }
    let content = String::from_utf8(bytes).expect("plain text validation checks UTF-8");
    Ok(ProjectTextFile {
        revision: content_revision(content.as_bytes()),
        content,
    })
}

pub fn open_file(root: &Path, relative_path: &str) -> Result<ProjectFileOpenResult> {
    let canonical_root = canonical_root(root)?;
    let path = resolve_existing(&canonical_root, relative_path)?;
    let metadata = fs::metadata(&path).context("无法读取文件属性")?;
    if !metadata.is_file() {
        bail!("只能打开普通文件");
    }
    let extension = path
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
        let bytes = read_bounded(&path, MAX_IMAGE_PREVIEW_BYTES).context("无法读取图片")?;
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
    let bytes = read_bounded(&path, MAX_TEXT_FILE_BYTES).context("无法读取文件")?;
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

pub fn save_text_file(
    root: &Path,
    relative_path: &str,
    content: &str,
    expected_revision: &str,
) -> Result<ProjectTextFile> {
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        bail!("文件超过 2 MiB 文本编辑限制");
    }
    if !is_plain_text(content.as_bytes()) {
        bail!("只能保存 UTF-8 文本文件");
    }
    let canonical_root = canonical_root(root)?;
    let path = resolve_existing(&canonical_root, relative_path)?;
    let metadata = fs::metadata(&path).context("无法读取文件属性")?;
    if !metadata.is_file() {
        bail!("只能保存普通文本文件");
    }
    let current = read_bounded(&path, MAX_TEXT_FILE_BYTES).context("无法读取文件")?;
    if !is_plain_text(&current) {
        bail!("只能保存 UTF-8 文本文件");
    }
    if content_revision(&current) != expected_revision {
        bail!("文件已在其他位置修改，请重新载入后再保存");
    }
    replace_file_if_revision(&path, content.as_bytes(), expected_revision)
        .context("无法安全保存文件")?;
    Ok(ProjectTextFile {
        content: content.to_string(),
        revision: content_revision(content.as_bytes()),
    })
}

fn canonical_root(root: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(root).context("项目目录不存在或无法访问")?;
    if !root.is_dir() {
        bail!("项目路径不是目录");
    }
    Ok(root)
}

fn resolve_existing(root: &Path, relative_path: &str) -> Result<PathBuf> {
    validate_relative_path(relative_path)?;
    let candidate = relative_path
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part));
    let canonical = fs::canonicalize(&candidate).context("项目文件不存在或无法访问")?;
    if !canonical.starts_with(root) {
        bail!("项目文件不能越过项目目录访问");
    }
    Ok(canonical)
}

fn validate_relative_path(relative_path: &str) -> Result<()> {
    if relative_path.is_empty() {
        return Ok(());
    }
    if relative_path.starts_with('/')
        || relative_path.contains('\\')
        || relative_path.contains(':')
        || relative_path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        bail!("文件路径必须是规范的项目内相对路径");
    }
    Ok(())
}

fn read_bounded(path: &Path, maximum_bytes: u64) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
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
    let mut temporary = create_synced_temporary(destination, bytes)?;
    let previous = sibling_suffix(destination, ".previous");
    temporary.finish_writing()?;
    temporary.commit(destination, &previous)
}

fn replace_file_if_revision(
    destination: &Path,
    bytes: &[u8],
    expected_revision: &str,
) -> Result<()> {
    let previous = sibling_suffix(destination, ".previous");
    let permissions = fs::metadata(destination)?.permissions();
    let mut temporary = create_synced_temporary(destination, bytes)?;
    temporary.finish_writing()?;
    temporary.set_permissions(permissions)?;

    let current = read_bounded(destination, MAX_TEXT_FILE_BYTES)?;
    if content_revision(&current) != expected_revision {
        bail!("文件已在其他位置修改，请重新载入后再保存");
    }
    temporary.commit(destination, &previous)
}

struct TemporaryReplacement {
    path: PathBuf,
    file: Option<fs::File>,
    committed: bool,
}

impl Drop for TemporaryReplacement {
    fn drop(&mut self) {
        if !self.committed {
            self.file.take();
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl TemporaryReplacement {
    fn finish_writing(&mut self) -> Result<()> {
        let file = self.file.as_mut().context("临时文件句柄已关闭")?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    }

    fn set_permissions(&self, permissions: fs::Permissions) -> Result<()> {
        self.file
            .as_ref()
            .context("临时文件句柄已关闭")?
            .set_permissions(permissions)?;
        Ok(())
    }

    fn commit(mut self, destination: &Path, previous: &Path) -> Result<()> {
        self.file.take();
        commit_replacement(destination, &self.path, previous)?;
        self.committed = true;
        Ok(())
    }
}

fn create_synced_temporary(destination: &Path, bytes: &[u8]) -> Result<TemporaryReplacement> {
    for _ in 0..8 {
        let suffix = format!(".{}.writing", uuid::Uuid::new_v4().simple());
        let temporary = sibling_suffix(destination, &suffix);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file);
                    let _ = fs::remove_file(&temporary);
                    return Err(error.into());
                }
                return Ok(TemporaryReplacement {
                    path: temporary,
                    file: Some(file),
                    committed: false,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    bail!("无法创建唯一的临时文件")
}

fn sibling_suffix(destination: &Path, suffix: &str) -> PathBuf {
    let mut result = destination.as_os_str().to_os_string();
    result.push(suffix);
    PathBuf::from(result)
}

#[cfg(windows)]
fn commit_replacement(destination: &Path, temporary: &Path, previous: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        fs::rename(temporary, destination)?;
        return Ok(());
    }

    let _ = fs::remove_file(previous);
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let destination_wide = wide(destination);
    let temporary_wide = wide(temporary);
    let previous_wide = wide(previous);
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            previous_wide.as_ptr(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let _ = fs::remove_file(previous);
    Ok(())
}

#[cfg(not(windows))]
fn commit_replacement(destination: &Path, temporary: &Path, _previous: &Path) -> Result<()> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn temporary_path_keeps_original_extension_identity() {
        let json = Path::new("report.json");
        let text = Path::new("report.txt");
        assert_ne!(
            sibling_suffix(json, ".writing"),
            sibling_suffix(text, ".writing")
        );
    }

    #[test]
    fn lists_files_and_marks_hidden_ignored_and_symlink_entries() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("src")).unwrap();
        fs::create_dir(directory.path().join("node_modules")).unwrap();
        fs::write(directory.path().join(".env"), "secret").unwrap();
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
        assert!(entries
            .iter()
            .any(|entry| entry.name == "node_modules" && entry.ignored));
        #[cfg(unix)]
        assert!(entries
            .iter()
            .any(|entry| entry.name == "link" && entry.symbolic_link));
    }

    #[test]
    fn directory_listing_is_bounded_and_reports_truncation() {
        let directory = tempdir().unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(directory.path().join(name), "x").unwrap();
        }

        let listing = list_directory_with_limit(directory.path(), "", 2).unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.truncated);

        let complete = list_directory_with_limit(directory.path(), "", 3).unwrap();
        assert_eq!(complete.entries.len(), 3);
        assert!(!complete.truncated);
    }

    #[test]
    fn text_file_save_uses_revision_and_refuses_external_changes() {
        let directory = tempdir().unwrap();
        let file = directory.path().join("note.txt");
        fs::write(&file, "first").unwrap();
        let opened = read_text_file(directory.path(), "note.txt").unwrap();
        let saved =
            save_text_file(directory.path(), "note.txt", "second", &opened.revision).unwrap();
        assert_eq!(saved.content, "second");

        fs::write(&file, "external").unwrap();
        assert!(
            save_text_file(directory.path(), "note.txt", "ours", &saved.revision,)
                .unwrap_err()
                .to_string()
                .contains("其他位置修改")
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "external");
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

    #[test]
    fn temporary_replacements_are_unique_and_cleaned_up_on_drop() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("note.txt");
        let first = create_synced_temporary(&destination, b"first").unwrap();
        let second = create_synced_temporary(&destination, b"second").unwrap();

        assert_ne!(first.path, second.path);
        assert_eq!(fs::read(&first.path).unwrap(), b"first");
        assert_eq!(fs::read(&second.path).unwrap(), b"second");

        let first_path = first.path.clone();
        let second_path = second.path.clone();
        drop(first);
        drop(second);
        assert!(!first_path.exists());
        assert!(!second_path.exists());
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
}
