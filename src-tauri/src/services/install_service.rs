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
    if tool_key == ToolKey::Grok && kind == InstallKind::Update {
        return grok_update_plan();
    }

    #[cfg(windows)]
    if tool_key == ToolKey::Codex && kind == InstallKind::Update {
        return codex_windows_update_plan();
    }

    let (program_name, args, source) = match kind {
        InstallKind::Install => install_spec(tool_key)?,
        InstallKind::Update => match tool_key {
            ToolKey::Claude => ("claude", vec!["update"], "Claude Code 内置更新命令"),
            ToolKey::Codex => ("codex", vec!["update"], "Codex 内置更新命令"),
            ToolKey::Antigravity => ("agy", vec!["update"], "Antigravity CLI 内置更新命令"),
            ToolKey::Grok => return Err(anyhow!("Grok Build 更新来源未经验证，不能创建更新计划")),
        },
    };

    let program = resolve_program(program_name)?;
    let args: Vec<String> = args.into_iter().map(str::to_string).collect();
    let preview = if tool_key == ToolKey::Grok && kind == InstallKind::Install {
        grok_install_preview(&program)
    } else {
        format!("{program} {}", args.join(" "))
    };

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
fn codex_windows_update_plan() -> Result<InstallPlan> {
    let codex = resolve_program("codex")?;
    let program = resolve_program("powershell")?;
    let command = format!(
        "& {} update; exit $LASTEXITCODE",
        quote_powershell_arg(&codex)
    );
    let args = vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        command,
    ];
    let preview = format!("{program} {}", args.join(" "));

    Ok(InstallPlan {
        tool_key: ToolKey::Codex,
        kind: InstallKind::Update,
        program,
        args,
        source: "Codex 内置更新命令（Windows PowerShell 5.1）".to_string(),
        preview,
    })
}

#[cfg(windows)]
fn quote_powershell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
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
        ToolKey::Grok => (
            "powershell",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$env:GROK_CHANNEL='stable'; irm https://x.ai/cli/install.ps1 | iex",
            ],
            "xAI Grok Build 官方 Windows PowerShell 安装脚本（固定 stable 通道）",
        ),
    })
}

fn grok_update_plan() -> Result<InstallPlan> {
    let path = detect::resolve_executable_path(&ToolKey::Grok.command_candidates())
        .ok_or_else(|| anyhow!("未检测到可运行的 Grok Build CLI"))?;
    let check =
        crate::services::version_service::inspect_grok_update_check(std::path::Path::new(&path))
            .map_err(anyhow::Error::msg)?;
    crate::services::version_service::validate_grok_native_update_source(
        std::path::Path::new(&path),
        check.installer.as_deref(),
    )
    .map_err(anyhow::Error::msg)?;
    Ok(grok_update_plan_for(&path))
}

fn grok_update_plan_for(path: &str) -> InstallPlan {
    InstallPlan {
        tool_key: ToolKey::Grok,
        kind: InstallKind::Update,
        program: path.to_string(),
        args: vec!["update".to_string()],
        source: "Grok Build 官方原生安装器（CLI 来源标记与安装路径均已核验）".to_string(),
        preview: format!("{} update", quote_command_path(path)),
    }
}

fn quote_command_path(path: &str) -> String {
    if path.chars().any(char::is_whitespace) {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

fn grok_install_preview(program: &str) -> String {
    #[cfg(windows)]
    {
        format!(
            "{} -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$env:GROK_CHANNEL='stable'; irm https://x.ai/cli/install.ps1 | iex\"",
            quote_command_path(program)
        )
    }
    #[cfg(not(windows))]
    {
        format!(
            "{} -c \"export GROK_CHANNEL=stable; curl -fsSL https://x.ai/cli/install.sh | bash\"",
            quote_command_path(program)
        )
    }
}

/// Official install scripts detect the OS themselves (`uname -s` for
/// darwin/linux), so macOS and Linux share the exact same URLs and
/// interpreters; only the human-readable source label differs.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_install_command(tool_key: ToolKey) -> Result<(&'static str, Vec<&'static str>)> {
    Ok(match tool_key {
        ToolKey::Claude => (
            "/bin/bash",
            vec!["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
        ),
        ToolKey::Codex => (
            "/bin/sh",
            vec!["-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
        ),
        ToolKey::Antigravity => (
            "/bin/bash",
            vec![
                "-c",
                "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            ],
        ),
        ToolKey::Grok => (
            "/bin/bash",
            vec![
                "-c",
                "export GROK_CHANNEL=stable; curl -fsSL https://x.ai/cli/install.sh | bash",
            ],
        ),
    })
}

#[cfg(target_os = "macos")]
fn install_spec(tool_key: ToolKey) -> Result<(&'static str, Vec<&'static str>, &'static str)> {
    let (program, args) = unix_install_command(tool_key)?;
    let source = match tool_key {
        ToolKey::Claude => "Anthropic Claude Code 官方 macOS 安装脚本",
        ToolKey::Codex => "OpenAI Codex 官方 macOS 安装脚本",
        ToolKey::Antigravity => "Google Antigravity 官方 macOS 安装脚本",
        ToolKey::Grok => "xAI Grok Build 官方 macOS 安装脚本",
    };
    Ok((program, args, source))
}

#[cfg(target_os = "linux")]
fn install_spec(tool_key: ToolKey) -> Result<(&'static str, Vec<&'static str>, &'static str)> {
    let (program, args) = unix_install_command(tool_key)?;
    let source = match tool_key {
        ToolKey::Claude => "Anthropic Claude Code 官方 Linux 安装脚本",
        ToolKey::Codex => "OpenAI Codex 官方 Linux 安装脚本",
        ToolKey::Antigravity => "Google Antigravity 官方 Linux 安装脚本",
        ToolKey::Grok => "xAI Grok Build 官方 Linux 安装脚本",
    };
    Ok((program, args, source))
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
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

    #[cfg(not(windows))]
    #[test]
    fn codex_update_uses_builtin_command() {
        if let Ok(plan) = plan(ToolKey::Codex, InstallKind::Update) {
            assert_eq!(plan.args, vec!["update".to_string()]);
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_update_uses_builtin_command_under_windows_powershell_5_1() {
        let plan = plan(ToolKey::Codex, InstallKind::Update).unwrap();
        assert!(plan
            .program
            .to_ascii_lowercase()
            .ends_with("system32\\windowspowershell\\v1.0\\powershell.exe"));
        assert_eq!(plan.args[0], "-NoProfile");
        assert_eq!(plan.args[4], "-Command");
        assert!(plan.args[5].contains(" update; exit $LASTEXITCODE"));
        assert!(plan.source.contains("Windows PowerShell 5.1"));
        assert!(plan.preview.contains("codex"));
        assert!(plan.preview.contains("update"));
    }

    #[cfg(windows)]
    #[test]
    fn powershell_argument_escapes_single_quotes() {
        assert_eq!(
            quote_powershell_arg("C:\\Tools\\O'Brien\\codex.exe"),
            "'C:\\Tools\\O''Brien\\codex.exe'"
        );
    }

    #[cfg(windows)]
    #[test]
    fn antigravity_uses_official_installer() {
        let plan = plan(ToolKey::Antigravity, InstallKind::Install).unwrap();
        assert!(plan.program.to_ascii_lowercase().contains("powershell"));
        assert!(plan.preview.contains("antigravity.google/cli/install.ps1"));
    }

    #[cfg(windows)]
    #[test]
    fn grok_install_uses_fixed_official_windows_script_and_preview() {
        let plan = plan(ToolKey::Grok, InstallKind::Install).unwrap();
        assert_eq!(plan.tool_key, ToolKey::Grok);
        assert_eq!(plan.kind, InstallKind::Install);
        assert!(plan.args.ends_with(&[
            "$env:GROK_CHANNEL='stable'; irm https://x.ai/cli/install.ps1 | iex".to_string()
        ]));
        assert!(plan.source.contains("xAI Grok Build 官方"));
        assert!(plan.preview.contains(
            "-Command \"$env:GROK_CHANNEL='stable'; irm https://x.ai/cli/install.ps1 | iex\""
        ));
        assert!(plan.source.contains("固定 stable 通道"));
    }

    #[test]
    fn grok_update_plan_uses_the_verified_binary_without_a_shell() {
        let plan = grok_update_plan_for(r"C:\Users\test user\.grok\bin\grok.exe");
        assert_eq!(plan.program, r"C:\Users\test user\.grok\bin\grok.exe");
        assert_eq!(plan.args, vec!["update"]);
        assert_eq!(
            plan.preview,
            r#""C:\Users\test user\.grok\bin\grok.exe" update"#
        );
        assert!(plan.source.contains("来源标记与安装路径均已核验"));
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

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_installs_use_fixed_official_scripts() {
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
            assert!(plan.source.contains("官方 Linux 安装脚本"));
        }
    }

    #[test]
    fn antigravity_update_uses_builtin_command() {
        if let Ok(plan) = plan(ToolKey::Antigravity, InstallKind::Update) {
            assert_eq!(plan.args, vec!["update".to_string()]);
        }
    }
}
