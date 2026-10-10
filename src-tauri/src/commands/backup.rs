use tauri::{Emitter, State};

use crate::models::backup::{BackupManifest, BackupReason};
use crate::services::pty_session_service::PtySessionManager;
use crate::services::{backup_service, storage_service::StoragePaths};
use crate::{
    update_close_behavior_state, with_connection, AppError, CacheDb, CloseBehaviorState, Db,
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

struct TauriRestoreNotifier(tauri::AppHandle);

impl backup_service::RestoreNotifier for TauriRestoreNotifier {
    fn workspace_data_restored(&self) -> Result<(), String> {
        self.0
            .emit_to("main", "workspace-data-restored", ())
            .map_err(|error| error.to_string())
    }
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
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let notifier = TauriRestoreNotifier(app);
        backup_service::restore_with_runtime_invalidation(
            &db, &cache, &sessions, &paths, &backup_id, &notifier,
        )
    })
    .await
    .map_err(|error| AppError::msg(format!("备份恢复任务异常：{error}")))??;

    if let Some(warning) = &outcome.cache_warning {
        log::warn!("backup restore: {warning}");
    }
    update_close_behavior_state(&close_behavior_state, outcome.close_behavior)?;
    Ok(outcome.manifest)
}
