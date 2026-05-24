use tauri::State;

use crate::db::tool_repo;
use crate::models::tool::{Tool, ToolKey};
use crate::Db;

#[tauri::command]
pub fn list_tools(state: State<'_, Db>) -> Result<Vec<Tool>, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    tool_repo::list(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_tool_global_args(
    state: State<'_, Db>,
    tool_key: ToolKey,
    args: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    tool_repo::update_global_args(&conn, tool_key, args.trim()).map_err(|error| error.to_string())
}
