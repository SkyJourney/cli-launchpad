use anyhow::{anyhow, Result};
use tokio::process::Command;

use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::platform::detect;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build the structured install/update command for a tool. Sources are the
/// official channels documented in `docs/tooling-and-installation.md`.
pub fn plan(tool_key: ToolKey, kind: InstallKind) -> Result<InstallPlan> {
    let (program_name, args, source) = match kind {
        InstallKind::Install => install_spec(tool_key)?,
        InstallKind::Update => match tool_key {
            ToolKey::Claude => ("claude", vec!["update"], "Claude Code 内置更新命令"),
            ToolKey::Codex => ("codex", vec!["update"], "Codex 内置更新命令"),
            ToolKey::Antigravity => ("agy", vec!["update"], "Antigravity CLI 内置更新命令"),
        },
    };

    let program = resolve_program(program_name)?;
    let args: Vec<String> = args.into_iter().map(str::to_string).collect();
    let preview = format!("{program} {}", args.join(" "));

    Ok(InstallPlan {
        tool_key,
        kind,
        program,
        args,
        source: source.to_string(),
        preview,
    })
}

#[cfg(windows)]
fn install_spec(tool_key: ToolKey) -> Result<(&'static str, Vec<&'static str>, &'static str)> {
    Ok(match tool_key {
        ToolKey::Claude => (
            "winget",
            vec![
                "install",
                "--id",
                "Anthropic.ClaudeCode",
                "--exact",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ],
            "winget 官方包 Anthropic.ClaudeCode",
        ),
        ToolKey::Codex => (
            "powershell",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "irm https://chatgpt.com/codex/install.ps1 | iex",
            ],
            "OpenAI Codex 官方 Windows 安装器",
        ),
        ToolKey::Antigravity => (
            "powershell",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "irm https://antigravity.google/cli/install.ps1 | iex",
            ],
            "Antigravity 官方 PowerShell 安装脚本",
        ),
    })
}

#[cfg(target_os = "macos")]
fn install_spec(tool_key: ToolKey) -> Result<(&'static str, Vec<&'static str>, &'static str)> {
    Ok(match tool_key {
        ToolKey::Claude => (
            "/bin/bash",
            vec!["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
            "Anthropic Claude Code 官方 macOS 安装脚本",
        ),
        ToolKey::Codex => (
            "/bin/sh",
            vec!["-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
            "OpenAI Codex 官方 macOS 安装脚本",
        ),
        ToolKey::Antigravity => (
            "/bin/bash",
            vec![
                "-c",
                "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            ],
            "Google Antigravity 官方 macOS 安装脚本",
        ),
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_spec(_tool_key: ToolKey) -> Result<(&'static str, Vec<&'static str>, &'static str)> {
    Err(anyhow!("当前平台尚未配置 CLI 安装计划"))
}

fn resolve_program(program: &str) -> Result<String> {
    #[cfg(windows)]
    if program.eq_ignore_ascii_case("powershell") {
        return Ok(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    }
    detect::resolve_executable_path(&[program])
        .ok_or_else(|| anyhow!("未找到执行安装或更新所需的程序：{program}"))
}

/// Execute only the executable path embedded in the confirmed plan.
pub(crate) fn build_command(plan: &InstallPlan) -> Command {
    let lower_program = plan.program.to_ascii_lowercase();
    let command = if lower_program.ends_with(".cmd") || lower_program.ends_with(".bat") {
        let mut command = Command::new(detect::system32("cmd.exe"));
        command
            .arg("/D")
            .arg("/C")
            .arg(&plan.program)
            .args(&plan.args);
        command
    } else {
        let mut command = Command::new(&plan.program);
        command.args(&plan.args);
        command
    };
    configure_command(command)
}

#[cfg(windows)]
fn configure_command(mut command: Command) -> Command {
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
fn configure_command(command: Command) -> Command {
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn claude_install_uses_winget_official_package() {
        if let Ok(plan) = plan(ToolKey::Claude, InstallKind::Install) {
            assert!(plan.args.contains(&"Anthropic.ClaudeCode".to_string()));
            assert!(plan.preview.contains("install"));
        }
    }

    #[test]
    fn claude_update_uses_builtin_command() {
        if let Ok(plan) = plan(ToolKey::Claude, InstallKind::Update) {
            assert_eq!(plan.args, vec!["update".to_string()]);
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_install_uses_official_windows_installer() {
        let plan = plan(ToolKey::Codex, InstallKind::Install).unwrap();
        assert!(plan.preview.contains("chatgpt.com/codex/install.ps1"));
    }

    #[test]
    fn codex_update_uses_builtin_command() {
        if let Ok(plan) = plan(ToolKey::Codex, InstallKind::Update) {
            assert_eq!(plan.args, vec!["update".to_string()]);
        }
    }

    #[cfg(windows)]
    #[test]
    fn antigravity_uses_official_installer() {
        let plan = plan(ToolKey::Antigravity, InstallKind::Install).unwrap();
        assert!(plan.program.to_ascii_lowercase().contains("powershell"));
        assert!(plan.preview.contains("antigravity.google/cli/install.ps1"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_installs_use_fixed_official_scripts() {
        let cases = [
            (
                ToolKey::Claude,
                "/bin/bash",
                "curl -fsSL https://claude.ai/install.sh | bash",
            ),
            (
                ToolKey::Codex,
                "/bin/sh",
                "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            ),
            (
                ToolKey::Antigravity,
                "/bin/bash",
                "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            ),
        ];
        for (tool_key, program, script) in cases {
            let plan = plan(tool_key, InstallKind::Install).unwrap();
            assert_eq!(plan.program, program);
            assert_eq!(plan.args, vec!["-c", script]);
            assert_eq!(plan.preview, format!("{program} -c {script}"));
            assert!(plan.source.contains("官方 macOS 安装脚本"));
        }
    }

    #[test]
    fn antigravity_update_uses_builtin_command() {
        if let Ok(plan) = plan(ToolKey::Antigravity, InstallKind::Update) {
            assert_eq!(plan.args, vec!["update".to_string()]);
        }
    }
}
