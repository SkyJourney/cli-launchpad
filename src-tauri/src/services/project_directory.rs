use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use rusqlite::Connection;

use crate::models::directory::Directory;
use crate::platform::file_location::{locate_nofollow, FileLocation};
use crate::{db::directory_repo, platform::path_identity, AppError};

/// A retained capability to one project directory. All paths accepted by this
/// type are validated project-relative paths and all filesystem operations are
/// performed through the retained directory handle.
pub struct ProjectDirectory {
    dir: Dir,
}

impl ProjectDirectory {
    pub fn open(root: &Path) -> Result<Self> {
        let dir =
            Dir::open_ambient_dir(root, ambient_authority()).context("项目目录不存在或无法访问")?;
        Ok(Self { dir })
    }

    /// Database stage: reads the directory row only. No filesystem access.
    pub fn lookup(connection: &Connection, directory_id: i64) -> Result<Directory, AppError> {
        directory_repo::get(connection, directory_id)?
            .ok_or_else(|| AppError::coded(crate::error_codes::PROJECT_NOT_FOUND, "项目目录不存在"))
    }

    /// Filesystem stage: compares the caller's path snapshot with the stored
    /// path and opens the directory. Never call this while holding the database lock.
    pub fn open_snapshot(directory_path: &str, expected_path: &str) -> Result<Self, AppError> {
        if !path_identity::paths_equal(expected_path, directory_path) {
            return Err(AppError::coded(
                crate::error_codes::PROJECT_IDENTITY_CHANGED,
                "项目目录身份已变化，请重新选择项目后再访问文件",
            ));
        }
        Self::open(Path::new(directory_path)).map_err(AppError::from)
    }

    /// Synchronous composition of both stages, kept for existing tests.
    #[cfg(test)]
    pub fn open_for(
        connection: &Connection,
        directory_id: i64,
        expected_path: &str,
    ) -> Result<Self, AppError> {
        let directory = Self::lookup(connection, directory_id)?;
        Self::open_snapshot(&directory.path, expected_path)
    }

    pub fn dir(&self) -> &Dir {
        &self.dir
    }

    pub fn validate_relative_path(path: &str) -> Result<()> {
        if path.is_empty() {
            return Ok(());
        }
        if path.starts_with('/')
            || path
                .split('/')
                .any(|part| crate::platform::path_rules::validate_component(part).is_err())
        {
            bail!("文件路径必须是规范的项目内相对路径");
        }
        Ok(())
    }

    pub fn validate_entry_name(name: &str) -> Result<()> {
        crate::platform::path_rules::validate_entry_name(name)
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    pub fn path(relative_path: &str) -> Result<PathBuf> {
        Self::validate_relative_path(relative_path)?;
        Ok(PathBuf::from(relative_path))
    }

    /// Parent handle plus final name for a validated project-relative path.
    pub fn locate(&self, relative: &str) -> Result<FileLocation> {
        let path = Self::path(relative)?;
        locate_nofollow(&self.dir, &path)
    }

    /// Opens a project directory; the empty path is the project root.
    /// Symbolic links are refused at every component, including the last.
    pub fn open_directory(&self, relative: &str) -> Result<Dir> {
        if relative.is_empty() {
            return Ok(self.dir.try_clone()?);
        }
        let location = self.locate(relative)?;
        let metadata = location
            .parent
            .symlink_metadata(&location.name)
            .context("项目目录不存在或无法访问")?;
        if metadata.file_type().is_symlink() {
            bail!("项目路径是符号链接，已拒绝访问");
        }
        if !metadata.is_dir() {
            bail!("所选项目路径不是目录");
        }
        Ok(location
            .parent
            .open_dir(&location.name)
            .context("无法打开项目目录")?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_for_rejects_a_stale_directory_path_snapshot() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        let directory = tempdir().unwrap();
        let record = directory_repo::add(
            &connection,
            "project",
            &directory.path().display().to_string(),
            None,
        )
        .unwrap();

        assert!(ProjectDirectory::open_for(&connection, record.id, &record.path).is_ok());
        let error = match ProjectDirectory::open_for(&connection, record.id, "C:/another/project") {
            Ok(_) => panic!("stale path identity must be rejected"),
            Err(error) => error,
        };
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["code"], "project.identity_changed");
    }

    #[test]
    fn open_directory_returns_the_root_for_the_empty_path_and_rejects_files() {
        let directory = tempdir().unwrap();
        std::fs::write(directory.path().join("a.txt"), "a").unwrap();
        std::fs::create_dir(directory.path().join("sub")).unwrap();
        let project = ProjectDirectory::open(directory.path()).unwrap();

        assert!(project.open_directory("").is_ok());
        assert!(project.open_directory("sub").is_ok());
        let error = project
            .open_directory("a.txt")
            .err()
            .expect("a file is not a project directory");
        assert!(format!("{error:#}").contains("所选项目路径不是目录"));
    }

    #[test]
    fn locate_applies_project_relative_path_validation() {
        let directory = tempdir().unwrap();
        std::fs::create_dir(directory.path().join("a")).unwrap();
        std::fs::write(directory.path().join("a/b"), "b").unwrap();
        let project = ProjectDirectory::open(directory.path()).unwrap();

        let location = project.locate("a/b").unwrap();
        assert_eq!(location.name.to_str(), Some("b"));
        for path in ["", "/x", "../x", "a/../b", "."] {
            if ProjectDirectory::validate_relative_path(path).is_err() {
                assert!(project.locate(path).is_err(), "{path}");
            }
        }
    }

    #[test]
    fn open_snapshot_rejects_a_stale_path_and_opens_a_matching_one() {
        let directory = tempdir().unwrap();
        let path = directory.path().display().to_string();

        assert!(ProjectDirectory::open_snapshot(&path, &path).is_ok());
        let error = match ProjectDirectory::open_snapshot(&path, "C:/another/project") {
            Ok(_) => panic!("stale path identity must be rejected"),
            Err(error) => error,
        };
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["code"], "project.identity_changed");
    }
}
