use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::tool::ToolKey;
use crate::platform::detect;

pub async fn detect_all() -> Vec<CliStatus> {
    let started = std::time::Instant::now();
    let mut statuses = Vec::new();
    for tool_key in ToolKey::ALL {
        statuses.push(detect_tool(tool_key).await);
    }
    log::info!(
        "cli detection completed elapsed_ms={}",
        started.elapsed().as_millis()
    );
    statuses
}

async fn detect_tool(tool_key: ToolKey) -> CliStatus {
    // 1) Resolvable on the current PATH.
    for command in tool_key.command_candidates() {
        if let Some(path) = detect::which(command).await {
            log::info!("cli available tool={}", tool_key.as_str());
            return CliStatus {
                tool_key,
                status: CliAvailability::Available,
                path: Some(path.display().to_string()),
                resolved_command: Some((*command).to_string()),
                // Do not execute PATH-resolved third-party binaries during passive detection.
                version: None,
                latest_version: None,
            };
        }
    }

    // 2) Present in a known install directory but not on PATH. Still launchable
    //    because launches use the full path.
    for command in tool_key.command_candidates() {
        if let Some(path) = detect::find_in_known_dirs(command) {
            log::info!("cli available outside path tool={}", tool_key.as_str());
            return CliStatus {
                tool_key,
                status: CliAvailability::Available,
                path: Some(path.display().to_string()),
                resolved_command: Some((*command).to_string()),
                version: None,
                latest_version: None,
            };
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
        latest_version: None,
    }
}
