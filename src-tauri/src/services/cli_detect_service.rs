use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::tool::ToolKey;
use crate::platform::detect;

pub async fn detect_all() -> Vec<CliStatus> {
    let mut statuses = Vec::new();
    for tool_key in [ToolKey::Claude, ToolKey::Codex, ToolKey::Antigravity] {
        statuses.push(detect_tool(tool_key).await);
    }
    statuses
}

async fn detect_tool(tool_key: ToolKey) -> CliStatus {
    // 1) Resolvable on the current PATH.
    for command in tool_key.command_candidates() {
        if let Some(path) = detect::which(command).await {
            return CliStatus {
                tool_key,
                status: CliAvailability::Available,
                path: Some(path.display().to_string()),
                resolved_command: Some((*command).to_string()),
                version: detect::run_version(command).await,
                latest_version: None,
            };
        }
    }

    // 2) Present in a known install directory but not on PATH. Still launchable
    //    because launches use the full path.
    for command in tool_key.command_candidates() {
        if let Some(path) = detect::find_in_known_dirs(command) {
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
    CliStatus {
        tool_key,
        status: CliAvailability::Missing,
        path: None,
        resolved_command: None,
        version: None,
        latest_version: None,
    }
}
