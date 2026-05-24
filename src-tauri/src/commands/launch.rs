use tauri::State;

use crate::models::tool::ToolKey;
use crate::services::launch_service;
use crate::Db;

#[tauri::command]
pub fn preview_launch(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<String, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    launch_service::preview(&conn, directory_id, tool_key).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn launch_tool(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    launch_service::launch(&conn, directory_id, tool_key).map_err(|error| error.to_string())
}
