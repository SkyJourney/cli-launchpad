use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    Install,
    Update,
}

/// A structured install/update command, modelled as program + args so the
/// business layer never concatenates free-form shell strings.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub tool_key: ToolKey,
    pub kind: InstallKind,
    pub program: String,
    pub args: Vec<String>,
    /// Human-readable source/origin shown in the UI.
    pub source: String,
    /// Human-readable command preview shown before execution.
    pub preview: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub success: bool,
    pub log: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    pub tool_key: ToolKey,
    pub latest: Option<String>,
}
