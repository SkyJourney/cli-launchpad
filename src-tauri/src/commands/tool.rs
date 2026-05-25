use tauri::State;

use crate::db::tool_repo;
use crate::models::tool::{Tool, ToolKey};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn list_tools(state: State<'_, Db>) -> Result<Vec<Tool>, AppError> {
    with_conn(&state, |conn| Ok(tool_repo::list(conn)?))
}

#[tauri::command]
pub fn save_tool_global_args(
    state: State<'_, Db>,
    tool_key: ToolKey,
    args: String,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(tool_repo::update_global_args(conn, tool_key, args.trim())?)
    })
}
