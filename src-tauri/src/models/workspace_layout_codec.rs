//! Layout JSON codec: reads the schema version and applies the v1 to v4 migrations.

use super::workspace_layout::WORKSPACE_LAYOUT_SCHEMA_VERSION;

/// The oldest layout schema version that can still be migrated to the current one.
pub const OLDEST_SUPPORTED_LAYOUT_VERSION: i64 = 1;

/// Reads the numeric `schemaVersion` of a stored layout payload. Only reads; it does not judge support.
pub fn source_layout_version(payload_json: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(payload_json)
        .ok()?
        .get("schemaVersion")?
        .as_i64()
}

/// Whether a stored layout version can be migrated to the current schema version.
pub fn is_supported_layout_version(version: i64) -> bool {
    (OLDEST_SUPPORTED_LAYOUT_VERSION..=i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION))
        .contains(&version)
}

/// Applies the v1..v4 migrations in place; a current (v5) payload is left untouched.
pub(crate) fn migrate_to_current(value: &mut serde_json::Value, source_version: u64) {
    if source_version == 4 {
        value["schemaVersion"] = serde_json::Value::from(WORKSPACE_LAYOUT_SCHEMA_VERSION);
    } else if source_version == 1 || source_version == 2 {
        migrate_legacy_content_refs(value, source_version);
        migrate_detached_slot_ids(value);
    } else if source_version == 3 {
        migrate_detached_slot_ids(value);
    }
}

fn migrate_legacy_content_refs(layout: &mut serde_json::Value, source_version: u64) {
    if let Some(object) = layout.as_object_mut() {
        object.insert(
            "schemaVersion".to_string(),
            serde_json::Value::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
        );
        if let Some(tree) = object.get_mut("tree") {
            migrate_legacy_content_node(tree, source_version);
        }
    }
}

fn migrate_detached_slot_ids(layout: &mut serde_json::Value) {
    let Some(object) = layout.as_object_mut() else {
        return;
    };
    let legacy = object.remove("detachedSlotIds");
    let detached_contents = match legacy {
        Some(serde_json::Value::Array(slot_ids)) => slot_ids
            .into_iter()
            .map(|value| match value.as_str() {
                Some(slot_id) => serde_json::json!({ "kind": "pty", "slotId": slot_id }),
                None => value,
            })
            .collect(),
        Some(value) => value,
        None => serde_json::Value::Array(Vec::new()),
    };
    object.insert(
        "schemaVersion".to_string(),
        serde_json::Value::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
    );
    object.insert("detachedContents".to_string(), detached_contents);
}

fn migrate_legacy_content_node(node: &mut serde_json::Value, source_version: u64) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    match object.get("kind").and_then(serde_json::Value::as_str) {
        Some("pane") => {
            let session_ids = object
                .remove("sessionIds")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let document_ids = object
                .remove("documentIds")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let active_session_id = object.remove("activeSessionId");
            let legacy_active_content = object.remove("activeContent");
            let mut contents = Vec::with_capacity(session_ids.len() + document_ids.len());
            contents.extend(session_ids.iter().filter_map(|value| {
                value
                    .as_str()
                    .map(|slot_id| serde_json::json!({ "kind": "pty", "slotId": slot_id }))
            }));
            contents.extend(document_ids.iter().filter_map(|value| {
                value.as_str().map(
                    |document_id| serde_json::json!({ "kind": "file", "documentId": document_id }),
                )
            }));
            let active_content = if source_version >= 2 {
                legacy_active_content.filter(|value| !value.is_null())
            } else {
                None
            }
            .or_else(|| {
                active_session_id
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .filter(|active| {
                        session_ids
                            .iter()
                            .any(|session_id| session_id.as_str() == Some(*active))
                    })
                    .map(|slot_id| serde_json::json!({ "kind": "pty", "slotId": slot_id }))
            })
            .or_else(|| contents.first().cloned());
            object.insert("contents".to_string(), serde_json::Value::Array(contents));
            object.insert(
                "activeContent".to_string(),
                active_content.unwrap_or(serde_json::Value::Null),
            );
        }
        Some("split") => {
            if let Some(first) = object.get_mut("first") {
                migrate_legacy_content_node(first, source_version);
            }
            if let Some(second) = object.get_mut("second") {
                migrate_legacy_content_node(second, source_version);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::workspace_layout::WORKSPACE_LAYOUT_SCHEMA_VERSION;
    use serde_json::json;

    #[test]
    fn source_layout_version_reads_only_the_numeric_schema_version() {
        assert_eq!(source_layout_version(r#"{"schemaVersion":3}"#), Some(3));
        assert_eq!(
            source_layout_version(r#"{"schemaVersion":5,"x":1}"#),
            Some(5)
        );
        assert_eq!(source_layout_version("{}"), None);
        assert_eq!(source_layout_version(r#"{"schemaVersion":"5"}"#), None);
        assert_eq!(source_layout_version("not json"), None);
        // 反向：只读取数字，不判断版本是否受支持。
        assert_eq!(source_layout_version(r#"{"schemaVersion":-1}"#), Some(-1));
    }

    #[test]
    fn migrate_to_current_leaves_current_payloads_untouched() {
        let current = json!({
            "schemaVersion": 5,
            "tree": {"kind": "pane", "id": "p1", "contents": []}
        });
        let mut value = current.clone();
        migrate_to_current(&mut value, 5);
        assert_eq!(value, current);

        // 反向：v4 会被迁移到当前版本号。
        let mut version_four = json!({"schemaVersion": 4});
        migrate_to_current(&mut version_four, 4);
        assert_eq!(version_four["schemaVersion"], json!(5));
    }

    #[test]
    fn supported_versions_are_one_through_the_current_version() {
        for version in 1..=i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION) {
            assert!(is_supported_layout_version(version));
        }
        assert!(is_supported_layout_version(5));
        assert!(!is_supported_layout_version(0));
        assert!(!is_supported_layout_version(-1));
        assert!(!is_supported_layout_version(
            i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION) + 1
        ));
        assert_eq!(OLDEST_SUPPORTED_LAYOUT_VERSION, 1);
    }
}
