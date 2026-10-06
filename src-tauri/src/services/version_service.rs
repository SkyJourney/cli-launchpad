use std::time::Duration;

use crate::models::install::{LatestVersion, ManagedUpdateStatus, UpdateAvailability};
use crate::models::tool::ToolKey;

#[cfg(test)]
use crate::services::cli_adapters::antigravity::version::{
    parse_antigravity_latest, platform_for as antigravity_platform_for,
};
#[cfg(test)]
use crate::services::cli_adapters::codex::version::parse_codex_latest;

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
            managed_update: managed_update_status(tool_key, None),
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
                managed_update: managed_update_status(tool_key, None),
            }
        }
    }
}

pub(crate) fn managed_update_status(
    tool_key: ToolKey,
    source_verified: Option<bool>,
) -> ManagedUpdateStatus {
    match tool_key {
        ToolKey::Claude | ToolKey::Codex | ToolKey::Antigravity => ManagedUpdateStatus::Allowed,
        ToolKey::Grok if source_verified == Some(true) => ManagedUpdateStatus::Allowed,
        ToolKey::Hermes if source_verified == Some(true) => ManagedUpdateStatus::Allowed,
        ToolKey::Grok => ManagedUpdateStatus::Denied {
            reason_key: "settings.grokUpdateSourceDenied".to_string(),
        },
        ToolKey::Hermes => ManagedUpdateStatus::Denied {
            reason_key: "settings.hermesUpdateSourceDenied".to_string(),
        },
    }
}

/// Combine the version service result with the current version captured by CLI
/// detection. Branch based tools provide their update state directly.
pub(crate) fn apply_update_availability(latest: &mut LatestVersion, current_version: Option<&str>) {
    if latest.tool_key == ToolKey::Hermes {
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
    use crate::services::cli_adapters::grok::version::{
        grok_update_check_command, grok_update_management_message_for, parse_grok_latest,
        parse_grok_update_check,
    };
    use crate::services::cli_adapters::hermes::version::parse_hermes_update_check;

    #[test]
    fn parses_codex_release_channel_tag() {
        assert_eq!(
            parse_codex_latest(r#"{"tag_name":"rust-v0.147.0"}"#).unwrap(),
            "0.147.0"
        );
    }

    #[test]
    fn parses_antigravity_manifest_version() {
        assert_eq!(
            parse_antigravity_latest(r#"{"version":"1.1.14","url":"https://example.test"}"#)
                .unwrap(),
            "1.1.14"
        );
    }

    #[test]
    fn parses_grok_official_update_check_json() {
        let check = parse_grok_update_check(
            r#"{"currentVersion":"0.1.10","latestVersion":"0.1.12","updateAvailable":true,"installer":"internal","channel":"stable","autoUpdate":null,"error":null}"#,
        )
        .unwrap();
        assert_eq!(check.latest_version, "0.1.12");
        assert_eq!(check.installer.as_deref(), Some("internal"));
    }

    #[test]
    fn rejects_grok_check_errors_and_missing_or_invalid_latest_versions() {
        assert!(parse_grok_latest(r#"{"latestVersion":null,"error":"offline"}"#).is_err());
        assert!(parse_grok_latest(r#"{"error":null}"#).is_err());
        assert!(parse_grok_latest(r#"{"latestVersion":"unknown"}"#).is_err());
        assert!(parse_grok_latest(r#"{"latestVersion":"0.1.03"}"#).is_err());
        assert!(parse_grok_latest(r#"{"latestVersion":"0.1.3-01"}"#).is_err());
        assert!(parse_grok_latest(r#"{"latestVersion":"0.1.3","error":false}"#).is_err());
    }

    #[test]
    fn grok_parser_accepts_valid_prerelease_and_build_metadata() {
        assert_eq!(
            parse_grok_latest(r#"{"latestVersion":"0.1.12-alpha.1+build.7"}"#).unwrap(),
            "0.1.12-alpha.1+build.7"
        );
    }

    #[test]
    fn parses_hermes_main_branch_update_status_without_semver() {
        assert_eq!(
            parse_hermes_update_check("Update available: 7 commits behind origin/main.").unwrap(),
            (true, Some(7))
        );
        assert_eq!(
            parse_hermes_update_check("Already up to date with origin/main.").unwrap(),
            (false, None)
        );
        assert_eq!(
            parse_hermes_update_check("Update available; commit count unavailable.").unwrap(),
            (true, None)
        );
        assert_eq!(
            parse_hermes_update_check(
                "warning: local branch is behind metadata cache\n✓ Already up to date."
            )
            .unwrap(),
            (false, None)
        );
        assert_eq!(
            parse_hermes_update_check("No updates available on origin/main.").unwrap(),
            (false, None)
        );
        assert!(parse_hermes_update_check("network request failed").is_err());
    }

    #[test]
    fn grok_update_check_ignores_pnpm_installer_hint() {
        let command = grok_update_check_command(std::path::Path::new("grok"));

        assert!(command.get_envs().any(|(key, value)| {
            key == std::ffi::OsStr::new("npm_config_user_agent") && value.is_none()
        }));
    }

    #[test]
    fn grok_update_management_trusts_reported_official_native_source() {
        assert_eq!(grok_update_management_message_for(Some("internal")), None);
        assert!(grok_update_management_message_for(Some("npm")).is_some());
        assert!(grok_update_management_message_for(None).is_some());
    }

    #[test]
    fn rejects_non_semver_release_values() {
        assert!(normalize_semver("latest").is_none());
        assert!(parse_codex_latest(r#"{"tag_name":"unexpected"}"#).is_err());
    }

    #[test]
    fn maps_antigravity_windows_macos_and_linux_platforms() {
        assert_eq!(
            antigravity_platform_for("windows", "x86_64").unwrap(),
            "windows_amd64"
        );
        assert_eq!(
            antigravity_platform_for("macos", "aarch64").unwrap(),
            "darwin_arm64"
        );
        assert_eq!(
            antigravity_platform_for("macos", "x86_64").unwrap(),
            "darwin_amd64"
        );
        assert_eq!(
            antigravity_platform_for("linux", "x86_64").unwrap(),
            "linux_amd64"
        );
        assert_eq!(
            antigravity_platform_for("linux", "aarch64").unwrap(),
            "linux_arm64"
        );
        assert!(antigravity_platform_for("freebsd", "x86_64").is_err());
    }

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
            latest.managed_update = managed_update_status(tool_key, Some(true));
            if branch_based {
                latest.update_availability = UpdateAvailability::Available;
            } else {
                apply_update_availability(&mut latest, Some("CLI version 1.2.3"));
            }

            assert_eq!(latest.managed_update, expected_managed);
            assert_eq!(latest.update_availability, UpdateAvailability::Available);
        }

        assert!(matches!(
            managed_update_status(ToolKey::Grok, None),
            ManagedUpdateStatus::Denied { .. }
        ));
        assert!(matches!(
            managed_update_status(ToolKey::Hermes, Some(false)),
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
