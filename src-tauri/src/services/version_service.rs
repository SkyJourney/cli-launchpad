use std::time::Duration;

use crate::models::install::LatestVersion;
use crate::models::tool::ToolKey;

const RELEASE_TIMEOUT: Duration = Duration::from_secs(8);
const CLAUDE_LATEST_URL: &str = "https://downloads.claude.ai/claude-code-releases/latest";
const CODEX_LATEST_URL: &str = "https://releases.openai.com/codex/channels/latest";
const ANTIGRAVITY_RELEASE_BASE: &str =
    "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

pub fn fetch_all_latest() -> Vec<LatestVersion> {
    // Query concurrently so the total wait is one request's timeout, not the
    // sum of all three official release endpoints.
    std::thread::scope(|scope| {
        let handles: Vec<_> = ToolKey::ALL
            .into_iter()
            .map(|tool_key| {
                scope.spawn(move || match fetch_latest(tool_key) {
                    Ok(latest) => LatestVersion {
                        tool_key,
                        latest: Some(latest),
                        error: None,
                        from_cache: false,
                    },
                    Err(error) => {
                        log::warn!("latest version query failed tool={}", tool_key.as_str());
                        LatestVersion {
                            tool_key,
                            latest: None,
                            error: Some(error),
                            from_cache: false,
                        }
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect()
    })
}

pub fn fetch_latest(tool_key: ToolKey) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(RELEASE_TIMEOUT)
        .timeout_read(RELEASE_TIMEOUT)
        .build();

    match tool_key {
        ToolKey::Claude => {
            let body = get_text(&agent, CLAUDE_LATEST_URL)?;
            normalize_semver(body.trim().trim_matches('"'))
                .ok_or_else(|| "Claude 官方版本响应格式无效".to_string())
        }
        ToolKey::Codex => {
            let body = get_text(&agent, CODEX_LATEST_URL)?;
            parse_codex_latest(&body)
        }
        ToolKey::Antigravity => {
            let platform = antigravity_platform()?;
            let body = get_text(
                &agent,
                &format!("{ANTIGRAVITY_RELEASE_BASE}/{platform}.json"),
            )?;
            parse_antigravity_latest(&body)
        }
    }
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

fn parse_codex_latest(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "Codex 官方版本响应格式无效".to_string())?;
    let tag = value
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Codex 官方版本响应缺少 tag_name".to_string())?;
    let normalized = tag
        .strip_prefix("rust-v")
        .or_else(|| tag.strip_prefix('v'))
        .unwrap_or(tag);
    normalize_semver(normalized).ok_or_else(|| "Codex 官方版本号无效".to_string())
}

fn parse_antigravity_latest(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "Antigravity 官方版本响应格式无效".to_string())?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Antigravity 官方版本响应缺少 version".to_string())?;
    normalize_semver(version).ok_or_else(|| "Antigravity 官方版本号无效".to_string())
}

fn normalize_semver(value: &str) -> Option<String> {
    let core = value.split_once('-').map_or(value, |(core, _)| core);
    let mut parts = core.split('.');
    let valid = (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.chars().all(|char| char.is_ascii_digit()))
    }) && parts.next().is_none();
    valid.then(|| value.to_string())
}

fn antigravity_platform() -> Result<&'static str, String> {
    antigravity_platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn antigravity_platform_for(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("windows", "x86_64") => Ok("windows_amd64"),
        ("windows", "aarch64") => Ok("windows_arm64"),
        ("macos", "x86_64") => Ok("darwin_amd64"),
        ("macos", "aarch64") => Ok("darwin_arm64"),
        _ => Err("当前平台尚未配置 Antigravity 官方版本查询".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rejects_non_semver_release_values() {
        assert!(normalize_semver("latest").is_none());
        assert!(parse_codex_latest(r#"{"tag_name":"unexpected"}"#).is_err());
    }

    #[test]
    fn maps_antigravity_windows_and_macos_platforms() {
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
        assert!(antigravity_platform_for("linux", "x86_64").is_err());
    }
}
