use tauri::State;

use crate::models::backup::BackupReason;
use crate::services::config_service;
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn export_config_to_path(state: State<'_, Db>, path: String) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(config_service::export_to_path(conn, &path)?)
    })
}

#[tauri::command]
pub fn import_config_from_path(
    state: State<'_, Db>,
    storage: State<'_, StoragePaths>,
    path: String,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        backup_service::create(conn, &storage, BackupReason::PreImport)?;
        Ok(config_service::import_from_path(conn, &path)?)
    })
}
