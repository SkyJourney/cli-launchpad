use tauri::State;

use crate::models::model::ModelCatalog;
use crate::models::tool::ToolKey;
use crate::services::{cache_service, model_service};
use crate::{with_cache, AppError, CacheDb};

const MODEL_CACHE_TTL_MS: i64 = 10 * 60 * 1_000;

#[tauri::command]
pub async fn get_model_catalog(
    cache: State<'_, CacheDb>,
    tool_key: ToolKey,
    force: Option<bool>,
) -> Result<ModelCatalog, AppError> {
    let key = format!("models:{}", tool_key.as_str());
    if !force.unwrap_or(false) {
        if let Some(mut catalog) = with_cache(&cache, |connection| {
            Ok(cache_service::get_fresh::<ModelCatalog>(
                connection,
                &key,
                MODEL_CACHE_TTL_MS,
            )?)
        })? {
            catalog.from_cache = true;
            return Ok(catalog);
        }
    }

    let stale = with_cache(&cache, |connection| {
        Ok(cache_service::get_any::<ModelCatalog>(connection, &key)?)
    })?;
    match model_service::fetch(tool_key).await {
        Ok(catalog) => {
            with_cache(&cache, |connection| {
                cache_service::put(connection, &key, &catalog)?;
                Ok(())
            })?;
            Ok(catalog)
        }
        Err(error) => {
            if let Some(mut catalog) = stale {
                catalog.from_cache = true;
                catalog.warning = Some(format!("刷新模型目录失败，当前显示缓存结果：{error}"));
                Ok(catalog)
            } else {
                Err(error.into())
            }
        }
    }
}
