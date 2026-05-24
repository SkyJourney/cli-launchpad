use crate::models::cli_status::CliStatus;
use crate::services::cli_detect_service;

#[tauri::command]
pub async fn detect_cli_status() -> Result<Vec<CliStatus>, String> {
    // Detection runs bounded, kill-on-drop subprocesses per tool, so it is safe
    // to await directly on the async runtime.
    Ok(cli_detect_service::detect_all().await)
}
