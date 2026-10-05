use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
#[cfg(windows)]
use std::path::PathBuf;

pub(super) fn build_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    match kind {
        InstallKind::Update => update_plan(kind),
        InstallKind::Install => install_plan(kind),
    }
}

#[cfg(windows)]
fn update_plan(_kind: InstallKind) -> anyhow::Result<InstallPlan> {
    let codex = crate::services::install_service::resolve_program("codex")?;
    codex_update_plan_for(&codex)
}

#[cfg(windows)]
pub(crate) fn codex_update_plan_for(codex: &str) -> anyhow::Result<InstallPlan> {
    let program = windows_powershell_51()?;
    let command = format!(
        "$env:PSModulePath = @((Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\\Modules'), (Join-Path $env:ProgramFiles 'WindowsPowerShell\\Modules'), (Join-Path $PSHOME 'Modules')) -join [IO.Path]::PathSeparator; & {} update; exit $LASTEXITCODE",
        quote_powershell_arg(codex)
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
    Ok(crate::services::install_service::resolved_plan(
        ToolKey::Codex,
        InstallKind::Update,
        program,
        args,
        "Codex 内置更新命令（Windows PowerShell 5.1，隔离模块路径）",
        preview,
    ))
}

#[cfg(windows)]
pub(crate) fn quote_powershell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(not(windows))]
fn update_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    crate::services::install_service::simple_plan(
        ToolKey::Codex,
        kind,
        "codex",
        &["update"],
        "Codex 内置更新命令",
    )
}

#[cfg(windows)]
fn install_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    let program = windows_powershell_51()?;
    let args = vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        "irm https://chatgpt.com/codex/install.ps1 | iex".to_string(),
    ];
    let preview = format!("{program} {}", args.join(" "));
    Ok(crate::services::install_service::resolved_plan(
        ToolKey::Codex,
        kind,
        program,
        args,
        "OpenAI Codex 官方 Windows PowerShell 5.1 安装器",
        preview,
    ))
}

#[cfg(windows)]
fn windows_powershell_51() -> anyhow::Result<String> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| anyhow::anyhow!("无法解析 Windows PowerShell 5.1：SystemRoot 未设置"))?;
    let executable = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !executable.is_file() {
        anyhow::bail!("未找到 Windows PowerShell 5.1：{}", executable.display());
    }
    Ok(executable.display().to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_plan(kind: InstallKind) -> anyhow::Result<InstallPlan> {
    let platform = if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    };
    crate::services::install_service::simple_plan(
        ToolKey::Codex,
        kind,
        "/bin/sh",
        &["-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
        &format!("OpenAI Codex 官方 {platform} 安装脚本"),
    )
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn install_plan(_kind: InstallKind) -> anyhow::Result<InstallPlan> {
    anyhow::bail!("当前平台尚未配置 CLI 安装计划")
}
