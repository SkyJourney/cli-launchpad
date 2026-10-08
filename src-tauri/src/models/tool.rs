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

    const TOOL_KEYS_JSON: &str = include_str!("../../../contracts/tool-keys.json");

    #[test]
    fn all_lists_every_variant_exactly_once() {
        // 新增变体会让下面的 match 编译失败：必须同步 ALL、contracts/tool-keys.json、
        // SQL 约束与前端注册表。
        fn ordinal(key: ToolKey) -> usize {
            match key {
                ToolKey::Claude => 0,
                ToolKey::Codex => 1,
                ToolKey::Antigravity => 2,
                ToolKey::Grok => 3,
                ToolKey::Hermes => 4,
            }
        }
        const VARIANT_COUNT: usize = 5;

        assert_eq!(ToolKey::ALL.len(), VARIANT_COUNT);
        let mut seen = std::collections::BTreeSet::new();
        for key in ToolKey::ALL {
            let value = ordinal(key);
            assert!(value < VARIANT_COUNT, "{key:?}");
            assert!(
                seen.insert(value),
                "ToolKey::ALL lists {key:?} more than once"
            );
        }
        assert_eq!(seen.len(), VARIANT_COUNT);

        let contract: Vec<String> = serde_json::from_str(TOOL_KEYS_JSON).expect("parse tool keys");
        for value in &contract {
            let key = ToolKey::from_key(value).unwrap_or_else(|| panic!("{value} has no ToolKey"));
            assert_eq!(key.as_str(), value);
            assert_eq!(
                serde_json::from_str::<ToolKey>(&format!("\"{value}\"")).expect("serde parse"),
                key
            );
        }
        assert_eq!(ToolKey::from_key("unknown"), None);
        assert!(serde_json::from_str::<ToolKey>("\"unknown\"").is_err());
    }

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

        for tool_key in ToolKey::ALL {
            let serialized = serde_json::to_string(&tool_key).unwrap();
            assert_eq!(
                serde_json::from_str::<ToolKey>(&serialized).unwrap(),
                tool_key
            );
            assert_eq!(ToolKey::from_key(tool_key.as_str()), Some(tool_key));
        }
        assert_eq!(ToolKey::from_key("unknown"), None);
    }
}
