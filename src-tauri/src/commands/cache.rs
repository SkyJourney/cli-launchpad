use tauri::State;

use crate::models::cache::CacheStats;
use crate::services::{cache_service, storage_service::StoragePaths};
use crate::{with_cache_connection, AppError, CacheDb};

#[tauri::command]
pub async fn get_cache_stats(
    cache: State<'_, CacheDb>,
    storage: State<'_, StoragePaths>,
) -> Result<CacheStats, AppError> {
    let cache = cache.inner().clone();
    let database_path = storage.cache_dir.join("cache.db");
    tauri::async_runtime::spawn_blocking(move || {
        with_cache_connection(&cache, |connection| {
            Ok(cache_service::stats(connection, &database_path)?)
        })
    })
    .await
    .map_err(|error| AppError::msg(format!("缓存统计任务异常：{error}")))?
}

#[tauri::command]
pub async fn clear_cache(cache: State<'_, CacheDb>) -> Result<(), AppError> {
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_cache_connection(&cache, |connection| {
            cache_service::clear(connection)?;
            log::info!("application cache cleared");
            Ok(())
        })
    })
    .await
    .map_err(|error| AppError::msg(format!("缓存清理任务异常：{error}")))?
}
