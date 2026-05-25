use tauri::State;

use crate::db::launch_history_repo;
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
