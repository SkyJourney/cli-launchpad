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

/// Search results across the local session metadata of all supported CLIs.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResults {
    pub items: Vec<SessionInfo>,
    /// Tools whose metadata could not be searched completely.
    pub incomplete_tools: Vec<ToolKey>,
}

/// Rebuildable local metadata for the cache database's session search index.
#[derive(Debug, Clone)]
pub struct SessionSearchIndexDocument {
    pub tool_key: ToolKey,
    pub session_id: String,
    pub title: String,
    pub last_active_ms: Option<i64>,
    pub fields: Vec<String>,
}

/// `documents: None` means the source could not be read safely; retain its last good index.
#[derive(Debug, Clone)]
pub struct SessionSearchIndexSource {
    pub tool_key: ToolKey,
    pub documents: Option<Vec<SessionSearchIndexDocument>>,
    pub incomplete: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchIndexRefresh {
    pub incomplete_tools: Vec<ToolKey>,
    pub indexed_sessions: usize,
}
