use std::path::Path;

use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::services::cli_adapters::AdapterContext;

pub(super) fn build_plan(
    kind: InstallKind,
    context: &AdapterContext,
) -> anyhow::Result<InstallPlan> {
    match kind {
        InstallKind::Update => {
            let path = context
                .resolved_path
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!(
                        "未检测到可运行的 Antigravity CLI（agy）（未找到执行安装或更新所需的程序：agy）"
                    ))?;
            // Updates only accept the primary command; the compatibility command `antigravity`
            // is a detection fallback, never an update target.
            let is_agy = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem.eq_ignore_ascii_case("agy"));
            if !is_agy {
                anyhow::bail!("未找到执行安装或更新所需的程序：agy");
            }
            update_plan_for(path)
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
    fn update_plan_uses_the_injected_agy_path() {
        let plan = build_plan(InstallKind::Update, &context(Some("custom-bin/agy"))).unwrap();

        assert_eq!(
            plan.program,
            PathBuf::from("custom-bin/agy").display().to_string()
        );
        assert_eq!(plan.args, vec!["update".to_string()]);
        assert_eq!(plan.tool_key, ToolKey::Antigravity);
    }

    #[test]
    fn update_plan_rejects_the_compatibility_command() {
        for path in ["custom-bin/antigravity", "custom-bin/antigravity.exe"] {
            let error = build_plan(InstallKind::Update, &context(Some(path))).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("未找到执行安装或更新所需的程序：agy"),
                "{path}"
            );
        }
    }

    #[test]
    fn update_plan_requires_a_detected_executable() {
        let error = build_plan(InstallKind::Update, &context(None)).unwrap_err();

        assert!(error
            .to_string()
            .contains("未检测到可运行的 Antigravity CLI（agy）"));
    }
}
