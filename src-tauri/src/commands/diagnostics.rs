use tauri::State;

use crate::services::{diagnostics_service, storage_service::StoragePaths};
use crate::{blocking_unbounded, with_connection, AppError, Db};

#[tauri::command]
pub async fn export_diagnostics_to_path(
    state: State<'_, Db>,
    storage: State<'_, StoragePaths>,
    path: String,
) -> Result<(), AppError> {
    let db = state.inner().clone();
    let storage = storage.inner().clone();
    blocking_unbounded("diagnostics.export", move || {
        with_connection(&db, |connection| {
            diagnostics_service::export_to_path(connection, &storage, &path)?;
            log::info!("diagnostics export completed");
            Ok(())
        })
    })
    .await
}

/// Records a window synchronisation failure reported by the renderer. The window
/// label comes from the calling window, not from the payload. The command is
/// synchronous on purpose: it only formats text and writes to the logger.
#[tauri::command]
// sync: 纯内存：只格式化文本并写日志
pub fn report_window_sync_failure(window: tauri::WebviewWindow, code: String, message: String) {
    diagnostics_service::log_window_sync_failure(window.label(), &code, &message);
}
