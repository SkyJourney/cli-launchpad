use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::models::tool::ToolKey;
use crate::platform::detect;
use crate::services::version_service::first_output_line;

const GROK_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) fn fetch_grok_update_check() -> Result<(GrokUpdateCheck, bool, Option<String>), String> {
    let path = crate::services::cli_adapters::installed_path(crate::services::cli_adapters::get(
        ToolKey::Grok,
    ))
    .ok_or_else(|| "未检测到可运行的 Grok Build CLI".to_string())?;
    let check = inspect_grok_update_check(&path)?;
    let management_message = grok_update_management_message(&path, check.installer.as_deref());
    let managed_update_allowed = management_message.is_none();
    Ok((check, managed_update_allowed, management_message))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GrokUpdateCheck {
    pub(crate) latest_version: String,
    pub(crate) installer: Option<String>,
}

/// Read the official CLI's update status from the exact executable selected by
/// detection. This does not install or update the CLI.
pub(crate) fn inspect_grok_update_check(path: &std::path::Path) -> Result<GrokUpdateCheck, String> {
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
pub(crate) fn grok_update_management_message(
    path: &std::path::Path,
    installer: Option<&str>,
) -> Option<String> {
    grok_update_management_message_for(path, installer, &grok_native_install_dirs())
}

pub(crate) fn grok_update_management_message_for(
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

pub(crate) fn validate_grok_native_update_source(
    path: &std::path::Path,
    installer: Option<&str>,
) -> Result<(), String> {
    grok_update_management_message(path, installer).map_or(Ok(()), Err)
}

pub(crate) fn is_grok_in_known_bin_dir(
    path: &std::path::Path,
    expected_dirs: &[std::path::PathBuf],
) -> bool {
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

pub(crate) fn grok_native_install_dirs() -> Vec<std::path::PathBuf> {
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

pub(crate) fn grok_update_check_command(path: &std::path::Path) -> Command {
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

#[cfg(test)]
pub(crate) fn parse_grok_latest(body: &str) -> Result<String, String> {
    parse_grok_update_check(body).map(|check| check.latest_version)
}

pub(crate) fn parse_grok_update_check(body: &str) -> Result<GrokUpdateCheck, String> {
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
