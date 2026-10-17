use std::path::{Path, PathBuf};

use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::services::cli_adapters::AdapterContext;

/// Resolve the home and XDG data directory that own a native Claude binary.
/// The versioned binary lives under `$HOME/.local/share/claude/versions`;
/// deriving its owner avoids redirecting updates into an isolated app HOME.
pub(crate) fn native_install_context(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let resolved_path = std::fs::canonicalize(path).ok()?;
    let versions_dir = resolved_path.parent()?;
    if versions_dir.file_name()?.to_str()? != "versions" {
        return None;
    }
    let claude_dir = versions_dir.parent()?;
    if claude_dir.file_name()?.to_str()? != "claude" {
        return None;
    }
    let share_dir = claude_dir.parent()?;
    if share_dir.file_name()?.to_str()? != "share" {
        return None;
    }
    let local_dir = share_dir.parent()?;
    if local_dir.file_name()?.to_str()? != ".local" {
        return None;
    }
    let home_dir = local_dir.parent()?.to_path_buf();

    Some((home_dir, share_dir.to_path_buf()))
}

pub(super) fn build_plan(
    kind: InstallKind,
    context: &AdapterContext,
) -> anyhow::Result<InstallPlan> {
    match kind {
        InstallKind::Update => {
            let path = context.resolved_path.as_deref().ok_or_else(|| {
                anyhow::anyhow!(
                    "未检测到可运行的 Claude Code CLI（未找到执行安装或更新所需的程序：claude）"
                )
            })?;
            update_plan_for(path)
        }
        InstallKind::Install => install_plan(kind),
    }
}

/// 以已解析的 claude 可执行文件路径构造内置更新计划（纯函数）。
pub(crate) fn update_plan_for(resolved: &Path) -> anyhow::Result<InstallPlan> {
    Ok(crate::services::install_service::simple_plan_at(
        ToolKey::Claude,
        InstallKind::Update,
        resolved.display().to_string(),
        &["update"],
        "Claude Code 内置更新命令",
    ))
}

#[cfg(windows)]
fn install_plan(_kind: InstallKind) -> anyhow::Result<InstallPlan> {
    let winget = crate::services::install_service::resolve_program("winget")?;
    install_plan_for(Path::new(&winget))
}

/// 以已解析的 winget 路径构造 Claude Code 官方安装计划（纯函数）。
#[cfg(windows)]
pub(crate) fn install_plan_for(winget: &Path) -> anyhow::Result<InstallPlan> {
    Ok(crate::services::install_service::simple_plan_at(
        ToolKey::Claude,
        InstallKind::Install,
        winget.display().to_string(),
        &[
            "install",
            "--id",
            "Anthropic.ClaudeCode",
            "--exact",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ],
        "winget 官方包 Anthropic.ClaudeCode",
    ))
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolves_home_from_native_versioned_binary() {
        let root = tempdir().unwrap();
        let home = std::fs::canonicalize(root.path()).unwrap();
        let versions = home.join(".local/share/claude/versions");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let versioned_binary = versions.join("2.1.280");
        let command_link = bin.join("claude");
        std::fs::write(&versioned_binary, b"test").unwrap();
        std::os::unix::fs::symlink(&versioned_binary, &command_link).unwrap();

        let (resolved_home, data_home) = native_install_context(&command_link).unwrap();

        assert_eq!(resolved_home, home);
        assert_eq!(data_home, home.join(".local/share"));
    }

    #[test]
    fn ignores_non_native_claude_binary_layouts() {
        let root = tempdir().unwrap();
        let binary = root.path().join("node_modules/.bin/claude");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"test").unwrap();

        assert!(native_install_context(&binary).is_none());
    }
}

#[cfg(test)]
mod context_tests {
    use super::*;
    use crate::services::cli_adapters::AdapterContext;

    fn context(path: Option<&str>) -> AdapterContext {
        AdapterContext {
            resolved_path: path.map(PathBuf::from),
            home: std::env::temp_dir(),
            budget: std::time::Duration::from_secs(10),
        }
    }

    #[test]
    fn update_plan_uses_the_injected_executable_path() {
        let plan = build_plan(InstallKind::Update, &context(Some("custom-bin/claude"))).unwrap();

        assert_eq!(
            plan.program,
            PathBuf::from("custom-bin/claude").display().to_string()
        );
        assert_eq!(plan.args, vec!["update".to_string()]);
        assert_eq!(plan.tool_key, ToolKey::Claude);
        assert!(!plan.fingerprint.is_empty());
    }

    #[test]
    fn update_plan_requires_a_detected_executable() {
        let error = build_plan(InstallKind::Update, &context(None)).unwrap_err();

        assert!(error
            .to_string()
            .contains("未检测到可运行的 Claude Code CLI"));
    }
}
