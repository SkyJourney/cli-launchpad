use crate::models::cache::CacheKey;
use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::install::{
    InstallKind, InstallPlan, LatestVersion, ManagedUpdateStatus, UpdateAvailability,
};
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
    let key = CacheKey::LatestVersion(tool_key);
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
    let home = match crate::services::session_service::home_dir() {
        Ok(home) => home,
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
    let (context, remaining) = cli_adapters::context_within_budget(
        cli_adapters::get(tool_key),
        std::time::Duration::from_secs(30),
        home,
        std::sync::Arc::new(cli_adapters::NativeExecutableResolver),
    )
    .await;
    let mut fetched = if remaining.is_zero() {
        crate::services::version_service::latest_from_version_result(
            tool_key,
            Err(format!("{} 版本查询超时", tool_key.as_str())),
        )
    } else {
        cli_adapters::query_update(tool_key, context).await
    };
    crate::services::version_service::apply_update_availability(
        &mut fetched,
        current_version.as_deref(),
    );

    store_latest_result(&cache, key.clone(), fetched.clone()).await?;

    if let Some(stale) = stale {
        merge_stale_latest(&mut fetched, stale);
    }
    crate::services::version_service::apply_update_availability(
        &mut fetched,
        current_version.as_deref(),
    );
    Ok(fetched)
}

fn merge_stale_latest(fetched: &mut LatestVersion, stale: LatestVersion) {
    let has_fresh_result =
        fetched.latest.is_some() || fetched.update_availability != UpdateAvailability::Unknown;
    if !has_fresh_result && fetched.error.is_some() {
        fetched.latest = stale.latest;
        fetched.update_availability = stale.update_availability;
        fetched.commits_behind = stale.commits_behind;
        fetched.from_cache = true;
        fetched.managed_update = match stale.managed_update {
            // 旧缓存没有记录托管状态（缺省值）时，按适配器策略重新计算。
            ManagedUpdateStatus::NotApplicable => {
                cli_adapters::get(fetched.tool_key).managed_update_after_failed_query()
            }
            recorded => recorded,
        };
    }
}

async fn cached_current_version(
    cache: &CacheDb,
    tool_key: ToolKey,
) -> Result<Option<String>, AppError> {
    let key = CacheKey::CliStatus(tool_key);
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
    key: CacheKey,
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
    use crate::models::install::{LatestVersion, ManagedUpdateStatus};
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
        key: &CacheKey,
        fetched: &LatestVersion,
    ) -> Result<(), AppError> {
        tauri::async_runtime::block_on(store_latest_result(cache, *key, fetched.clone()))
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
        cache_service::put(
            &crate::runtime::CacheConn::for_test(&connection),
            &CacheKey::LatestVersion(ToolKey::Codex),
            &latest(None, false),
        )
        .unwrap();
        let original_timestamp: i64 = connection
            .query_row(
                "select created_at_ms from cache_entries where key = ?1",
                params!["latest-version:codex"],
                |row| row.get(0),
            )
            .unwrap();

        let failed = latest(Some("network unavailable"), false);
        let cache = CacheDb::new(connection);
        cache_successful_latest_result(&cache, &CacheKey::LatestVersion(ToolKey::Codex), &failed)
            .unwrap();

        let connection = cache.lock_for_test();
        let current_timestamp: i64 = connection
            .query_row(
                "select created_at_ms from cache_entries where key = ?1",
                params!["latest-version:codex"],
                |row| row.get(0),
            )
            .unwrap();
        let cached: LatestVersion = cache_service::get_any(
            &crate::runtime::CacheConn::for_test(&connection),
            &CacheKey::LatestVersion(ToolKey::Codex),
        )
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
        let cache = CacheDb::new(connection);

        cache_successful_latest_result(
            &cache,
            &CacheKey::LatestVersion(ToolKey::Codex),
            &latest(None, false),
        )
        .unwrap();

        let connection = cache.lock_for_test();
        let timestamp: i64 = connection
            .query_row(
                "select created_at_ms from cache_entries where key = ?1",
                params!["latest-version:codex"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(timestamp > 1);
    }

    #[test]
    fn merge_stale_latest_restores_cached_fields_and_managed_update() {
        let failed = |tool_key| LatestVersion {
            tool_key,
            latest: None,
            update_availability: UpdateAvailability::Unknown,
            commits_behind: None,
            error: Some("network".to_string()),
            from_cache: false,
            managed_update: ManagedUpdateStatus::NotApplicable,
        };
        let stale = |tool_key, managed_update| LatestVersion {
            tool_key,
            latest: Some("1.0.0".to_string()),
            update_availability: UpdateAvailability::Available,
            commits_behind: Some(3),
            error: None,
            from_cache: false,
            managed_update,
        };
        let denied = ManagedUpdateStatus::Denied {
            reason_key: "settings.grokUpdateSourceDenied".to_string(),
        };

        // 旧缓存记录了 Denied：失败刷新后原样恢复，错误文本保留。
        let mut fetched = failed(ToolKey::Grok);
        merge_stale_latest(&mut fetched, stale(ToolKey::Grok, denied.clone()));
        assert_eq!(fetched.latest.as_deref(), Some("1.0.0"));
        assert_eq!(fetched.update_availability, UpdateAvailability::Available);
        assert_eq!(fetched.commits_behind, Some(3));
        assert!(fetched.from_cache);
        assert_eq!(fetched.error.as_deref(), Some("network"));
        assert_eq!(fetched.managed_update, denied);

        // 旧缓存是缺省的 NotApplicable：按适配器策略重新计算（Claude 总是允许）。
        let mut fetched = failed(ToolKey::Claude);
        merge_stale_latest(
            &mut fetched,
            stale(ToolKey::Claude, ManagedUpdateStatus::NotApplicable),
        );
        assert_eq!(fetched.managed_update, ManagedUpdateStatus::Allowed);

        // 反向断言：本次查询有新结果时不合并旧缓存。
        let mut fresh = failed(ToolKey::Grok);
        fresh.latest = Some("2.0.0".to_string());
        merge_stale_latest(&mut fresh, stale(ToolKey::Grok, denied));
        assert_eq!(fresh.latest.as_deref(), Some("2.0.0"));
        assert!(!fresh.from_cache);
        assert_eq!(fresh.managed_update, ManagedUpdateStatus::NotApplicable);
    }
}
