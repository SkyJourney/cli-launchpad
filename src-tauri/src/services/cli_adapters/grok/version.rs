use std::process::Command;
use std::time::Duration;

use crate::platform::process::{self, BoundedOutput};
use crate::services::version_service::first_output_line;

const GROK_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) fn fetch_grok_update_check(
    path: Option<&std::path::Path>,
) -> Result<(GrokUpdateCheck, bool, Option<String>), String> {
    let path = path.ok_or_else(|| "未检测到可运行的 Grok Build CLI".to_string())?;
    let check = inspect_grok_update_check(&path)?;
    let management_message = grok_update_management_message(check.installer.as_deref());
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
    if output.truncated {
        return Err("Grok Build 官方版本检查输出超过安全读取上限".to_string());
    }
    if !output.status.success() {
        let detail = first_output_line(&output.stderr)
            .or_else(|| first_output_line(&output.stdout))
            .unwrap_or_else(|| format!("退出码 {}", output.status));
        return Err(format!("Grok Build 官方版本检查失败：{detail}"));
    }
    parse_grok_update_check(&String::from_utf8_lossy(&output.stdout))
}

/// The CLI's update check reports the installation source. Trust its `internal`
/// result regardless of executable location so custom paths for a native
/// install still use the official `grok update` command.
pub(crate) fn grok_update_management_message(installer: Option<&str>) -> Option<String> {
    grok_update_management_message_for(installer)
}

pub(crate) fn grok_update_management_message_for(installer: Option<&str>) -> Option<String> {
    match installer {
        Some("internal") => None,
        Some("npm") => Some(
            "此 Grok Build 由 npm 管理。请使用原安装渠道更新，或查看 Grok Build 官方 CLI 安装说明。"
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

pub(crate) fn validate_grok_native_update_source(installer: Option<&str>) -> Result<(), String> {
    grok_update_management_message(installer).map_or(Ok(()), Err)
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
    let mut process = process::cli_std_command(path, ["update", "--check", "--json"]);
    // pnpm's marker makes Grok choose its npm updater even when this is the
    // official native installation. Keep the source check independent of it.
    process::remove_pnpm_user_agent_std(&mut process);
    process
}

fn run_grok_update_check(path: &std::path::Path) -> Result<BoundedOutput, String> {
    process::run_bounded_sync(
        grok_update_check_command(path),
        GROK_UPDATE_CHECK_TIMEOUT,
        64 * 1024,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            "Grok Build 官方版本检查超时".to_string()
        } else {
            format!("Grok Build 版本检查进程异常：{error}")
        }
    })
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
