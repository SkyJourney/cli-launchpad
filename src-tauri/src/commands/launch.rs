use tauri::State;

use crate::commands::terminal::{load_terminal_environment, TerminalEnvironmentCache};
use crate::models::tool::ToolKey;
use crate::services::launch_service;
use crate::services::storage_service::StoragePaths;
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub async fn preview_launch(
    state: State<'_, Db>,
    terminal_cache: State<'_, TerminalEnvironmentCache>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<String, AppError> {
    let environment = load_terminal_environment(&terminal_cache, false).await?;
    with_conn(&state, |conn| {
        Ok(launch_service::preview(
            conn,
            &environment,
            directory_id,
            tool_key,
        )?)
    })
}

#[tauri::command]
pub async fn launch_tool(
    state: State<'_, Db>,
    terminal_cache: State<'_, TerminalEnvironmentCache>,
    storage: State<'_, StoragePaths>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<(), AppError> {
    let environment = load_terminal_environment(&terminal_cache, false).await?;
    with_conn(&state, |conn| {
        Ok(launch_service::launch(
            conn,
            &environment,
            &storage,
            directory_id,
            tool_key,
        )?)
    })
}
