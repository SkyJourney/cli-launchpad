use tauri::State;

use crate::db::{app_setting_repo, launch_history_repo};
use crate::models::launch_history::LaunchHistoryEntry;
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn list_launch_history(state: State<'_, Db>) -> Result<Vec<LaunchHistoryEntry>, AppError> {
    with_conn(&state, |connection| {
        Ok(launch_history_repo::list_recent(connection)?)
    })
}

#[tauri::command]
pub fn clear_launch_history(state: State<'_, Db>) -> Result<(), AppError> {
    with_conn(&state, |connection| {
        launch_history_repo::clear(connection)?;
        log::info!("launch history cleared");
        Ok(())
    })
}

#[tauri::command]
pub fn get_launch_history_limit(state: State<'_, Db>) -> Result<i64, AppError> {
    with_conn(&state, |connection| {
        Ok(app_setting_repo::get_launch_history_limit(connection)?)
    })
}

#[tauri::command]
pub fn set_launch_history_limit(state: State<'_, Db>, limit: i64) -> Result<(), AppError> {
    with_conn(&state, |connection| {
        app_setting_repo::set_launch_history_limit(connection, limit)?;
        launch_history_repo::prune_to_limit(connection)?;
        Ok(())
    })
}
