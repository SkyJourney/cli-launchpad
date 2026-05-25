use tauri::State;

use crate::models::backup::{BackupManifest, BackupReason};
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{with_conn, AppError, Db};

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
    paths: State<'_, StoragePaths>,
    backup_id: String,
) -> Result<BackupManifest, AppError> {
    with_conn(&state, |connection| {
        Ok(backup_service::restore(connection, &paths, &backup_id)?)
    })
}
