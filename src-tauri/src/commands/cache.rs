use tauri::State;

use crate::models::cache::CacheStats;
use crate::services::{cache_service, storage_service::StoragePaths};
use crate::{AppError, CacheDb};

#[tauri::command]
pub async fn get_cache_stats(
    cache: State<'_, CacheDb>,
    storage: State<'_, StoragePaths>,
) -> Result<CacheStats, AppError> {
    let database_path = storage.cache_dir.join("cache.db");
    cache
        .call("cache.stats", move |connection| {
            Ok(cache_service::stats(connection, &database_path)?)
        })
        .await
}

#[tauri::command]
pub async fn clear_cache(cache: State<'_, CacheDb>) -> Result<(), AppError> {
    cache
        .call("cache.clear", |connection| {
            cache_service::clear(connection)?;
            log::info!("application cache cleared");
            Ok(())
        })
        .await
}
