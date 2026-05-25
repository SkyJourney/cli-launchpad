use tauri::State;

use crate::db::directory_tool_args_repo;
use crate::models::directory_tool_args::DirectoryToolArgs;
use crate::models::tool::ToolArgsUpdate;
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
pub fn save_directory_tool_args_batch(
    state: State<'_, Db>,
    directory_id: i64,
    updates: Vec<ToolArgsUpdate>,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        let transaction = conn.transaction()?;
        for update in updates {
            directory_tool_args_repo::save(
                &transaction,
                directory_id,
                update.tool_key,
                update.args.trim(),
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
}
