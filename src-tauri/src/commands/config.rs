use tauri::State;

use crate::services::app_lifecycle::AppLifecycle;
use crate::services::config_service;
use crate::services::storage_service::StoragePaths;
use crate::{
    blocking_unbounded, update_close_behavior_state, AppError, CacheDb, CloseBehaviorState, Db,
};

#[tauri::command]
pub async fn export_config_to_path(state: State<'_, Db>, path: String) -> Result<(), AppError> {
    let db = state.inner().clone();
    // A write whose timeout would be misleading: no budget, still off the async worker.
    blocking_unbounded("config.export", move || {
        config_service::export_with(&db, &path)
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
        config_service::import_with(&db, &cache, &storage, &lifecycle, &path)
    })
    .await?;
    update_close_behavior_state(&close_behavior_state, close_behavior)?;
    Ok(())
}
