use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::models::install::LatestVersion;
use crate::models::tool::ToolKey;
use crate::platform::detect;

const RELEASE_TIMEOUT: Duration = Duration::from_secs(8);
const GROK_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const CLAUDE_LATEST_URL: &str = "https://downloads.claude.ai/claude-code-releases/latest";
const CODEX_LATEST_URL: &str = "https://releases.openai.com/codex/channels/latest";
const ANTIGRAVITY_RELEASE_BASE: &str =
    "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

pub fn fetch_all_latest(refresh_grok: bool) -> Vec<LatestVersion> {
    // Query concurrently so the total wait is one request's timeout, not the
    // sum of every official release source.
    std::thread::scope(|scope| {
        let handles: Vec<_> = ToolKey::ALL
            .into_iter()
            .map(|tool_key| {
                scope.spawn(move || {
                    if !should_check_tool(tool_key, refresh_grok) {
                        return LatestVersion {
                            tool_key,
                            latest: None,
                            error: Some("请手动刷新以检查 Grok Build 最新版本".to_string()),
                            from_cache: false,
                            managed_update_allowed: false,
                            management_message: Some(
                                "请刷新版本信息以确认 Grok Build 安装来源".to_string(),
                            ),
                        };
                    }
                    if tool_key == ToolKey::Grok {
                        return match fetch_grok_update_check() {
                            Ok((check, managed_update_allowed, management_message)) => {
                                LatestVersion {
                                    tool_key,
                                    latest: Some(check.latest_version),
                                    error: None,
                                    from_cache: false,
                                    managed_update_allowed,
                                    management_message,
                                }
                            }
                            Err(error) => LatestVersion {
                                tool_key,
                                latest: None,
                                error: Some(error),
                                from_cache: false,
                                managed_update_allowed: false,
                                management_message: Some(
                                    "无法确认 Grok Build 安装来源；请检查 CLI 后重试".to_string(),
                                ),
                            },
                        };
                    }
                    match fetch_latest(tool_key) {
                        Ok(latest) => LatestVersion {
                            tool_key,
                            latest: Some(latest),
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
                                error: Some(error),
                                from_cache: false,
                                managed_update_allowed: false,
                                management_message: None,
                            }
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

fn should_check_tool(tool_key: ToolKey, explicit_grok_refresh: bool) -> bool {
    tool_key != ToolKey::Grok || explicit_grok_refresh
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
        ToolKey::Grok => fetch_grok_latest(),
    }
}

fn fetch_grok_latest() -> Result<String, String> {
    let path = detect::resolve_executable_path(&ToolKey::Grok.command_candidates())
        .ok_or_else(|| "未检测到可运行的 Grok Build CLI".to_string())?;
    inspect_grok_update_check(std::path::Path::new(&path)).map(|check| check.latest_version)
}

fn fetch_grok_update_check() -> Result<(GrokUpdateCheck, bool, Option<String>), String> {
    let path = detect::resolve_executable_path(&ToolKey::Grok.command_candidates())
        .ok_or_else(|| "未检测到可运行的 Grok Build CLI".to_string())?;
    let path = std::path::Path::new(&path);
    let check = inspect_grok_update_check(path)?;
    let management_message = grok_update_management_message(path, check.installer.as_deref());
    let managed_update_allowed = management_message.is_none();
    Ok((check, managed_update_allowed, management_message))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokUpdateCheck {
    pub latest_version: String,
    pub installer: Option<String>,
}

/// Read the official CLI's update status from the exact executable selected by
/// detection. This does not install or update the CLI.
pub fn inspect_grok_update_check(path: &std::path::Path) -> Result<GrokUpdateCheck, String> {
    let output = run_grok_update_check(path)?;
    if !output.status.success() {
        let detail = first_output_line(&output.stderr)
            .or_else(|| first_output_line(&output.stdout))
            .unwrap_or_else(|| format!("退出码 {}", output.status));
        return Err(format!("Grok Build 官方版本检查失败：{detail}"));
    }
    parse_grok_update_check(&String::from_utf8_lossy(&output.stdout))
}

/// Return a management explanation unless both the CLI and its location
/// identify the official native installer. In particular, a stale
/// `config.toml` marker cannot make an npm shim eligible for `grok update`.
pub fn grok_update_management_message(
    path: &std::path::Path,
    installer: Option<&str>,
) -> Option<String> {
    grok_update_management_message_for(path, installer, &grok_native_install_dirs())
}

fn grok_update_management_message_for(
    path: &std::path::Path,
    installer: Option<&str>,
    expected_dirs: &[std::path::PathBuf],
) -> Option<String> {
    match installer {
        Some("internal") if is_grok_in_known_bin_dir(path, expected_dirs) => None,
        Some("npm") => Some(
            "此 Grok Build 由 npm 管理。请使用原安装渠道更新，或查看 Grok Build 官方 CLI 安装说明。"
                .to_string(),
        ),
        Some("internal") => Some(
            "CLI 报告为官方原生安装，但程序路径不在已知官方安装目录中；为避免误更新，Launchpad 已禁用托管更新。"
                .to_string(),
        ),
        Some(_) => Some(
            "当前 Grok Build 安装来源不是 Launchpad 可管理的官方原生安装；请使用原安装渠道更新。"
                .to_string(),
        ),
        None => Some(
            "Grok Build 未报告可验证的安装来源；为避免更新错误的安装，Launchpad 已禁用托管更新。"
                .to_string(),
        ),
    }
}

pub fn validate_grok_native_update_source(
    path: &std::path::Path,
    installer: Option<&str>,
) -> Result<(), String> {
    grok_update_management_message(path, installer).map_or(Ok(()), Err)
}

fn is_grok_in_known_bin_dir(path: &std::path::Path, expected_dirs: &[std::path::PathBuf]) -> bool {
    let expected_name = if cfg!(windows) { "grok.exe" } else { "grok" };
    if !path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(expected_name))
    {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    normalized_path(parent).is_some_and(|parent| {
        expected_dirs
            .iter()
            .filter_map(|directory| normalized_path(directory))
            .any(|directory| parent == directory)
    })
}

fn normalized_path(path: &std::path::Path) -> Option<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let resolved = std::fs::canonicalize(&absolute).unwrap_or(absolute);
    Some(
        resolved
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase(),
    )
}

fn grok_native_install_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(custom_dir) = std::env::var_os("GROK_BIN_DIR") {
        dirs.push(std::path::PathBuf::from(custom_dir));
    }
    #[cfg(windows)]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        dirs.push(std::path::PathBuf::from(profile).join(".grok").join("bin"));
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(std::path::PathBuf::from(home).join(".grok").join("bin"));
    }
    dirs
}

fn grok_update_check_command(path: &std::path::Path) -> Command {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut process = match extension.as_str() {
        "cmd" | "bat" => {
            let mut process = Command::new(detect::system32("cmd.exe"));
            process.arg("/D").arg("/C").arg(path);
            process
        }
        "ps1" => {
            let mut process =
                Command::new(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
            process
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(path);
            process
        }
        _ => Command::new(path),
    };
    process
        .args(["update", "--check", "--json"])
        // pnpm sets this for child processes. Grok interprets it as evidence
        // that Grok itself was installed by npm, then runs `npm view` instead
        // of its native updater. Launchpad's pnpm environment must not alter
        // the install source reported by the installed Grok binary.
        .env_remove("npm_config_user_agent")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000);
    }
    process
}

fn run_grok_update_check(path: &std::path::Path) -> Result<Output, String> {
    let mut child = grok_update_check_command(path)
        .spawn()
        .map_err(|error| format!("无法启动 Grok Build 版本检查：{error}"))?;
    let deadline = Instant::now() + GROK_UPDATE_CHECK_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("读取 Grok Build 版本检查结果失败：{error}"));
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Grok Build 官方版本检查超时".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Grok Build 版本检查进程异常：{error}"));
            }
        }
    }
}

fn first_output_line(bytes: &[u8]) -> Option<String> {
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

#[cfg(test)]
fn parse_grok_latest(body: &str) -> Result<String, String> {
    parse_grok_update_check(body).map(|check| check.latest_version)
}

fn parse_grok_update_check(body: &str) -> Result<GrokUpdateCheck, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "Grok Build 官方版本响应格式无效".to_string())?;
    match value.get("error") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::String(error)) if error.trim().is_empty() => {}
        Some(serde_json::Value::String(error)) => {
            return Err(format!("Grok Build 官方版本检查失败：{error}"));
        }
        Some(_) => return Err("Grok Build 官方版本响应格式无效".to_string()),
    }
    let latest = value
        .get("latestVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Grok Build 官方版本响应缺少 latestVersion".to_string())?;
    let latest_version = normalize_grok_semver(latest)
        .ok_or_else(|| "Grok Build 官方版本响应中的版本号无效".to_string())?;
    let installer = value
        .get("installer")
        .and_then(serde_json::Value::as_str)
        .map(str::to_ascii_lowercase);
    Ok(GrokUpdateCheck {
        latest_version,
        installer,
    })
}

fn normalize_grok_semver(value: &str) -> Option<String> {
    let (version, build) = value
        .split_once('+')
        .map_or((value, None), |(version, build)| (version, Some(build)));
    if build.is_some_and(|metadata| {
        metadata.contains('+') || !valid_semver_identifiers(metadata, false)
    }) {
        return None;
    }

    let (core, prerelease) = version
        .split_once('-')
        .map_or((version, None), |(core, prerelease)| {
            (core, Some(prerelease))
        });
    if prerelease.is_some_and(|identifiers| !valid_semver_identifiers(identifiers, true)) {
        return None;
    }

    let mut components = core.split('.');
    let valid_core = (0..3).all(|_| {
        components.next().is_some_and(|component| {
            !component.is_empty()
                && component
                    .chars()
                    .all(|character| character.is_ascii_digit())
                && (component == "0" || !component.starts_with('0'))
        })
    }) && components.next().is_none();
    valid_core.then(|| value.to_string())
}

fn valid_semver_identifiers(value: &str, is_prerelease: bool) -> bool {
    !value.is_empty()
        && value.split('.').all(|identifier| {
            !identifier.is_empty()
                && identifier
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
                && !(is_prerelease
                    && identifier.len() > 1
                    && identifier.starts_with('0')
                    && identifier
                        .chars()
                        .all(|character| character.is_ascii_digit()))
        })
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
        ("linux", "x86_64") => Ok("linux_amd64"),
        ("linux", "aarch64") => Ok("linux_arm64"),
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
    fn grok_update_check_runs_only_when_requested_by_caller() {
        assert!(!should_check_tool(ToolKey::Grok, false));
        assert!(should_check_tool(ToolKey::Grok, true));
        assert!(should_check_tool(ToolKey::Codex, false));
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
