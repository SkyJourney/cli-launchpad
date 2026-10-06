use std::path::Path;

use anyhow::{bail, Result};

use crate::{db::directory_repo, AppError};

pub fn remove_directory(connection: &rusqlite::Connection, id: i64) -> Result<(), AppError> {
    let transaction = connection.unchecked_transaction()?;
    if directory_repo::has_running_pty_session(&transaction, id)? {
        return Err(AppError::coded(
            "directory.in_use",
            "该项目仍有运行中的 PTY 会话，请先关闭终端后再移除项目",
        ));
    }
    directory_repo::remove(&transaction, id)?;
    transaction.commit()?;
    Ok(())
}

pub fn validate_path(path: &str) -> Result<()> {
    normalized_existing_path(path).map(|_| ())
}

pub fn normalized_existing_path(path: &str) -> Result<String> {
    let directory = Path::new(path);
    let normalized = normalized_configured_path(path)?;
    if !directory.exists() {
        bail!("项目目录不存在，请检查路径后重试");
    }
    if !directory.is_dir() {
        bail!("项目路径不是目录，请选择文件夹");
    }
    Ok(normalized)
}

/// Normalize configured project identity while retaining unavailable absolute
/// paths so imported configuration can be repaired after a checkout or move.
pub fn normalized_configured_path(path: &str) -> Result<String> {
    let directory = Path::new(path);
    if !directory.is_absolute() {
        bail!("项目目录必须使用绝对路径");
    }
    if directory.exists() {
        Ok(path_for_storage(&std::fs::canonicalize(directory)?))
    } else {
        Ok(directory.display().to_string())
    }
}

#[cfg(windows)]
fn path_for_storage(path: &Path) -> String {
    strip_windows_verbatim_prefix(&path.display().to_string())
}

#[cfg(not(windows))]
fn path_for_storage(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod removal_tests {
    use super::*;
    use crate::db::{connection, directory_repo, pty_session_repo};
    use crate::models::tool::ToolKey;
    use tempfile::tempdir;

    #[test]
    fn removal_refuses_a_running_session_and_preserves_the_directory() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        let directory = tempdir().unwrap();
        let saved = directory_repo::add(
            &connection,
            "demo",
            directory.path().to_str().unwrap(),
            None,
        )
        .unwrap();
        pty_session_repo::insert_running(
            &connection,
            "running-session",
            saved.id,
            ToolKey::Claude,
            directory.path().to_str().unwrap(),
            1,
        )
        .unwrap();

        let error = remove_directory(&connection, saved.id).unwrap_err();

        assert_eq!(
            serde_json::to_value(error).unwrap()["code"],
            "directory.in_use"
        );
        assert!(directory_repo::get(&connection, saved.id)
            .unwrap()
            .is_some());
    }

    #[test]
    fn removal_deletes_an_idle_directory() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        let directory = tempdir().unwrap();
        let saved = directory_repo::add(
            &connection,
            "demo",
            directory.path().to_str().unwrap(),
            None,
        )
        .unwrap();

        remove_directory(&connection, saved.id).unwrap();

        assert!(directory_repo::get(&connection, saved.id)
            .unwrap()
            .is_none());
    }
}

#[cfg(any(windows, test))]
fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn accepts_existing_directory() {
        let directory = tempdir().unwrap();
        assert!(normalized_existing_path(directory.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn rejects_missing_directory_and_file() {
        let directory = tempdir().unwrap();
        assert!(validate_path(directory.path().join("missing").to_str().unwrap()).is_err());
        let file = directory.path().join("file.txt");
        std::fs::write(&file, "data").unwrap();
        assert!(validate_path(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn rejects_relative_directory_paths() {
        assert!(normalized_existing_path(".").is_err());
        assert!(normalized_configured_path(".").is_err());
    }

    #[test]
    fn strips_windows_verbatim_drive_prefix_for_storage() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Projects\demo"),
            r"C:\Projects\demo"
        );
    }

    #[test]
    fn strips_windows_verbatim_unc_prefix_for_storage() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\server\share\demo"),
            r"\\server\share\demo"
        );
    }

    #[test]
    fn keeps_regular_path_for_storage() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"C:\Projects\demo"),
            r"C:\Projects\demo"
        );
    }
}
