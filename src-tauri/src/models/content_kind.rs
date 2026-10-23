//! Content kinds known to this build, derived at runtime from
//! `contracts/content-kinds.json` (same approach as `window_kind.rs`).
use std::sync::OnceLock;

use serde::Deserialize;

const CONTENT_KINDS_JSON: &str = include_str!("../../../contracts/content-kinds.json");

/// Envelope kind written for content this build does not understand. It is a
/// reserved word, not a registered kind.
pub const UNKNOWN_CONTENT_KIND: &str = "unknown";

#[derive(Deserialize)]
struct ContentKindsManifest {
    items: Vec<ContentKindDefinition>,
}

#[derive(Deserialize)]
struct ContentKindDefinition {
    id: String,
}

pub fn registered_content_kinds() -> &'static [String] {
    static KINDS: OnceLock<Vec<String>> = OnceLock::new();
    KINDS.get_or_init(|| {
        serde_json::from_str::<ContentKindsManifest>(CONTENT_KINDS_JSON)
            .expect("content-kinds.json must be valid")
            .items
            .into_iter()
            .map(|definition| definition.id)
            .collect()
    })
}

pub fn is_registered_content_kind(kind: &str) -> bool {
    registered_content_kinds().iter().any(|id| id == kind)
}

/// Kinds that an `Unknown` content reference must not claim as its original kind.
pub fn is_reserved_content_kind(kind: &str) -> bool {
    kind == UNKNOWN_CONTENT_KIND || is_registered_content_kind(kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_content_kinds_are_well_formed() {
        let kinds = registered_content_kinds();
        assert!(!kinds.is_empty());
        let mut seen = std::collections::HashSet::new();
        for kind in kinds {
            assert!(seen.insert(kind.as_str()), "重复的内容 kind：{kind}");
            assert_ne!(kind, UNKNOWN_CONTENT_KIND);
            let mut characters = kind.chars();
            assert!(
                characters.next().is_some_and(|c| c.is_ascii_lowercase()),
                "{kind}"
            );
            assert!(kind.chars().all(|c| c.is_ascii_alphanumeric()), "{kind}");
        }
        assert!(is_registered_content_kind("pty"));
        assert!(!is_registered_content_kind("markdownPreview"));
        assert!(is_reserved_content_kind(UNKNOWN_CONTENT_KIND));
        assert!(!is_reserved_content_kind("markdownPreview"));
    }
}
