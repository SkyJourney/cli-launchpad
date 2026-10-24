use serde::{Deserialize, Serialize};

/// Declares the Rust side of the tool registry. `product` lists the shipped tool keys and
/// `fixtures` lists test-only keys (`#[cfg(test)]`); `contracts/tool-keys.json` must list the product
/// keys in the same order, and `src/test/fixtures/tool-keys.json` the fixture keys.
macro_rules! tool_keys {
    (
        product { $($variant:ident => $key:literal),+ $(,)? }
        fixtures { $($fvariant:ident => $fkey:literal),* $(,)? }
    ) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum ToolKey {
            $($variant,)+
            $(#[cfg(test)] $fvariant,)*
        }

        const TOOL_KEY_COUNT: usize = [$(stringify!($variant)),+].len();

        #[cfg(test)]
        const FIXTURE_KEYS: &[ToolKey] = &[$(ToolKey::$fvariant),*];

        impl ToolKey {
            /// The shipped tool keys, in display order. Single source for iteration of product behaviour.
            pub const ALL: [ToolKey; TOOL_KEY_COUNT] = [$(ToolKey::$variant),+];

            /// Every key the running build knows: the shipped keys, plus the fixtures in test builds.
            pub fn registered() -> Vec<ToolKey> {
                let keys = Self::ALL.to_vec();
                #[cfg(test)]
                let keys = [keys, FIXTURE_KEYS.to_vec()].concat();
                keys
            }

            pub fn as_str(self) -> &'static str {
                match self {
                    $(ToolKey::$variant => $key,)+
                    $(#[cfg(test)] ToolKey::$fvariant => $fkey,)*
                }
            }

            pub fn from_key(value: &str) -> Option<Self> {
                match value {
                    $($key => Some(ToolKey::$variant),)+
                    $(#[cfg(test)] $fkey => Some(ToolKey::$fvariant),)*
                    _ => None,
                }
            }
        }
    };
}

tool_keys! {
    product {
        Claude => "claude",
        Codex => "codex",
        Antigravity => "antigravity",
        Grok => "grok",
        Hermes => "hermes",
    }
    fixtures {
    }
}

#[cfg(test)]
mod tests {
    use super::ToolKey;

    const TOOL_KEYS_JSON: &str = include_str!("../../../contracts/tool-keys.json");
    const FIXTURE_MANIFEST_JSON: &str = include_str!("../../../src/test/fixtures/tool-keys.json");

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
    fn registered_keys_are_the_product_keys_plus_the_fixture_manifest() {
        let manifest: serde_json::Value =
            serde_json::from_str(FIXTURE_MANIFEST_JSON).expect("parse fixture manifest");
        let manifest_keys: Vec<String> = manifest["items"]
            .as_array()
            .expect("fixture manifest items")
            .iter()
            .map(|key| key.as_str().expect("fixture key").to_string())
            .collect();
        let registered = ToolKey::registered();
        assert_eq!(&registered[..ToolKey::ALL.len()], &ToolKey::ALL[..]);
        let fixtures: Vec<String> = registered[ToolKey::ALL.len()..]
            .iter()
            .map(|key| key.as_str().to_string())
            .collect();
        assert_eq!(fixtures, manifest_keys);
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
