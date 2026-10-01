use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::models::tool::ToolKey;
use crate::platform::detect;
use crate::services::version_service::first_output_line;

const HERMES_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const HERMES_PLAN_TIMEOUT: Duration = Duration::from_secs(12);
const HERMES_INSTALL_ID_TIMEOUT: Duration = Duration::from_secs(8);
const HERMES_OUTPUT_LIMIT: usize = 64 * 1024;
const HERMES_VERSION_PROBE_CONFIG: &str = "updates:\n  check: false\n";

pub(crate) fn hermes_install_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return vec![PathBuf::from(local_app_data).join("hermes").join("bin")];
    }
    Vec::new()
}

pub(crate) async fn probe_current_version(path: &Path) -> Result<String, String> {
    let home = HermesVersionProbeHome::create()?;
    let environment = [(
        "HERMES_HOME".to_string(),
        home.path().as_os_str().to_owned(),
    )];
    detect::probe_version_with_env(path, &environment).await
}

pub(crate) struct HermesVersionProbeHome {
    path: PathBuf,
}

impl HermesVersionProbeHome {
    pub(crate) fn create() -> Result<Self, String> {
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

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for HermesVersionProbeHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HermesUpdateCheck {
    pub(crate) update_available: Option<bool>,
    pub(crate) commits_behind: Option<u32>,
    pub(crate) error: Option<String>,
    pub(crate) managed_update_allowed: bool,
    pub(crate) management_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HermesUpdatePlan {
    pub(crate) install_kind: String,
    pub(crate) summary: String,
}

/// Inspect Hermes' default Windows source installation and compare it with
/// the updater's default channel. This is called only for an explicit refresh.
pub(crate) fn fetch_hermes_update_check() -> Result<HermesUpdateCheck, String> {
    let path = crate::services::cli_adapters::installed_path(crate::services::cli_adapters::get(
        ToolKey::Hermes,
    ))
    .ok_or_else(|| "未检测到可运行的 Hermes Agent CLI".to_string())?;
    let plan = match inspect_hermes_managed_update(&path) {
        Ok(plan) => plan,
        Err(message) => {
            return Ok(HermesUpdateCheck {
                update_available: None,
                commits_behind: None,
                error: None,
                managed_update_allowed: false,
                management_message: Some(message),
            });
        }
    };
    if plan.install_kind != "git" {
        return Ok(HermesUpdateCheck {
            update_available: None,
            commits_behind: None,
            error: None,
            managed_update_allowed: false,
            management_message: Some(format!(
                "Hermes Agent 当前由 {} 安装或管理；请使用原安装渠道更新。",
                plan.install_kind
            )),
        });
    }

    let output =
        match run_hermes_command(&path, &["update", "--check"], HERMES_UPDATE_CHECK_TIMEOUT) {
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
    if !output.status.success() {
        let detail = first_output_line(&output.stderr)
            .or_else(|| first_output_line(&output.stdout))
            .unwrap_or_else(|| format!("退出码 {}", output.status));
        return Ok(HermesUpdateCheck {
            update_available: None,
            commits_behind: None,
            error: Some(format!("Hermes Agent 官方 main 分支检查失败：{detail}")),
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

/// Verify the default Hermes source install and its update ownership for the
/// Settings status query.
pub(crate) fn inspect_hermes_managed_update(
    path: &std::path::Path,
) -> Result<HermesUpdatePlan, String> {
    #[cfg(not(windows))]
    {
        let _ = path;
        return Err("Hermes Agent 托管安装和更新将在 M5 跨平台阶段接入".to_string());
    }
    #[cfg(windows)]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "无法确认 Windows 用户级 Hermes 安装目录".to_string())?;
        let expected_bin = local_app_data.join("hermes").join("bin");
        let checkout_root = local_app_data.join("hermes").join("hermes-agent");
        if !is_hermes_default_install_path(path, &expected_bin, &checkout_root) {
            return Err(
                "仅对 Hermes 官方默认 Windows 源码安装启用 Launchpad 托管更新；其他安装请使用原渠道。"
                    .to_string(),
            );
        }

        let install_id_output =
            run_hermes_command(path, &["update", "--install-id"], HERMES_INSTALL_ID_TIMEOUT)?;
        if !install_id_output.status.success()
            || parse_hermes_install_id(&combined_output(&install_id_output)).is_none()
        {
            return Err("Hermes Agent 未返回有效的官方安装身份".to_string());
        }

        let plan_output = run_hermes_command(path, &["update", "--plan"], HERMES_PLAN_TIMEOUT)?;
        if !plan_output.status.success() {
            let detail = first_output_line(&plan_output.stderr)
                .or_else(|| first_output_line(&plan_output.stdout))
                .unwrap_or_else(|| format!("退出码 {}", plan_output.status));
            return Err(format!("Hermes Agent 官方更新计划读取失败：{detail}"));
        }
        parse_hermes_update_plan(&combined_output(&plan_output))
    }
}

#[cfg(windows)]
pub(crate) fn is_hermes_default_install_path(
    path: &std::path::Path,
    expected_bin: &std::path::Path,
    checkout_root: &std::path::Path,
) -> bool {
    let executable_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let supported_name = ["hermes.exe", "hermes.cmd", "hermes.bat"]
        .iter()
        .any(|name| executable_name.eq_ignore_ascii_case(name));
    supported_name
        && path
            .parent()
            .is_some_and(|parent| same_path(parent, expected_bin))
        && checkout_root.join(".git").exists()
}

fn same_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    fn normalized(path: &std::path::Path) -> String {
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        resolved
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    normalized(left) == normalized(right)
}

fn run_hermes_command(
    path: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Output, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut command = match extension.as_str() {
        "cmd" | "bat" => {
            let mut command = Command::new(detect::system32("cmd.exe"));
            command.arg("/D").arg("/C").arg(path).args(args);
            command
        }
        "ps1" => {
            let mut command =
                Command::new(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(path)
                .args(args);
            command
        }
        _ => {
            let mut command = Command::new(path);
            command.args(args);
            command
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Hermes Agent 检查命令：{error}"))?;
    let stdout_reader = child
        .stdout
        .take()
        .map(|mut stream| thread::spawn(move || read_bounded(&mut stream, HERMES_OUTPUT_LIMIT)));
    let stderr_reader = child
        .stderr
        .take()
        .map(|mut stream| thread::spawn(move || read_bounded(&mut stream, HERMES_OUTPUT_LIMIT)));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Hermes Agent 官方检查超时".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Hermes Agent 检查进程异常：{error}"));
            }
        }
    };
    let stdout = stdout_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn read_bounded(reader: &mut impl std::io::Read, limit: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(limit.min(4096));
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = limit.saturating_sub(output.len());
                output.extend_from_slice(&buffer[..read.min(remaining)]);
            }
        }
    }
    output
}

fn combined_output(output: &Output) -> String {
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    strip_ansi_sequences(&combined)
}

pub(crate) fn parse_hermes_install_id(output: &str) -> Option<&str> {
    let trimmed = output.trim();
    let mut lines = trimmed.lines();
    let id = lines.next()?.trim();
    if id.len() < 8
        || id.len() > 128
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || lines.any(|line| !line.trim().is_empty())
    {
        return None;
    }
    Some(id)
}

pub(crate) fn parse_hermes_update_plan(output: &str) -> Result<HermesUpdatePlan, String> {
    let cleaned = strip_ansi_sequences(output);
    let mut install_kind = None;
    let mut has_profiles = false;
    let mut has_running_services = false;
    for line in cleaned.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("Install:") {
            let first = value.split_whitespace().next().unwrap_or_default();
            if first.is_empty() || install_kind.replace(first.to_ascii_lowercase()).is_some() {
                return Err("Hermes Agent 官方更新计划中的安装类型无效".to_string());
            }
        }
        has_profiles |= line.starts_with("Profiles:");
        has_running_services |= line.starts_with("Running Hermes services:");
    }
    let install_kind =
        install_kind.ok_or_else(|| "Hermes Agent 官方更新计划缺少安装类型".to_string())?;
    if !has_profiles || !has_running_services {
        return Err("Hermes Agent 官方更新计划缺少 Profile 或运行服务信息".to_string());
    }
    let summary = cleaned
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .take(80)
        .collect::<Vec<_>>()
        .join("\n");
    let summary = summary.chars().take(4000).collect::<String>();
    Ok(HermesUpdatePlan {
        install_kind,
        summary,
    })
}

pub(crate) fn parse_hermes_update_check(output: &str) -> Result<(bool, Option<u32>), String> {
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
    result.ok_or_else(|| "Hermes Agent 官方 main 分支检查结果无法识别".to_string())
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
        let has_behind = window.iter().any(|word| *word == "behind");
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
