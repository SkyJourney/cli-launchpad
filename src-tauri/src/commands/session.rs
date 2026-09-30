use tauri::State;

use crate::commands::terminal::{load_terminal_environment, TerminalEnvironmentCache};
use crate::db::session_alias_repo;
use crate::models::session::{SessionPage, SessionSearchIndexRefresh, SessionSearchResults};
use crate::models::tool::ToolKey;
use crate::services::storage_service::StoragePaths;
use crate::services::{launch_service, session_service};
use crate::{with_cache, with_conn, AppError, CacheDb, Db};

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<SessionPage, AppError> {
    let (path, aliases) = with_conn(&state, |conn| {
        Ok((
            session_service::directory_path(conn, directory_id)?,
            session_alias_repo::list_for_tool(conn, tool_key)?,
        ))
    })?;
    let mut page =
        session_service::list_sessions(tool_key, &path, cursor.as_deref(), limit.unwrap_or(10))
            .await?;
    session_service::apply_aliases(&mut page, &aliases);
    Ok(page)
}

#[tauri::command]
pub async fn search_sessions(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    directory_id: i64,
    query: String,
) -> Result<SessionSearchResults, AppError> {
    let aliases = with_conn(&state, |conn| {
        session_service::directory_path(conn, directory_id)?;
        let mut aliases = std::collections::HashMap::new();
        for tool_key in ToolKey::ALL {
            aliases.insert(tool_key, session_alias_repo::list_for_tool(conn, tool_key)?);
        }
        Ok(aliases)
    })?;
    with_cache(&cache, |connection| {
        Ok(session_service::search_indexed_sessions(
            connection,
            directory_id,
            &query,
            &aliases,
        )?)
    })
}

#[tauri::command]
pub async fn refresh_session_search_index(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    directory_id: i64,
) -> Result<SessionSearchIndexRefresh, AppError> {
    let path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;
    let sources = session_service::refresh_search_index(&path).await?;
    let current_path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;
    if current_path != path {
        return Err(AppError::msg("项目目录已变更，已取消写入旧的会话搜索索引"));
    }
    with_cache(&cache, |connection| {
        Ok(crate::db::session_search_repo::refresh(
            connection,
            directory_id,
            &sources,
        )?)
    })
}

#[tauri::command]
pub async fn set_session_alias(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: String,
    alias: String,
) -> Result<(), AppError> {
    let alias = session_service::normalize_alias(&alias)?;
    let path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;
    ensure_session_belongs(tool_key, &path, &session_id).await?;
    with_conn(&state, |conn| {
        session_alias_repo::save(conn, tool_key, &session_id, &alias)?;
        Ok(())
    })
}

#[tauri::command]
pub async fn delete_session_alias(
    state: State<'_, Db>,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: String,
) -> Result<(), AppError> {
    let path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;
    ensure_session_belongs(tool_key, &path, &session_id).await?;
    with_conn(&state, |conn| {
        session_alias_repo::delete(conn, tool_key, &session_id)?;
        Ok(())
    })
}

async fn ensure_session_belongs(
    tool_key: ToolKey,
    directory_path: &str,
    session_id: &str,
) -> Result<(), AppError> {
    if session_service::session_belongs_to_directory(tool_key, directory_path, session_id).await? {
        Ok(())
    } else {
        Err(AppError::msg("该会话不属于当前项目目录，已拒绝修改别名"))
    }
}

#[tauri::command]
pub async fn resume_session(
    state: State<'_, Db>,
    terminal_cache: State<'_, TerminalEnvironmentCache>,
    storage: State<'_, StoragePaths>,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: String,
) -> Result<(), AppError> {
    let path = with_conn(&state, |conn| {
        Ok(session_service::directory_path(conn, directory_id)?)
    })?;
    if !session_service::session_belongs_to_directory(tool_key, &path, &session_id).await? {
        return Err(AppError::msg("该会话不属于当前项目目录，已拒绝恢复"));
    }
    let environment = load_terminal_environment(&terminal_cache, false).await?;
    with_conn(&state, |conn| {
        Ok(launch_service::resume(
            conn,
            &environment,
            &storage,
            directory_id,
            tool_key,
            &session_id,
        )?)
    })
}
