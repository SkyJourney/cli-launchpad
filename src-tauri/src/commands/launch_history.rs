use tauri::State;

use crate::db::{app_setting_repo, launch_history_repo};
use crate::models::launch_history::LaunchHistoryEntry;
use crate::{AppError, Db};

#[tauri::command]
pub async fn list_launch_history(
    state: State<'_, Db>,
) -> Result<Vec<LaunchHistoryEntry>, AppError> {
    state
        .call("launch_history.list", |connection| {
            Ok(launch_history_repo::list_recent(connection)?)
        })
        .await
}

#[tauri::command]
pub async fn clear_launch_history(state: State<'_, Db>) -> Result<(), AppError> {
    state
        .call("launch_history.clear", |connection| {
            launch_history_repo::clear(connection)?;
            log::info!("launch history cleared");
            Ok(())
        })
        .await
}

#[tauri::command]
pub async fn get_launch_history_limit(state: State<'_, Db>) -> Result<i64, AppError> {
    state
        .call("launch_history.get_limit", |connection| {
            Ok(app_setting_repo::get_launch_history_limit(connection)?)
        })
        .await
}

#[tauri::command]
pub async fn set_launch_history_limit(state: State<'_, Db>, limit: i64) -> Result<(), AppError> {
    state
        .call("launch_history.set_limit", move |connection| {
            app_setting_repo::set_launch_history_limit(connection, limit)?;
            launch_history_repo::prune_to_limit(connection)?;
            Ok(())
        })
        .await
}
