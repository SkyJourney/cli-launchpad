use tauri::State;

use crate::db::directory_repo;
use crate::services::workspace_file_index_service::{self, WorkspaceFileIndex};
use crate::{with_cache, with_conn, AppError, CacheDb, Db};

#[tauri::command]
pub async fn get_workspace_file_index(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    directory_id: i64,
    force_refresh: Option<bool>,
) -> Result<WorkspaceFileIndex, AppError> {
    let directory = with_conn(&state, |connection| {
        directory_repo::get(connection, directory_id)?
            .ok_or_else(|| AppError::msg("项目目录不存在"))
    })?;
    let root = directory.path;
    if !force_refresh.unwrap_or(false) {
        if let Some(index) = with_cache(&cache, |connection| {
            Ok(workspace_file_index_service::get_fresh_cached_index(
                connection,
                directory_id,
                std::path::Path::new(&root),
            )?)
        })? {
            return Ok(index);
        }
    }

    let scan_root = root.clone();
    let index = tauri::async_runtime::spawn_blocking(move || {
        workspace_file_index_service::scan_workspace(std::path::Path::new(&scan_root))
    })
    .await
    .map_err(|error| AppError::msg(format!("工作区索引任务异常：{error}")))??;
    with_cache(&cache, |connection| {
        workspace_file_index_service::save_cached_index(
            connection,
            directory_id,
            std::path::Path::new(&root),
            &index,
        )?;
        Ok(())
    })?;
    Ok(index)
}
