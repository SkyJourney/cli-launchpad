use crate::models::install::{InstallKind, InstallOutcome, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;
use crate::services::{cache_service, install_service, version_service};
use crate::{with_cache, AppError, CacheDb};
use tauri::State;

#[tauri::command]
pub async fn fetch_latest_versions(
    cache: State<'_, CacheDb>,
    force: Option<bool>,
) -> Result<Vec<LatestVersion>, AppError> {
    const KEY: &str = "latest-versions";
    if !force.unwrap_or(false) {
        if let Some(cached) = with_cache(&cache, |connection| {
            Ok(cache_service::get_fresh(connection, KEY, 30 * 60 * 1000)?)
        })? {
            return Ok(cached);
        }
    }
    let stale = with_cache(&cache, |connection| {
        Ok(cache_service::get_any::<Vec<LatestVersion>>(
            connection, KEY,
        )?)
    })?;
    let fetched = tauri::async_runtime::spawn_blocking(version_service::fetch_all_latest)
        .await
        .map_err(|error| AppError::msg(error.to_string()))?;
    if fetched.iter().any(|entry| entry.latest.is_some()) {
        with_cache(&cache, |connection| {
            cache_service::put(connection, KEY, &fetched)?;
            Ok(())
        })?;
        Ok(fetched)
    } else {
        Ok(stale.unwrap_or(fetched))
    }
}

/// Return the structured command without executing it, for UI preview/confirm.
#[tauri::command]
pub fn get_install_plan(tool_key: ToolKey, kind: InstallKind) -> Result<InstallPlan, AppError> {
    Ok(install_service::plan(tool_key, kind)?)
}

#[tauri::command]
pub async fn run_install(tool_key: ToolKey, kind: InstallKind) -> Result<InstallOutcome, AppError> {
    let plan = install_service::plan(tool_key, kind)?;
    Ok(install_service::run(&plan).await)
}
