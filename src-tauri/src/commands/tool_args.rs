use tauri::State;

use crate::db::directory_tool_args_repo;
use crate::models::directory_tool_args::DirectoryToolArgs;
use crate::models::tool::ToolKey;
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn get_directory_tool_args(
    state: State<'_, Db>,
    directory_id: i64,
) -> Result<Vec<DirectoryToolArgs>, AppError> {
    with_conn(&state, |conn| {
        Ok(directory_tool_args_repo::list_for_directory(
            conn,
            directory_id,
        )?)
    })
}

#[tauri::command]
pub fn save_directory_tool_args(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    args: String,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(directory_tool_args_repo::save(
            conn,
            directory_id,
            tool_key,
            &args,
        )?)
    })
}
