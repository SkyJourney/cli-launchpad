use tauri::State;

use crate::models::session::SessionInfo;
use crate::models::tool::ToolKey;
use crate::services::{cache_service, launch_service, session_service};
use crate::{with_cache, with_conn, AppError, CacheDb, Db};

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    directory_id: i64,
    tool_key: ToolKey,
    force: Option<bool>,
) -> Result<Vec<SessionInfo>, AppError> {
    let cache_key = format!("sessions:{directory_id}:{}", tool_key.as_str());
    if !force.unwrap_or(false) {
        if let Some(cached) = with_cache(&cache, |connection| {
            Ok(cache_service::get_fresh(connection, &cache_key, 60_000)?)
        })? {
            return Ok(cached);
        }
    }
    // Resolve the directory path under the lock, then release it before the
    // (potentially disk-heavy) scan runs on a blocking thread.
    let path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;

    let sessions = tauri::async_runtime::spawn_blocking(move || {
        session_service::list_sessions(tool_key, &path)
    })
    .await
    .map_err(|error| AppError::msg(error.to_string()))?;
    with_cache(&cache, |connection| {
        cache_service::put(connection, &cache_key, &sessions)?;
        Ok(())
    })?;
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
        Ok(launch_service::resume(
            conn,
            directory_id,
            tool_key,
            &session_id,
        )?)
    })
}
