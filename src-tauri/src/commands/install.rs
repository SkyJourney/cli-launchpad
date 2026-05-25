use crate::models::install::{InstallKind, InstallOutcome, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;
use crate::services::{install_service, version_service};
use crate::AppError;

#[tauri::command]
pub async fn fetch_latest_versions() -> Result<Vec<LatestVersion>, AppError> {
    tauri::async_runtime::spawn_blocking(version_service::fetch_all_latest)
        .await
        .map_err(|error| AppError::msg(error.to_string()))
}

/// Return the structured command without executing it, for UI preview/confirm.
#[tauri::command]
pub fn get_install_plan(tool_key: ToolKey, kind: InstallKind) -> InstallPlan {
    install_service::plan(tool_key, kind)
}

#[tauri::command]
pub async fn run_install(tool_key: ToolKey, kind: InstallKind) -> Result<InstallOutcome, AppError> {
    let plan = install_service::plan(tool_key, kind);
    Ok(install_service::run(&plan).await)
}
