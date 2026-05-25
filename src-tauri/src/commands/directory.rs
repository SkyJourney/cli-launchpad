use tauri::State;

use crate::db::directory_repo;
use crate::models::directory::Directory;
use crate::services::cache_service;
use crate::services::directory_service;
use crate::{with_cache, with_conn, AppError, CacheDb, Db};

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
    with_conn(&state, |conn| Ok(directory_repo::remove(conn, id)?))?;
    with_cache(&cache, |connection| {
        cache_service::remove_prefix(connection, "sessions:")?;
        Ok(())
    })
}

#[tauri::command]
pub fn set_directory_pinned(state: State<'_, Db>, id: i64, pinned: bool) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(directory_repo::set_pinned(conn, id, pinned)?)
    })
}
