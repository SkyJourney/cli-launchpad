use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub sort_order: i64,
    pub pinned: bool,
    pub last_used_at: Option<String>,
    pub note: Option<String>,
}
