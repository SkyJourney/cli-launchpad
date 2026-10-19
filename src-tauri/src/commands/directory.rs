use crate::error_codes::ErrorCode;
use tauri::State;

use crate::db::directory_repo;
use crate::models::directory::Directory;
use crate::services::cache_service;
use crate::services::directory_service;
use crate::services::pty_session_service::PtySessionManager;
use crate::{blocking, budgets, AppError, CacheDb, Db};

fn contains_exactly(expected_ids: &[i64], submitted_ids: &[i64]) -> bool {
    let expected = expected_ids
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let submitted = submitted_ids
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    expected.len() == submitted_ids.len() && submitted == expected
}

#[tauri::command]
pub async fn list_directories(state: State<'_, Db>) -> Result<Vec<Directory>, AppError> {
    state
        .call("directory.list", |conn| Ok(directory_repo::list(conn)?))
        .await
}

#[tauri::command]
pub async fn add_directory(
    state: State<'_, Db>,
    name: String,
    path: String,
    note: Option<String>,
) -> Result<Directory, AppError> {
    let path = blocking(
        "directory.normalize",
        budgets::PROJECT_DIRECTORY,
        move || Ok(directory_service::normalized_existing_path(&path)?),
    )
    .await?;
    state
        .call("directory.add", move |conn| {
            Ok(directory_repo::add(conn, &name, &path, note.as_deref())?)
        })
        .await
}

#[tauri::command]
pub async fn update_directory(
    state: State<'_, Db>,
    id: i64,
    name: String,
    note: Option<String>,
) -> Result<(), AppError> {
    state
        .call("directory.update", move |conn| {
            Ok(directory_repo::update(conn, id, &name, note.as_deref())?)
        })
        .await
}

/// The database side of `remove_directory` without Tauri state (m6-112, so the order is tested):
/// earlier `finish` writes land first, in their own database access; only then the removal runs
/// and reads the in-memory open sessions inside the database closure (m6-056 D1).
async fn remove_directory_reconciled(
    db: &Db,
    flush: impl FnOnce() + Send + 'static,
    running_in: impl FnOnce(i64) -> Vec<String> + Send + 'static,
    id: i64,
) -> Result<(), AppError> {
    // A failed write is only logged by the retry store. This is its own database access, never
    // nested in the call below.
    blocking("directory.flush", budgets::PROJECT_DIRECTORY, move || {
        flush();
        Ok(())
    })
    .await?;
    db.call("directory.remove", move |connection| {
        // m6-056 D1: the only allowed Db -> registry nesting; see PtySessionManager::running_in
        let running = running_in(id);
        directory_service::remove_directory(connection, id, &running)
    })
    .await
}

#[tauri::command]
pub async fn remove_directory(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    path_semantics: State<
        '_,
        std::sync::Arc<crate::services::project_path_semantics::CaseSensitivityCache>,
    >,
    sessions: State<'_, PtySessionManager>,
    id: i64,
) -> Result<(), AppError> {
    let db = state.inner().clone();
    let manager = sessions.inner().clone();
    let flush_db = db.clone();
    let flush_manager = manager.clone();
    remove_directory_reconciled(
        &db,
        move || {
            flush_manager.flush_pending_persistence(&flush_db);
        },
        move |directory_id| manager.running_in(directory_id),
        id,
    )
    .await?;
    // The id may be reused later; an old answer must not follow it.
    path_semantics.invalidate_project(id);
    cache
        .call("directory.remove_cache", move |connection| {
            cache_service::invalidate_directory(connection, id)?;
            Ok(())
        })
        .await
}

#[tauri::command]
pub async fn set_directory_pinned(
    state: State<'_, Db>,
    id: i64,
    pinned: bool,
) -> Result<(), AppError> {
    state
        .call("directory.set_pinned", move |conn| {
            Ok(directory_repo::set_pinned(conn, id, pinned)?)
        })
        .await
}

#[tauri::command]
pub async fn reorder_directories(
    state: State<'_, Db>,
    ordered_ids: Vec<i64>,
    pinned: bool,
) -> Result<(), AppError> {
    state
        .call("directory.reorder", move |conn| {
            let expected_ids = directory_repo::list(conn)?
                .into_iter()
                .filter(|directory| directory.pinned == pinned)
                .map(|directory| directory.id)
                .collect::<Vec<_>>();

            if !contains_exactly(&expected_ids, &ordered_ids) {
                return Err(AppError::internal(
                    "项目排序只能调整同一置顶分组内的全部项目",
                ));
            }

            directory_repo::reorder(conn, &ordered_ids)?;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use crate::models::pty_session::PtySessionState;
    use std::sync::{Arc, Mutex};

    use super::{contains_exactly, remove_directory_reconciled};
    use crate::db::{directory_repo, pty_session_repo};
    use crate::models::tool::ToolKey;
    use crate::services::pty_session_service::PtySessionManager;
    use crate::{AppError, Db};

    fn memory_db() -> Db {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        Db::new(connection)
    }

    fn add_directory(db: &Db, name: &str) -> i64 {
        let connection = db.lock_for_test();
        directory_repo::add(&connection, name, &format!("C:/{name}"), None)
            .unwrap()
            .id
    }

    fn code_of(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    #[tokio::test]
    async fn remove_directory_flushes_pending_finishes_while_the_database_lock_is_free() {
        let db = memory_db();
        let id = add_directory(&db, "flush");
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let flush_log = Arc::clone(&log);
        let flush_probe = db.shared_for_test();
        let running_log = Arc::clone(&log);

        remove_directory_reconciled(
            &db,
            move || {
                let free = flush_probe.try_lock().is_ok();
                flush_log.lock().unwrap().push(format!("flush free={free}"));
            },
            move |_| {
                running_log.lock().unwrap().push("running_in".to_string());
                Vec::new()
            },
            id,
        )
        .await
        .unwrap();

        assert_eq!(
            *log.lock().unwrap(),
            vec!["flush free=true".to_string(), "running_in".to_string()],
            "the flush runs first and without the database lock"
        );
    }

    #[tokio::test]
    async fn remove_directory_reads_running_sessions_inside_the_database_lock() {
        let db = memory_db();
        let id = add_directory(&db, "inside");
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let flush_log = Arc::clone(&log);
        let flush_probe = db.shared_for_test();
        let running_log = Arc::clone(&log);
        let running_probe = db.shared_for_test();

        remove_directory_reconciled(
            &db,
            move || {
                let free = flush_probe.try_lock().is_ok();
                flush_log.lock().unwrap().push(format!("flush free={free}"));
            },
            move |_| {
                let held = running_probe.try_lock().is_err();
                running_log
                    .lock()
                    .unwrap()
                    .push(format!("running_in held={held}"));
                Vec::new()
            },
            id,
        )
        .await
        .unwrap();

        assert_eq!(
            *log.lock().unwrap(),
            vec![
                "flush free=true".to_string(),
                "running_in held=true".to_string()
            ],
            "the open sessions are read while the database lock is held"
        );
    }

    #[tokio::test]
    async fn remove_directory_is_refused_while_a_session_is_open_in_memory() {
        let db = memory_db();
        let saved = add_directory(&db, "saved");
        let other = add_directory(&db, "other");
        let manager = PtySessionManager::default();
        manager.insert_test_session_in_directory("main", saved, None);
        let running_manager = manager.clone();

        let error = remove_directory_reconciled(
            &db,
            || {},
            move |directory_id| running_manager.running_in(directory_id),
            saved,
        )
        .await
        .unwrap_err();

        assert_eq!(code_of(&error), "directory.in_use");
        let connection = db.lock_for_test();
        assert!(directory_repo::get(&connection, saved).unwrap().is_some());
        drop(connection);

        // Reverse: a directory without an open session is removed by the same wiring.
        let running_manager = manager.clone();
        remove_directory_reconciled(
            &db,
            || {},
            move |directory_id| running_manager.running_in(directory_id),
            other,
        )
        .await
        .unwrap();
        let connection = db.lock_for_test();
        assert!(directory_repo::get(&connection, other).unwrap().is_none());
    }

    #[tokio::test]
    async fn remove_directory_settles_stale_rows_when_nothing_is_open_in_memory() {
        let db = memory_db();
        let id = add_directory(&db, "stale");
        {
            let connection = db.lock_for_test();
            pty_session_repo::insert_running(
                &connection,
                "stale",
                id,
                ToolKey::Claude,
                "C:/stale",
                1,
            )
            .unwrap();
        }
        let manager = PtySessionManager::default();
        manager.queue_failed_finish_for_test("stale", PtySessionState::Exited, 5, Some(0));
        let flush_manager = manager.clone();
        let flush_db = db.clone();
        let running_manager = manager.clone();

        remove_directory_reconciled(
            &db,
            move || {
                flush_manager.flush_pending_persistence(&flush_db);
            },
            move |directory_id| running_manager.running_in(directory_id),
            id,
        )
        .await
        .unwrap();

        let connection = db.lock_for_test();
        assert!(directory_repo::get(&connection, id).unwrap().is_none());
        assert!(pty_session_repo::get_by_id(&connection, "stale")
            .unwrap()
            .is_none());
        drop(connection);
        // The queued write was retried by the flush: nothing is left to retry.
        assert_eq!(manager.flush_pending_persistence(&db).retried, 0);
    }

    #[test]
    fn reorder_requires_every_project_once_from_the_requested_group() {
        assert!(contains_exactly(&[1, 2, 3], &[3, 1, 2]));
        assert!(!contains_exactly(&[1, 2, 3], &[1, 2]));
        assert!(!contains_exactly(&[1, 2, 3], &[1, 2, 4]));
        assert!(!contains_exactly(&[1, 2, 3], &[1, 2, 2]));
    }
}

#[tauri::command]
pub async fn open_project_directory(state: State<'_, Db>, id: i64) -> Result<(), AppError> {
    let directory = state
        .call("directory.get", move |conn| {
            directory_repo::get(conn, id)?.ok_or_else(|| {
                AppError::coded(ErrorCode::ProjectNotFound, format!("项目目录 {id} 不存在"))
            })
        })
        .await?;
    blocking("directory.open", budgets::PROJECT_DIRECTORY, move || {
        directory_service::validate_path(&directory.path)?;
        crate::platform::opener::open_directory(&directory.path)?;
        Ok(())
    })
    .await
}
