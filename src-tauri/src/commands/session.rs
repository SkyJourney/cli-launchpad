use tauri::State;

use crate::models::session::SessionInfo;
use crate::models::tool::ToolKey;
use crate::services::{launch_service, session_service};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<Vec<SessionInfo>, AppError> {
    // Resolve the directory path under the lock, then release it before the
    // (potentially disk-heavy) scan runs on a blocking thread.
    let path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;

    tauri::async_runtime::spawn_blocking(move || session_service::list_sessions(tool_key, &path))
        .await
        .map_err(|error| AppError::msg(error.to_string()))
}

#[tauri::command]
pub fn resume_session(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: String,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(launch_service::resume(
            conn,
            directory_id,
            tool_key,
            &session_id,
        )?)
    })
}
