use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;

pub(super) fn build_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    match kind {
        InstallKind::Update => crate::services::install_service::simple_plan(
            ToolKey::Claude,
            kind,
            "claude",
            &["update"],
            "Claude Code 内置更新命令",
        ),
        InstallKind::Install => install_plan(kind),
    }
}

#[cfg(windows)]
fn install_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    crate::services::install_service::simple_plan(
        ToolKey::Claude,
        kind,
        "winget",
        &[
            "install",
            "--id",
            "Anthropic.ClaudeCode",
            "--exact",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ],
        "winget 官方包 Anthropic.ClaudeCode",
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    let platform = if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    };
    crate::services::install_service::simple_plan(
        ToolKey::Claude,
        kind,
        "/bin/bash",
        &["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
        &format!("Anthropic Claude Code 官方 {platform} 安装脚本"),
    )
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn install_plan(_kind: InstallKind) -> anyhow::Result<InstallPlan> {
    anyhow::bail!("当前平台尚未配置 CLI 安装计划")
}
