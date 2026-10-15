use tauri::State;

use crate::models::backup::BackupReason;
use crate::services::app_lifecycle::{AppLifecycle, DataReplaceKind, Operation};
use crate::services::config_service;
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{
    blocking_unbounded, update_close_behavior_state, with_cache_connection, with_connection,
    AppError, CacheDb, CloseBehaviorState, Db,
};

#[tauri::command]
pub async fn export_config_to_path(state: State<'_, Db>, path: String) -> Result<(), AppError> {
    let db = state.inner().clone();
    // A write whose timeout would be misleading: no budget, still off the async worker.
    blocking_unbounded("config.export", move || {
        with_connection(&db, |conn| {
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
    })
    .await
}

#[tauri::command]
pub async fn import_config_from_path(
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    close_behavior_state: State<'_, CloseBehaviorState>,
    storage: State<'_, StoragePaths>,
    lifecycle: State<'_, AppLifecycle>,
    path: String,
) -> Result<(), AppError> {
    let db = state.inner().clone();
    let cache = cache.inner().clone();
    let storage = storage.inner().clone();
    let lifecycle = lifecycle.inner().clone();
    let close_behavior = blocking_unbounded("config.import", move || {
        let bundle = config_service::read_bundle_from_path(&path)?;
        // Held until the import and its cache invalidation finish.
        let _data_replace_permit =
            lifecycle.admit(Operation::DataReplace(DataReplaceKind::ImportConfig))?;
        let close_behavior = with_connection(&db, |conn| {
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
        with_cache_connection(&cache, |connection| {
            crate::services::cache_service::remove_prefix(connection, "sessions:")?;
            Ok(())
        })?;
        Ok::<_, AppError>(close_behavior)
    })
    .await?;
    update_close_behavior_state(&close_behavior_state, close_behavior)?;
    Ok(())
}
