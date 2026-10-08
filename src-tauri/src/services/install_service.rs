use anyhow::{anyhow, Result};
use tokio::process::Command;

use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::platform::detect;

/// Build the structured install/update command for a tool. Sources are the
/// official channels documented in `docs/tooling-and-installation.md`.
pub fn plan(tool_key: ToolKey, kind: InstallKind) -> Result<InstallPlan> {
    crate::services::cli_adapters::build_plan(tool_key, kind)
}

pub(crate) fn simple_plan(
    tool_key: ToolKey,
    kind: InstallKind,
    program_name: &str,
    args: &[&str],
    source: &str,
) -> Result<InstallPlan> {
    let program = resolve_program(program_name)?;
    Ok(simple_plan_at(tool_key, kind, program, args, source))
}

/// 以已解析的可执行文件路径构造计划：纯函数，不探测机器环境。
pub(crate) fn simple_plan_at(
    tool_key: ToolKey,
    kind: InstallKind,
    program: String,
    args: &[&str],
    source: &str,
) -> InstallPlan {
    let args = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    let preview = format!("{program} {}", args.join(" "));
    resolved_plan(tool_key, kind, program, args, source, preview)
}

pub(crate) fn resolved_plan(
    tool_key: ToolKey,
    kind: InstallKind,
    program: String,
    args: Vec<String>,
    source: &str,
    preview: String,
) -> InstallPlan {
    let mut plan = InstallPlan {
        tool_key,
        kind,
        program,
        args,
        fingerprint: String::new(),
        source: source.to_string(),
        preview,
        effects: None,
    };
    plan.refresh_fingerprint();
    plan
}

pub fn verify_expected_fingerprint(plan: &InstallPlan, expected_fingerprint: &str) -> Result<()> {
    if plan.calculated_fingerprint() != expected_fingerprint {
        anyhow::bail!("plan_changed");
    }
    Ok(())
}

pub(crate) fn resolve_program(program: &str) -> Result<String> {
    #[cfg(windows)]
    if program.eq_ignore_ascii_case("powershell") {
        return Ok(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    }
    detect::resolve_executable_path(&[program])
        .ok_or_else(|| anyhow!("未找到执行安装或更新所需的程序：{program}"))
}

/// Execute only the executable path embedded in the confirmed plan.
pub(crate) fn build_command(plan: &InstallPlan) -> Command {
    crate::platform::process::cli_command(std::path::Path::new(&plan.program), &plan.args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn changed_install_plan_is_rejected_before_execution() {
        let mut plan = super::resolved_plan(
            ToolKey::Codex,
            InstallKind::Update,
            "codex".to_string(),
            vec!["update".to_string()],
            "test",
            "codex update".to_string(),
        );
        let expected = plan.fingerprint.clone();
        plan.program = "C:/changed/codex.exe".to_string();

        let error = verify_expected_fingerprint(&plan, &expected).unwrap_err();
        assert_eq!(error.to_string(), "plan_changed");
    }

    #[cfg(windows)]
    #[test]
    fn claude_install_uses_winget_official_package() {
        // 走真实的 plan()（含可执行文件解析）：winget 存在时断言计划，不存在时断言精确的缺失错误。
        match plan(ToolKey::Claude, InstallKind::Install) {
            Ok(plan) => {
                assert!(plan.args.contains(&"Anthropic.ClaudeCode".to_string()));
                assert!(plan.preview.contains("install"));
            }
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("未找到执行安装或更新所需的程序：winget"),
                "{error}"
            ),
        }
    }

    #[test]
    fn claude_update_uses_builtin_command() {
        match plan(ToolKey::Claude, InstallKind::Update) {
            Ok(plan) => assert_eq!(plan.args, vec!["update".to_string()]),
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("未找到执行安装或更新所需的程序：claude"),
                "{error}"
            ),
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
        match plan(ToolKey::Codex, InstallKind::Update) {
            Ok(plan) => assert_eq!(plan.args, vec!["update".to_string()]),
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("未找到执行安装或更新所需的程序：codex"),
                "{error}"
            ),
        }
    }

    #[cfg(windows)]
    #[test]
    fn codex_update_uses_builtin_command_under_windows_powershell_5_1() {
        let plan = crate::services::cli_adapters::codex::platform::codex_update_plan_for(
            r"C:\Program Files\Codex\codex.exe",
        )
        .unwrap();
        assert!(plan
            .program
            .to_ascii_lowercase()
            .ends_with("system32\\windowspowershell\\v1.0\\powershell.exe"));
        assert_eq!(plan.args[0], "-NoProfile");
        assert_eq!(plan.args[4], "-Command");
        assert!(plan.args[5].starts_with("$env:PSModulePath = @("));
        assert!(plan.args[5].contains("GetFolderPath('MyDocuments')"));
        assert!(plan.args[5].contains("'WindowsPowerShell\\Modules'"));
        assert!(plan.args[5].contains("(Join-Path $PSHOME 'Modules')"));
        assert!(plan.args[5].contains(" update; exit $LASTEXITCODE"));
        assert!(!plan.args[5]
            .to_ascii_lowercase()
            .contains("\\powershell\\7\\"));
        assert!(plan.source.contains("Windows PowerShell 5.1"));
        assert!(plan.source.contains("隔离模块路径"));
        assert!(plan.preview.contains("codex"));
        assert!(plan.preview.contains("update"));
    }

    #[cfg(windows)]
    #[test]
    fn powershell_argument_escapes_single_quotes() {
        assert_eq!(
            crate::services::cli_adapters::codex::platform::quote_powershell_arg(
                "C:\\Tools\\O'Brien\\codex.exe"
            ),
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
    fn grok_update_plan_uses_the_detected_binary_without_a_shell() {
        let plan = crate::services::cli_adapters::grok::platform::grok_update_plan_for(
            r"C:\Users\test user\.grok\bin\grok.exe",
        );
        assert_eq!(plan.program, r"C:\Users\test user\.grok\bin\grok.exe");
        assert_eq!(plan.args, vec!["update"]);
        assert_eq!(
            plan.preview,
            r#""C:\Users\test user\.grok\bin\grok.exe" update"#
        );
        assert!(plan.source.contains("任务启动后校验 CLI 来源"));
    }

    #[test]
    fn grok_update_command_removes_pnpm_installer_hint() {
        let plan = crate::services::cli_adapters::grok::platform::grok_update_plan_for(
            r"C:\Users\test user\.grok\bin\grok.exe",
        );
        let command = crate::services::cli_adapters::get(ToolKey::Grok).prepare_command(&plan);

        assert!(command.as_std().get_envs().any(|(key, value)| {
            key == std::ffi::OsStr::new("npm_config_user_agent") && value.is_none()
        }));
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
        match plan(ToolKey::Antigravity, InstallKind::Update) {
            Ok(plan) => assert_eq!(plan.args, vec!["update".to_string()]),
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("未找到执行安装或更新所需的程序：agy"),
                "{error}"
            ),
        }
    }

    fn fixed_tool_path(name: &str) -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(format!(r"C:\tools\{name}.exe"))
        }
        #[cfg(not(windows))]
        {
            PathBuf::from(format!("/opt/{name}/bin/{name}"))
        }
    }

    fn assert_builtin_update_plan(plan: &InstallPlan, tool_key: ToolKey, path: &std::path::Path) {
        assert_eq!(plan.tool_key, tool_key);
        assert_eq!(plan.kind, InstallKind::Update);
        assert_eq!(plan.args, vec!["update".to_string()]);
        assert_eq!(plan.program, path.display().to_string());
        assert!(!plan.preview.is_empty());
        assert!(!plan.fingerprint.is_empty());
        assert_eq!(plan.fingerprint, plan.calculated_fingerprint());
    }

    #[test]
    fn claude_update_plan_for_uses_builtin_command() {
        let path = fixed_tool_path("claude");
        let plan = crate::services::cli_adapters::claude::platform::update_plan_for(&path).unwrap();
        assert_builtin_update_plan(&plan, ToolKey::Claude, &path);
    }

    #[test]
    fn antigravity_update_plan_for_uses_builtin_command() {
        let path = fixed_tool_path("agy");
        let plan =
            crate::services::cli_adapters::antigravity::platform::update_plan_for(&path).unwrap();
        assert_builtin_update_plan(&plan, ToolKey::Antigravity, &path);
    }

    #[cfg(not(windows))]
    #[test]
    fn codex_unix_update_plan_for_uses_builtin_command() {
        let path = fixed_tool_path("codex");
        let plan = crate::services::cli_adapters::codex::platform::update_plan_for(&path).unwrap();
        assert_builtin_update_plan(&plan, ToolKey::Codex, &path);
    }

    #[cfg(windows)]
    #[test]
    fn claude_install_plan_for_uses_winget_official_package() {
        let path = fixed_tool_path("winget");
        let plan =
            crate::services::cli_adapters::claude::platform::install_plan_for(&path).unwrap();
        assert_eq!(plan.tool_key, ToolKey::Claude);
        assert_eq!(plan.kind, InstallKind::Install);
        assert_eq!(plan.program, path.display().to_string());
        assert!(plan.args.contains(&"Anthropic.ClaudeCode".to_string()));
        assert!(plan.args.contains(&"--exact".to_string()));
        assert!(plan.preview.contains("install"));
        assert!(!plan.fingerprint.is_empty());
    }
}
