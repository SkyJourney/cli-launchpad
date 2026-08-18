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
    let (program_name, args, source) = match (tool_key, kind) {
        (ToolKey::Claude, InstallKind::Install) => (
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
        (ToolKey::Claude, InstallKind::Update) => {
            ("claude", vec!["update"], "Claude Code 内置更新命令")
        }
        (ToolKey::Codex, InstallKind::Install) => (
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
        (ToolKey::Codex, InstallKind::Update) => ("codex", vec!["update"], "Codex 内置更新命令"),
        (ToolKey::Antigravity, InstallKind::Install) => (
            "powershell",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "irm https://antigravity.google/cli/install.ps1 | iex",
            ],
            "Antigravity 官方 PowerShell 安装脚本",
        ),
        (ToolKey::Antigravity, InstallKind::Update) => {
            ("agy", vec!["update"], "Antigravity CLI 内置更新命令")
        }
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

fn resolve_program(program: &str) -> Result<String> {
    if program.eq_ignore_ascii_case("powershell") {
        return Ok(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    }
    detect::resolve_executable_path(&[program])
        .ok_or_else(|| anyhow!("未找到执行安装或更新所需的程序：{program}"))
}

/// Execute only the executable path embedded in the confirmed plan.
pub(crate) fn build_command(plan: &InstallPlan) -> Command {
    let lower_program = plan.program.to_ascii_lowercase();
    let mut command = if lower_program.ends_with(".cmd") || lower_program.ends_with(".bat") {
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
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn antigravity_uses_official_installer() {
        let plan = plan(ToolKey::Antigravity, InstallKind::Install).unwrap();
        assert!(plan.program.to_ascii_lowercase().contains("powershell"));
        assert!(plan.preview.contains("antigravity.google/cli/install.ps1"));
    }

    #[test]
    fn antigravity_update_uses_builtin_command() {
        if let Ok(plan) = plan(ToolKey::Antigravity, InstallKind::Update) {
            assert_eq!(plan.args, vec!["update".to_string()]);
        }
    }
}
