use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;

pub(super) fn build_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    if kind == InstallKind::Update {
        let path = crate::services::cli_adapters::installed_path(&super::ADAPTER)
            .ok_or_else(|| anyhow::anyhow!("未检测到可运行的 Grok Build CLI"))?;
        return Ok(grok_update_plan_for(&path.display().to_string()));
    }

    #[cfg(windows)]
    {
        let program = crate::services::install_service::resolve_program("powershell")?;
        let args = vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-Command".to_string(),
            "$env:GROK_CHANNEL='stable'; irm https://x.ai/cli/install.ps1 | iex".to_string(),
        ];
        let preview = grok_install_preview(&program);
        Ok(crate::services::install_service::resolved_plan(
            ToolKey::Grok,
            kind,
            program,
            args,
            "xAI Grok Build 官方 Windows PowerShell 安装脚本（固定 stable 通道）",
            preview,
        ))
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let program = crate::services::install_service::resolve_program("/bin/bash")?;
        let args = vec![
            "-c".to_string(),
            "export GROK_CHANNEL=stable; curl -fsSL https://x.ai/cli/install.sh | bash".to_string(),
        ];
        let preview = grok_install_preview(&program);
        let os = if cfg!(target_os = "macos") {
            "macOS"
        } else {
            "Linux"
        };
        Ok(crate::services::install_service::resolved_plan(
            ToolKey::Grok,
            kind,
            program,
            args,
            &format!("xAI Grok Build 官方 {os} 安装脚本"),
            preview,
        ))
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        anyhow::bail!("当前平台尚未配置 CLI 安装计划")
    }
}

pub(crate) fn grok_update_plan_for(path: &str) -> InstallPlan {
    InstallPlan {
        tool_key: ToolKey::Grok,
        kind: InstallKind::Update,
        program: path.to_string(),
        args: vec!["update".to_string()],
        fingerprint: String::new(),
        source: "Grok Build 官方原生更新器（任务启动后校验 CLI 来源）".to_string(),
        preview: format!("{} update", quote_command_path(path)),
        effects: None,
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

fn quote_command_path(path: &str) -> String {
    if path.chars().any(char::is_whitespace) {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}
