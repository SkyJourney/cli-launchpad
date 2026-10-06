use tauri::State;

use crate::services::{diagnostics_service, storage_service::StoragePaths};
use crate::{with_connection, AppError, Db};

#[tauri::command]
pub async fn export_diagnostics_to_path(
    state: State<'_, Db>,
    storage: State<'_, StoragePaths>,
    path: String,
) -> Result<(), AppError> {
    let db = state.inner().clone();
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_connection(&db, |connection| {
            diagnostics_service::export_to_path(connection, &storage, &path)?;
            log::info!("diagnostics export completed");
            Ok(())
        })
    })
    .await
    .map_err(|error| AppError::msg(format!("诊断导出任务异常：{error}")))?
}
