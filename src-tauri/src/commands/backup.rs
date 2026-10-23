use tauri::{Manager, State};

use crate::commands::files::TauriContentWindowReclaimer;
use crate::models::backup::{BackupManifest, BackupReason};
use crate::models::window_kind::{CallerWindow, WindowKind};
use crate::services::app_lifecycle::AppLifecycle;
use crate::services::content_window_grants::{
    ContentWindowGrantRegistry, ContentWindowRevoker, RevocationReason,
};
use crate::services::session_service::RestoreGeneration;
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{
    blocking, blocking_unbounded, budgets, update_close_behavior_state, AppError, CacheDb,
    CloseBehaviorState, Db,
};

#[tauri::command]
pub async fn list_backups(paths: State<'_, StoragePaths>) -> Result<Vec<BackupManifest>, AppError> {
    let paths = paths.inner().clone();
    blocking("backup.list", budgets::FILE_OPERATION, move || {
        backup_service::list(&paths).map_err(AppError::from)
    })
    .await
}

#[tauri::command]
pub async fn create_backup(
    state: State<'_, Db>,
    paths: State<'_, StoragePaths>,
) -> Result<BackupManifest, AppError> {
    let db = state.inner().clone();
    let paths = paths.inner().clone();
    blocking_unbounded("backup.create", move || {
        backup_service::create_with(&db, &paths, BackupReason::Manual)
    })
    .await
}

struct TauriRestoreNotifier(tauri::AppHandle);

impl backup_service::RestoreNotifier for TauriRestoreNotifier {
    fn workspace_data_restored(&self) -> Result<(), String> {
        match crate::services::window_inbox::notify_main(
            &self.0,
            crate::events::WORKSPACE_DATA_RESTORED,
            serde_json::Value::Null,
        ) {
            crate::services::window_inbox::DeliverOutcome::NoInbox => {
                Err("main window inbox is unavailable".to_string())
            }
            _ => Ok(()),
        }
    }
}

#[tauri::command]
pub async fn restore_backup(
    caller: CallerWindow,
    state: State<'_, Db>,
    cache: State<'_, CacheDb>,
    path_semantics: State<
        '_,
        std::sync::Arc<crate::services::project_path_semantics::CaseSensitivityCache>,
    >,
    close_behavior_state: State<'_, CloseBehaviorState>,
    lifecycle: State<'_, AppLifecycle>,
    generation: State<'_, RestoreGeneration>,
    paths: State<'_, StoragePaths>,
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<BackupManifest, AppError> {
    caller.require(&[WindowKind::Main])?;
    let db = state.inner().clone();
    let cache = cache.inner().clone();
    let lifecycle = lifecycle.inner().clone();
    let generation = generation.inner().clone();
    let paths = paths.inner().clone();
    let app = app.clone();
    let outcome = blocking_unbounded("backup.restore", move || {
        let reclaimer = TauriContentWindowReclaimer(app.clone());
        let grants = app.state::<ContentWindowGrantRegistry>();
        let revoker =
            ContentWindowRevoker::new(grants.inner(), &reclaimer, RevocationReason::RestoreBackup);
        let notifier = TauriRestoreNotifier(app.clone());
        backup_service::restore_with_runtime_invalidation(
            &db,
            &cache,
            &lifecycle,
            &paths,
            &backup_id,
            &notifier,
            &generation,
            &revoker,
        )
    })
    .await?;
    // The restored database may give other projects the same ids.
    path_semantics.invalidate_all();

    if let Some(warning) = &outcome.cache_warning {
        log::warn!("backup restore: {warning}");
    }
    update_close_behavior_state(&close_behavior_state, outcome.close_behavior)?;
    Ok(outcome.manifest)
}

#[cfg(test)]
mod tests {
    #[test]
    fn restore_command_passes_the_managed_generation_to_the_restore_orchestration() {
        let production = include_str!("backup.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            production.contains("State<'_, RestoreGeneration>"),
            "restore_backup must receive the managed RestoreGeneration"
        );
        assert!(
            production.contains("restore_with_runtime_invalidation("),
            "restore_backup must call the restore orchestration"
        );
        let lib = include_str!("../lib.rs");
        assert!(
            lib.contains("RestoreGeneration::default()"),
            "the generation must be registered as managed state"
        );
        assert!(
            !production.contains("generation.advance()"),
            "the generation is advanced inside the service, never by the command"
        );
    }
}
