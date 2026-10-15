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

#[tauri::command]
pub async fn remove_directory(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    sessions: State<'_, PtySessionManager>,
    id: i64,
) -> Result<(), AppError> {
    let db = state.inner().clone();
    let manager = sessions.inner().clone();
    // Earlier finish writes land first so the rows catch up with memory; a failure is only
    // logged by the retry store. This is its own database access, never nested in the call below.
    {
        let manager = manager.clone();
        blocking("directory.flush", budgets::PROJECT_DIRECTORY, move || {
            manager.flush_pending_persistence(&db);
            Ok(())
        })
        .await?;
    }
    state
        .call("directory.remove", move |connection| {
            // m6-056 D1: the only allowed Db -> registry nesting; see PtySessionManager::running_in
            let running = manager.running_in(id);
            directory_service::remove_directory(connection, id, &running)
        })
        .await?;
    cache
        .call("directory.remove_cache", move |connection| {
            cache_service::remove_prefix(connection, "sessions:")?;
            cache_service::remove_workspace_file_index_for_directory(connection, id)?;
            crate::db::session_search_repo::remove_directory(connection, id)?;
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
                return Err(AppError::msg("项目排序只能调整同一置顶分组内的全部项目"));
            }

            directory_repo::reorder(conn, &ordered_ids)?;
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::contains_exactly;

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
            directory_repo::get(conn, id)?
                .ok_or_else(|| AppError::msg(format!("项目目录 {id} 不存在")))
        })
        .await?;
    blocking("directory.open", budgets::PROJECT_DIRECTORY, move || {
        directory_service::validate_path(&directory.path)?;
        crate::platform::opener::open_directory(&directory.path)?;
        Ok(())
    })
    .await
}
