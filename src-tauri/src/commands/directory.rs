use tauri::State;

use crate::db::directory_repo;
use crate::models::directory::Directory;
use crate::services::cache_service;
use crate::services::directory_service;
use crate::{with_cache, with_conn, AppError, CacheDb, Db};

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
pub fn list_directories(state: State<'_, Db>) -> Result<Vec<Directory>, AppError> {
    with_conn(&state, |conn| Ok(directory_repo::list(conn)?))
}

#[tauri::command]
pub fn add_directory(
    state: State<'_, Db>,
    name: String,
    path: String,
    note: Option<String>,
) -> Result<Directory, AppError> {
    let path = directory_service::normalized_existing_path(&path)?;
    with_conn(&state, |conn| {
        Ok(directory_repo::add(conn, &name, &path, note.as_deref())?)
    })
}

#[tauri::command]
pub fn update_directory(
    state: State<'_, Db>,
    id: i64,
    name: String,
    note: Option<String>,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(directory_repo::update(conn, id, &name, note.as_deref())?)
    })
}

#[tauri::command]
pub fn remove_directory(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    id: i64,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        if directory_repo::has_running_pty_session(conn, id)? {
            return Err(AppError::msg(
                "该项目仍有运行中的 PTY 会话，请先关闭终端后再移除项目",
            ));
        }
        Ok(())
    })?;
    with_cache(&cache, |connection| {
        cache_service::remove_prefix(connection, "sessions:")?;
        crate::db::session_search_repo::remove_directory(connection, id)?;
        Ok(())
    })?;
    with_conn(&state, |conn| Ok(directory_repo::remove(conn, id)?))
}

#[tauri::command]
pub fn set_directory_pinned(state: State<'_, Db>, id: i64, pinned: bool) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(directory_repo::set_pinned(conn, id, pinned)?)
    })
}

#[tauri::command]
pub fn reorder_directories(
    state: State<'_, Db>,
    ordered_ids: Vec<i64>,
    pinned: bool,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
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
pub fn open_project_directory(state: State<'_, Db>, id: i64) -> Result<(), AppError> {
    let directory = with_conn(&state, |conn| {
        directory_repo::get(conn, id)?.ok_or_else(|| AppError::msg(format!("项目目录 {id} 不存在")))
    })?;
    directory_service::validate_path(&directory.path)?;
    crate::platform::opener::open_directory(&directory.path)?;
    Ok(())
}
