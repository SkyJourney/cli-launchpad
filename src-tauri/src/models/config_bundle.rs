use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

pub const CONFIG_BUNDLE_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedToolArgs {
    pub tool_key: ToolKey,
    pub args: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedDirectory {
    pub name: String,
    pub path: String,
    pub pinned: bool,
    pub note: Option<String>,
    pub tool_args: Vec<ExportedToolArgs>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedTool {
    pub key: ToolKey,
    pub global_args: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBundle {
    pub version: u32,
    pub directories: Vec<ExportedDirectory>,
    pub tools: Vec<ExportedTool>,
}
