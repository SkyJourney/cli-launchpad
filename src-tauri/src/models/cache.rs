use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub size_bytes: u64,
    pub entry_count: i64,
    pub session_entry_count: i64,
    pub newest_entry_at_ms: Option<i64>,
}
