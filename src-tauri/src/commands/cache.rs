use tauri::State;

use crate::models::cache::CacheStats;
use crate::services::{cache_service, storage_service::StoragePaths};
use crate::{with_cache, AppError, CacheDb};

#[tauri::command]
pub fn get_cache_stats(
    cache: State<'_, CacheDb>,
    storage: State<'_, StoragePaths>,
) -> Result<CacheStats, AppError> {
    with_cache(&cache, |connection| {
        Ok(cache_service::stats(
            connection,
            &storage.cache_dir.join("cache.db"),
        )?)
    })
}

#[tauri::command]
pub fn clear_cache(cache: State<'_, CacheDb>) -> Result<(), AppError> {
    with_cache(&cache, |connection| {
        cache_service::clear(connection)?;
        log::info!("application cache cleared");
        Ok(())
    })
}
