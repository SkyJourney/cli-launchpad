use crate::db::tx::with_tx;
use crate::error_codes::ErrorCode;
use crate::util::time::now_ms;
use rusqlite::TransactionBehavior;
use std::path::Path;

use anyhow::{bail, Result};

#[cfg(any(windows, test))]
use crate::platform::path_identity::strip_windows_verbatim_prefix;
use crate::{
    db::{directory_repo, pty_session_repo},
    AppError,
};

pub fn remove_directory(
    connection: &rusqlite::Connection,
    id: i64,
    running_in_memory: &[String],
) -> Result<(), AppError> {
    with_tx(connection, TransactionBehavior::Deferred, |transaction| {
        if !running_in_memory.is_empty() {
            return Err(AppError::coded(
                ErrorCode::DirectoryInUse,
                "该项目仍有运行中的 PTY 会话，请先关闭终端后再移除项目",
            ));
        }
        // Memory is the authority for liveness: rows still marked running here are stale (a
        // finish write failed earlier). Settle them so the delete trigger does not block removal.
        let settled = pty_session_repo::mark_directory_running_ended(&transaction, id, now_ms())?;
        if settled > 0 {
            log::warn!(
                "settled {settled} stale PTY session row(s) before removing directory id={id}"
            );
        }
        directory_repo::remove(&transaction, id)?;
        Ok(())
    })
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

/// Revokes the content-window grants of a directory whose removal has committed. Called only
/// after the database removal succeeded and outside any database lock (IPC happens here).
pub fn revoke_removed_directory(
    revoker: &crate::services::content_window_grants::ContentWindowRevoker<'_>,
    id: i64,
) -> crate::services::content_window_grants::RevocationReport {
    revoker.revoke_for_directory(id)
}

#[cfg(test)]
mod removal_tests {
    use super::*;
    use crate::db::{connection, directory_repo, pty_session_repo};
    use crate::models::pty_session::PtySessionState;
    use crate::models::tool::ToolKey;
    use tempfile::tempdir;

    use crate::services::content_window_grants::{
        test_support::RecordingReclaimer, ContentWindowFileGrant, ContentWindowGrantRegistry,
        ContentWindowRevoker, RevocationReason,
    };

    const LABEL_A: &str = "workspace-content-11111111-2222-4333-8444-555555555555";
    const LABEL_B: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";

    fn grant_of(directory_id: i64, path: &str, relative_path: &str) -> ContentWindowFileGrant {
        ContentWindowFileGrant {
            directory_id,
            directory_path: path.to_string(),
            relative_path: relative_path.to_string(),
        }
    }

    #[test]
    fn removing_a_directory_revokes_only_its_content_window_grants() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        let dir_a = directory_repo::add(&connection, "A", "C:/a", None).unwrap();
        let dir_b = directory_repo::add(&connection, "B", "C:/b", None).unwrap();
        let grants = ContentWindowGrantRegistry::default();
        grants
            .grant(LABEL_A, grant_of(dir_a.id, "C:/a", "a.txt"))
            .unwrap();
        grants
            .grant(LABEL_B, grant_of(dir_b.id, "C:/b", "b.txt"))
            .unwrap();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&grants, &reclaimer, RevocationReason::RemoveDirectory);

        remove_directory(&connection, dir_a.id, &[]).unwrap();
        let report = revoke_removed_directory(&revoker, dir_a.id);

        assert_eq!(report.revoked, vec![LABEL_A.to_string()]);
        assert_eq!(reclaimer.reclaimed(), vec![LABEL_A.to_string()]);
        let remaining: Vec<String> = grants
            .snapshot()
            .unwrap()
            .into_iter()
            .map(|(label, _)| label)
            .collect();
        assert_eq!(remaining, vec![LABEL_B.to_string()]);
        assert!(directory_repo::get(&connection, dir_a.id)
            .unwrap()
            .is_none());
        assert!(directory_repo::get(&connection, dir_b.id)
            .unwrap()
            .is_some());
    }

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

        let error =
            remove_directory(&connection, saved.id, &["running-session".to_string()]).unwrap_err();

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

        remove_directory(&connection, saved.id, &[]).unwrap();

        assert!(directory_repo::get(&connection, saved.id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn removal_reconciles_stale_running_rows_when_memory_reports_none() {
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
            "stale",
            saved.id,
            ToolKey::Claude,
            directory.path().to_str().unwrap(),
            1,
        )
        .unwrap();

        remove_directory(&connection, saved.id, &[]).unwrap();

        assert!(directory_repo::get(&connection, saved.id)
            .unwrap()
            .is_none());
        assert!(pty_session_repo::get_by_id(&connection, "stale")
            .unwrap()
            .is_none());
    }

    #[test]
    fn removal_reconciliation_only_touches_the_removed_directory() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let a =
            directory_repo::add(&connection, "a", first.path().to_str().unwrap(), None).unwrap();
        let b =
            directory_repo::add(&connection, "b", second.path().to_str().unwrap(), None).unwrap();
        pty_session_repo::insert_running(
            &connection,
            "sa",
            a.id,
            ToolKey::Claude,
            first.path().to_str().unwrap(),
            1,
        )
        .unwrap();
        pty_session_repo::insert_running(
            &connection,
            "sb",
            b.id,
            ToolKey::Claude,
            second.path().to_str().unwrap(),
            2,
        )
        .unwrap();

        remove_directory(&connection, a.id, &[]).unwrap();

        let untouched = pty_session_repo::get_by_id(&connection, "sb")
            .unwrap()
            .unwrap();
        assert_eq!(untouched.state, PtySessionState::Running);
        assert_eq!(untouched.ended_at_ms, None);
        assert!(directory_repo::get(&connection, b.id).unwrap().is_some());
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
