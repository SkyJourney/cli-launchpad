use std::time::Duration;

use crate::models::install::LatestVersion;
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
            update_available: None,
            commits_behind: None,
            error: None,
            from_cache: false,
            managed_update_allowed: false,
            management_message: None,
        },
        Err(error) => {
            log::warn!("latest version query failed tool={}", tool_key.as_str());
            LatestVersion {
                tool_key,
                latest: None,
                update_available: None,
                commits_behind: None,
                error: Some(error),
                from_cache: false,
                managed_update_allowed: false,
                management_message: None,
            }
        }
    }
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
    use crate::services::cli_adapters::grok::version::{
        grok_update_check_command, grok_update_management_message_for, is_grok_in_known_bin_dir,
        parse_grok_latest, parse_grok_update_check,
    };
    #[cfg(windows)]
    use crate::services::cli_adapters::hermes::version::is_hermes_default_install_path;
    use crate::services::cli_adapters::hermes::version::{
        parse_hermes_install_id, parse_hermes_update_check, parse_hermes_update_plan,
    };

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
    fn parses_hermes_update_plan_and_rejects_incomplete_or_managed_installs() {
        let plan = parse_hermes_update_plan(
            "Update plan:\n  Install: git (v0.21.5 @ 040b6df2)\n  Profiles: default\n  Running Hermes services: none detected — code swap only.\n",
        )
        .unwrap();
        assert_eq!(plan.install_kind, "git");
        assert!(plan.summary.contains("Profiles: default"));

        let managed = parse_hermes_update_plan(
            "Update plan:\n  Install: docker\n  Profiles: default\n  Running Hermes services: none detected.\n",
        )
        .unwrap();
        assert_eq!(managed.install_kind, "docker");
        assert!(parse_hermes_update_plan("Install: git").is_err());
    }

    #[test]
    fn parses_hermes_install_id_as_a_single_bounded_token() {
        assert_eq!(
            parse_hermes_install_id("cc57596e7c2ed097\n"),
            Some("cc57596e7c2ed097")
        );
        assert_eq!(parse_hermes_install_id("warning\ncc57596e7c2ed097"), None);
        assert_eq!(parse_hermes_install_id("../install"), None);
    }

    #[cfg(windows)]
    #[test]
    fn hermes_source_update_requires_default_bin_and_git_checkout() {
        let root = tempfile::tempdir().unwrap();
        let local_app_data = root.path();
        let bin = local_app_data.join("hermes").join("bin");
        let checkout = local_app_data.join("hermes").join("hermes-agent");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        let exe = bin.join("hermes.exe");
        std::fs::write(&exe, []).unwrap();

        assert!(is_hermes_default_install_path(&exe, &bin, &checkout));
        assert!(!is_hermes_default_install_path(
            &root.path().join("npm").join("hermes.exe"),
            &bin,
            &checkout
        ));
        assert!(!is_hermes_default_install_path(
            &bin.join("hermes.cmd"),
            &bin,
            &root.path().join("other-checkout")
        ));
    }

    #[test]
    fn grok_update_check_ignores_pnpm_installer_hint() {
        let command = grok_update_check_command(std::path::Path::new("grok"));

        assert!(command.get_envs().any(|(key, value)| {
            key == std::ffi::OsStr::new("npm_config_user_agent") && value.is_none()
        }));
    }

    #[test]
    fn grok_update_management_requires_both_internal_source_and_known_path() {
        let binary = std::path::PathBuf::from(if cfg!(windows) {
            r"C:\Users\tester\.grok\bin\grok.exe"
        } else {
            "/home/tester/.grok/bin/grok"
        });
        let directory = binary.parent().unwrap().to_path_buf();
        assert_eq!(
            grok_update_management_message_for(&binary, Some("internal"), &[directory.clone()]),
            None
        );
        assert!(
            grok_update_management_message_for(&binary, Some("npm"), &[directory.clone()])
                .is_some()
        );
        assert!(grok_update_management_message_for(&binary, None, &[directory.clone()]).is_some());

        let wrong_binary = std::path::PathBuf::from(if cfg!(windows) {
            r"C:\Users\tester\AppData\Roaming\npm\grok.exe"
        } else {
            "/home/tester/.npm/bin/grok"
        });
        assert!(grok_update_management_message_for(
            &wrong_binary,
            Some("internal"),
            &[directory.clone()]
        )
        .is_some());

        let expected_name = if cfg!(windows) { "grok.exe" } else { "grok" };
        let known = directory.join(expected_name);
        assert!(is_grok_in_known_bin_dir(&known, &[directory]));
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
}
