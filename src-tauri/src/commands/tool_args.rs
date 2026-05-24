use tauri::State;

use crate::db::directory_tool_args_repo;
use crate::models::directory_tool_args::DirectoryToolArgs;
use crate::models::tool::ToolKey;
use crate::Db;

#[tauri::command]
pub fn get_directory_tool_args(
    state: State<'_, Db>,
    directory_id: i64,
) -> Result<Vec<DirectoryToolArgs>, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    directory_tool_args_repo::list_for_directory(&conn, directory_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_directory_tool_args(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    args: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    directory_tool_args_repo::save(&conn, directory_id, tool_key, &args)
        .map_err(|error| error.to_string())
}
