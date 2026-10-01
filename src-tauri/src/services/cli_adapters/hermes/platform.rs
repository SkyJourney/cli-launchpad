use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;

pub(super) fn build_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    if kind == InstallKind::Update {
        #[cfg(not(windows))]
        anyhow::bail!("Hermes Agent 托管更新将在 M5 跨平台阶段接入");
        #[cfg(windows)]
        {
            let path = crate::services::cli_adapters::installed_path(&super::ADAPTER)
                .ok_or_else(|| anyhow::anyhow!("未检测到可运行的 Hermes Agent CLI"))?;
            return Ok(InstallPlan {
                tool_key: ToolKey::Hermes,
                kind: InstallKind::Update,
                program: path.display().to_string(),
                preview: format!("{} update", quote_command_path(&path.display().to_string())),
                args: vec!["update".to_string()],
                source: "Hermes Agent 官方内置更新命令".to_string(),
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
    #[cfg(not(windows))]
    {
        anyhow::bail!("Hermes Agent 官方安装流程将在 G2.2 接入")
    }
}

fn quote_command_path(path: &str) -> String {
    if path.chars().any(char::is_whitespace) {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}
