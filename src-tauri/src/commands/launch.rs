use tauri::State;

use crate::models::tool::ToolKey;
use crate::services::launch_service;
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn preview_launch(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<String, AppError> {
    with_conn(&state, |conn| {
        Ok(launch_service::preview(conn, directory_id, tool_key)?)
    })
}

#[tauri::command]
pub fn launch_tool(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(launch_service::launch(conn, directory_id, tool_key)?)
    })
}
