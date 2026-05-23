use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKey {
    Antigravity,
    Codex,
    Claude,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Tool {
    pub id: i64,
    pub key: ToolKey,
    pub display_name: String,
    pub executable: String,
    pub global_args: String,
    pub enabled: bool,
}

