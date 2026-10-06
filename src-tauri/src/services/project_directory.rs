use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use rusqlite::Connection;

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

    pub fn open_for(
        connection: &Connection,
        directory_id: i64,
        expected_path: &str,
    ) -> Result<Self, AppError> {
        let directory = directory_repo::get(connection, directory_id)?
            .ok_or_else(|| AppError::coded("file.not_found", "项目目录不存在"))?;
        if !path_identity::paths_equal(expected_path, &directory.path) {
            return Err(AppError::coded(
                "project_identity_changed",
                "项目目录身份已变化，请重新选择项目后再访问文件",
            ));
        }
        Self::open(Path::new(&directory.path)).map_err(AppError::from)
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
        assert_eq!(serialized["code"], "project_identity_changed");
    }
}
