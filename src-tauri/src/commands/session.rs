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
    let path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;
    let sessions = tauri::async_runtime::spawn_blocking(move || {
        session_service::list_sessions(tool_key, &path)
    })
    .await
    .map_err(|error| AppError::msg(error.to_string()))??;
    Ok(sessions)
}

#[tauri::command]
pub fn resume_session(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: String,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        let path = session_service::directory_path(conn, directory_id)?;
        if !session_service::session_belongs_to_directory(tool_key, &path, &session_id)? {
            return Err(AppError::msg("该会话不属于当前项目目录，已拒绝恢复"));
        }
        Ok(launch_service::resume(
            conn,
            directory_id,
            tool_key,
            &session_id,
        )?)
    })
}
