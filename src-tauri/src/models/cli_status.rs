use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAvailability {
    /// Installed and resolvable on the current PATH.
    Available,
    /// Found in a known install directory but not on the current PATH.
    PathNotVisible,
    /// Not found anywhere we checked.
    Missing,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub tool_key: ToolKey,
    pub status: CliAvailability,
    /// Resolved executable path, when known.
    pub path: Option<String>,
    /// Command that resolved the tool (e.g. `agy` vs the `antigravity` probe).
    pub resolved_command: Option<String>,
    /// Raw `--version` output, when obtainable.
    pub version: Option<String>,
    /// Latest available version; populated in a later milestone.
    pub latest_version: Option<String>,
    pub path_visible: bool,
}
