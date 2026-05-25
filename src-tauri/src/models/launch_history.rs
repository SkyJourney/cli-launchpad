use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchAction {
    Launch,
    Resume,
}

impl LaunchAction {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchAction::Launch => "launch",
            LaunchAction::Resume => "resume",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchHistoryEntry {
    pub id: i64,
    pub directory_name: String,
    pub tool_key: ToolKey,
    pub action: LaunchAction,
    pub success: bool,
    pub error_category: Option<String>,
    pub launched_at: String,
}
