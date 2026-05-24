use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAvailability {
    /// Found on disk (PATH or a known install dir); launchable by full path.
    Available,
    /// Not found anywhere we checked.
    Missing,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub tool_key: ToolKey,
    pub status: CliAvailability,
    /// Resolved full executable path, when found.
    pub path: Option<String>,
    /// Command that resolved the tool (e.g. `agy` vs the `antigravity` probe).
    pub resolved_command: Option<String>,
    /// Raw `--version` output, when obtainable.
    pub version: Option<String>,
    /// Latest available version; populated by the version service.
    pub latest_version: Option<String>,
}
