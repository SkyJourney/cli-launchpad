use std::time::Duration;

use crate::models::install::{LatestVersion, UpdateAvailability};
use crate::models::tool::ToolKey;

const RELEASE_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) fn latest_from_version_result(
    tool_key: ToolKey,
    result: Result<String, String>,
) -> LatestVersion {
    match result {
        Ok(latest) => LatestVersion {
            tool_key,
            latest: Some(latest),
            update_availability: UpdateAvailability::Unknown,
            commits_behind: None,
            error: None,
            from_cache: false,
            managed_update: crate::services::cli_adapters::get(tool_key).managed_update(None),
        },
        Err(error) => {
            log::warn!("latest version query failed tool={}", tool_key.as_str());
            LatestVersion {
                tool_key,
                latest: None,
                update_availability: UpdateAvailability::Unknown,
                commits_behind: None,
                error: Some(error),
                from_cache: false,
                managed_update: crate::services::cli_adapters::get(tool_key)
                    .managed_update_after_failed_query(),
            }
        }
    }
}

/// Combine the version service result with the current version captured by CLI
/// detection. Branch based tools provide their update state directly.
pub(crate) fn apply_update_availability(latest: &mut LatestVersion, current_version: Option<&str>) {
    if crate::services::cli_adapters::get(latest.tool_key)
        .descriptor()
        .capabilities
        .update_semantics
        == crate::services::cli_adapters::UpdateSemantics::Branch
    {
        return;
    }
    latest.update_availability = match (
        current_version.and_then(semver_tuple),
        latest.latest.as_deref().and_then(semver_tuple),
    ) {
        (Some(current), Some(remote)) if remote > current => UpdateAvailability::Available,
        (Some(_), Some(_)) => UpdateAvailability::UpToDate,
        _ => UpdateAvailability::Unknown,
    };
}

fn semver_tuple(value: &str) -> Option<(u64, u64, u64)> {
    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() {
            continue;
        }
        if start > 0 && bytes[start - 1].is_ascii_digit() {
            continue;
        }
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
            end += 1;
        }
        let candidate = &value[start..end];
        let mut parts = candidate.split('.');
        let Some(major) = parts.next().and_then(|part| part.parse().ok()) else {
            continue;
        };
        let Some(minor) = parts.next().and_then(|part| part.parse().ok()) else {
            continue;
        };
        let Some(patch) = parts.next().and_then(|part| part.parse().ok()) else {
            continue;
        };
        if parts.next().is_none() {
            return Some((major, minor, patch));
        }
    }
    None
}

pub(crate) fn fetch_release_text(url: &str) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(RELEASE_TIMEOUT)
        .timeout_read(RELEASE_TIMEOUT)
        .build();
    get_text(&agent, url)
}

pub(crate) fn first_output_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(200).collect())
}

fn get_text(agent: &ureq::Agent, url: &str) -> Result<String, String> {
    let response = agent
        .get(url)
        .call()
        .map_err(|error| format!("官方发布服务请求失败：{error}"))?;
    response
        .into_string()
        .map_err(|error| format!("官方发布响应读取失败：{error}"))
}

pub(crate) fn normalize_semver(value: &str) -> Option<String> {
    let core = value.split_once('-').map_or(value, |(core, _)| core);
    let mut parts = core.split('.');
    let valid = (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.chars().all(|char| char.is_ascii_digit()))
    }) && parts.next().is_none();
    valid.then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::install::ManagedUpdateStatus;

    #[test]
    fn maps_managed_update_and_availability_for_all_five_clis() {
        let cases = [
            (ToolKey::Claude, ManagedUpdateStatus::Allowed, false),
            (ToolKey::Codex, ManagedUpdateStatus::Allowed, false),
            (ToolKey::Antigravity, ManagedUpdateStatus::Allowed, false),
            (ToolKey::Grok, ManagedUpdateStatus::Allowed, false),
            (ToolKey::Hermes, ManagedUpdateStatus::Allowed, true),
        ];

        for (tool_key, expected_managed, branch_based) in cases {
            let mut latest = latest_from_version_result(tool_key, Ok("1.2.4".to_string()));
            latest.managed_update =
                crate::services::cli_adapters::get(tool_key).managed_update(Some(true));
            if branch_based {
                latest.update_availability = UpdateAvailability::Available;
            } else {
                apply_update_availability(&mut latest, Some("CLI version 1.2.3"));
            }

            assert_eq!(latest.managed_update, expected_managed);
            assert_eq!(latest.update_availability, UpdateAvailability::Available);
        }

        assert!(matches!(
            crate::services::cli_adapters::get(ToolKey::Grok).managed_update(None),
            ManagedUpdateStatus::Denied { .. }
        ));
        assert!(matches!(
            crate::services::cli_adapters::get(ToolKey::Hermes).managed_update(Some(false)),
            ManagedUpdateStatus::Denied { .. }
        ));
    }

    #[test]
    fn version_comparison_reports_up_to_date_and_unknown_states() {
        let mut up_to_date = latest_from_version_result(ToolKey::Codex, Ok("1.2.3".to_string()));
        apply_update_availability(&mut up_to_date, Some("v1.2.3-beta.1"));
        assert_eq!(up_to_date.update_availability, UpdateAvailability::UpToDate);

        let mut unknown = latest_from_version_result(ToolKey::Codex, Ok("1.2.3".to_string()));
        apply_update_availability(&mut unknown, None);
        assert_eq!(unknown.update_availability, UpdateAvailability::Unknown);
    }
}
