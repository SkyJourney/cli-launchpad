use std::path::{Path, PathBuf};

use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::services::cli_adapters::AdapterContext;

pub(super) fn install_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return vec![PathBuf::from(local_app_data).join("hermes").join("bin")];
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if let Some(home) = std::env::var_os("HOME") {
        return vec![PathBuf::from(home).join(".local").join("bin")];
    }
    Vec::new()
}

pub(super) fn validate_managed_update_install(path: &Path, home: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = home;
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "无法确认 Windows 用户级 Hermes 安装目录".to_string())?;
        let expected_bin = local_app_data.join("hermes").join("bin");
        let checkout_root = local_app_data.join("hermes").join("hermes-agent");
        if !is_hermes_default_install_path(path, &expected_bin, &checkout_root) {
            return Err(
                "仅对 Hermes 官方默认 Windows 源码安装启用 Launchpad 托管更新；其他安装请使用原渠道。"
                    .to_string(),
            );
        }
        Ok(())
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let expected_bin = home.join(".local").join("bin");
        let checkout_root = home.join(".hermes").join("hermes-agent");
        if !is_hermes_posix_source_install(path, &expected_bin, &checkout_root) {
            return Err(
                "仅对 Hermes 官方默认 macOS/Linux 源码安装启用 Launchpad 托管更新；其他安装请使用原渠道。"
                    .to_string(),
            );
        }
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (path, home);
        Err("当前平台不支持 Hermes Agent 托管安装和更新".to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn is_hermes_posix_source_install(path: &Path, expected_bin: &Path, checkout_root: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("hermes")
        && path
            .parent()
            .is_some_and(|parent| same_path(parent, expected_bin))
        && checkout_root.join(".git").exists()
}

#[cfg(windows)]
fn is_hermes_default_install_path(path: &Path, expected_bin: &Path, checkout_root: &Path) -> bool {
    let executable_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let supported_name = ["hermes.exe", "hermes.cmd", "hermes.bat"]
        .iter()
        .any(|name| executable_name.eq_ignore_ascii_case(name));
    supported_name
        && path
            .parent()
            .is_some_and(|parent| same_path(parent, expected_bin))
        && checkout_root.join(".git").exists()
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn same_path(left: &Path, right: &Path) -> bool {
    fn normalized(path: &Path) -> String {
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        #[cfg(windows)]
        {
            resolved
                .to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        }
        #[cfg(not(windows))]
        {
            resolved.to_string_lossy().trim_end_matches('/').to_string()
        }
    }
    normalized(left) == normalized(right)
}

pub(super) fn build_plan(
    kind: InstallKind,
    context: &AdapterContext,
) -> anyhow::Result<InstallPlan> {
    if kind == InstallKind::Update {
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            let path = context
                .resolved_path
                .as_deref()
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
        let context = AdapterContext {
            resolved_path: None,
            home: std::env::temp_dir(),
            budget: std::time::Duration::from_secs(10),
        };
        let plan = build_plan(InstallKind::Install, &context).unwrap();

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

#[cfg(all(test, any(windows, target_os = "macos", target_os = "linux")))]
mod context_tests {
    use super::*;

    #[test]
    fn update_plan_uses_the_injected_executable_path() {
        let path = std::path::PathBuf::from("custom-bin/hermes");
        let context = AdapterContext {
            resolved_path: Some(path.clone()),
            home: std::env::temp_dir(),
            budget: std::time::Duration::from_secs(10),
        };

        let plan = build_plan(InstallKind::Update, &context).unwrap();

        assert_eq!(plan.program, path.display().to_string());
        assert_eq!(plan.args, vec!["update".to_string()]);
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod posix_managed_install_tests {
    use super::*;

    #[test]
    fn managed_source_install_requires_default_launcher_and_checkout() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join(".local").join("bin");
        let checkout = root.path().join(".hermes").join("hermes-agent");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        let launcher = bin.join("hermes");
        std::fs::write(&launcher, "#!/bin/sh\n").unwrap();

        assert!(is_hermes_posix_source_install(&launcher, &bin, &checkout));
        assert!(!is_hermes_posix_source_install(
            &root.path().join("homebrew/bin/hermes"),
            &bin,
            &checkout
        ));

        std::fs::remove_dir_all(checkout.join(".git")).unwrap();
        assert!(!is_hermes_posix_source_install(&launcher, &bin, &checkout));
    }
}

#[cfg(all(test, windows))]
mod windows_managed_install_tests {
    use super::*;

    #[test]
    fn managed_source_update_requires_default_bin_and_git_checkout() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("hermes").join("bin");
        let checkout = root.path().join("hermes").join("hermes-agent");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        let exe = bin.join("hermes.exe");
        std::fs::write(&exe, []).unwrap();

        assert!(is_hermes_default_install_path(&exe, &bin, &checkout));
        assert!(!is_hermes_default_install_path(
            &root.path().join("npm").join("hermes.exe"),
            &bin,
            &checkout
        ));
        assert!(!is_hermes_default_install_path(
            &bin.join("hermes.cmd"),
            &bin,
            &root.path().join("other-checkout")
        ));
    }
}
