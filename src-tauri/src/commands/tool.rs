use tauri::State;

use crate::db::tool_repo;
use crate::models::tool::{Tool, ToolArgsUpdate};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn list_tools(state: State<'_, Db>) -> Result<Vec<Tool>, AppError> {
    with_conn(&state, |conn| Ok(tool_repo::list(conn)?))
}

#[tauri::command]
pub fn save_tool_global_args_batch(
    state: State<'_, Db>,
    updates: Vec<ToolArgsUpdate>,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        let transaction = conn.transaction()?;
        for update in updates {
            tool_repo::update_global_args(&transaction, update.tool_key, update.args.trim())?;
        }
        transaction.commit()?;
        Ok(())
    })
}
