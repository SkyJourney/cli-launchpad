use tauri::{AppHandle, Manager, State};

use crate::commands::files::TauriContentWindowReclaimer;
use crate::models::window_kind::{CallerWindow, WindowKind};
use crate::services::app_lifecycle::AppLifecycle;
use crate::services::config_service;
use crate::services::content_window_grants::{
    ContentWindowGrantRegistry, ContentWindowRevoker, RevocationReason,
};
use crate::services::session_service::RestoreGeneration;
use crate::services::storage_service::StoragePaths;
use crate::{blocking_unbounded, update_close_behavior_state, AppError, CloseBehaviorState, Db};

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
    caller: CallerWindow,
    app: AppHandle,
    state: State<'_, Db>,
    close_behavior_state: State<'_, CloseBehaviorState>,
    storage: State<'_, StoragePaths>,
    lifecycle: State<'_, AppLifecycle>,
    generation: State<'_, RestoreGeneration>,
    path: String,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main])?;
    let db = state.inner().clone();
    let generation = generation.inner().clone();
    let storage = storage.inner().clone();
    let lifecycle = lifecycle.inner().clone();
    let close_behavior = blocking_unbounded("config.import", move || {
        // The revoker is built here and handed to the hook entry point, which revokes only the
        // grants whose project was removed or re-pathed by the import (m6-099).
        let grants = app.state::<ContentWindowGrantRegistry>();
        let reclaimer = TauriContentWindowReclaimer(app.clone());
        let revoker =
            ContentWindowRevoker::new(grants.inner(), &reclaimer, RevocationReason::ImportConfig);
        config_service::import_with(&db, &storage, &lifecycle, &generation, &revoker, &path)
    })
    .await?;
    update_close_behavior_state(&close_behavior_state, close_behavior)?;
    Ok(())
}
