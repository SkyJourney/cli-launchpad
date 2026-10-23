use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::services::cli_adapters::AdapterContext;
#[cfg(windows)]
use std::path::PathBuf;

pub(super) fn build_plan(
    kind: InstallKind,
    context: &AdapterContext,
) -> anyhow::Result<InstallPlan> {
    match kind {
        InstallKind::Update => update_plan(context),
        InstallKind::Install => install_plan(kind),
    }
}

#[cfg(windows)]
fn update_plan(context: &AdapterContext) -> anyhow::Result<InstallPlan> {
    let path = detected_codex(context)?;
    codex_update_plan_for(&path.display().to_string())
}

fn detected_codex(context: &AdapterContext) -> anyhow::Result<&std::path::Path> {
    context.resolved_path.as_deref().ok_or_else(|| {
        anyhow::anyhow!("未检测到可运行的 Codex CLI（未找到执行安装或更新所需的程序：codex）")
    })
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
fn update_plan(context: &AdapterContext) -> anyhow::Result<InstallPlan> {
    update_plan_for(detected_codex(context)?)
}

/// 以已解析的 codex 可执行文件路径构造内置更新计划（纯函数；Windows 对应 `codex_update_plan_for`）。
#[cfg(not(windows))]
pub(crate) fn update_plan_for(resolved: &std::path::Path) -> anyhow::Result<InstallPlan> {
    Ok(crate::services::install_service::simple_plan_at(
        ToolKey::Codex,
        InstallKind::Update,
        resolved.display().to_string(),
        &["update"],
        "Codex 内置更新命令",
    ))
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

#[cfg(test)]
mod context_tests {
    use super::*;
    use crate::services::cli_adapters::AdapterContext;
    use std::path::PathBuf;

    fn context(path: Option<&str>) -> AdapterContext {
        AdapterContext {
            resolved_path: path.map(PathBuf::from),
            home: std::env::temp_dir(),
            budget: std::time::Duration::from_secs(10),
        }
    }

    #[test]
    fn update_plan_uses_the_injected_executable_path() {
        let shown = PathBuf::from("custom-bin/codex").display().to_string();
        let plan = build_plan(InstallKind::Update, &context(Some("custom-bin/codex"))).unwrap();

        assert_eq!(plan.tool_key, ToolKey::Codex);
        #[cfg(windows)]
        assert!(plan
            .args
            .last()
            .unwrap()
            .contains(&quote_powershell_arg(&shown)));
        #[cfg(not(windows))]
        {
            assert_eq!(plan.program, shown);
            assert_eq!(plan.args, vec!["update".to_string()]);
        }
    }

    #[test]
    fn update_plan_requires_a_detected_executable() {
        let error = build_plan(InstallKind::Update, &context(None)).unwrap_err();

        assert!(error.to_string().contains("未检测到可运行的 Codex CLI"));
    }
}
