//! The only place that compares or folds project-relative paths (PD-10).
//!
//! `PathKey::of` turns a project-relative path into a comparison key under the
//! semantics probed for the project root. Equal keys only mean "candidate for
//! the same file": callers confirm with a file identity before merging.

use unicase::UniCase;
use unicode_normalization::UnicodeNormalization;

use super::case_sensitivity::{CaseSensitivity, PathSemantics, Tri};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PathKey(String);

impl PathKey {
    /// `Sensitive` and `Unknown` never fold; the normalization axis only acts on
    /// `Yes`. Separators and non-letters are kept as they are.
    pub fn of(relative: &str, semantics: &PathSemantics) -> PathKey {
        let fold = semantics.case == CaseSensitivity::Insensitive;
        let normalize = semantics.normalization_insensitive == Tri::Yes;
        let key = match (fold, normalize) {
            // Canonical caseless matching (Unicode D145), re-composed so the key is stable.
            (true, true) => {
                let decomposed: String = relative.nfd().collect();
                let folded = UniCase::unicode(decomposed.as_str()).to_folded_case();
                folded.nfd().nfc().collect()
            }
            (true, false) => UniCase::unicode(relative).to_folded_case(),
            (false, true) => relative.nfc().collect(),
            (false, false) => relative.to_owned(),
        };
        PathKey(key)
    }

    #[cfg(test)]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::PathKey;
    use crate::platform::case_sensitivity::{CaseSensitivity, PathSemantics, Tri};

    const VECTORS: &str = include_str!("../../../contracts/path-key/path-key-vectors.json");

    fn semantics(case: CaseSensitivity, normalization: Tri) -> PathSemantics {
        PathSemantics {
            case,
            normalization_insensitive: normalization,
        }
    }

    fn parse_semantics(value: &Value) -> PathSemantics {
        serde_json::from_value(value.clone()).expect("vector semantics must deserialize")
    }

    fn vectors() -> Vec<Value> {
        let document: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(document["version"], 1);
        document["vectors"].as_array().unwrap().clone()
    }

    #[test]
    fn path_key_behaves_per_flag() {
        use CaseSensitivity::{Insensitive, Sensitive, Unknown};

        let all = vectors();
        assert!(all.len() >= 20, "only {} vectors", all.len());
        let mut asserted = 0;
        for vector in &all {
            let name = vector["name"].as_str().unwrap();
            let flag = parse_semantics(&vector["semantics"]);
            let relative = vector["relative"].as_str().unwrap();
            // Unverified vectors carry `key: null`: only assert that they do not panic.
            let key = PathKey::of(relative, &flag);
            if let Some(expected) = vector["key"].as_str() {
                assert_eq!(key.as_str(), expected, "vector {name}");
                asserted += 1;
            }
            // Reverse assertion: sensitive and unknown semantics never fold case.
            if matches!(flag.case, Sensitive | Unknown) {
                let unfolded = PathKey::of(relative, &semantics(flag.case, Tri::No));
                assert_eq!(unfolded.as_str(), relative, "vector {name} must not fold");
            }
        }
        assert!(asserted >= 20, "only {asserted} asserted vectors");

        // The flag matrix of the test specification, one row at a time.
        let nfc = "\u{e9}.txt";
        let nfd = "e\u{301}.txt";
        let key = |case, normalization, text: &str| {
            PathKey::of(text, &semantics(case, normalization))
                .as_str()
                .to_owned()
        };
        // Sensitive / No.
        assert_ne!(
            key(Sensitive, Tri::No, "A.txt"),
            key(Sensitive, Tri::No, "a.txt")
        );
        assert_ne!(key(Sensitive, Tri::No, nfc), key(Sensitive, Tri::No, nfd));
        // Sensitive / Yes.
        assert_ne!(
            key(Sensitive, Tri::Yes, "A.txt"),
            key(Sensitive, Tri::Yes, "a.txt")
        );
        assert_eq!(key(Sensitive, Tri::Yes, nfc), key(Sensitive, Tri::Yes, nfd));
        // Insensitive / No.
        assert_eq!(
            key(Insensitive, Tri::No, "A.txt"),
            key(Insensitive, Tri::No, "a.txt")
        );
        assert_ne!(
            key(Insensitive, Tri::No, nfc),
            key(Insensitive, Tri::No, nfd)
        );
        // Insensitive / Yes.
        assert_eq!(
            key(Insensitive, Tri::Yes, "A.txt"),
            key(Insensitive, Tri::Yes, "a.txt")
        );
        assert_eq!(
            key(Insensitive, Tri::Yes, nfc),
            key(Insensitive, Tri::Yes, nfd)
        );
        // Unknown / Unknown.
        assert_ne!(
            key(Unknown, Tri::Unknown, "A.txt"),
            key(Unknown, Tri::Unknown, "a.txt")
        );
        assert_ne!(
            key(Unknown, Tri::Unknown, nfc),
            key(Unknown, Tri::Unknown, nfd)
        );
        // Insensitive / Unknown.
        assert_eq!(
            key(Insensitive, Tri::Unknown, "A.txt"),
            key(Insensitive, Tri::Unknown, "a.txt")
        );
        assert_ne!(
            key(Insensitive, Tri::Unknown, nfc),
            key(Insensitive, Tri::Unknown, nfd)
        );
        // Separators are kept, including a backslash.
        assert_eq!(key(Insensitive, Tri::No, "Dir\\A.txt"), "dir\\a.txt");
    }
}
