use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub tool_key: ToolKey,
    pub session_id: String,
    pub title: String,
    /// Last activity as Unix epoch milliseconds (file mtime), when available.
    pub last_active_ms: Option<i64>,
}
