use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use rusqlite::Connection;

use crate::models::directory::Directory;
use crate::platform::file_location::{locate_nofollow, FileLocation};
use crate::platform::path_identity::{ProjectPathKey, ProjectRootIdentity};
use crate::{db::directory_repo, AppError};

/// What one PTY launch needs to know about its project, opened and checked once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRef {
    pub id: i64,
    pub path: String,
    pub key: ProjectPathKey,
    pub root: ProjectRootIdentity,
}

impl ProjectRef {
    /// Re-checks right before use that the opened directory is still the one on disk. Filesystem
    /// access: never call it under a lock. Reopens by path, so it also fails when the directory
    /// is gone. Best effort: a directory deleted and recreated at once can get the same inode
    /// number back, which `dev/ino` cannot tell apart, and the spawn that follows resolves its
    /// working directory by path again. Keeping the handle from `open_ref` alive narrows both
    /// windows (an open directory handle blocks rename/delete on Windows and pins the inode).
    pub fn verify_unchanged(&self) -> Result<(), AppError> {
        let root = ProjectDirectory::open(Path::new(&self.path)).map_err(AppError::from)?;
        let now = ProjectRootIdentity::of(root.dir())
            .map_err(|error| AppError::msg(format!("无法读取项目目录身份：{error}")))?;
        if now != self.root {
            return Err(AppError::coded(
                crate::error_codes::PROJECT_IDENTITY_CHANGED,
                "项目目录在启动准备期间发生变化，请重试",
            ));
        }
        Ok(())
    }
}

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
        if ProjectPathKey::of(expected_path) != ProjectPathKey::of(directory_path) {
            return Err(AppError::coded(
                crate::error_codes::PROJECT_IDENTITY_CHANGED,
                "项目目录身份已变化，请重新选择项目后再访问文件",
            ));
        }
        Self::open(Path::new(directory_path)).map_err(AppError::from)
    }

    /// Both stages in one call: database read (`Db::call`, no filesystem) then the
    /// directory open (`blocking`, no database lock).
    pub async fn open_ref(
        db: &crate::Db,
        directory_id: i64,
        expected_path: Option<&str>,
    ) -> Result<(ProjectDirectory, ProjectRef), AppError> {
        let directory = db
            .call("project.lookup", move |connection| {
                ProjectDirectory::lookup(connection, directory_id)
            })
            .await?;
        let expected = expected_path.map(str::to_string);
        crate::blocking(
            "project.open",
            crate::budgets::PROJECT_DIRECTORY,
            move || {
                // The stored path is untrusted input: never resolve a relative path against the
                // process working directory (the old validate_path refused it).
                if !Path::new(&directory.path).is_absolute() {
                    return Err(AppError::msg("项目目录必须使用绝对路径"));
                }
                let root = match expected.as_deref() {
                    Some(expected) => ProjectDirectory::open_snapshot(&directory.path, expected)?,
                    None => ProjectDirectory::open(Path::new(&directory.path))
                        .map_err(AppError::from)?,
                };
                let identity = ProjectRootIdentity::of(root.dir())
                    .map_err(|error| AppError::msg(format!("无法读取项目目录身份：{error}")))?;
                let project = ProjectRef {
                    id: directory.id,
                    key: ProjectPathKey::of(&directory.path),
                    path: directory.path,
                    root: identity,
                };
                Ok((root, project))
            },
        )
        .await
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

    fn memory_db_with_project() -> (
        crate::Db,
        tempfile::TempDir,
        crate::models::directory::Directory,
    ) {
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
        let db = crate::Db(std::sync::Arc::new(std::sync::Mutex::new(connection)));
        (db, directory, record)
    }

    fn code_of(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn open_ref_returns_the_row_with_a_matching_key_and_root_identity() {
        let (db, _directory, record) = memory_db_with_project();

        let (root, project) = ProjectDirectory::open_ref(&db, record.id, None)
            .await
            .unwrap();

        assert_eq!(project.id, record.id);
        assert_eq!(project.path, record.path);
        assert_eq!(project.key, ProjectPathKey::of(&record.path));
        assert_eq!(project.root, ProjectRootIdentity::of(root.dir()).unwrap());
        assert!(root.dir().dir_metadata().unwrap().is_dir());
    }

    #[tokio::test]
    async fn open_ref_rejects_a_stale_expected_path() {
        let (db, _directory, record) = memory_db_with_project();

        assert!(
            ProjectDirectory::open_ref(&db, record.id, Some(&record.path))
                .await
                .is_ok()
        );
        let error =
            match ProjectDirectory::open_ref(&db, record.id, Some("C:/another/project")).await {
                Ok(_) => panic!("a stale snapshot must be rejected"),
                Err(error) => error,
            };
        assert_eq!(code_of(&error), "project.identity_changed");

        // The same stored path spelled differently is not a stale snapshot.
        #[cfg(windows)]
        {
            let upper = record.path.to_uppercase();
            assert!(ProjectDirectory::open_ref(&db, record.id, Some(&upper))
                .await
                .is_ok());
            let trailing = format!("{}\\", record.path);
            assert!(ProjectDirectory::open_ref(&db, record.id, Some(&trailing))
                .await
                .is_ok());
        }
    }

    #[tokio::test]
    async fn open_ref_without_an_expected_path_skips_the_snapshot_check() {
        let (db, _directory, record) = memory_db_with_project();

        let (_root, project) = ProjectDirectory::open_ref(&db, record.id, None)
            .await
            .unwrap();

        assert_eq!(project.path, record.path);
    }

    #[tokio::test]
    async fn open_ref_reports_a_missing_directory_row_as_not_found() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        let db = crate::Db(std::sync::Arc::new(std::sync::Mutex::new(connection)));

        let error = match ProjectDirectory::open_ref(&db, 999, None).await {
            Ok(_) => panic!("a missing row must be an error"),
            Err(error) => error,
        };

        assert_eq!(code_of(&error), "project.not_found");
    }

    #[tokio::test]
    async fn open_ref_fails_when_the_directory_no_longer_exists() {
        let (db, directory, record) = memory_db_with_project();
        drop(directory);

        let error = match ProjectDirectory::open_ref(&db, record.id, None).await {
            Ok(_) => panic!("a removed directory must be an error"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("项目目录不存在或无法访问"));
    }

    #[tokio::test]
    async fn open_ref_rejects_a_relative_stored_path() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        let record = directory_repo::add(&connection, "project", "relative/project", None).unwrap();
        let db = crate::Db(std::sync::Arc::new(std::sync::Mutex::new(connection)));

        let error = match ProjectDirectory::open_ref(&db, record.id, None).await {
            Ok(_) => panic!("a relative path must be refused"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("项目目录必须使用绝对路径"));
    }

    #[tokio::test]
    async fn verify_unchanged_detects_a_replaced_directory() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        let parent = tempdir().unwrap();
        let project_path = parent.path().join("project");
        std::fs::create_dir(&project_path).unwrap();
        let record = directory_repo::add(
            &connection,
            "project",
            &project_path.display().to_string(),
            None,
        )
        .unwrap();
        let db = crate::Db(std::sync::Arc::new(std::sync::Mutex::new(connection)));
        let (root, project) = ProjectDirectory::open_ref(&db, record.id, None)
            .await
            .unwrap();
        drop(root);

        // Move the opened directory away (it stays alive, so its inode cannot be reused) and put a
        // different directory at the same path.
        std::fs::rename(&project_path, parent.path().join("project-old")).unwrap();
        std::fs::create_dir(&project_path).unwrap();

        let error = project
            .verify_unchanged()
            .expect_err("a replaced directory must be detected");
        assert_eq!(code_of(&error), "project.identity_changed");
        assert!(error.to_string().contains("项目目录在启动准备期间发生变化"));
    }

    #[tokio::test]
    async fn verify_unchanged_accepts_the_same_directory() {
        let (db, directory, record) = memory_db_with_project();
        let (root, project) = ProjectDirectory::open_ref(&db, record.id, None)
            .await
            .unwrap();
        drop(root);

        assert!(project.verify_unchanged().is_ok());

        std::fs::remove_dir(directory.path()).unwrap();
        let error = project
            .verify_unchanged()
            .expect_err("a removed directory must be an error");
        assert!(error.to_string().contains("项目目录不存在或无法访问"));
    }
}
