use serde::{Deserialize, Serialize};

use crate::models::tool::ToolKey;

/// A cache row's key. `as_key` gives the persisted string, which existing rows already use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CacheKey {
    CliStatusAll,
    CliStatus(ToolKey),
    LatestVersion(ToolKey),
}

impl CacheKey {
    /// The persisted string form. Stable across versions: existing cache rows keep working.
    pub fn as_key(&self) -> String {
        match self {
            CacheKey::CliStatusAll => "cli-status:all".to_string(),
            CacheKey::CliStatus(tool) => format!("cli-status:{}", tool.as_str()),
            CacheKey::LatestVersion(tool) => format!("latest-version:{}", tool.as_str()),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub size_bytes: u64,
    pub entry_count: i64,
    pub newest_entry_at_ms: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::tool::ToolKey;
    use std::collections::HashSet;

    #[test]
    fn cache_keys_keep_their_persisted_string_forms() {
        assert_eq!(CacheKey::CliStatusAll.as_key(), "cli-status:all");
        for tool in ToolKey::ALL {
            assert_eq!(
                CacheKey::CliStatus(tool).as_key(),
                format!("cli-status:{}", tool.as_str())
            );
            assert_eq!(
                CacheKey::LatestVersion(tool).as_key(),
                format!("latest-version:{}", tool.as_str())
            );
        }
        // Literal spellings, so the expectation does not read the same format string as the code.
        assert_eq!(
            CacheKey::CliStatus(ToolKey::Claude).as_key(),
            "cli-status:claude"
        );
        assert_eq!(
            CacheKey::LatestVersion(ToolKey::Codex).as_key(),
            "latest-version:codex"
        );
        // Reverse: the status and the latest-version keys of one tool are different rows.
        assert_ne!(
            CacheKey::CliStatus(ToolKey::Claude).as_key(),
            CacheKey::LatestVersion(ToolKey::Claude).as_key()
        );
    }

    #[test]
    fn cache_keys_are_distinct_per_tool_and_kind() {
        let mut keys = vec![CacheKey::CliStatusAll];
        for tool in ToolKey::ALL {
            keys.push(CacheKey::CliStatus(tool));
            keys.push(CacheKey::LatestVersion(tool));
        }
        let strings: HashSet<String> = keys.iter().map(|key| key.as_key()).collect();
        assert_eq!(strings.len(), 1 + 2 * ToolKey::ALL.len());
        // Reverse: the aggregate status key is not any single tool's status key.
        assert!(ToolKey::ALL
            .iter()
            .all(|tool| CacheKey::CliStatusAll.as_key() != CacheKey::CliStatus(*tool).as_key()));
    }
}
