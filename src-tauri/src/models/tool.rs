use serde::{Deserialize, Serialize};

/// Declares the Rust side of the tool registry: one line per tool, generating the enum, the
/// iteration list and the key conversions. `contracts/tool-keys.json` must list the same keys in
/// the same order; a contract test enforces it.
macro_rules! tool_keys {
    ($($variant:ident => $key:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum ToolKey {
            $($variant),+
        }

        const TOOL_KEY_COUNT: usize = [$(stringify!($variant)),+].len();

        impl ToolKey {
            /// All tool keys, in display order. Single source for iteration.
            pub const ALL: [ToolKey; TOOL_KEY_COUNT] = [$(ToolKey::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(ToolKey::$variant => $key),+
                }
            }

            pub fn from_key(value: &str) -> Option<Self> {
                match value {
                    $($key => Some(ToolKey::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

tool_keys! {
    Claude => "claude",
    Codex => "codex",
    Antigravity => "antigravity",
    Grok => "grok",
    Hermes => "hermes",
}

#[cfg(test)]
mod tests {
    use super::ToolKey;

    const TOOL_KEYS_JSON: &str = include_str!("../../../contracts/tool-keys.json");

    fn contract_keys() -> Vec<String> {
        let manifest: serde_json::Value =
            serde_json::from_str(TOOL_KEYS_JSON).expect("parse tool keys");
        manifest["items"]
            .as_array()
            .expect("tool keys must be an items array")
            .iter()
            .map(|key| key.as_str().expect("tool key").to_string())
            .collect()
    }

    #[test]
    fn all_matches_the_contract_in_order() {
        // 新增工具只改契约与 tool_keys! 宏的一行：这里保证两者在顺序和集合上一致。
        let contract = contract_keys();
        assert_eq!(ToolKey::ALL.len(), contract.len());
        let mut seen = std::collections::BTreeSet::new();
        for (key, value) in ToolKey::ALL.iter().zip(&contract) {
            assert_eq!(key.as_str(), value);
            assert!(seen.insert(value.clone()), "重复的工具键：{value}");
            assert_eq!(ToolKey::from_key(value), Some(*key));
            assert_eq!(
                serde_json::from_str::<ToolKey>(&format!("\"{value}\"")).expect("serde parse"),
                *key
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
