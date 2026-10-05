use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use serde_json::Value;

const APP_COMMANDS_JSON: &str = include_str!("../../contracts/app-commands.json");
const TOOL_KEYS_JSON: &str = include_str!("../../contracts/tool-keys.json");
const CONTENT_KINDS_JSON: &str = include_str!("../../contracts/content-kinds.json");
const WINDOW_KINDS_JSON: &str = include_str!("../../contracts/window-kinds.json");
const LIB_RS: &str = include_str!("lib.rs");

fn sorted_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut values: Vec<String> = values.into_iter().collect();
    values.sort();
    values
}

fn json_strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("contract field must be an array")
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("contract array values must be strings")
                .to_string()
        })
        .collect()
}

#[test]
fn tool_key_contract_matches_the_rust_registry() {
    let contract: Vec<String> =
        serde_json::from_str(TOOL_KEYS_JSON).expect("parse ToolKey contract");
    let rust_keys = crate::models::tool::ToolKey::ALL
        .into_iter()
        .map(|key| key.as_str().to_string())
        .collect::<Vec<_>>();

    assert_eq!(contract, rust_keys);
}

#[test]
fn content_kind_contract_matches_rust_serialization() {
    use crate::models::workspace_layout::WorkspacePaneContentRef;

    let contract: Vec<String> =
        serde_json::from_str(CONTENT_KINDS_JSON).expect("parse content kind contract");
    let pty = serde_json::to_value(WorkspacePaneContentRef::Pty {
        slot_id: "slot".to_string(),
    })
    .expect("serialize PTY content ref");
    let file = serde_json::to_value(WorkspacePaneContentRef::File {
        document_id: "document".to_string(),
    })
    .expect("serialize file content ref");
    let serialized_kinds = vec![
        pty["kind"].as_str().unwrap().to_string(),
        file["kind"].as_str().unwrap().to_string(),
    ];

    assert_eq!(contract, serialized_kinds);
}

#[test]
fn app_command_contract_matches_the_registered_handler() {
    let commands: Vec<String> =
        serde_json::from_str(APP_COMMANDS_JSON).expect("parse app command contract");
    let command_set: HashSet<&str> = commands.iter().map(String::as_str).collect();
    assert_eq!(commands.len(), command_set.len(), "duplicate app command");

    let handler_marker = "generate_handler![";
    let handler = LIB_RS
        .split_once(handler_marker)
        .expect("lib.rs must register a Tauri handler")
        .1
        .split_once("])")
        .expect("generate_handler! must close")
        .0;
    let handler_commands = sorted_strings(
        handler
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                entry
                    .rsplit("::")
                    .next()
                    .expect("handler entry must name a command")
                    .to_string()
            }),
    );
    assert_eq!(sorted_strings(commands), handler_commands);
}

#[test]
fn window_kind_contract_matches_capabilities() {
    let manifest: Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kind contract");
    assert_eq!(manifest["version"].as_u64(), Some(1));
    let kinds = manifest["kinds"]
        .as_array()
        .expect("window kinds must be an array");
    let mut by_capability = HashMap::new();
    for kind in kinds {
        let capability_id = kind["capability"]
            .as_str()
            .expect("window kind needs a capability id");
        assert!(
            by_capability.insert(capability_id, kind).is_none(),
            "duplicate capability declaration: {capability_id}"
        );
        assert_ne!(
            kind.get("label").is_some(),
            kind.get("labelPrefix").is_some(),
            "each window kind needs exactly one label rule"
        );
    }

    let capability_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut found_capabilities = HashSet::new();
    for entry in fs::read_dir(capability_dir).expect("read capability directory") {
        let path = entry.expect("read capability entry").path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let capability: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read capability file"))
                .expect("parse capability file");
        let capability_id = capability["identifier"]
            .as_str()
            .expect("capability needs an identifier");
        found_capabilities.insert(capability_id.to_string());
        let kind = by_capability
            .get(capability_id)
            .unwrap_or_else(|| panic!("missing window contract for {capability_id}"));

        let expected_window = if let Some(label) = kind["label"].as_str() {
            label.to_string()
        } else {
            format!(
                "{}*",
                kind["labelPrefix"]
                    .as_str()
                    .expect("window kind needs a label prefix")
            )
        };
        let actual_windows = json_strings(&capability["windows"]);
        assert_eq!(actual_windows, vec![expected_window], "{capability_id}");

        let declared_commands = if kind["appCommands"].as_str() == Some("all") {
            serde_json::from_str::<Vec<String>>(APP_COMMANDS_JSON)
                .expect("parse app command contract")
        } else {
            json_strings(&kind["appCommands"])
        };
        let actual_commands = sorted_strings(
            capability["permissions"]
                .as_array()
                .expect("capability permissions must be an array")
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|permission| permission.strip_prefix("allow-"))
                .map(|command| command.replace('-', "_")),
        );
        assert_eq!(
            sorted_strings(declared_commands),
            actual_commands,
            "app commands for {capability_id}"
        );

        let declared_core_permissions = sorted_strings(json_strings(&kind["corePermissions"]));
        let actual_core_permissions = sorted_strings(
            capability["permissions"]
                .as_array()
                .expect("capability permissions must be an array")
                .iter()
                .filter_map(Value::as_str)
                .filter(|permission| permission.starts_with("core:"))
                .map(str::to_string),
        );
        assert_eq!(
            declared_core_permissions, actual_core_permissions,
            "core permissions for {capability_id}"
        );
    }

    assert_eq!(
        found_capabilities,
        by_capability
            .keys()
            .map(|capability| (*capability).to_string())
            .collect()
    );
}
