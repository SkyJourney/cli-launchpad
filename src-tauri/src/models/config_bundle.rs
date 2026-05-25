use serde::{Deserialize, Serialize};

use super::app_setting::CloseBehavior;
use super::tool::ToolKey;

pub const CONFIG_BUNDLE_VERSION: u32 = 3;

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
    #[serde(default)]
    pub shell_profiles: Vec<ExportedShellProfile>,
    #[serde(default)]
    pub close_behavior: Option<CloseBehavior>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedShellProfile {
    pub name: String,
    pub terminal_exe: String,
    pub shell_exe: String,
    pub shell_args: String,
    pub init_script: String,
    pub is_default: bool,
    pub kind: String,
}
