use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::tool::ToolKey;
use crate::platform::detect;

/// Candidate commands per tool. `agy` is the official Antigravity command;
/// `antigravity` is only a conservative compatibility probe.
fn candidates(tool_key: ToolKey) -> &'static [&'static str] {
    match tool_key {
        ToolKey::Claude => &["claude"],
        ToolKey::Codex => &["codex"],
        ToolKey::Antigravity => &["agy", "antigravity"],
    }
}

pub async fn detect_all() -> Vec<CliStatus> {
    let mut statuses = Vec::new();
    for tool_key in [ToolKey::Claude, ToolKey::Codex, ToolKey::Antigravity] {
        statuses.push(detect_tool(tool_key).await);
    }
    statuses
}

async fn detect_tool(tool_key: ToolKey) -> CliStatus {
    // 1) Resolvable on the current PATH.
    for command in candidates(tool_key) {
        if let Some(path) = detect::which(command).await {
            return CliStatus {
                tool_key,
                status: CliAvailability::Available,
                path: Some(path.display().to_string()),
                resolved_command: Some((*command).to_string()),
                version: detect::run_version(command).await,
                latest_version: None,
                path_visible: true,
            };
        }
    }

    // 2) Present in a known install directory but not on PATH.
    for command in candidates(tool_key) {
        if let Some(path) = detect::find_in_known_dirs(command) {
            return CliStatus {
                tool_key,
                status: CliAvailability::PathNotVisible,
                path: Some(path.display().to_string()),
                resolved_command: Some((*command).to_string()),
                version: None,
                latest_version: None,
                path_visible: false,
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
        path_visible: false,
    }
}
