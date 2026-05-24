use tauri::State;

use crate::db::tool_repo;
use crate::models::tool::Tool;
use crate::Db;

#[tauri::command]
pub fn list_tools(state: State<'_, Db>) -> Result<Vec<Tool>, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    tool_repo::list(&conn).map_err(|error| error.to_string())
}
