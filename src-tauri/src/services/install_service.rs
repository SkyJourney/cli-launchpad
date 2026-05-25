use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::process::Command;

use crate::models::install::{InstallKind, InstallOutcome, InstallPlan};
use crate::models::tool::ToolKey;
use crate::platform::detect;

/// Installs legitimately take a while (downloads), but a process stuck on an
/// interactive prompt must not hang forever; kill_on_drop enforces the bound.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

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
        (ToolKey::Codex, InstallKind::Install) | (ToolKey::Codex, InstallKind::Update) => (
            "npm",
            vec!["i", "-g", "@openai/codex@latest"],
            "npm 官方包 @openai/codex",
        ),
        (ToolKey::Antigravity, _) => (
            "powershell",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "irm https://antigravity.google/cli/install.ps1 | iex",
            ],
            "Antigravity 官方 PowerShell 安装脚本",
        ),
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
fn build_command(plan: &InstallPlan) -> Command {
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

/// Execute the plan, capturing combined stdout+stderr as the log. Bounded by a
/// timeout with the child killed on drop so a hung prompt cannot block forever.
pub async fn run(plan: &InstallPlan) -> InstallOutcome {
    let mut command = build_command(plan);
    command.kill_on_drop(true);

    match tokio::time::timeout(INSTALL_TIMEOUT, command.output()).await {
        Ok(Ok(result)) => {
            let mut log = String::from_utf8_lossy(&result.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&result.stderr);
            if !stderr.trim().is_empty() {
                if !log.is_empty() {
                    log.push('\n');
                }
                log.push_str(&stderr);
            }
            log::info!(
                "install action completed tool={} kind={:?} success={}",
                plan.tool_key.as_str(),
                plan.kind,
                result.status.success()
            );
            InstallOutcome {
                success: result.status.success(),
                log: log.trim().to_string(),
            }
        }
        Ok(Err(error)) => {
            log::error!(
                "install action spawn failed tool={} kind={:?}",
                plan.tool_key.as_str(),
                plan.kind
            );
            InstallOutcome {
                success: false,
                log: format!("无法启动命令 `{}`：{error}", plan.program),
            }
        }
        Err(_) => {
            log::error!(
                "install action timed out tool={} kind={:?}",
                plan.tool_key.as_str(),
                plan.kind
            );
            InstallOutcome {
                success: false,
                log: "命令执行超时（超过 10 分钟），已终止。".to_string(),
            }
        }
    }
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
    fn codex_install_and_update_use_npm_latest() {
        for kind in [InstallKind::Install, InstallKind::Update] {
            if let Ok(plan) = plan(ToolKey::Codex, kind) {
                assert!(plan.args.contains(&"@openai/codex@latest".to_string()));
            }
        }
    }

    #[test]
    fn antigravity_uses_official_installer() {
        let plan = plan(ToolKey::Antigravity, InstallKind::Install).unwrap();
        assert!(plan.program.to_ascii_lowercase().contains("powershell"));
        assert!(plan.preview.contains("antigravity.google/cli/install.ps1"));
    }
}
