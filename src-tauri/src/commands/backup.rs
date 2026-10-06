use tauri::{Emitter, State};

use crate::models::backup::{BackupManifest, BackupReason};
use crate::services::pty_session_service::PtySessionManager;
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{
    update_close_behavior_state, with_cache_connection, with_connection, AppError, CacheDb,
    CloseBehaviorState, Db,
};

#[tauri::command]
pub async fn list_backups(paths: State<'_, StoragePaths>) -> Result<Vec<BackupManifest>, AppError> {
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup_service::list(&paths))
        .await
        .map_err(|error| AppError::msg(format!("备份列表任务异常：{error}")))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn create_backup(
    state: State<'_, Db>,
    paths: State<'_, StoragePaths>,
) -> Result<BackupManifest, AppError> {
    let db = state.inner().clone();
    let paths = paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_connection(&db, |connection| {
            Ok(backup_service::create(
                connection,
                &paths,
                BackupReason::Manual,
            )?)
        })
    })
    .await
    .map_err(|error| AppError::msg(format!("备份创建任务异常：{error}")))?
}

#[tauri::command]
pub async fn restore_backup(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    close_behavior_state: State<'_, CloseBehaviorState>,
    sessions: State<'_, PtySessionManager>,
    paths: State<'_, StoragePaths>,
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<BackupManifest, AppError> {
    let db = state.inner().clone();
    let cache = cache.inner().clone();
    let sessions = sessions.inner().clone();
    let paths = paths.inner().clone();
    let app = app.clone();
    let (restored, close_behavior) = tauri::async_runtime::spawn_blocking(move || {
        let (restored, close_behavior) = with_connection(&db, |connection| {
            let _restore_guard = sessions.begin_backup_restore()?;
            let restored = backup_service::restore(connection, &paths, &backup_id)?;
            let close_behavior = crate::db::app_setting_repo::get_close_behavior(connection)?;
            Ok((restored, close_behavior))
        })?;
        with_cache_connection(&cache, |connection| {
            crate::services::cache_service::remove_prefix(connection, "sessions:")?;
            crate::services::cache_service::remove_prefix(connection, "workspace-file-index:")?;
            crate::services::cache_service::clear_session_search(connection)?;
            Ok(())
        })?;
        app.emit_to("main", "workspace-data-restored", ())
            .map_err(|error| AppError::msg(error.to_string()))?;
        Ok::<_, AppError>((restored, close_behavior))
    })
    .await
    .map_err(|error| AppError::msg(format!("备份恢复任务异常：{error}")))??;

    update_close_behavior_state(&close_behavior_state, close_behavior)?;
    Ok(restored)
}
