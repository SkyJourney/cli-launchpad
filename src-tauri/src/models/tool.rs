use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKey {
    Antigravity,
    Codex,
    Claude,
}

impl ToolKey {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolKey::Antigravity => "antigravity",
            ToolKey::Codex => "codex",
            ToolKey::Claude => "claude",
        }
    }

    pub fn from_key(value: &str) -> Option<Self> {
        match value {
            "antigravity" => Some(ToolKey::Antigravity),
            "codex" => Some(ToolKey::Codex),
            "claude" => Some(ToolKey::Claude),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: i64,
    pub key: ToolKey,
    pub display_name: String,
    pub executable: String,
    pub global_args: String,
    pub enabled: bool,
}
