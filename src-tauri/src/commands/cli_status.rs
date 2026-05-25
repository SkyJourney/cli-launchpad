use crate::models::cli_status::CliStatus;
use crate::services::{cache_service, cli_detect_service};
use crate::{with_cache, AppError, CacheDb};
use tauri::State;

#[tauri::command]
pub async fn detect_cli_status(
    cache: State<'_, CacheDb>,
    force: Option<bool>,
) -> Result<Vec<CliStatus>, AppError> {
    const KEY: &str = "cli-status";
    if !force.unwrap_or(false) {
        if let Some(cached) = with_cache(&cache, |connection| {
            Ok(cache_service::get_fresh(connection, KEY, 30_000)?)
        })? {
            return Ok(cached);
        }
    }
    // Detection runs bounded, kill-on-drop subprocesses per tool, so it is safe
    // to await directly on the async runtime.
    let statuses = cli_detect_service::detect_all().await;
    with_cache(&cache, |connection| {
        cache_service::put(connection, KEY, &statuses)?;
        Ok(())
    })?;
    Ok(statuses)
}
