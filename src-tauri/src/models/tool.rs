use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKey {
    Antigravity,
    Codex,
    Claude,
}

impl ToolKey {
    /// All tool keys, in display order. Single source for iteration so adding a
    /// tool only requires touching this list (plus its arms).
    pub const ALL: [ToolKey; 3] = [ToolKey::Claude, ToolKey::Codex, ToolKey::Antigravity];

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

    /// Candidate commands to resolve, in priority order. Antigravity's official
    /// command is `agy`; `antigravity` is only a conservative compatibility probe.
    pub fn command_candidates(self) -> &'static [&'static str] {
        match self {
            ToolKey::Claude => &["claude"],
            ToolKey::Codex => &["codex"],
            ToolKey::Antigravity => &["agy", "antigravity"],
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
