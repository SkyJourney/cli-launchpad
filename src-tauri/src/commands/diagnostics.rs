use tauri::State;

use crate::services::{diagnostics_service, storage_service::StoragePaths};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn export_diagnostics_to_path(
    state: State<'_, Db>,
    storage: State<'_, StoragePaths>,
    path: String,
) -> Result<(), AppError> {
    with_conn(&state, |connection| {
        diagnostics_service::export_to_path(connection, &storage, &path)?;
        log::info!("diagnostics export completed");
        Ok(())
    })
}
