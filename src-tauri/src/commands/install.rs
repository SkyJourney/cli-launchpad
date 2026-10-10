use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::install::{InstallKind, InstallPlan, LatestVersion, UpdateAvailability};
use crate::models::tool::ToolKey;
use crate::services::{cache_service, cli_adapters, install_service};
use crate::{blocking, budgets, AppError, CacheDb};
use tauri::State;

#[tauri::command]
pub async fn fetch_latest_version(
    cache: State<'_, CacheDb>,
    tool_key: ToolKey,
    force: Option<bool>,
) -> Result<LatestVersion, AppError> {
    let key = format!("latest-version:{}", tool_key.as_str());
    let current_version = cached_current_version(&cache, tool_key).await?;
    if !force.unwrap_or(false) {
        let lookup_key = key.clone();
        if let Some(mut cached) = cache
            .call("install.latest_fresh", move |connection| {
                Ok(cache_service::get_fresh(
                    connection,
                    &lookup_key,
                    30 * 60 * 1000,
                )?)
            })
            .await?
        {
            crate::services::version_service::apply_update_availability(
                &mut cached,
                current_version.as_deref(),
            );
            return Ok(cached);
        }
    }
    let stale_key = key.clone();
    let stale = cache
        .call("install.latest_stale", move |connection| {
            Ok(cache_service::get_any::<LatestVersion>(
                connection, &stale_key,
            )?)
        })
        .await?;
    let context = match blocking("install.context", budgets::EXECUTABLE_PROBE, move || {
        cli_adapters::context_for_tool(tool_key, std::time::Duration::from_secs(30))
            .map_err(AppError::from)
    })
    .await
    {
        Ok(context) => context,
        Err(error) => {
            let mut failed = crate::services::version_service::latest_from_version_result(
                tool_key,
                Err(format!(
                    "{} 版本查询上下文不可用：{error}",
                    tool_key.as_str()
                )),
            );
            crate::services::version_service::apply_update_availability(
                &mut failed,
                current_version.as_deref(),
            );
            return Ok(failed);
        }
    };
    let mut fetched = cli_adapters::query_update(tool_key, context).await;
    crate::services::version_service::apply_update_availability(
        &mut fetched,
        current_version.as_deref(),
    );

    store_latest_result(&cache, key.clone(), fetched.clone()).await?;

    if let Some(stale) = stale {
        let has_fresh_result =
            fetched.latest.is_some() || fetched.update_availability != UpdateAvailability::Unknown;
        if !has_fresh_result && fetched.error.is_some() {
            fetched.latest = stale.latest;
            fetched.update_availability = stale.update_availability;
            fetched.commits_behind = stale.commits_behind;
            fetched.from_cache = true;
        }
    }
    crate::services::version_service::apply_update_availability(
        &mut fetched,
        current_version.as_deref(),
    );
    Ok(fetched)
}

async fn cached_current_version(
    cache: &CacheDb,
    tool_key: ToolKey,
) -> Result<Option<String>, AppError> {
    let key = format!("cli-status:{}", tool_key.as_str());
    let statuses = cache
        .call("install.cached_current_version", move |connection| {
            Ok(cache_service::get_any::<Vec<CliStatus>>(connection, &key)?)
        })
        .await?;
    Ok(current_version_from_statuses(statuses, tool_key))
}

fn current_version_from_statuses(
    statuses: Option<Vec<CliStatus>>,
    tool_key: ToolKey,
) -> Option<String> {
    statuses?.into_iter().find_map(|status| {
        (status.tool_key == tool_key
            && status.status == CliAvailability::Available
            && status.path.is_some())
        .then_some(status.version)
        .flatten()
    })
}

/// Whether a fetched result may replace the cached entry.
fn latest_result_is_cacheable(fetched: &LatestVersion) -> bool {
    if fetched.from_cache || fetched.error.is_some() {
        return false;
    }
    !(fetched.latest.is_none() && fetched.update_availability == UpdateAvailability::Unknown)
}

async fn store_latest_result(
    cache: &CacheDb,
    key: String,
    fetched: LatestVersion,
) -> Result<(), AppError> {
    if !latest_result_is_cacheable(&fetched) {
        return Ok(());
    }
    cache
        .call("install.latest_store", move |connection| {
            cache_service::put(connection, &key, &fetched)?;
            Ok(())
        })
        .await
}

/// Return the structured command without executing it, for UI preview/confirm.
#[tauri::command]
pub async fn get_install_plan(
    tool_key: ToolKey,
    kind: InstallKind,
) -> Result<InstallPlan, AppError> {
    blocking("install.plan", budgets::INSTALL_PLAN, move || {
        install_service::plan(tool_key, kind).map_err(AppError::from)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::cli_status::CliAvailability;
    use crate::models::install::LatestVersion;
    use crate::models::tool::ToolKey;
    use rusqlite::{params, Connection};

    fn latest(error: Option<&str>, from_cache: bool) -> LatestVersion {
        LatestVersion {
            tool_key: ToolKey::Codex,
            latest: Some("0.147.0".to_string()),
            update_availability: UpdateAvailability::Available,
            commits_behind: None,
            error: error.map(str::to_string),
            from_cache,
            managed_update: crate::models::install::ManagedUpdateStatus::Allowed,
        }
    }

    /// Test seam over the production store path: the cache tests below keep this
    /// name, and the write itself runs through `store_latest_result`.
    fn cache_successful_latest_result(
        cache: &CacheDb,
        key: &str,
        fetched: &LatestVersion,
    ) -> Result<(), AppError> {
        tauri::async_runtime::block_on(store_latest_result(cache, key.to_string(), fetched.clone()))
    }

    #[test]
    fn current_version_requires_an_available_cli_with_a_resolved_path() {
        let make_status = |status, path: Option<&str>, version: Option<&str>| CliStatus {
            tool_key: ToolKey::Codex,
            status,
            path: path.map(str::to_string),
            resolved_command: Some("codex".to_string()),
            version: version.map(str::to_string),
            version_error: None,
            latest_version: None,
        };

        assert_eq!(
            current_version_from_statuses(
                Some(vec![make_status(
                    CliAvailability::Available,
                    Some("/bin/codex"),
                    Some("0.147.0"),
                )]),
                ToolKey::Codex,
            )
            .as_deref(),
            Some("0.147.0")
        );
        assert_eq!(
            current_version_from_statuses(
                Some(vec![make_status(
                    CliAvailability::Unknown,
                    Some("/bin/codex"),
                    Some("0.147.0"),
                )]),
                ToolKey::Codex,
            ),
            None
        );
        assert_eq!(
            current_version_from_statuses(
                Some(vec![make_status(
                    CliAvailability::Available,
                    None,
                    Some("0.147.0"),
                )]),
                ToolKey::Codex,
            ),
            None
        );
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
        let cache = CacheDb(std::sync::Arc::new(std::sync::Mutex::new(connection)));
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
        let cache = CacheDb(std::sync::Arc::new(std::sync::Mutex::new(connection)));

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
