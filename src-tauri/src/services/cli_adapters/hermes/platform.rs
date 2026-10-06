use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;

pub(super) fn build_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    if kind == InstallKind::Update {
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            let path = crate::services::cli_adapters::installed_path(&super::ADAPTER)
                .ok_or_else(|| anyhow::anyhow!("未检测到可运行的 Hermes Agent CLI"))?;
            return Ok(InstallPlan {
                tool_key: ToolKey::Hermes,
                kind: InstallKind::Update,
                program: path.display().to_string(),
                preview: format!("{} update", quote_command_path(&path.display().to_string())),
                args: vec!["update".to_string()],
                fingerprint: String::new(),
                source: "Hermes Agent 官方源码安装内置更新命令（任务启动前校验安装来源）"
                    .to_string(),
                effects: None,
            });
        }
    }

    #[cfg(windows)]
    {
        crate::services::install_service::simple_plan(
            ToolKey::Hermes,
            kind,
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "& ([scriptblock]::Create((irm https://hermes-agent.nousresearch.com/install.ps1))) -NonInteractive -Branch main -SkipBrowser -SkipComputerUse",
            ],
            "Hermes Agent 官方 Windows PowerShell 源码安装器",
        )
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let args = vec![
            "-c",
            "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --skip-browser --skip-computer-use",
        ];
        crate::services::install_service::simple_plan(
            ToolKey::Hermes,
            kind,
            "/bin/bash",
            &args,
            "Hermes Agent 官方 macOS/Linux POSIX 源码安装脚本（非交互，跳过工作台不提供的可选工具）",
        )
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        anyhow::bail!("当前平台不支持 Hermes Agent 官方安装流程")
    }
}

fn quote_command_path(path: &str) -> String {
    if path.chars().any(char::is_whitespace) {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    fn posix_install_uses_official_non_interactive_source_installer() {
        let plan = build_plan(InstallKind::Install).unwrap();

        assert_eq!(plan.tool_key, ToolKey::Hermes);
        assert_eq!(plan.kind, InstallKind::Install);
        assert_eq!(plan.program, "/bin/bash");
        assert_eq!(plan.args.len(), 2);
        assert_eq!(plan.args[0], "-c");
        assert!(plan.args[1].contains("https://hermes-agent.nousresearch.com/install.sh"));
        assert!(plan.args[1].contains("--non-interactive"));
        assert!(plan.args[1].contains("--skip-browser"));
        assert!(plan.args[1].contains("--skip-computer-use"));
        assert!(plan.source.contains("官方 macOS/Linux POSIX 源码安装脚本"));
    }
}
