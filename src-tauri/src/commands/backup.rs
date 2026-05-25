use tauri::State;

use crate::models::backup::{BackupManifest, BackupReason};
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
    paths: State<'_, StoragePaths>,
    backup_id: String,
) -> Result<BackupManifest, AppError> {
    let (restored, close_behavior) = with_conn(&state, |connection| {
        let restored = backup_service::restore(connection, &paths, &backup_id)?;
        let close_behavior = crate::db::app_setting_repo::get_close_behavior(connection)?;
        Ok((restored, close_behavior))
    })?;
    update_close_behavior_state(&close_behavior_state, close_behavior)?;
    with_cache(&cache, |connection| {
        crate::services::cache_service::remove_prefix(connection, "sessions:")?;
        Ok(())
    })?;
    Ok(restored)
}
