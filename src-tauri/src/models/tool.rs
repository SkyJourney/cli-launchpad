use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKey {
    Antigravity,
    Codex,
    Claude,
    Grok,
    Hermes,
}

impl ToolKey {
    /// All tool keys, in display order. Single source for iteration so adding a
    /// tool only requires touching this list (plus its arms).
    pub const ALL: [ToolKey; 5] = [
        ToolKey::Claude,
        ToolKey::Codex,
        ToolKey::Antigravity,
        ToolKey::Grok,
        ToolKey::Hermes,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ToolKey::Antigravity => "antigravity",
            ToolKey::Codex => "codex",
            ToolKey::Claude => "claude",
            ToolKey::Grok => "grok",
            ToolKey::Hermes => "hermes",
        }
    }

    pub fn from_key(value: &str) -> Option<Self> {
        match value {
            "antigravity" => Some(ToolKey::Antigravity),
            "codex" => Some(ToolKey::Codex),
            "claude" => Some(ToolKey::Claude),
            "grok" => Some(ToolKey::Grok),
            "hermes" => Some(ToolKey::Hermes),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ToolKey;

    #[test]
    fn tool_keys_round_trip_through_database_and_ipc_names() {
        assert_eq!(ToolKey::Grok.as_str(), "grok");
        assert_eq!(serde_json::to_string(&ToolKey::Grok).unwrap(), "\"grok\"");
        assert_eq!(ToolKey::from_key("grok"), Some(ToolKey::Grok));
        assert_eq!(ToolKey::Hermes.as_str(), "hermes");
        assert_eq!(
            serde_json::to_string(&ToolKey::Hermes).unwrap(),
            "\"hermes\""
        );
        assert_eq!(ToolKey::from_key("hermes"), Some(ToolKey::Hermes));
        assert_eq!(ToolKey::ALL.len(), 5);
    }
}
