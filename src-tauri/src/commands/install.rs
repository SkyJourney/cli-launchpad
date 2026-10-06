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

    cache_successful_latest_result(&cache, &key, &fetched)?;

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
    Ok(fetched)
}

fn cache_successful_latest_result(
    cache: &CacheDb,
    key: &str,
    fetched: &LatestVersion,
) -> Result<(), AppError> {
    if fetched.from_cache || fetched.error.is_some() {
        return Ok(());
    }
    if fetched.latest.is_none() && fetched.update_available.is_none() {
        return Ok(());
    }
    let connection = cache
        .0
        .lock()
        .map_err(|_| AppError::msg("缓存数据库连接锁中毒"))?;
    cache_service::put(&connection, key, fetched)?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::install::LatestVersion;
    use crate::models::tool::ToolKey;
    use rusqlite::{params, Connection};

    fn latest(error: Option<&str>, from_cache: bool) -> LatestVersion {
        LatestVersion {
            tool_key: ToolKey::Codex,
            latest: Some("0.147.0".to_string()),
            update_available: None,
            commits_behind: None,
            error: error.map(str::to_string),
            from_cache,
            managed_update_allowed: true,
            management_message: None,
        }
    }

    #[test]
    fn failed_refresh_does_not_rewrite_the_cached_timestamp_or_error() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "create table cache_entries (key text primary key, value_json text not null, created_at_ms integer not null);",
            )
            .unwrap();
        cache_service::put(&connection, "latest-version:codex", &latest(None, false)).unwrap();
        let original_timestamp: i64 = connection
            .query_row(
                "select created_at_ms from cache_entries where key = ?1",
                params!["latest-version:codex"],
                |row| row.get(0),
            )
            .unwrap();

        let failed = latest(Some("network unavailable"), false);
        let cache = CacheDb(std::sync::Mutex::new(connection));
        cache_successful_latest_result(&cache, "latest-version:codex", &failed).unwrap();

        let connection = cache.0.lock().unwrap();
        let current_timestamp: i64 = connection
            .query_row(
                "select created_at_ms from cache_entries where key = ?1",
                params!["latest-version:codex"],
                |row| row.get(0),
            )
            .unwrap();
        let cached: LatestVersion = cache_service::get_any(&connection, "latest-version:codex")
            .unwrap()
            .unwrap();
        assert_eq!(current_timestamp, original_timestamp);
        assert_eq!(cached.error, None);
    }

    #[test]
    fn successful_refresh_replaces_the_cached_entry() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "create table cache_entries (key text primary key, value_json text not null, created_at_ms integer not null);",
            )
            .unwrap();
        connection
            .execute(
                "insert into cache_entries (key, value_json, created_at_ms) values (?1, ?2, 1)",
                params![
                    "latest-version:codex",
                    serde_json::to_string(&latest(None, false)).unwrap()
                ],
            )
            .unwrap();
        let cache = CacheDb(std::sync::Mutex::new(connection));

        cache_successful_latest_result(&cache, "latest-version:codex", &latest(None, false))
            .unwrap();

        let connection = cache.0.lock().unwrap();
        let timestamp: i64 = connection
            .query_row(
                "select created_at_ms from cache_entries where key = ?1",
                params!["latest-version:codex"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(timestamp > 1);
    }
}
