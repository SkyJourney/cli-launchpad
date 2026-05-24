use tauri::State;

use crate::db::directory_repo;
use crate::models::directory::Directory;
use crate::Db;

#[tauri::command]
pub fn list_directories(state: State<'_, Db>) -> Result<Vec<Directory>, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    directory_repo::list(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_directory(
    state: State<'_, Db>,
    name: String,
    path: String,
    note: Option<String>,
) -> Result<Directory, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    directory_repo::add(&conn, &name, &path, note.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_directory(
    state: State<'_, Db>,
    id: i64,
    name: String,
    note: Option<String>,
) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    directory_repo::update(&conn, id, &name, note.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn remove_directory(state: State<'_, Db>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    directory_repo::remove(&conn, id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_directory_pinned(state: State<'_, Db>, id: i64, pinned: bool) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    directory_repo::set_pinned(&conn, id, pinned).map_err(|error| error.to_string())
}
