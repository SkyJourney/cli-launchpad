use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::tool::ToolKey;
use crate::platform::detect;
use crate::services::cli_adapters::{self, CliAdapter};

pub async fn detect_all(probe_versions: bool) -> Vec<CliStatus> {
    let started = std::time::Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    let mut task_tools = std::collections::HashMap::new();
    for tool_key in ToolKey::ALL {
        let adapter = cli_adapters::get(tool_key);
        let task = tasks.spawn(async move { detect_tool(adapter, probe_versions).await });
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

async fn detect_tool(adapter: &'static dyn CliAdapter, probe_versions: bool) -> CliStatus {
    let tool_key = adapter.tool_key();
    let additional_install_dirs = adapter.additional_install_dirs();
    // 1) Resolvable on the current PATH.
    for command in adapter.command_candidates() {
        if let Some(path) = detect::which(command).await {
            log::info!("cli available tool={}", tool_key.as_str());
            return available_status(adapter, command, path, probe_versions).await;
        }
    }

    // 2) Present in a known install directory but not on PATH. Still launchable
    //    because launches use the full path.
    for command in adapter.command_candidates() {
        if let Some(path) = detect::find_in_known_dirs_with(command, &additional_install_dirs) {
            log::info!("cli available outside path tool={}", tool_key.as_str());
            return available_status(adapter, command, path, probe_versions).await;
        }
    }

    // 3) Not found.
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
        match adapter.probe_current_version(&path).await {
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
