use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::tool::ToolKey;
use crate::platform::launch_environment::LaunchEnvironment;
use crate::services::cli_adapters::{self, CliAdapter};

pub async fn detect_all(probe_versions: bool) -> Vec<CliStatus> {
    let started = std::time::Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    let mut task_tools = std::collections::HashMap::new();
    let environment = LaunchEnvironment::capture();
    for tool_key in ToolKey::ALL {
        let adapter = cli_adapters::get(tool_key);
        let environment = environment.clone();
        let task = tasks
            .spawn(async move { detect_tool_with(adapter, probe_versions, &environment).await });
        task_tools.insert(task.id(), tool_key);
    }
    let mut statuses = Vec::with_capacity(ToolKey::ALL.len());
    while let Some(result) = tasks.join_next_with_id().await {
        match result {
            Ok((id, status)) => {
                task_tools.remove(&id);
                statuses.push(status);
            }
            Err(error) => {
                if let Some(tool_key) = task_tools.remove(&error.id()) {
                    log::warn!(
                        "cli detection adapter isolated tool={} error={error}",
                        tool_key.as_str()
                    );
                    statuses.push(CliStatus {
                        tool_key,
                        status: CliAvailability::Unknown,
                        path: None,
                        resolved_command: None,
                        version: None,
                        version_error: Some("CLI 检测适配器异常；其他 CLI 检测不受影响".into()),
                        latest_version: None,
                    });
                }
            }
        }
    }
    statuses.sort_by_key(|status| {
        ToolKey::ALL
            .iter()
            .position(|tool_key| *tool_key == status.tool_key)
            .unwrap_or(usize::MAX)
    });
    log::info!(
        "cli detection completed elapsed_ms={}",
        started.elapsed().as_millis()
    );
    statuses
}

pub async fn detect_one(tool_key: ToolKey, probe_versions: bool) -> CliStatus {
    detect_tool(cli_adapters::get(tool_key), probe_versions).await
}

async fn detect_tool(adapter: &'static dyn CliAdapter, probe_versions: bool) -> CliStatus {
    detect_tool_with(adapter, probe_versions, &LaunchEnvironment::capture()).await
}

async fn detect_tool_with(
    adapter: &'static dyn CliAdapter,
    probe_versions: bool,
    environment: &LaunchEnvironment,
) -> CliStatus {
    let tool_key = adapter.tool_key();
    let additional_install_dirs = adapter.additional_install_dirs();
    // PATH first, then the known per-user install directories (still launchable by full path).
    let resolved = crate::platform::executable_resolver::resolve(
        adapter.command_candidates(),
        &additional_install_dirs,
        environment,
        crate::budgets::EXECUTABLE_PROBE,
    )
    .await;
    if let Some(found) = resolved {
        log::info!("cli available tool={}", tool_key.as_str());
        return available_status(adapter, &found.command, found.path, probe_versions).await;
    }

    // Not found.
    log::info!("cli missing tool={}", tool_key.as_str());
    CliStatus {
        tool_key,
        status: CliAvailability::Missing,
        path: None,
        resolved_command: None,
        version: None,
        version_error: None,
        latest_version: None,
    }
}

async fn available_status(
    adapter: &'static dyn CliAdapter,
    command: &str,
    path: std::path::PathBuf,
    probe_versions: bool,
) -> CliStatus {
    let tool_key = adapter.tool_key();
    let (version, version_error) = if probe_versions {
        match cli_adapters::probe_version_bounded(
            adapter,
            path.clone(),
            cli_adapters::VERSION_PROBE_BUDGET,
        )
        .await
        {
            Ok(version) => (Some(version), None),
            Err(error) => {
                log::warn!("cli version probe failed tool={}", tool_key.as_str());
                (None, Some(error))
            }
        }
    } else {
        // Passive detection must not execute a PATH-resolved candidate.
        (None, None)
    };

    CliStatus {
        tool_key,
        status: CliAvailability::Available,
        path: Some(path.display().to_string()),
        resolved_command: Some(command.to_string()),
        version,
        version_error,
        latest_version: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::cli_adapters::{
        ManagedUpdatePolicy, ProviderCapabilities, ProviderDescriptor, UpdateSemantics,
        PROVIDER_DESCRIPTOR_API_VERSION,
    };

    struct FakeAdapter;
    static FAKE: FakeAdapter = FakeAdapter;

    impl CliAdapter for FakeAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> ProviderDescriptor {
            ProviderDescriptor {
                tool_key: ToolKey::Claude,
                api_version: PROVIDER_DESCRIPTOR_API_VERSION,
                capabilities: ProviderCapabilities {
                    history: true,
                    resume: true,
                    update_semantics: UpdateSemantics::Version,
                    managed_update: ManagedUpdatePolicy::Always,
                    install_effects_key: None,
                },
            }
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["m6069-detect-cli"]
        }

        fn resume_args(&self, _session_id: &str) -> anyhow::Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn detection_resolves_commands_on_the_launch_environment_path() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let file = directory.path().join("m6069-detect-cli.cmd");
        #[cfg(not(windows))]
        let file = directory.path().join("m6069-detect-cli");
        std::fs::write(&file, b"@echo off\r\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let environment =
            LaunchEnvironment::from_path(Some(std::env::join_paths([directory.path()]).unwrap()));

        let found = detect_tool_with(&FAKE, false, &environment).await;
        assert_eq!(found.status, CliAvailability::Available);
        assert_eq!(
            std::path::PathBuf::from(found.path.expect("path")).file_name(),
            file.file_name()
        );
        assert_eq!(found.resolved_command.as_deref(), Some("m6069-detect-cli"));

        // 反向断言：空的启动环境看不到该命令，检测结果为缺失。
        let missing = detect_tool_with(&FAKE, false, &LaunchEnvironment::from_path(None)).await;
        assert_eq!(missing.status, CliAvailability::Missing);
        assert!(missing.path.is_none());
    }
}
