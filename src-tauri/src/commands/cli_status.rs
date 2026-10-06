use crate::models::cli_status::CliStatus;
use crate::models::tool::ToolKey;
use crate::services::{cache_service, cli_detect_service};
use crate::{with_cache, AppError, CacheDb};
use tauri::State;

#[tauri::command]
pub async fn detect_cli_status(
    cache: State<'_, CacheDb>,
    force: Option<bool>,
    tool_key: Option<ToolKey>,
) -> Result<Vec<CliStatus>, AppError> {
    let key = cache_key(tool_key);
    let probe_versions = force.unwrap_or(false);
    if !probe_versions {
        if let Some(cached) = with_cache(&cache, |connection| {
            Ok(cache_service::get_fresh(connection, &key, 30_000)?)
        })? {
            return Ok(cached);
        }
    }
    let previous = with_cache(&cache, |connection| {
        Ok(cache_service::get_any::<Vec<CliStatus>>(connection, &key)?)
    })?;
    // Detection runs bounded, kill-on-drop subprocesses per tool, so it is safe
    // to await directly on the async runtime.
    let mut statuses = match tool_key {
        Some(tool_key) => vec![cli_detect_service::detect_one(tool_key, probe_versions).await],
        None => cli_detect_service::detect_all(probe_versions).await,
    };
    if !probe_versions {
        preserve_versions_for_unchanged_paths(&mut statuses, previous.as_deref());
    }
    with_cache(&cache, |connection| {
        cache_service::put(connection, &key, &statuses)?;
        Ok(())
    })?;
    Ok(statuses)
}

fn cache_key(tool_key: Option<ToolKey>) -> String {
    match tool_key {
        Some(tool_key) => format!("cli-status:{}", tool_key.as_str()),
        None => "cli-status:all".to_string(),
    }
}

fn preserve_versions_for_unchanged_paths(
    statuses: &mut [CliStatus],
    previous: Option<&[CliStatus]>,
) {
    let Some(previous) = previous else {
        return;
    };
    for status in statuses {
        let Some(old) = previous.iter().find(|old| old.tool_key == status.tool_key) else {
            continue;
        };
        if paths_equal(status.path.as_deref(), old.path.as_deref()) {
            status.version.clone_from(&old.version);
            status.version_error.clone_from(&old.version_error);
        }
    }
}

fn paths_equal(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => crate::platform::path_identity::paths_equal(left, right),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::cli_status::CliAvailability;
    use crate::models::tool::ToolKey;

    #[test]
    fn status_cache_keys_are_isolated_per_tool() {
        assert_eq!(cache_key(Some(ToolKey::Claude)), "cli-status:claude");
        assert_eq!(cache_key(Some(ToolKey::Codex)), "cli-status:codex");
        assert_eq!(cache_key(None), "cli-status:all");
    }

    fn status(path: &str, version: Option<&str>) -> CliStatus {
        CliStatus {
            tool_key: ToolKey::Codex,
            status: CliAvailability::Available,
            path: Some(path.to_string()),
            resolved_command: Some("codex".to_string()),
            version: version.map(str::to_string),
            version_error: None,
            latest_version: None,
        }
    }

    #[test]
    #[cfg(windows)]
    fn preserves_version_only_when_resolved_path_is_unchanged() {
        let previous = vec![status("C:\\Tools\\codex.exe", Some("0.147.0"))];
        let mut unchanged = vec![status("c:\\tools\\CODEX.exe", None)];
        preserve_versions_for_unchanged_paths(&mut unchanged, Some(&previous));
        assert_eq!(unchanged[0].version.as_deref(), Some("0.147.0"));

        let mut changed = vec![status("C:\\Other\\codex.exe", None)];
        preserve_versions_for_unchanged_paths(&mut changed, Some(&previous));
        assert_eq!(changed[0].version, None);
    }

    #[test]
    #[cfg(not(windows))]
    fn preserves_version_with_unix_path_semantics() {
        let previous = vec![status("/Users/me/bin/codex", Some("0.147.0"))];
        let mut unchanged = vec![status("/Users/me/bin/codex/", None)];
        preserve_versions_for_unchanged_paths(&mut unchanged, Some(&previous));
        assert_eq!(unchanged[0].version.as_deref(), Some("0.147.0"));

        let mut changed = vec![status("/Users/Me/bin/codex", None)];
        preserve_versions_for_unchanged_paths(&mut changed, Some(&previous));
        assert_eq!(changed[0].version, None);
    }
}
