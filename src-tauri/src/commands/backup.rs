use tauri::{Emitter, State};

use crate::models::backup::{BackupManifest, BackupReason};
use crate::services::pty_session_service::PtySessionManager;
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{
    update_close_behavior_state, with_cache, with_conn, AppError, CacheDb, CloseBehaviorState, Db,
};

#[tauri::command]
pub fn list_backups(paths: State<'_, StoragePaths>) -> Result<Vec<BackupManifest>, AppError> {
    Ok(backup_service::list(&paths)?)
}

#[tauri::command]
pub fn create_backup(
    state: State<'_, Db>,
    paths: State<'_, StoragePaths>,
) -> Result<BackupManifest, AppError> {
    with_conn(&state, |connection| {
        Ok(backup_service::create(
            connection,
            &paths,
            BackupReason::Manual,
        )?)
    })
}

#[tauri::command]
pub fn restore_backup(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    close_behavior_state: State<'_, CloseBehaviorState>,
    sessions: State<'_, PtySessionManager>,
    paths: State<'_, StoragePaths>,
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<BackupManifest, AppError> {
    with_conn(&state, |connection| {
        let _restore_guard = sessions.begin_backup_restore()?;
        let restored = backup_service::restore(connection, &paths, &backup_id)?;
        let close_behavior = crate::db::app_setting_repo::get_close_behavior(connection)?;
        let close_behavior_result =
            update_close_behavior_state(&close_behavior_state, close_behavior);
        let cache_result = with_cache(&cache, |connection| {
            crate::services::cache_service::remove_prefix(connection, "sessions:")?;
            crate::services::cache_service::remove_prefix(connection, "workspace-file-index:")?;
            crate::services::cache_service::clear_session_search(connection)?;
            Ok(())
        });
        let event_result = app
            .emit_to("main", "workspace-data-restored", ())
            .map_err(|error| AppError::msg(error.to_string()));
        close_behavior_result?;
        cache_result?;
        event_result?;
        Ok(restored)
    })
}
