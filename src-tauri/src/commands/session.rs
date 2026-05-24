use tauri::State;

use crate::db::directory_repo;
use crate::models::session::SessionInfo;
use crate::models::tool::ToolKey;
use crate::services::{launch_service, session_service};
use crate::Db;

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<Vec<SessionInfo>, String> {
    // Read the directory path under the lock, then release it before the
    // (potentially disk-heavy) scan runs on a blocking thread.
    let path = {
        let conn = state.lock().map_err(|error| error.to_string())?;
        directory_repo::get(&conn, directory_id)
            .map_err(|error| error.to_string())?
            .map(|directory| directory.path)
            .ok_or_else(|| format!("directory {directory_id} not found"))?
    };

    tauri::async_runtime::spawn_blocking(move || session_service::list_sessions(tool_key, &path))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resume_session(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    launch_service::resume(&conn, directory_id, tool_key, &session_id)
        .map_err(|error| error.to_string())
}
