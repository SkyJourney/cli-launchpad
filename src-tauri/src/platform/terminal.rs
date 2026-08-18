use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tokio::process::Command;

use crate::models::terminal::{
    DirectShellTarget, ProfilePreservation, ShellFamily, TerminalDistribution, TerminalEnvironment,
    TerminalProfileTarget, WindowsTerminalHost,
};

use super::detect;

const PACKAGE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone)]
struct InstalledPackage {
    name: String,
    version: String,
    install_location: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    default_profile: Option<String>,
    #[serde(default)]
    profiles: ProfileCollection,
}

#[derive(Debug, Default, Deserialize)]
struct ProfileCollection {
    #[serde(default)]
    list: Vec<SettingsProfile>,
}

#[derive(Debug, Deserialize)]
struct SettingsProfile {
    name: Option<String>,
    guid: Option<String>,
    source: Option<String>,
    commandline: Option<String>,
    #[serde(default)]
    hidden: bool,
}

pub async fn detect_environment() -> TerminalEnvironment {
    let (packages, pwsh) = tokio::join!(detect_terminal_packages(), detect::which("pwsh.exe"));
    let mut warnings = Vec::new();
    let hosts = detect_windows_terminal_hosts(&packages, &mut warnings);
    let direct_shells = detect_direct_shells(pwsh);
    let recommended_target_id = recommend_target(&hosts, &direct_shells);

    if hosts.is_empty() {
        warnings.push("未检测到 Windows Terminal，将使用独立控制台回退链".to_string());
    }

    TerminalEnvironment {
        windows_terminal_hosts: hosts,
        direct_shells,
        recommended_target_id,
        warnings,
    }
}

fn detect_windows_terminal_hosts(
    packages: &[InstalledPackage],
    warnings: &mut Vec<String>,
) -> Vec<WindowsTerminalHost> {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        warnings.push("无法读取 LOCALAPPDATA，不能发现 Windows Terminal Profile".to_string());
        return Vec::new();
    };

    let specs = [
        (
            TerminalDistribution::Stable,
            "Microsoft.WindowsTerminal",
            "Windows Terminal",
            local_app_data
                .join("Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json"),
        ),
        (
            TerminalDistribution::Preview,
            "Microsoft.WindowsTerminalPreview",
            "Windows Terminal Preview",
            local_app_data.join(
                "Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json",
            ),
        ),
        (
            TerminalDistribution::Canary,
            "Microsoft.WindowsTerminalCanary",
            "Windows Terminal Canary",
            local_app_data.join(
                "Packages/Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe/LocalState/settings.json",
            ),
        ),
    ];

    let mut hosts = Vec::new();
    for (distribution, package_name, display_name, settings_path) in specs {
        let Some(package) = packages
            .iter()
            .find(|candidate| candidate.name.eq_ignore_ascii_case(package_name))
        else {
            continue;
        };
        let executable = package.install_location.join("WindowsTerminal.exe");
        if !executable.is_file() {
            warnings.push(format!("{display_name} 已注册，但未找到可信的主程序路径"));
            continue;
        }
        hosts.push(build_host(
            distribution,
            display_name,
            executable,
            Some(package.version.clone()),
            settings_path,
            warnings,
        ));
    }

    let unpackaged_settings = local_app_data.join("Microsoft/Windows Terminal/settings.json");
    if packages.is_empty() && unpackaged_settings.is_file() {
        if let Some(executable) = detect::which_path_sync("wt.exe") {
            let executable = PathBuf::from(executable);
            if executable
                .metadata()
                .is_ok_and(|metadata| metadata.len() > 0)
            {
                hosts.push(build_host(
                    TerminalDistribution::Unpackaged,
                    "Windows Terminal（免安装版）",
                    executable,
                    None,
                    unpackaged_settings,
                    warnings,
                ));
            }
        }
    }

    hosts
}

fn build_host(
    distribution: TerminalDistribution,
    display_name: &str,
    executable: PathBuf,
    version: Option<String>,
    settings_path: PathBuf,
    warnings: &mut Vec<String>,
) -> WindowsTerminalHost {
    let supports_append_command_line = version
        .as_deref()
        .and_then(parse_major_minor)
        .is_some_and(|(major, minor)| major > 1 || (major == 1 && minor >= 19));
    let profiles = if settings_path.is_file() {
        match parse_profiles(&settings_path, distribution, supports_append_command_line) {
            Ok(profiles) => profiles,
            Err(error) => {
                warnings.push(format!("无法读取 {display_name} Profile：{error}"));
                Vec::new()
            }
        }
    } else {
        warnings.push(format!("{display_name} 尚未生成 settings.json"));
        Vec::new()
    };

    WindowsTerminalHost {
        id: format!("wt:{}", distribution.as_str()),
        distribution,
        display_name: display_name.to_string(),
        executable_path: executable.display().to_string(),
        version,
        supports_append_command_line,
        settings_path: settings_path
            .is_file()
            .then(|| settings_path.display().to_string()),
        profiles,
    }
}

fn parse_profiles(
    path: &Path,
    distribution: TerminalDistribution,
    supports_append_command_line: bool,
) -> Result<Vec<TerminalProfileTarget>, String> {
    let content = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    parse_profiles_text(&content, distribution, supports_append_command_line)
}

fn parse_profiles_text(
    content: &str,
    distribution: TerminalDistribution,
    supports_append_command_line: bool,
) -> Result<Vec<TerminalProfileTarget>, String> {
    let settings: SettingsFile = json5::from_str(content).map_err(|error| error.to_string())?;
    let default_guid = settings.default_profile.as_deref().map(normalize_guid);

    Ok(settings
        .profiles
        .list
        .into_iter()
        .filter(|profile| !profile.hidden)
        .filter_map(|profile| {
            let guid = profile.guid?;
            let normalized_guid = normalize_guid(&guid);
            let shell_family = classify_shell(
                profile.commandline.as_deref(),
                profile.source.as_deref(),
                &guid,
            );
            let (preservation, preservation_reason) = classify_preservation(
                supports_append_command_line,
                shell_family,
                profile.commandline.as_deref(),
            );
            Some(TerminalProfileTarget {
                target_id: format!("wt:{}:{}", distribution.as_str(), normalized_guid),
                name: profile.name.unwrap_or_else(|| "未命名 Profile".to_string()),
                guid,
                source: profile.source,
                is_default: default_guid.as_deref() == Some(normalized_guid.as_str()),
                shell_family,
                preservation,
                preservation_reason,
            })
        })
        .collect())
}

fn classify_shell(commandline: Option<&str>, source: Option<&str>, guid: &str) -> ShellFamily {
    if let Some(program) = commandline.and_then(first_command_token) {
        let normalized = program.replace('/', "\\").to_ascii_lowercase();
        let filename = normalized.rsplit('\\').next().unwrap_or(&normalized);
        return match filename {
            "pwsh" | "pwsh.exe" => ShellFamily::Pwsh,
            "powershell" | "powershell.exe" => ShellFamily::WindowsPowerShell,
            "cmd" | "cmd.exe" => ShellFamily::Cmd,
            _ => ShellFamily::Unknown,
        };
    }

    if source.is_some_and(|value| value.eq_ignore_ascii_case("Windows.Terminal.PowershellCore")) {
        return ShellFamily::Pwsh;
    }

    match normalize_guid(guid).as_str() {
        "61c54bbd-c2c6-5271-96e7-009a87ff44bf" => ShellFamily::WindowsPowerShell,
        "0caa0dad-35be-5f56-a8ff-afceeeaa6101" => ShellFamily::Cmd,
        _ => ShellFamily::Unknown,
    }
}

fn classify_preservation(
    supports_append_command_line: bool,
    shell_family: ShellFamily,
    commandline: Option<&str>,
) -> (ProfilePreservation, String) {
    if !supports_append_command_line {
        return (
            ProfilePreservation::AppearanceOnly,
            "Windows Terminal 版本低于 1.19 或版本未知，需要替换 Profile 启动命令".to_string(),
        );
    }
    if shell_family == ShellFamily::Unknown {
        return (
            ProfilePreservation::AppearanceOnly,
            "无法确认 Profile 使用的 Windows shell，仅保留终端外观".to_string(),
        );
    }

    let switches = commandline
        .map(command_switches)
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();

    match shell_family {
        ShellFamily::Pwsh | ShellFamily::WindowsPowerShell => {
            if switches
                .iter()
                .any(|value| matches!(value.as_str(), "-encodedcommand" | "-enc" | "-file" | "-f"))
            {
                (
                    ProfilePreservation::AppearanceOnly,
                    "Profile 使用脚本文件或编码命令，不能安全续接".to_string(),
                )
            } else if switches
                .iter()
                .any(|value| matches!(value.as_str(), "-command" | "-c"))
            {
                if switches
                    .iter()
                    .any(|value| matches!(value.as_str(), "-noexit" | "-noe"))
                {
                    (
                        ProfilePreservation::CommandContinuation,
                        "将在 Profile 现有 PowerShell 初始化命令后继续执行 CLI".to_string(),
                    )
                } else {
                    (
                        ProfilePreservation::AppearanceOnly,
                        "Profile 的 PowerShell 命令执行后会退出，需替换为保持窗口的启动命令"
                            .to_string(),
                    )
                }
            } else {
                (
                    ProfilePreservation::Exact,
                    "可保留 Profile 命令与参数并追加 CLI".to_string(),
                )
            }
        }
        ShellFamily::Cmd => {
            if switches.iter().any(|value| value == "/c") {
                (
                    ProfilePreservation::AppearanceOnly,
                    "Profile 使用 CMD /C，需替换为可保持窗口的启动命令".to_string(),
                )
            } else if switches.iter().any(|value| value == "/k") {
                (
                    ProfilePreservation::CommandContinuation,
                    "将在 Profile 现有 CMD 初始化命令后继续执行 CLI".to_string(),
                )
            } else {
                (
                    ProfilePreservation::Exact,
                    "可保留 Profile 命令与参数并追加 CLI".to_string(),
                )
            }
        }
        ShellFamily::Unknown => unreachable!(),
    }
}

fn detect_direct_shells(pwsh: Option<PathBuf>) -> Vec<DirectShellTarget> {
    let mut shells = Vec::new();
    if let Some(path) = pwsh.filter(|path| path.is_file()) {
        shells.push(direct_shell(
            "direct:pwsh",
            "PowerShell 7",
            ShellFamily::Pwsh,
            path,
            1,
        ));
    }

    let windows_powershell =
        PathBuf::from(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    if windows_powershell.is_file() {
        shells.push(direct_shell(
            "direct:windows-powershell",
            "Windows PowerShell",
            ShellFamily::WindowsPowerShell,
            windows_powershell,
            2,
        ));
    }

    let cmd = PathBuf::from(detect::system32("cmd.exe"));
    if cmd.is_file() {
        shells.push(direct_shell(
            "direct:cmd",
            "命令提示符",
            ShellFamily::Cmd,
            cmd,
            3,
        ));
    }
    shells
}

fn direct_shell(
    target_id: &str,
    display_name: &str,
    shell_family: ShellFamily,
    executable: PathBuf,
    priority: u8,
) -> DirectShellTarget {
    DirectShellTarget {
        target_id: target_id.to_string(),
        display_name: display_name.to_string(),
        shell_family,
        executable_path: executable.display().to_string(),
        priority,
    }
}

fn recommend_target(
    hosts: &[WindowsTerminalHost],
    direct_shells: &[DirectShellTarget],
) -> Option<String> {
    hosts
        .iter()
        .flat_map(|host| &host.profiles)
        .find(|profile| profile.is_default)
        .or_else(|| {
            hosts
                .iter()
                .flat_map(|host| &host.profiles)
                .find(|profile| profile.shell_family == ShellFamily::Pwsh)
        })
        .map(|profile| profile.target_id.clone())
        .or_else(|| direct_shells.first().map(|shell| shell.target_id.clone()))
}

async fn detect_terminal_packages() -> Vec<InstalledPackage> {
    let script = "Get-AppxPackage -Name 'Microsoft.WindowsTerminal*' | ForEach-Object { \"$($_.Name)`t$($_.Version.ToString())`t$($_.InstallLocation)\" }";
    let mut process = Command::new(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    process
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .kill_on_drop(true);
    #[cfg(windows)]
    process.creation_flags(CREATE_NO_WINDOW);

    let Ok(Ok(output)) = tokio::time::timeout(PACKAGE_PROBE_TIMEOUT, process.output()).await else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim().splitn(3, '\t');
            let name = fields.next()?.trim();
            let version = fields.next()?.trim();
            let install_location = fields.next()?.trim();
            (!name.is_empty() && !install_location.is_empty()).then(|| InstalledPackage {
                name: name.to_string(),
                version: version.to_string(),
                install_location: PathBuf::from(install_location),
            })
        })
        .collect()
}

fn first_command_token(commandline: &str) -> Option<&str> {
    let value = commandline.trim_start();
    if value.is_empty() {
        return None;
    }
    if let Some(rest) = value.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some(&rest[..end]);
    }
    Some(value.split_whitespace().next()?)
}

fn command_switches(commandline: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in commandline.chars() {
        match ch {
            '"' => quoted = !quoted,
            value if value.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            value => current.push(value),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens.into_iter().skip(1).collect()
}

fn normalize_guid(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .to_ascii_lowercase()
}

fn parse_major_minor(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = r#"
    {
      // Windows Terminal accepts JSON with comments and trailing commas.
      defaultProfile: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
      profiles: {
        list: [
          {
            name: "PowerShell",
            guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
            source: "Windows.Terminal.PowershellCore",
            commandline: "pwsh.exe -NoExit -Command \\\"chcp 65001 >$null\\\"",
          },
          {
            name: "命令提示符",
            guid: "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}",
            commandline: "%SystemRoot%\\\\System32\\\\cmd.exe /k chcp 65001 >nul",
          },
          {
            name: "Git Bash",
            guid: "{8a96b418-b9ba-4446-8db7-f42e8a04f7ad}",
            commandline: "\\\"C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe\\\" -i -l",
          },
        ],
      },
    }
    "#;

    #[test]
    fn parses_jsonc_and_marks_default_profile() {
        let profiles = parse_profiles_text(SETTINGS, TerminalDistribution::Stable, true).unwrap();
        assert_eq!(profiles.len(), 3);
        assert!(profiles[0].is_default);
        assert_eq!(profiles[0].shell_family, ShellFamily::Pwsh);
        assert_eq!(
            profiles[0].preservation,
            ProfilePreservation::CommandContinuation
        );
        assert_eq!(profiles[1].shell_family, ShellFamily::Cmd);
        assert_eq!(
            profiles[1].preservation,
            ProfilePreservation::CommandContinuation
        );
        assert_eq!(profiles[2].shell_family, ShellFamily::Unknown);
        assert_eq!(
            profiles[2].preservation,
            ProfilePreservation::AppearanceOnly
        );
    }

    #[test]
    fn old_terminal_only_preserves_appearance() {
        let profiles = parse_profiles_text(SETTINGS, TerminalDistribution::Stable, false).unwrap();
        assert!(profiles
            .iter()
            .all(|profile| profile.preservation == ProfilePreservation::AppearanceOnly));
    }

    #[test]
    fn powershell_file_mode_cannot_be_continued() {
        let (preservation, _) = classify_preservation(
            true,
            ShellFamily::Pwsh,
            Some("pwsh.exe -NoExit -File init.ps1"),
        );
        assert_eq!(preservation, ProfilePreservation::AppearanceOnly);
    }

    #[test]
    fn powershell_command_requires_no_exit_for_continuation() {
        let (without_no_exit, _) = classify_preservation(
            true,
            ShellFamily::Pwsh,
            Some("pwsh.exe -Command init-command"),
        );
        let (with_no_exit, _) = classify_preservation(
            true,
            ShellFamily::Pwsh,
            Some("pwsh.exe -NoExit -Command init-command"),
        );
        assert_eq!(without_no_exit, ProfilePreservation::AppearanceOnly);
        assert_eq!(with_no_exit, ProfilePreservation::CommandContinuation);
    }

    #[test]
    fn version_gate_starts_at_1_19() {
        assert!(!parse_major_minor("1.18.3181.0")
            .is_some_and(|(major, minor)| major > 1 || (major == 1 && minor >= 19)));
        assert!(parse_major_minor("1.19.10302.0")
            .is_some_and(|(major, minor)| major > 1 || (major == 1 && minor >= 19)));
    }
}
