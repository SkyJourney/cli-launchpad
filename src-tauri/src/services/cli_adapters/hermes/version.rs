use std::path::{Path, PathBuf};
use std::time::Duration;

use uuid::Uuid;

use crate::platform::detect;
use crate::platform::process::{self, BoundedOutput};
use crate::services::version_service::first_output_line;

const HERMES_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const HERMES_OUTPUT_LIMIT: usize = 64 * 1024;
const HERMES_VERSION_PROBE_CONFIG: &str = "updates:\n  check: false\n";

pub(super) fn hermes_install_dirs() -> Vec<PathBuf> {
    super::platform::install_dirs()
}

pub(super) async fn probe_current_version(path: &Path) -> Result<String, String> {
    let home = HermesVersionProbeHome::create()?;
    let environment = [(
        "HERMES_HOME".to_string(),
        home.path().as_os_str().to_owned(),
    )];
    detect::probe_version_with_env(path, &environment).await
}

struct HermesVersionProbeHome {
    path: PathBuf,
}

impl HermesVersionProbeHome {
    fn create() -> Result<Self, String> {
        let path =
            std::env::temp_dir().join(format!("cli-launchpad-hermes-version-{}", Uuid::new_v4()));
        std::fs::create_dir(&path)
            .map_err(|error| format!("无法建立 Hermes 版本探测目录：{error}"))?;
        if let Err(error) = std::fs::write(path.join("config.yaml"), HERMES_VERSION_PROBE_CONFIG) {
            let _ = std::fs::remove_dir_all(&path);
            return Err(format!("无法创建 Hermes 版本探测配置：{error}"));
        }
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for HermesVersionProbeHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HermesUpdateCheck {
    pub(super) update_available: Option<bool>,
    pub(super) commits_behind: Option<u32>,
    pub(super) error: Option<String>,
    pub(super) managed_update_allowed: bool,
    pub(super) management_message: Option<String>,
}

/// Inspect Hermes' default managed source installation and compare it with
/// the updater's default channel. This is called only for an explicit refresh.
pub(super) fn fetch_hermes_update_check(
    path: Option<&Path>,
    home: &Path,
) -> Result<HermesUpdateCheck, String> {
    let path = path.ok_or_else(|| "未检测到可运行的 Hermes Agent CLI".to_string())?;
    match inspect_hermes_managed_install(path, home) {
        Ok(()) => {}
        Err(message) => {
            return Ok(HermesUpdateCheck {
                update_available: None,
                commits_behind: None,
                error: None,
                managed_update_allowed: false,
                management_message: Some(message),
            });
        }
    }

    let output = match run_hermes_command(path, &["update", "--check"], HERMES_UPDATE_CHECK_TIMEOUT)
    {
        Ok(output) => output,
        Err(error) => {
            return Ok(HermesUpdateCheck {
                update_available: None,
                commits_behind: None,
                error: Some(error),
                managed_update_allowed: true,
                management_message: None,
            });
        }
    };
    if output.truncated {
        return Ok(HermesUpdateCheck {
            update_available: None,
            commits_behind: None,
            error: Some("Hermes Agent 官方检查输出超过安全读取上限".to_string()),
            managed_update_allowed: false,
            management_message: Some(
                "无法确认 Hermes Agent 更新状态；请检查 CLI 后重试".to_string(),
            ),
        });
    }
    if !output.status.success() {
        let detail = first_output_line(&output.stderr)
            .or_else(|| first_output_line(&output.stdout))
            .unwrap_or_else(|| format!("退出码 {}", output.status));
        return Ok(HermesUpdateCheck {
            update_available: None,
            commits_behind: None,
            error: Some(format!("Hermes Agent 官方更新检查失败：{detail}")),
            managed_update_allowed: true,
            management_message: None,
        });
    }
    let (update_available, commits_behind) =
        match parse_hermes_update_check(&combined_output(&output)) {
            Ok(check) => check,
            Err(error) => {
                return Ok(HermesUpdateCheck {
                    update_available: None,
                    commits_behind: None,
                    error: Some(error),
                    managed_update_allowed: true,
                    management_message: None,
                });
            }
        };
    Ok(HermesUpdateCheck {
        update_available: Some(update_available),
        commits_behind,
        error: None,
        managed_update_allowed: true,
        management_message: None,
    })
}

/// Verify the default Hermes source install before enabling app-managed updates.
/// The official `update --check` command itself provides the update status, so
/// the install identity and plan commands are unnecessary here.
fn inspect_hermes_managed_install(path: &std::path::Path, home: &Path) -> Result<(), String> {
    super::platform::validate_managed_update_install(path, home)
}

pub(super) fn validate_managed_install(path: &std::path::Path) -> Result<(), String> {
    let home = crate::platform::home::home_dir()
        .map_err(|error| format!("无法确认 Hermes 用户目录：{error}"))?;
    inspect_hermes_managed_install(path, &home)
}

fn run_hermes_command(
    path: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<BoundedOutput, String> {
    let mut command = process::cli_std_command(path, args);
    command.env("NO_COLOR", "1");
    process::run_bounded_sync(command, timeout, HERMES_OUTPUT_LIMIT).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            "Hermes Agent 官方检查超时".to_string()
        } else {
            format!("无法启动 Hermes Agent 检查命令：{error}")
        }
    })
}

fn combined_output(output: &BoundedOutput) -> String {
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    strip_ansi_sequences(&combined)
}

fn parse_hermes_update_check(output: &str) -> Result<(bool, Option<u32>), String> {
    let cleaned = strip_ansi_sequences(output).replace("up-to-date", "up to date");
    let mut result = None;
    for line in cleaned.lines() {
        let normalized = line.to_ascii_lowercase();
        if normalized.contains("already up to date")
            || normalized.contains("already current")
            || normalized.contains("no update available")
            || normalized.contains("no updates available")
        {
            result = Some((false, None));
        } else if normalized.contains("update available")
            || normalized.contains("updates available")
        {
            result = Some((true, parse_commits_behind(&normalized)));
        }
    }
    result.ok_or_else(|| "Hermes Agent 官方更新检查结果无法识别".to_string())
}

fn parse_commits_behind(output: &str) -> Option<u32> {
    let words = output
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    words.iter().enumerate().find_map(|(index, word)| {
        let number = word.parse::<u32>().ok()?;
        let window = words.get(index + 1..(index + 5).min(words.len()))?;
        let has_commit = window.iter().any(|word| word.starts_with("commit"));
        let has_behind = window.contains(&"behind");
        (has_commit && has_behind).then_some(number)
    })
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            output.push(character);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for code in chars.by_ref() {
                    if ('@'..='~').contains(&code) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(code) = chars.next() {
                    if code == '\u{7}' {
                        break;
                    }
                    if code == '\u{1b}' && chars.next_if_eq(&'\\').is_some() {
                        break;
                    }
                }
            }
            Some(_) | None => {}
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn hermes_version_probe_config_disables_passive_update_checks_and_cleans_up() {
        let home = HermesVersionProbeHome::create().unwrap();
        let path = home.path().to_path_buf();
        let config = std::fs::read_to_string(path.join("config.yaml")).unwrap();

        assert_eq!(config, "updates:\n  check: false\n");
        drop(home);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hermes_version_probe_passes_isolated_home_to_cli() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("hermes");
        std::fs::write(
            &script,
            "#!/bin/sh\nif grep -Fq 'check: false' \"$HERMES_HOME/config.yaml\"; then echo 'Hermes Agent test'; else exit 7; fi\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let version =
            crate::services::cli_adapters::hermes::version::probe_current_version(&script)
                .await
                .unwrap();
        assert_eq!(version, "Hermes Agent test");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn hermes_version_probe_passes_isolated_home_to_cli() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("hermes.cmd");
        std::fs::write(
            &script,
            "@echo off\r\nfindstr /C:\"check: false\" \"%HERMES_HOME%\\config.yaml\" >nul\r\nif errorlevel 1 exit /b 7\r\necho Hermes Agent test\r\n",
        )
        .unwrap();

        let version =
            crate::services::cli_adapters::hermes::version::probe_current_version(&script)
                .await
                .unwrap();
        assert_eq!(version, "Hermes Agent test");
    }
}
