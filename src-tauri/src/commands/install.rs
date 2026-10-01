use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;
use crate::services::{cache_service, cli_adapters, install_service};
use crate::{with_cache, AppError, CacheDb};
use tauri::State;

#[tauri::command]
pub async fn fetch_latest_version(
    cache: State<'_, CacheDb>,
    tool_key: ToolKey,
    force: Option<bool>,
) -> Result<LatestVersion, AppError> {
    let key = format!("latest-version:{}", tool_key.as_str());
    if !force.unwrap_or(false) {
        if let Some(cached) = with_cache(&cache, |connection| {
            Ok(cache_service::get_fresh(connection, &key, 30 * 60 * 1000)?)
        })? {
            return Ok(cached);
        }
    }
    let stale = with_cache(&cache, |connection| {
        Ok(cache_service::get_any::<LatestVersion>(connection, &key)?)
    })?;
    let mut fetched = match tauri::async_runtime::spawn_blocking(move || {
        cli_adapters::get(tool_key).query_update()
    })
    .await
    {
        Ok(result) => result,
        Err(error) => crate::services::version_service::latest_from_version_result(
            tool_key,
            Err(format!("{} 版本查询适配器异常：{error}", tool_key.as_str())),
        ),
    };

    if let Some(stale) = stale {
        let has_fresh_result = fetched.latest.is_some() || fetched.update_available.is_some();
        if !has_fresh_result && fetched.error.is_some() {
            fetched.latest = stale.latest;
            fetched.update_available = stale.update_available;
            fetched.commits_behind = stale.commits_behind;
            if fetched.management_message.is_none() {
                fetched.managed_update_allowed = stale.managed_update_allowed;
                fetched
                    .management_message
                    .clone_from(&stale.management_message);
            }
            fetched.from_cache = true;
        }
    }
    if fetched.latest.is_some() || fetched.update_available.is_some() {
        with_cache(&cache, |connection| {
            cache_service::put(connection, &key, &fetched)?;
            Ok(())
        })?;
    }
    Ok(fetched)
}

/// Return the structured command without executing it, for UI preview/confirm.
#[tauri::command]
pub async fn get_install_plan(
    tool_key: ToolKey,
    kind: InstallKind,
) -> Result<InstallPlan, AppError> {
    tauri::async_runtime::spawn_blocking(move || install_service::plan(tool_key, kind))
        .await
        .map_err(|error| {
            AppError::msg(format!("{} 安装计划适配器异常：{error}", tool_key.as_str()))
        })?
        .map_err(Into::into)
}
