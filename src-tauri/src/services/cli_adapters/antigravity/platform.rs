use std::path::Path;

use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;

pub(super) fn build_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    match kind {
        InstallKind::Update => {
            let program = crate::services::install_service::resolve_program("agy")?;
            update_plan_for(Path::new(&program))
        }
        InstallKind::Install => install_plan(kind),
    }
}

/// 以已解析的 agy 可执行文件路径构造内置更新计划（纯函数）。
pub(crate) fn update_plan_for(resolved: &Path) -> anyhow::Result<InstallPlan> {
    Ok(crate::services::install_service::simple_plan_at(
        ToolKey::Antigravity,
        InstallKind::Update,
        resolved.display().to_string(),
        &["update"],
        "Antigravity CLI 内置更新命令",
    ))
}

#[cfg(windows)]
fn install_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    crate::services::install_service::simple_plan(
        ToolKey::Antigravity,
        kind,
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "irm https://antigravity.google/cli/install.ps1 | iex",
        ],
        "Antigravity 官方 PowerShell 安装脚本",
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
        ToolKey::Antigravity,
        kind,
        "/bin/bash",
        &[
            "-c",
            "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        ],
        &format!("Google Antigravity 官方 {platform} 安装脚本"),
    )
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn install_plan(_kind: InstallKind) -> anyhow::Result<InstallPlan> {
    anyhow::bail!("当前平台尚未配置 CLI 安装计划")
}
