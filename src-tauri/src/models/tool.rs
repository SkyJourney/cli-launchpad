use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKey {
    Antigravity,
    Codex,
    Claude,
    Grok,
}

impl ToolKey {
    /// All tool keys, in display order. Single source for iteration so adding a
    /// tool only requires touching this list (plus its arms).
    pub const ALL: [ToolKey; 4] = [
        ToolKey::Claude,
        ToolKey::Codex,
        ToolKey::Antigravity,
        ToolKey::Grok,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ToolKey::Antigravity => "antigravity",
            ToolKey::Codex => "codex",
            ToolKey::Claude => "claude",
            ToolKey::Grok => "grok",
        }
    }

    pub fn from_key(value: &str) -> Option<Self> {
        match value {
            "antigravity" => Some(ToolKey::Antigravity),
            "codex" => Some(ToolKey::Codex),
            "claude" => Some(ToolKey::Claude),
            "grok" => Some(ToolKey::Grok),
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
            ToolKey::Grok => &["grok"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ToolKey;

    #[test]
    fn grok_key_round_trips_through_database_and_ipc_name() {
        assert_eq!(ToolKey::Grok.as_str(), "grok");
        assert_eq!(serde_json::to_string(&ToolKey::Grok).unwrap(), "\"grok\"");
        assert_eq!(ToolKey::from_key("grok"), Some(ToolKey::Grok));
        assert_eq!(ToolKey::Grok.command_candidates(), &["grok"]);
        assert_eq!(ToolKey::ALL.len(), 4);
    }
}
