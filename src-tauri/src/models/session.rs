use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub tool_key: ToolKey,
    pub session_id: String,
    /// Title reported by the CLI's own session store.
    pub title: String,
    /// Sparse user-defined override stored by CLI Launchpad.
    pub alias: Option<String>,
    /// Last activity as Unix epoch milliseconds (file mtime), when available.
    pub last_active_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub items: Vec<SessionInfo>,
    pub next_cursor: Option<String>,
}
