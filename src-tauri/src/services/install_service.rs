use std::time::Duration;

use tokio::process::Command;

use crate::models::install::{InstallKind, InstallOutcome, InstallPlan};
use crate::models::tool::ToolKey;
use crate::platform::detect;

/// Installs legitimately take a while (downloads), but a process stuck on an
/// interactive prompt must not hang forever; kill_on_drop enforces the bound.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// Build the structured install/update command for a tool. Sources are the
/// official channels documented in `docs/tooling-and-installation.md`.
pub fn plan(tool_key: ToolKey, kind: InstallKind) -> InstallPlan {
    let (program, args, source) = match (tool_key, kind) {
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

    let args: Vec<String> = args.into_iter().map(str::to_string).collect();
    let preview = format!("{program} {}", args.join(" "));

    InstallPlan {
        tool_key,
        kind,
        program: program.to_string(),
        args,
        source: source.to_string(),
        preview,
    }
}

/// Build the executable command. PATH shims (npm.cmd, claude.cmd, the winget
/// alias) need `cmd /C` to resolve, but powershell.exe is a real executable and
/// must run directly so its `| iex` pipe is interpreted by PowerShell rather
/// than by cmd.
fn build_command(plan: &InstallPlan) -> Command {
    if plan.program.eq_ignore_ascii_case("powershell") {
        let mut command = Command::new(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
        command.args(&plan.args);
        command
    } else {
        let mut command = Command::new(detect::system32("cmd.exe"));
        command.arg("/C").arg(&plan.program).args(&plan.args);
        command
    }
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
            InstallOutcome {
                success: result.status.success(),
                log: log.trim().to_string(),
            }
        }
        Ok(Err(error)) => InstallOutcome {
            success: false,
            log: format!("无法启动命令 `{}`：{error}", plan.program),
        },
        Err(_) => InstallOutcome {
            success: false,
            log: "命令执行超时（超过 10 分钟），已终止。".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_install_uses_winget_official_package() {
        let plan = plan(ToolKey::Claude, InstallKind::Install);
        assert_eq!(plan.program, "winget");
        assert!(plan.args.contains(&"Anthropic.ClaudeCode".to_string()));
        assert!(plan.preview.starts_with("winget install"));
    }

    #[test]
    fn claude_update_uses_builtin_command() {
        let plan = plan(ToolKey::Claude, InstallKind::Update);
        assert_eq!(plan.program, "claude");
        assert_eq!(plan.args, vec!["update".to_string()]);
    }

    #[test]
    fn codex_install_and_update_use_npm_latest() {
        for kind in [InstallKind::Install, InstallKind::Update] {
            let plan = plan(ToolKey::Codex, kind);
            assert_eq!(plan.program, "npm");
            assert!(plan.args.contains(&"@openai/codex@latest".to_string()));
        }
    }

    #[test]
    fn antigravity_uses_official_installer() {
        let plan = plan(ToolKey::Antigravity, InstallKind::Install);
        assert_eq!(plan.program, "powershell");
        assert!(plan.preview.contains("antigravity.google/cli/install.ps1"));
    }
}
