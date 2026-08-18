use std::collections::HashSet;

use anyhow::{anyhow, Result};
use base64::Engine;

use crate::models::terminal::{
    DirectShellTarget, MacosTerminalHost, MacosTerminalLaunchMode, ProfilePreservation,
    ShellFamily, TerminalEnvironment, TerminalPlatform, TerminalProfileTarget, WindowsTerminalHost,
};

pub const MACOS_COMMAND_DOCUMENT_PLACEHOLDER: &str = "<一次性启动载荷.command>";

#[derive(Debug, Clone)]
pub struct LaunchPayload {
    pub directory: String,
    pub tool_executable: String,
    pub tool_args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ComposedCommand {
    pub program: String,
    pub args: Vec<String>,
    pub working_dir: Option<String>,
    #[cfg_attr(not(windows), allow(dead_code))]
    pub new_console: bool,
}

#[derive(Debug, Clone)]
pub struct LaunchCandidate {
    pub target_id: String,
    pub label: String,
    pub preservation: Option<ProfilePreservation>,
    pub reason: String,
    pub command: ComposedCommand,
    pub requires_macos_command_document: bool,
}

#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub platform: TerminalPlatform,
    pub payload: LaunchPayload,
    pub candidates: Vec<LaunchCandidate>,
    pub selection_note: Option<String>,
}

pub fn build_launch_plan(
    payload: LaunchPayload,
    environment: &TerminalEnvironment,
    preference: &str,
) -> Result<LaunchPlan> {
    build_launch_plan_internal(payload, environment, preference)
}

fn build_launch_plan_internal(
    payload: LaunchPayload,
    environment: &TerminalEnvironment,
    preference: &str,
) -> Result<LaunchPlan> {
    if environment.platform == TerminalPlatform::Macos {
        return build_macos_launch_plan(payload, environment, preference);
    }
    build_windows_launch_plan(payload, environment, preference)
}

fn build_windows_launch_plan(
    payload: LaunchPayload,
    environment: &TerminalEnvironment,
    preference: &str,
) -> Result<LaunchPlan> {
    let mut candidates = Vec::new();
    let mut selection_note = None;

    match select_target(environment, preference) {
        SelectedTarget::Profile(host, profile) => {
            append_profile_candidates(&mut candidates, &payload, host, profile, environment);
        }
        SelectedTarget::HostDefault(host) => {
            selection_note = Some(
                "Windows Terminal 没有可解析的 Profile，使用默认 Profile 外观兼容启动".to_string(),
            );
            if let Some(shell) = environment.direct_shells.first() {
                candidates.push(compose_wt_appearance(
                    &payload,
                    host,
                    None,
                    shell,
                    "使用 Windows Terminal 默认 Profile，并替换为可信 shell",
                ));
            }
            append_direct_candidates(&mut candidates, &payload, &environment.direct_shells, None);
        }
        SelectedTarget::Direct(selected) => {
            append_direct_candidates(
                &mut candidates,
                &payload,
                &environment.direct_shells,
                Some(&selected.target_id),
            );
        }
        SelectedTarget::Unavailable => {}
    }

    if preference != "auto" && !candidates.iter().any(|item| item.target_id == preference) {
        selection_note = Some(format!(
            "保存的启动目标 {preference} 当前不可用，已进入自动回退链"
        ));
        candidates.clear();
        append_automatic_candidates(&mut candidates, &payload, environment);
    }

    deduplicate_commands(&mut candidates);
    if candidates.is_empty() {
        return Err(anyhow!(
            "未找到可用的 Windows Terminal、PowerShell 或 CMD 启动方式"
        ));
    }

    Ok(LaunchPlan {
        platform: environment.platform,
        payload,
        candidates,
        selection_note,
    })
}

fn build_macos_launch_plan(
    payload: LaunchPayload,
    environment: &TerminalEnvironment,
    preference: &str,
) -> Result<LaunchPlan> {
    let system_terminal = environment
        .macos_terminal_hosts
        .iter()
        .find(|host| host.target_id == "macos:terminal");
    let selected = if preference == "auto" {
        system_terminal
    } else {
        environment
            .macos_terminal_hosts
            .iter()
            .find(|host| host.target_id == preference)
    };
    let mut selection_note = None;
    let mut candidates = Vec::new();

    if let Some(host) = selected {
        candidates.push(compose_macos_candidate(&payload, host)?);
    } else if preference != "auto" {
        selection_note = Some(format!(
            "保存的启动目标 {preference} 当前不可用，已回退到系统 Terminal.app"
        ));
    }

    if selected.is_none_or(|host| host.target_id != "macos:terminal") {
        if let Some(host) = system_terminal {
            candidates.push(compose_macos_candidate(&payload, host)?);
        }
    }

    deduplicate_commands(&mut candidates);
    if candidates.is_empty() {
        return Err(anyhow!("未找到可用的 macOS 终端启动方式"));
    }
    Ok(LaunchPlan {
        platform: environment.platform,
        payload,
        candidates,
        selection_note,
    })
}

fn compose_macos_candidate(
    payload: &LaunchPayload,
    host: &MacosTerminalHost,
) -> Result<LaunchCandidate> {
    let (program, args, working_dir, reason, requires_macos_command_document) =
        match host.launch_mode {
            MacosTerminalLaunchMode::CommandDocument => (
                "/usr/bin/open".to_string(),
                vec![
                    "-b".to_string(),
                    host.bundle_identifier.clone(),
                    MACOS_COMMAND_DOCUMENT_PLACEHOLDER.to_string(),
                ],
                None,
                "通过 LaunchServices 打开一次性、自删除的 .command 载荷".to_string(),
                true,
            ),
            MacosTerminalLaunchMode::AppleScript => {
                if host.target_id != "macos:ghostty" {
                    return Err(anyhow!("未知的 macOS AppleScript 终端：{}", host.target_id));
                }
                (
                    "/usr/bin/osascript".to_string(),
                    compose_ghostty_applescript_args(payload),
                    None,
                    "通过 Ghostty AppleScript 在普通 shell 窗口输入安全命令".to_string(),
                    false,
                )
            }
            MacosTerminalLaunchMode::DirectArguments => {
                let executable = host
                    .executable_path
                    .clone()
                    .ok_or_else(|| anyhow!("{} 缺少已验证的包内可执行文件", host.display_name))?;
                let mut args = match host.target_id.as_str() {
                    "macos:wezterm" => vec![
                        "start".to_string(),
                        "--cwd".to_string(),
                        payload.directory.clone(),
                        "--".to_string(),
                        payload.tool_executable.clone(),
                    ],
                    "macos:kitty" => vec![
                        "--hold".to_string(),
                        "--directory".to_string(),
                        payload.directory.clone(),
                        payload.tool_executable.clone(),
                    ],
                    _ => return Err(anyhow!("未知的 macOS 直接参数终端：{}", host.target_id)),
                };
                args.extend(payload.tool_args.iter().cloned());
                (
                    executable,
                    args,
                    Some(payload.directory.clone()),
                    "通过终端官方 CLI 的结构化参数直接执行目标 CLI".to_string(),
                    false,
                )
            }
        };

    Ok(LaunchCandidate {
        target_id: host.target_id.clone(),
        label: host.display_name.clone(),
        preservation: None,
        reason,
        command: ComposedCommand {
            program,
            args,
            working_dir,
            new_console: false,
        },
        requires_macos_command_document,
    })
}

fn compose_shell_command(payload: &LaunchPayload) -> String {
    let invocation = std::iter::once(payload.tool_executable.as_str())
        .chain(payload.tool_args.iter().map(String::as_str))
        .map(quote_posix)
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "builtin cd -- {} && {invocation}",
        quote_posix(&payload.directory)
    )
}

fn compose_ghostty_applescript_args(payload: &LaunchPayload) -> Vec<String> {
    const LINES: [&str; 10] = [
        "on run argv",
        "tell application \"Ghostty\"",
        "set launchWindow to new window",
        "set launchTerminal to focused terminal of selected tab of launchWindow",
        "input text (item 1 of argv) to launchTerminal",
        "send key \"enter\" to launchTerminal",
        "focus launchTerminal",
        "return id of launchWindow",
        "end tell",
        "end run",
    ];
    let mut args = Vec::with_capacity(LINES.len() * 2 + 2);
    for line in LINES {
        args.push("-e".to_string());
        args.push(line.to_string());
    }
    args.push("--".to_string());
    args.push(compose_shell_command(payload));
    args
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn preview_plan(plan: &LaunchPlan) -> String {
    let primary = &plan.candidates[0];
    let mut lines = vec![format!("启动方式：{}", primary.label)];
    if plan.platform == TerminalPlatform::Macos {
        lines.push(format!(
            "启动接口：{}",
            macos_launch_interface(&primary.target_id)
        ));
    } else {
        lines.push(format!(
            "保留级别：{}",
            preservation_label(primary.preservation)
        ));
    }
    lines.extend([
        format!("项目目录：{}", plan.payload.directory),
        format!(
            "执行命令：{}",
            display_command(
                &plan.payload.tool_executable,
                &plan.payload.tool_args,
                false
            )
        ),
        format!("终端命令：{}", display_terminal_command(primary)),
    ]);
    if let Some(note) = &plan.selection_note {
        lines.push(format!("选择说明：{note}"));
    }
    lines.push(format!("启动说明：{}", primary.reason));
    if plan.candidates.len() > 1 {
        lines.push(format!(
            "失败回退：{}",
            plan.candidates
                .iter()
                .skip(1)
                .map(|candidate| candidate.label.as_str())
                .collect::<Vec<_>>()
                .join(" → ")
        ));
    }
    lines.join("\n")
}

fn macos_launch_interface(target_id: &str) -> &'static str {
    match target_id {
        "macos:terminal" | "macos:iterm2" => "LaunchServices + 一次性 .command",
        "macos:ghostty" => "Ghostty AppleScript 原生窗口 + shell 输入",
        "macos:wezterm" | "macos:kitty" => "终端官方 CLI 结构化参数",
        _ => "macOS 终端安全启动载荷",
    }
}

fn display_terminal_command(candidate: &LaunchCandidate) -> String {
    if candidate.target_id == "macos:ghostty" {
        return "/usr/bin/osascript <Ghostty 原生窗口脚本> -- <安全转义的 CLI 命令>".to_string();
    }
    display_command(&candidate.command.program, &candidate.command.args, true)
}

enum SelectedTarget<'a> {
    Profile(&'a WindowsTerminalHost, &'a TerminalProfileTarget),
    HostDefault(&'a WindowsTerminalHost),
    Direct(&'a DirectShellTarget),
    Unavailable,
}

fn select_target<'a>(environment: &'a TerminalEnvironment, preference: &str) -> SelectedTarget<'a> {
    if preference == "auto" {
        if let Some(recommended) = environment.recommended_target_id.as_deref() {
            if let Some((host, profile)) = find_profile(environment, recommended) {
                return SelectedTarget::Profile(host, profile);
            }
        }
        if let Some(host) = environment.windows_terminal_hosts.first() {
            if let Some(profile) = host.profiles.iter().find(|profile| profile.is_default) {
                return SelectedTarget::Profile(host, profile);
            }
            return SelectedTarget::HostDefault(host);
        }
        return environment
            .direct_shells
            .first()
            .map_or(SelectedTarget::Unavailable, SelectedTarget::Direct);
    }

    if let Some((host, profile)) = find_profile(environment, preference) {
        return SelectedTarget::Profile(host, profile);
    }
    environment
        .direct_shells
        .iter()
        .find(|shell| shell.target_id == preference)
        .map_or(SelectedTarget::Unavailable, SelectedTarget::Direct)
}

fn find_profile<'a>(
    environment: &'a TerminalEnvironment,
    target_id: &str,
) -> Option<(&'a WindowsTerminalHost, &'a TerminalProfileTarget)> {
    environment.windows_terminal_hosts.iter().find_map(|host| {
        host.profiles
            .iter()
            .find(|profile| profile.target_id == target_id)
            .map(|profile| (host, profile))
    })
}

fn append_automatic_candidates(
    candidates: &mut Vec<LaunchCandidate>,
    payload: &LaunchPayload,
    environment: &TerminalEnvironment,
) {
    match select_target(environment, "auto") {
        SelectedTarget::Profile(host, profile) => {
            append_profile_candidates(candidates, payload, host, profile, environment)
        }
        SelectedTarget::HostDefault(host) => {
            if let Some(shell) = environment.direct_shells.first() {
                candidates.push(compose_wt_appearance(
                    payload,
                    host,
                    None,
                    shell,
                    "自动回退到 Windows Terminal 默认 Profile 外观",
                ));
            }
            append_direct_candidates(candidates, payload, &environment.direct_shells, None);
        }
        SelectedTarget::Direct(shell) => append_direct_candidates(
            candidates,
            payload,
            &environment.direct_shells,
            Some(&shell.target_id),
        ),
        SelectedTarget::Unavailable => {}
    }
}

fn append_profile_candidates(
    candidates: &mut Vec<LaunchCandidate>,
    payload: &LaunchPayload,
    host: &WindowsTerminalHost,
    profile: &TerminalProfileTarget,
    environment: &TerminalEnvironment,
) {
    let matching_shell = environment
        .direct_shells
        .iter()
        .find(|shell| shell.shell_family == profile.shell_family)
        .or_else(|| environment.direct_shells.first());

    match profile.preservation {
        ProfilePreservation::Exact => candidates.push(compose_wt_exact(payload, host, profile)),
        ProfilePreservation::CommandContinuation => {
            candidates.push(compose_wt_continuation(payload, host, profile))
        }
        ProfilePreservation::AppearanceOnly => {}
    }

    if let Some(shell) = matching_shell {
        candidates.push(compose_wt_appearance(
            payload,
            host,
            Some(profile),
            shell,
            &profile.preservation_reason,
        ));
    }
    append_direct_candidates(candidates, payload, &environment.direct_shells, None);
}

fn compose_wt_exact(
    payload: &LaunchPayload,
    host: &WindowsTerminalHost,
    profile: &TerminalProfileTarget,
) -> LaunchCandidate {
    let mut args = wt_prefix(payload, profile);
    args.push("--appendCommandLine".to_string());
    args.push("--".to_string());
    match profile.shell_family {
        ShellFamily::Pwsh | ShellFamily::WindowsPowerShell => {
            args.push("-NoExit".to_string());
            args.push("-EncodedCommand".to_string());
            args.push(encode_powershell_command(&powershell_invocation(payload)));
        }
        ShellFamily::Cmd => {
            args.push("/K".to_string());
            args.extend(cmd_powershell_runner(payload));
        }
        ShellFamily::Unknown => unreachable!(),
    }
    LaunchCandidate {
        target_id: profile.target_id.clone(),
        label: format!("{} / {}", host.display_name, profile.name),
        preservation: Some(ProfilePreservation::Exact),
        reason: profile.preservation_reason.clone(),
        command: ComposedCommand {
            program: host.executable_path.clone(),
            args,
            working_dir: None,
            new_console: false,
        },
        requires_macos_command_document: false,
    }
}

fn compose_wt_continuation(
    payload: &LaunchPayload,
    host: &WindowsTerminalHost,
    profile: &TerminalProfileTarget,
) -> LaunchCandidate {
    let mut args = wt_prefix(payload, profile);
    args.push("--appendCommandLine".to_string());
    args.push("--".to_string());
    match profile.shell_family {
        ShellFamily::Pwsh | ShellFamily::WindowsPowerShell => {
            args.push("\\;".to_string());
            args.push(encoded_script_block(payload));
        }
        ShellFamily::Cmd => {
            args.push("&".to_string());
            args.extend(cmd_powershell_runner(payload));
        }
        ShellFamily::Unknown => unreachable!(),
    }
    LaunchCandidate {
        target_id: profile.target_id.clone(),
        label: format!("{} / {}", host.display_name, profile.name),
        preservation: Some(ProfilePreservation::CommandContinuation),
        reason: profile.preservation_reason.clone(),
        command: ComposedCommand {
            program: host.executable_path.clone(),
            args,
            working_dir: None,
            new_console: false,
        },
        requires_macos_command_document: false,
    }
}

fn compose_wt_appearance(
    payload: &LaunchPayload,
    host: &WindowsTerminalHost,
    profile: Option<&TerminalProfileTarget>,
    shell: &DirectShellTarget,
    reason: &str,
) -> LaunchCandidate {
    let mut args = vec![
        "new-tab".to_string(),
        "--startingDirectory".to_string(),
        payload.directory.clone(),
    ];
    if let Some(profile) = profile {
        args.push("--profile".to_string());
        args.push(profile.guid.clone());
    }
    args.push(shell.executable_path.clone());
    args.extend(direct_shell_args(shell.shell_family, payload));

    LaunchCandidate {
        target_id: profile
            .map(|profile| profile.target_id.clone())
            .unwrap_or_else(|| host.id.clone()),
        label: profile.map_or_else(
            || format!("{} / 默认 Profile（兼容）", host.display_name),
            |profile| format!("{} / {}（兼容）", host.display_name, profile.name),
        ),
        preservation: Some(ProfilePreservation::AppearanceOnly),
        reason: reason.to_string(),
        command: ComposedCommand {
            program: host.executable_path.clone(),
            args,
            working_dir: None,
            new_console: false,
        },
        requires_macos_command_document: false,
    }
}

fn append_direct_candidates(
    candidates: &mut Vec<LaunchCandidate>,
    payload: &LaunchPayload,
    shells: &[DirectShellTarget],
    preferred_target: Option<&str>,
) {
    if let Some(target_id) = preferred_target {
        if let Some(shell) = shells.iter().find(|shell| shell.target_id == target_id) {
            candidates.push(compose_direct(payload, shell, "使用用户选择的独立控制台"));
        }
    }
    for shell in shells {
        if preferred_target == Some(shell.target_id.as_str()) {
            continue;
        }
        candidates.push(compose_direct(
            payload,
            shell,
            "前序启动方式不可用时的独立控制台回退",
        ));
    }
}

fn compose_direct(
    payload: &LaunchPayload,
    shell: &DirectShellTarget,
    reason: &str,
) -> LaunchCandidate {
    LaunchCandidate {
        target_id: shell.target_id.clone(),
        label: format!("{} 独立窗口", shell.display_name),
        preservation: None,
        reason: reason.to_string(),
        command: ComposedCommand {
            program: shell.executable_path.clone(),
            args: direct_shell_args(shell.shell_family, payload),
            working_dir: Some(payload.directory.clone()),
            new_console: true,
        },
        requires_macos_command_document: false,
    }
}

fn direct_shell_args(shell_family: ShellFamily, payload: &LaunchPayload) -> Vec<String> {
    match shell_family {
        ShellFamily::Pwsh | ShellFamily::WindowsPowerShell => vec![
            "-NoExit".to_string(),
            "-EncodedCommand".to_string(),
            encode_powershell_command(&powershell_invocation(payload)),
        ],
        ShellFamily::Cmd => {
            let mut args = vec!["/K".to_string()];
            args.extend(cmd_powershell_runner(payload));
            args
        }
        ShellFamily::Unknown => Vec::new(),
    }
}

fn wt_prefix(payload: &LaunchPayload, profile: &TerminalProfileTarget) -> Vec<String> {
    vec![
        "new-tab".to_string(),
        "--profile".to_string(),
        profile.guid.clone(),
        "--startingDirectory".to_string(),
        payload.directory.clone(),
    ]
}

fn cmd_powershell_runner(payload: &LaunchPayload) -> Vec<String> {
    vec![
        crate::platform::detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"),
        "-NoProfile".to_string(),
        "-EncodedCommand".to_string(),
        encode_powershell_command(&powershell_invocation(payload)),
    ]
}

fn powershell_invocation(payload: &LaunchPayload) -> String {
    let mut invocation = format!("& {}", quote_powershell_arg(&payload.tool_executable));
    for arg in &payload.tool_args {
        invocation.push(' ');
        invocation.push_str(&quote_powershell_arg(arg));
    }
    invocation
}

fn encoded_script_block(payload: &LaunchPayload) -> String {
    let encoded = encode_powershell_command(&powershell_invocation(payload));
    format!(
        "&([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{encoded}'))))"
    )
}

fn encode_powershell_command(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn quote_powershell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn preservation_label(value: Option<ProfilePreservation>) -> &'static str {
    match value {
        Some(ProfilePreservation::Exact) => "完整保留 Profile",
        Some(ProfilePreservation::CommandContinuation) => "保留 Profile 并续接命令",
        Some(ProfilePreservation::AppearanceOnly) => "仅保留 Profile 外观",
        None => "独立控制台",
    }
}

fn display_command(program: &str, args: &[String], hide_encoded_payload: bool) -> String {
    let mut tokens = vec![display_token(program)];
    let mut redact_next = false;
    for arg in args {
        if redact_next && hide_encoded_payload {
            tokens.push("<已编码的 CLI 命令>".to_string());
            redact_next = false;
            continue;
        }
        tokens.push(display_token(arg));
        redact_next = arg.eq_ignore_ascii_case("-EncodedCommand");
    }
    tokens.join(" ")
}

fn display_token(value: &str) -> String {
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || matches!(character, '&' | ';'))
    {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn deduplicate_commands(candidates: &mut Vec<LaunchCandidate>) {
    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        seen.insert((
            candidate.command.program.clone(),
            candidate.command.args.clone(),
        ))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::terminal::{
        MacosTerminalHost, MacosTerminalLaunchMode, TerminalDistribution, TerminalEnvironment,
        TerminalPlatform,
    };

    fn payload(args: Vec<&str>) -> LaunchPayload {
        LaunchPayload {
            directory: "C:\\Projects\\演示 项目".to_string(),
            tool_executable: "C:\\Program Files\\CLI\\claude.cmd".to_string(),
            tool_args: args.into_iter().map(str::to_string).collect(),
        }
    }

    fn shell(target_id: &str, family: ShellFamily, priority: u8) -> DirectShellTarget {
        DirectShellTarget {
            target_id: target_id.to_string(),
            display_name: target_id.to_string(),
            shell_family: family,
            executable_path: match family {
                ShellFamily::Pwsh => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                ShellFamily::WindowsPowerShell => {
                    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
                }
                ShellFamily::Cmd => "C:\\Windows\\System32\\cmd.exe",
                ShellFamily::Unknown => "unknown.exe",
            }
            .to_string(),
            priority,
        }
    }

    fn profile(preservation: ProfilePreservation, family: ShellFamily) -> TerminalProfileTarget {
        TerminalProfileTarget {
            target_id: "wt:stable:574e775e-4f2a-5b96-ac1e-a2962a402336".to_string(),
            name: "PowerShell".to_string(),
            guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}".to_string(),
            source: None,
            is_default: true,
            shell_family: family,
            preservation,
            preservation_reason: "测试原因".to_string(),
        }
    }

    fn environment(profile: TerminalProfileTarget) -> TerminalEnvironment {
        TerminalEnvironment {
            platform: TerminalPlatform::Windows,
            windows_terminal_hosts: vec![WindowsTerminalHost {
                id: "wt:stable".to_string(),
                distribution: TerminalDistribution::Stable,
                display_name: "Windows Terminal".to_string(),
                executable_path: "C:\\WindowsTerminal.exe".to_string(),
                version: Some("1.24.0.0".to_string()),
                supports_append_command_line: true,
                settings_path: None,
                profiles: vec![profile],
            }],
            macos_terminal_hosts: Vec::new(),
            direct_shells: vec![
                shell("direct:pwsh", ShellFamily::Pwsh, 1),
                shell(
                    "direct:windows-powershell",
                    ShellFamily::WindowsPowerShell,
                    2,
                ),
                shell("direct:cmd", ShellFamily::Cmd, 3),
            ],
            recommended_target_id: Some(
                "wt:stable:574e775e-4f2a-5b96-ac1e-a2962a402336".to_string(),
            ),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn exact_profile_uses_append_and_has_full_fallback_chain() {
        let environment = environment(profile(ProfilePreservation::Exact, ShellFamily::Pwsh));
        let plan =
            build_launch_plan(payload(vec!["--model", "opus"]), &environment, "auto").unwrap();
        assert_eq!(plan.candidates.len(), 5);
        assert!(plan.candidates[0]
            .command
            .args
            .contains(&"--appendCommandLine".to_string()));
        assert!(plan.candidates[0]
            .command
            .args
            .contains(&"-EncodedCommand".to_string()));
        assert_eq!(
            plan.candidates[1].preservation,
            Some(ProfilePreservation::AppearanceOnly)
        );
        assert_eq!(plan.candidates[2].target_id, "direct:pwsh");
        assert_eq!(plan.candidates[4].target_id, "direct:cmd");
    }

    #[test]
    fn command_profile_appends_escaped_separator_and_encoded_script_block() {
        let environment = environment(profile(
            ProfilePreservation::CommandContinuation,
            ShellFamily::Pwsh,
        ));
        let plan =
            build_launch_plan(payload(vec!["a;b", "$unsafe"]), &environment, "auto").unwrap();
        let args = &plan.candidates[0].command.args;
        assert!(args.contains(&"\\;".to_string()));
        let script = args.last().unwrap();
        assert!(script.starts_with("&([ScriptBlock]::Create("));
        assert!(!script.contains("a;b"));
        assert!(!script.contains("$unsafe"));
    }

    #[test]
    fn cmd_never_receives_user_arguments_as_plain_text() {
        let environment = TerminalEnvironment {
            platform: TerminalPlatform::Windows,
            windows_terminal_hosts: Vec::new(),
            macos_terminal_hosts: Vec::new(),
            direct_shells: vec![shell("direct:cmd", ShellFamily::Cmd, 3)],
            recommended_target_id: Some("direct:cmd".to_string()),
            warnings: Vec::new(),
        };
        let plan = build_launch_plan(
            payload(vec!["& calc.exe", "%PATH%", "!value!"]),
            &environment,
            "auto",
        )
        .unwrap();
        let joined = plan.candidates[0].command.args.join(" ");
        assert!(!joined.contains("calc.exe"));
        assert!(!joined.contains("%PATH%"));
        assert!(!joined.contains("!value!"));
        assert!(joined.contains("-EncodedCommand"));
    }

    #[test]
    fn stale_preference_falls_back_to_auto() {
        let environment = environment(profile(ProfilePreservation::Exact, ShellFamily::Pwsh));
        let plan = build_launch_plan(payload(vec![]), &environment, "direct:missing").unwrap();
        assert!(plan.selection_note.is_some());
        assert!(plan.candidates[0].target_id.starts_with("wt:stable:"));
    }

    #[test]
    fn preview_shows_readable_cli_and_hides_encoded_payload() {
        let environment = environment(profile(ProfilePreservation::Exact, ShellFamily::Pwsh));
        let plan =
            build_launch_plan(payload(vec!["--model", "opus"]), &environment, "auto").unwrap();
        let preview = preview_plan(&plan);
        assert!(preview.contains("执行命令："));
        assert!(preview.contains("--model opus"));
        assert!(preview.contains("<已编码的 CLI 命令>"));
        assert!(preview.contains("失败回退："));
    }

    fn macos_payload(args: Vec<&str>) -> LaunchPayload {
        LaunchPayload {
            directory: "/workspace/demo".to_string(),
            tool_executable: "/Users/test/.local/bin/claude".to_string(),
            tool_args: args.into_iter().map(str::to_string).collect(),
        }
    }

    fn macos_host(
        target_id: &str,
        display_name: &str,
        bundle_identifier: &str,
        executable_path: Option<&str>,
        launch_mode: MacosTerminalLaunchMode,
    ) -> MacosTerminalHost {
        MacosTerminalHost {
            target_id: target_id.to_string(),
            display_name: display_name.to_string(),
            application_path: format!("/Applications/{display_name}.app"),
            bundle_identifier: bundle_identifier.to_string(),
            executable_path: executable_path.map(str::to_string),
            version: Some("1.0".to_string()),
            launch_mode,
        }
    }

    fn macos_environment() -> TerminalEnvironment {
        TerminalEnvironment {
            platform: TerminalPlatform::Macos,
            windows_terminal_hosts: Vec::new(),
            macos_terminal_hosts: vec![
                macos_host(
                    "macos:terminal",
                    "Terminal.app",
                    "com.apple.Terminal",
                    None,
                    MacosTerminalLaunchMode::CommandDocument,
                ),
                macos_host(
                    "macos:iterm2",
                    "iTerm2",
                    "com.googlecode.iterm2",
                    Some("/Applications/iTerm.app/Contents/MacOS/iTerm2"),
                    MacosTerminalLaunchMode::CommandDocument,
                ),
                macos_host(
                    "macos:ghostty",
                    "Ghostty",
                    "com.mitchellh.ghostty",
                    Some("/Applications/Ghostty.app/Contents/MacOS/ghostty"),
                    MacosTerminalLaunchMode::AppleScript,
                ),
                macos_host(
                    "macos:wezterm",
                    "WezTerm",
                    "com.github.wez.wezterm",
                    Some("/Applications/WezTerm.app/Contents/MacOS/wezterm"),
                    MacosTerminalLaunchMode::DirectArguments,
                ),
                macos_host(
                    "macos:kitty",
                    "kitty",
                    "net.kovidgoyal.kitty",
                    Some("/Applications/kitty.app/Contents/MacOS/kitty"),
                    MacosTerminalLaunchMode::DirectArguments,
                ),
            ],
            direct_shells: Vec::new(),
            recommended_target_id: Some("macos:terminal".to_string()),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn macos_auto_always_selects_system_terminal() {
        let plan = build_launch_plan(
            macos_payload(vec!["--model", "opus"]),
            &macos_environment(),
            "auto",
        )
        .unwrap();
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].target_id, "macos:terminal");
        assert_eq!(plan.candidates[0].command.program, "/usr/bin/open");
        assert_eq!(
            plan.candidates[0].command.args,
            vec![
                "-b",
                "com.apple.Terminal",
                MACOS_COMMAND_DOCUMENT_PLACEHOLDER,
            ]
        );
        assert!(plan.candidates[0].requires_macos_command_document);
        let preview = preview_plan(&plan);
        assert!(preview.contains("启动接口：LaunchServices + 一次性 .command"));
        assert!(!preview.contains("保留级别："));
    }

    #[test]
    fn macos_explicit_terminal_adds_system_fallback() {
        let plan = build_launch_plan(macos_payload(vec![]), &macos_environment(), "macos:ghostty")
            .unwrap();
        assert_eq!(
            plan.candidates
                .iter()
                .map(|candidate| candidate.target_id.as_str())
                .collect::<Vec<_>>(),
            vec!["macos:ghostty", "macos:terminal"]
        );
    }

    #[test]
    fn macos_ghostty_uses_applescript_with_payload_only_in_argv() {
        let plan = build_launch_plan(
            macos_payload(vec!["--model", "quote's opus"]),
            &macos_environment(),
            "macos:ghostty",
        )
        .unwrap();
        let command = &plan.candidates[0].command;
        assert_eq!(command.program, "/usr/bin/osascript");
        let separator = command.args.iter().position(|arg| arg == "--").unwrap();
        let script_source = command.args[..separator].join("\n");
        assert!(script_source.contains("new window"));
        assert!(script_source.contains("input text (item 1 of argv)"));
        assert!(script_source.contains("send key \"enter\""));
        assert!(!script_source.contains("/workspace/demo"));
        assert!(!script_source.contains("quote's opus"));
        assert_eq!(
            command.args.last().unwrap(),
            "builtin cd -- '/workspace/demo' && '/Users/test/.local/bin/claude' '--model' 'quote'\\''s opus'"
        );
        assert!(!plan.candidates[0].requires_macos_command_document);
        assert!(plan.candidates[1].requires_macos_command_document);
        let preview = preview_plan(&plan);
        assert!(preview.contains("Ghostty AppleScript 原生窗口 + shell 输入"));
        assert!(preview.contains("<Ghostty 原生窗口脚本>"));
    }

    #[test]
    fn macos_iterm_uses_self_deleting_command_document() {
        let plan = build_launch_plan(
            macos_payload(vec!["--model", "opus"]),
            &macos_environment(),
            "macos:iterm2",
        )
        .unwrap();
        let command = &plan.candidates[0].command;
        assert_eq!(command.program, "/usr/bin/open");
        assert_eq!(
            command.args,
            vec![
                "-b",
                "com.googlecode.iterm2",
                MACOS_COMMAND_DOCUMENT_PLACEHOLDER,
            ]
        );
        assert!(plan.candidates[0].requires_macos_command_document);
        assert!(preview_plan(&plan).contains("LaunchServices + 一次性 .command"));
    }

    #[test]
    fn macos_direct_terminals_receive_tool_and_arguments_without_helper() {
        let plan = build_launch_plan(
            macos_payload(vec!["--model", "opus"]),
            &macos_environment(),
            "macos:wezterm",
        )
        .unwrap();
        assert_eq!(
            plan.candidates[0].command.args,
            vec![
                "start",
                "--cwd",
                "/workspace/demo",
                "--",
                "/Users/test/.local/bin/claude",
                "--model",
                "opus",
            ]
        );
        assert!(!plan.candidates[0].requires_macos_command_document);
        assert_eq!(plan.candidates[1].target_id, "macos:terminal");

        let kitty = build_launch_plan(
            macos_payload(vec!["--model", "opus"]),
            &macos_environment(),
            "macos:kitty",
        )
        .unwrap();
        assert_eq!(
            kitty.candidates[0].command.args,
            vec![
                "--hold",
                "--directory",
                "/workspace/demo",
                "/Users/test/.local/bin/claude",
                "--model",
                "opus",
            ]
        );
        assert!(!kitty.candidates[0].requires_macos_command_document);
    }

    #[test]
    fn removed_macos_targets_fall_back_to_system_terminal() {
        for target_id in ["macos:alacritty", "macos:warp"] {
            let plan =
                build_launch_plan(macos_payload(vec![]), &macos_environment(), target_id).unwrap();
            assert_eq!(plan.candidates[0].target_id, "macos:terminal");
            assert!(plan
                .selection_note
                .as_deref()
                .is_some_and(|note| note.contains(target_id)));
        }
    }
}
