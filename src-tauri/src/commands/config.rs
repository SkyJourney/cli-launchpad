use tauri::State;

use crate::models::backup::BackupReason;
use crate::services::config_service;
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{
    update_close_behavior_state, with_cache, with_conn, AppError, CacheDb, CloseBehaviorState, Db,
};

#[tauri::command]
pub fn export_config_to_path(state: State<'_, Db>, path: String) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        match config_service::export_to_path(conn, &path) {
            Ok(()) => {
                log::info!("configuration export completed");
                Ok(())
            }
            Err(error) => {
                log::error!("configuration export failed");
                Err(error.into())
            }
        }
    })
}

#[tauri::command]
pub fn import_config_from_path(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    close_behavior_state: State<'_, CloseBehaviorState>,
    storage: State<'_, StoragePaths>,
    path: String,
) -> Result<(), AppError> {
    let bundle = config_service::read_bundle_from_path(&path)?;
    let close_behavior = with_conn(&state, |conn| {
        backup_service::create(conn, &storage, BackupReason::PreImport)?;
        match config_service::import(conn, &bundle) {
            Ok(()) => {
                log::info!("configuration import completed");
                Ok(crate::db::app_setting_repo::get_close_behavior(conn)?)
            }
            Err(error) => {
                log::error!("configuration import failed");
                Err(error.into())
            }
        }
    })?;
    update_close_behavior_state(&close_behavior_state, close_behavior)?;
    with_cache(&cache, |connection| {
        crate::services::cache_service::remove_prefix(connection, "sessions:")?;
        Ok(())
    })
}
