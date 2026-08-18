use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::tool::ToolKey;
use crate::platform::detect;

pub async fn detect_all(probe_versions: bool) -> Vec<CliStatus> {
    let started = std::time::Instant::now();
    let mut statuses = Vec::new();
    for tool_key in ToolKey::ALL {
        statuses.push(detect_tool(tool_key, probe_versions).await);
    }
    log::info!(
        "cli detection completed elapsed_ms={}",
        started.elapsed().as_millis()
    );
    statuses
}

async fn detect_tool(tool_key: ToolKey, probe_versions: bool) -> CliStatus {
    // 1) Resolvable on the current PATH.
    for command in tool_key.command_candidates() {
        if let Some(path) = detect::which(command).await {
            log::info!("cli available tool={}", tool_key.as_str());
            return available_status(tool_key, command, path, probe_versions).await;
        }
    }

    // 2) Present in a known install directory but not on PATH. Still launchable
    //    because launches use the full path.
    for command in tool_key.command_candidates() {
        if let Some(path) = detect::find_in_known_dirs(command) {
            log::info!("cli available outside path tool={}", tool_key.as_str());
            return available_status(tool_key, command, path, probe_versions).await;
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
    tool_key: ToolKey,
    command: &str,
    path: std::path::PathBuf,
    probe_versions: bool,
) -> CliStatus {
    let (version, version_error) = if probe_versions {
        match detect::probe_version(&path).await {
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
