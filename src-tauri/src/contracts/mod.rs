use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::Path,
};

use serde_json::{json, Value};

mod fixtures;
mod serde_lint;

const APP_COMMANDS_JSON: &str = include_str!("../../../contracts/app-commands.json");
const TOOL_KEYS_JSON: &str = include_str!("../../../contracts/tool-keys.json");
const TOOL_CAPABILITIES_JSON: &str = include_str!("../../../contracts/tool-capabilities.json");
const CONTENT_KINDS_JSON: &str = include_str!("../../../contracts/content-kinds.json");
const API_VERSIONS_JSON: &str = include_str!("../../../contracts/api-versions.json");
const WINDOW_KINDS_JSON: &str = include_str!("../../../contracts/window-kinds.json");
const LIB_RS: &str = include_str!("../lib.rs");
const TAURI_CONFIG_JSON: &str = include_str!("../../tauri.conf.json");
const SERDE_LINT_ALLOWLIST_JSON: &str =
    include_str!("../../../contracts/serde-lint-allowlist.json");

fn sorted_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut values: Vec<String> = values.into_iter().collect();
    values.sort();
    values
}

/// The `id` of every entry of a `{ formatVersion, items }` manifest whose items are objects.
fn item_ids(manifest: &Value) -> Vec<String> {
    manifest["items"]
        .as_array()
        .expect("manifest items must be an array")
        .iter()
        .map(|item| {
            item["id"]
                .as_str()
                .expect("manifest item needs an id")
                .to_string()
        })
        .collect()
}

/// The registered app command names (`contracts/app-commands.json`, `items[].name`).
fn app_command_names() -> Vec<String> {
    serde_json::from_str::<Value>(APP_COMMANDS_JSON).expect("parse app command contract")["items"]
        .as_array()
        .expect("app command items must be an array")
        .iter()
        .map(|item| {
            item["name"]
                .as_str()
                .expect("every app command item has a name")
                .to_string()
        })
        .collect()
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

fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 删除 `//` 与（可嵌套的）`/* */` 注释，普通字符串字面量原样保留。
/// 前提（前置检查第 9 项已核对）：被扫描的源码没有 '"' 字符字面量和原始字符串。
fn strip_rust_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut output = String::with_capacity(source.len());
    let mut index = 0;
    let mut in_string = false;
    while index < chars.len() {
        let current = chars[index];
        if in_string {
            output.push(current);
            if current == '\\' && index + 1 < chars.len() {
                output.push(chars[index + 1]);
                index += 2;
                continue;
            }
            if current == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if current == '"' {
            in_string = true;
            output.push(current);
            index += 1;
            continue;
        }
        if current == '/' && chars.get(index + 1) == Some(&'/') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if current == '/' && chars.get(index + 1) == Some(&'*') {
            let mut depth = 1usize;
            index += 2;
            while index < chars.len() && depth > 0 {
                if chars[index] == '/' && chars.get(index + 1) == Some(&'*') {
                    depth += 1;
                    index += 2;
                } else if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            output.push(' ');
            continue;
        }
        output.push(current);
        index += 1;
    }
    output
}

/// `strip_rust_comments` 只处理普通字符串：源码里出现 `'"'` 字符字面量或原始字符串时，
/// 字符串状态机会错位，所以扫描前先拒绝这两种写法（而不是静默得到错误结果）。
fn reject_unsupported_literals(source: &str) -> Result<(), String> {
    if source.contains("'\"'") {
        return Err("source contains a '\"' character literal".to_string());
    }
    let chars: Vec<char> = source.chars().collect();
    for (index, character) in chars.iter().enumerate() {
        if *character != 'r'
            || (index > 0 && (chars[index - 1].is_alphanumeric() || chars[index - 1] == '_'))
        {
            continue;
        }
        let mut cursor = index + 1;
        while chars.get(cursor) == Some(&'#') {
            cursor += 1;
        }
        if chars.get(cursor) == Some(&'"') {
            return Err("source contains a raw string literal".to_string());
        }
    }
    Ok(())
}

fn parse_handler_commands(source: &str) -> Result<Vec<String>, String> {
    reject_unsupported_literals(source)?;
    let stripped = strip_rust_comments(source);
    let marker = "generate_handler![";
    if stripped.matches(marker).count() > 1 {
        return Err("multiple generate_handler! markers found".to_string());
    }
    let start = stripped
        .find(marker)
        .ok_or_else(|| "generate_handler! marker not found".to_string())?
        + marker.len();
    let mut depth = 1usize;
    let mut end = None;
    for (offset, character) in stripped[start..].char_indices() {
        match character {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(start + offset);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end.ok_or_else(|| "generate_handler! is not closed".to_string())?;
    let entries: Vec<&str> = stripped[start..end].split(',').map(str::trim).collect();
    let mut names = Vec::new();
    for (position, entry) in entries.iter().enumerate() {
        if entry.is_empty() {
            if position + 1 == entries.len() {
                continue;
            }
            return Err("empty handler entry".to_string());
        }
        let segments: Vec<&str> = entry.split("::").collect();
        let valid = segments.len() >= 3
            && segments[0] == "commands"
            && segments.iter().all(|segment| is_identifier(segment));
        if !valid {
            return Err(format!(
                "handler entry must be commands::<module>::<function>: {entry}"
            ));
        }
        names.push(segments[segments.len() - 1].to_string());
    }
    if names.is_empty() {
        return Err("generate_handler! lists no commands".to_string());
    }
    Ok(names)
}

fn tauri_command_functions(source: &str) -> Result<Vec<String>, String> {
    reject_unsupported_literals(source)?;
    let stripped = strip_rust_comments(source);
    // 同时识别 `#[tauri::command]` 与带参数的 `#[tauri::command(rename_all = "snake_case")]`。
    let marker = "#[tauri::command";
    let mut names = Vec::new();
    let mut rest = stripped.as_str();
    while let Some(position) = rest.find(marker) {
        rest = &rest[position + marker.len()..];
        if let Some(after) = rest.strip_prefix(']') {
            rest = after;
        } else if rest.starts_with('(') {
            let mut depth = 0usize;
            let mut close = None;
            for (offset, character) in rest.char_indices() {
                match character {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(offset);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let close =
                close.ok_or_else(|| "unterminated #[tauri::command(...)] arguments".to_string())?;
            let after = rest[close + 1..].trim_start();
            rest = after
                .strip_prefix(']')
                .ok_or_else(|| "expected ] after #[tauri::command(...)]".to_string())?;
        } else {
            // 例如 `#[tauri::command_x]`：不是命令属性。
            continue;
        }
        let mut tail = rest.trim_start();
        while tail.starts_with("#[") {
            let close = tail
                .find(']')
                .ok_or_else(|| "unterminated attribute after #[tauri::command]".to_string())?;
            tail = tail[close + 1..].trim_start();
        }
        let declaration = tail
            .strip_prefix("pub async fn ")
            .or_else(|| tail.strip_prefix("pub fn "))
            .ok_or_else(|| {
                format!(
                    "#[tauri::command] must precede pub fn: {}",
                    tail.chars().take(60).collect::<String>()
                )
            })?;
        let name: String = declaration
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if name.is_empty() {
            return Err("missing command function name".to_string());
        }
        names.push(name);
    }
    Ok(names)
}

fn permission_identifier(permission: &Value) -> Option<&str> {
    match permission {
        Value::String(text) => Some(text.as_str()),
        Value::Object(object) => object.get("identifier").and_then(Value::as_str),
        _ => None,
    }
}

fn capability_contract_violations(
    kind: &Value,
    capability: &Value,
    app_commands: &[String],
) -> Vec<String> {
    let mut violations = Vec::new();
    let kind_id = kind["id"].as_str().unwrap_or("<missing id>");
    let Some(permissions) = capability["permissions"].as_array() else {
        return vec!["capability permissions must be an array".to_string()];
    };

    let mut actual_commands = BTreeSet::new();
    let mut actual_core = BTreeSet::new();
    let mut actual_plugin: Vec<Value> = Vec::new();
    for permission in permissions {
        let Some(identifier) = permission_identifier(permission) else {
            violations.push(format!("permission without identifier: {permission}"));
            continue;
        };
        for forbidden in ["fs:", "shell:", "http:"] {
            if identifier.starts_with(forbidden) {
                violations.push(format!("forbidden permission namespace: {identifier}"));
            }
        }
        if identifier.ends_with(":default") && !(kind_id == "main" && identifier == "core:default")
        {
            violations.push(format!(
                "default permission set is not allowed: {identifier}"
            ));
        }
        match permission {
            Value::String(text) if text.starts_with("allow-") => {
                actual_commands.insert(text["allow-".len()..].replace('-', "_"));
            }
            Value::String(text) if text.starts_with("core:") => {
                actual_core.insert(text.clone());
            }
            other => actual_plugin.push(other.clone()),
        }
    }

    let declared_commands: BTreeSet<String> = if kind["appCommands"].as_str() == Some("all") {
        app_commands.iter().cloned().collect()
    } else {
        json_strings(&kind["appCommands"]).into_iter().collect()
    };
    for command in declared_commands.difference(&actual_commands) {
        violations.push(format!("app command missing from capability: {command}"));
    }
    for command in actual_commands.difference(&declared_commands) {
        violations.push(format!("app command not declared in contract: {command}"));
    }

    let declared_core: BTreeSet<String> =
        json_strings(&kind["corePermissions"]).into_iter().collect();
    for permission in declared_core.difference(&actual_core) {
        violations.push(format!(
            "core permission missing from capability: {permission}"
        ));
    }
    for permission in actual_core.difference(&declared_core) {
        violations.push(format!(
            "core permission not declared in contract: {permission}"
        ));
    }

    let Some(declared_plugin) = kind["pluginPermissions"].as_array() else {
        violations.push(format!(
            "window kind {kind_id} must declare pluginPermissions"
        ));
        return violations;
    };
    for declared in declared_plugin {
        if !actual_plugin.contains(declared) {
            violations.push(format!(
                "plugin permission missing or changed: {}",
                permission_identifier(declared).unwrap_or("<missing identifier>")
            ));
        }
    }
    for actual in &actual_plugin {
        if !declared_plugin.contains(actual) {
            violations.push(format!(
                "plugin permission not declared in contract: {}",
                permission_identifier(actual).unwrap_or("<missing identifier>")
            ));
        }
    }
    violations
}

fn parse_csp(policy: &str) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let mut directives = BTreeMap::new();
    for raw in policy.split(';') {
        let text = raw.trim();
        if text.is_empty() {
            continue;
        }
        let mut parts = text.split_whitespace();
        let name = parts.next().expect("non-empty directive").to_string();
        let values: BTreeSet<String> = parts.map(str::to_string).collect();
        if directives.insert(name.clone(), values).is_some() {
            return Err(format!("duplicate CSP directive: {name}"));
        }
    }
    Ok(directives)
}

#[test]
fn tool_key_contract_matches_the_rust_registry() {
    let manifest: Value = serde_json::from_str(TOOL_KEYS_JSON).expect("parse ToolKey contract");
    let contract = json_strings(&manifest["items"]);
    let rust_keys = crate::models::tool::ToolKey::ALL
        .into_iter()
        .map(|key| key.as_str().to_string())
        .collect::<Vec<_>>();

    assert_eq!(contract, rust_keys);
}

#[test]
fn tauri_csp_defines_production_and_development_policies() {
    let config: Value = serde_json::from_str(TAURI_CONFIG_JSON).expect("parse tauri config");
    let security = &config["app"]["security"];
    let production = security["csp"]
        .as_str()
        .expect("production CSP is configured");
    let development = security["devCsp"]
        .as_str()
        .expect("development CSP is configured");

    for policy in [production, development] {
        for directive in [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "worker-src 'self' blob:",
            "ipc:",
            "http://ipc.localhost",
        ] {
            assert!(
                policy.contains(directive),
                "missing {directive} in {policy}"
            );
        }
    }
    assert!(development.contains("http://localhost:1420"));
    assert!(development.contains("ws://localhost:1420"));
}

#[test]
fn content_kind_contract_matches_rust_serialization() {
    use crate::models::workspace_layout::WorkspacePaneContentRef;

    let contract: Value =
        serde_json::from_str(CONTENT_KINDS_JSON).expect("parse content kind contract");
    let api_versions: Value =
        serde_json::from_str(API_VERSIONS_JSON).expect("parse api versions contract");
    let adapter_api_version = api_versions["items"]
        .as_array()
        .expect("api version items")
        .iter()
        .find(|item| item["id"] == "workspaceContentAdapter")
        .expect("workspaceContentAdapter entry");
    assert_eq!(adapter_api_version["version"], 3);
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

    assert_eq!(item_ids(&contract), serialized_kinds);
}

#[test]
fn window_kind_contract_matches_rust_registry() {
    use crate::models::window_kind::{window_kind_of, WindowKind};

    let manifest: Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse WindowKind contract");
    let kinds = manifest["items"]
        .as_array()
        .expect("window kinds must be an array");
    for kind in kinds {
        let id = kind["id"].as_str().expect("window kind needs an id");
        let label = kind["label"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "{}8e783338-f464-4b10-b15e-b534748c6241",
                    kind["labelPrefix"]
                        .as_str()
                        .expect("window kind needs a label rule")
                )
            });
        let expected = match id {
            "main" => WindowKind::Main,
            "terminal" => WindowKind::Terminal,
            "workspaceContent" => WindowKind::WorkspaceContent,
            _ => panic!("unregistered Rust window kind: {id}"),
        };
        assert_eq!(window_kind_of(&label), Some(expected), "{id}");
    }
}

#[test]
fn app_command_contract_matches_the_registered_handler() {
    let commands: Vec<String> = app_command_names();
    let command_set: HashSet<&str> = commands.iter().map(String::as_str).collect();
    assert_eq!(commands.len(), command_set.len(), "duplicate app command");

    let handler_commands =
        sorted_strings(parse_handler_commands(LIB_RS).expect("parse generate_handler!"));
    assert_eq!(sorted_strings(commands.clone()), handler_commands);

    // 契约中的每个命令在 src/commands/*.rs 里恰好有一个紧跟 #[tauri::command] 的 pub fn。
    let commands_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("commands");
    let mut found: Vec<String> = Vec::new();
    for entry in fs::read_dir(commands_dir).expect("read commands directory") {
        let path = entry.expect("read commands entry").path();
        if path.extension().and_then(|value| value.to_str()) != Some("rs") {
            continue;
        }
        let source = fs::read_to_string(&path).expect("read command source");
        found.extend(
            tauri_command_functions(&source)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display())),
        );
    }
    for command in &commands {
        let count = found.iter().filter(|name| *name == command).count();
        assert_eq!(
            count, 1,
            "{command} must be defined exactly once with #[tauri::command]"
        );
    }
    let extra: Vec<&String> = found
        .iter()
        .filter(|name| !command_set.contains(name.as_str()))
        .collect();
    assert!(
        extra.is_empty(),
        "#[tauri::command] functions missing from the contract: {extra:?}"
    );
}

#[test]
fn window_kind_contract_matches_capabilities() {
    let manifest: Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kind contract");
    assert_eq!(manifest["formatVersion"].as_u64(), Some(1));
    let kinds = manifest["items"]
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

    let app_commands: Vec<String> = app_command_names();
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

        let violations = capability_contract_violations(kind, &capability, &app_commands);
        assert!(
            violations.is_empty(),
            "capability {capability_id} violates the window contract: {violations:?}"
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

fn real_capability(file: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("capabilities")
        .join(file);
    serde_json::from_str(&fs::read_to_string(path).expect("read capability file"))
        .expect("parse capability file")
}

fn kind_of(manifest: &Value, id: &str) -> Value {
    manifest["items"]
        .as_array()
        .expect("window kinds must be an array")
        .iter()
        .find(|kind| kind["id"] == id)
        .unwrap_or_else(|| panic!("window kind {id} is not declared"))
        .clone()
}

#[test]
fn handler_parser_ignores_comments_and_rejects_malformed_entries() {
    // 1. 行注释与块注释里的条目不算注册
    let commented = "generate_handler![\n commands::a::one,\n // commands::a::secret,\n /* commands::a::two, */ commands::b::three,\n]";
    assert_eq!(
        parse_handler_commands(commented).expect("commented fixture"),
        vec!["one".to_string(), "three".to_string()]
    );
    // 2. 带属性的条目被拒绝
    assert!(parse_handler_commands(
        "generate_handler![\n #[cfg(debug_assertions)] commands::x::y,\n]"
    )
    .is_err());
    // 3. 末尾逗号可以接受，没有末尾逗号也可以接受
    assert_eq!(
        parse_handler_commands("generate_handler![commands::a::one, commands::a::two,]")
            .expect("trailing comma"),
        vec!["one".to_string(), "two".to_string()]
    );
    assert_eq!(
        parse_handler_commands("generate_handler![commands::a::one]").expect("no comma"),
        vec!["one".to_string()]
    );
    // 4. 必须在 commands:: 下
    assert!(parse_handler_commands("generate_handler![crate::other::f]").is_err());
    // 补充：嵌套块注释、注释里含标记、缺标记、未闭合、空条目、过短路径
    assert_eq!(
        parse_handler_commands(
            "generate_handler![commands::a::one, /* outer /* nested */ commands::a::hidden, */ commands::a::two]"
        )
        .expect("nested block comment"),
        vec!["one".to_string(), "two".to_string()]
    );
    assert_eq!(
        parse_handler_commands(
            "// generate_handler![ commands::x::fake ]\ngenerate_handler![ commands::a::one ]"
        )
        .expect("marker inside a comment"),
        vec!["one".to_string()]
    );
    assert!(parse_handler_commands("no marker here").is_err());
    assert!(parse_handler_commands("generate_handler![commands::a::one").is_err());
    assert!(
        parse_handler_commands("generate_handler![commands::a::one,, commands::a::two]").is_err()
    );
    assert!(parse_handler_commands("generate_handler![]").is_err());
    assert!(parse_handler_commands("generate_handler![commands::one]").is_err());
    // 5. 真实 lib.rs
    let contract: Vec<String> = app_command_names();
    assert_eq!(
        sorted_strings(parse_handler_commands(LIB_RS).expect("parse lib.rs")),
        sorted_strings(contract)
    );
}

#[test]
fn capability_comparator_rejects_extra_plugin_and_object_permissions() {
    let manifest: Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kind contract");
    let app_commands: Vec<String> = app_command_names();
    let terminal_kind = kind_of(&manifest, "terminal");
    let content_kind = kind_of(&manifest, "workspaceContent");
    let main_kind = kind_of(&manifest, "main");
    let terminal = real_capability("terminal-window.json");
    let content = real_capability("workspace-content-window.json");
    let main = real_capability("default.json");

    // 基线：真实的三个 capability 没有违规
    assert_eq!(
        capability_contract_violations(&terminal_kind, &terminal, &app_commands),
        Vec::<String>::new()
    );
    assert_eq!(
        capability_contract_violations(&content_kind, &content, &app_commands),
        Vec::<String>::new()
    );
    assert_eq!(
        capability_contract_violations(&main_kind, &main, &app_commands),
        Vec::<String>::new()
    );

    // 负向夹具：每一项都必须报违规，且信息包含对应标识符
    let with_added = |base: &Value, added: Value| {
        let mut copy = base.clone();
        copy["permissions"]
            .as_array_mut()
            .expect("permissions")
            .push(added);
        copy
    };
    let cases: Vec<(&str, Value, Value, &str)> = vec![
        (
            "fs:default",
            terminal_kind.clone(),
            with_added(&terminal, json!("fs:default")),
            "fs:default",
        ),
        (
            "shell object",
            terminal_kind.clone(),
            with_added(
                &terminal,
                json!({"identifier": "shell:allow-execute", "allow": [{"name": "x"}]}),
            ),
            "shell:allow-execute",
        ),
        (
            "missing command",
            terminal_kind.clone(),
            {
                let mut copy = terminal.clone();
                copy["permissions"]
                    .as_array_mut()
                    .expect("permissions")
                    .retain(|permission| permission != "allow-write-pty-session");
                copy
            },
            "write_pty_session",
        ),
        (
            "extra core permission",
            content_kind.clone(),
            with_added(&content, json!("core:window:allow-set-focus")),
            "core:window:allow-set-focus",
        ),
        (
            "altered opener url",
            main_kind.clone(),
            {
                let mut copy = main.clone();
                for permission in copy["permissions"].as_array_mut().expect("permissions") {
                    if permission["identifier"] == "opener:allow-open-url" {
                        permission["allow"][0]["url"] = json!("https://example.com");
                    }
                }
                copy
            },
            "opener:allow-open-url",
        ),
        (
            "default permission set on a child window",
            terminal_kind.clone(),
            with_added(&terminal, json!("dialog:default")),
            "dialog:default",
        ),
    ];
    for (name, kind, capability, identifier) in cases {
        let violations = capability_contract_violations(&kind, &capability, &app_commands);
        assert!(!violations.is_empty(), "{name}: no violation reported");
        assert!(
            violations
                .iter()
                .any(|violation| violation.contains(identifier)),
            "{name}: no violation mentions {identifier}: {violations:?}"
        );
    }
}

#[test]
fn content_kind_contract_covers_every_known_variant() {
    use crate::models::workspace_layout::WorkspacePaneContentRef;

    // 新增变体会让下面的 match 编译失败：必须同步 contracts/content-kinds.json、
    // 前端 adapter 与规格。
    fn sample(variant: &WorkspacePaneContentRef) -> Option<(&'static str, Value)> {
        match variant {
            WorkspacePaneContentRef::Pty { .. } => {
                Some(("pty", json!({"kind": "pty", "slotId": "s"})))
            }
            WorkspacePaneContentRef::File { .. } => {
                Some(("file", json!({"kind": "file", "documentId": "d"})))
            }
            WorkspacePaneContentRef::Unknown { .. } => None,
        }
    }
    let variants = [
        WorkspacePaneContentRef::Pty {
            slot_id: "s".to_string(),
        },
        WorkspacePaneContentRef::File {
            document_id: "d".to_string(),
        },
        WorkspacePaneContentRef::Unknown {
            original_kind: "x".to_string(),
            raw: Value::Null,
        },
    ];
    let samples: Vec<(&'static str, Value)> = variants.iter().filter_map(sample).collect();
    let contract: Value =
        serde_json::from_str(CONTENT_KINDS_JSON).expect("parse content kind contract");
    assert_eq!(
        sorted_strings(samples.iter().map(|(kind, _)| (*kind).to_string())),
        sorted_strings(item_ids(&contract))
    );
    for (kind, value) in &samples {
        let parsed: WorkspacePaneContentRef =
            serde_json::from_value(value.clone()).expect("deserialize known kind");
        assert!(
            !matches!(parsed, WorkspacePaneContentRef::Unknown { .. }),
            "{kind} deserialized as Unknown"
        );
    }
    let unknown: WorkspacePaneContentRef =
        serde_json::from_value(json!({"kind": "markdownPreview", "x": 1}))
            .expect("deserialize an unregistered kind");
    match &unknown {
        WorkspacePaneContentRef::Unknown { original_kind, .. } => {
            assert_eq!(original_kind, "markdownPreview");
        }
        other => panic!("unregistered kind must deserialize as Unknown: {other:?}"),
    }
    let round_trip = serde_json::to_value(&unknown).expect("serialize unknown kind");
    assert_eq!(round_trip["raw"]["x"], 1);
}

#[test]
fn csp_parser_rejects_duplicate_directives() {
    assert!(parse_csp("script-src 'self'; script-src 'none'").is_err());
    assert!(parse_csp("script-src 'self'; style-src 'self'").is_ok());
    let parsed = parse_csp(" default-src 'self' ;; img-src data: blob: ").expect("parse");
    assert_eq!(parsed.len(), 2);
    assert_eq!(
        parsed["img-src"],
        ["blob:", "data:"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
    );
}

#[test]
fn production_csp_matches_exact_directive_contract() {
    fn policy(entries: &[(&str, &[&str])]) -> BTreeMap<String, BTreeSet<String>> {
        entries
            .iter()
            .map(|(name, values)| {
                (
                    (*name).to_string(),
                    values.iter().map(|value| (*value).to_string()).collect(),
                )
            })
            .collect()
    }

    let config: Value = serde_json::from_str(TAURI_CONFIG_JSON).expect("parse tauri config");
    let security = &config["app"]["security"];
    let production =
        parse_csp(security["csp"].as_str().expect("production CSP")).expect("parse production CSP");
    let development = parse_csp(security["devCsp"].as_str().expect("development CSP"))
        .expect("parse development CSP");

    let expected_production = policy(&[
        ("default-src", &["'self'"]),
        ("script-src", &["'self'"]),
        ("style-src", &["'self'", "'unsafe-inline'"]),
        ("img-src", &["'self'", "data:", "blob:"]),
        ("font-src", &["'self'", "data:"]),
        ("worker-src", &["'self'", "blob:"]),
        ("connect-src", &["'self'", "ipc:", "http://ipc.localhost"]),
        ("object-src", &["'none'"]),
        ("base-uri", &["'none'"]),
        ("form-action", &["'none'"]),
    ]);
    assert_eq!(production, expected_production);

    let mut expected_development = expected_production.clone();
    expected_development
        .get_mut("script-src")
        .expect("script-src")
        .insert("'unsafe-eval'".to_string());
    let connect = expected_development
        .get_mut("connect-src")
        .expect("connect-src");
    connect.insert("http://localhost:1420".to_string());
    connect.insert("ws://localhost:1420".to_string());
    assert_eq!(development, expected_development);

    for value in production.values().flatten() {
        assert_ne!(value, "*");
        assert_ne!(value, "http:");
        assert_ne!(value, "https:");
        assert_ne!(value, "'unsafe-eval'");
        assert!(!value.contains("localhost:1420"), "{value}");
    }
    assert!(security
        .get("dangerousDisableAssetCspModification")
        .is_none());

    for overlay in [
        include_str!("../../tauri.macos.conf.json"),
        include_str!("../../tauri.windows.conf.json"),
        include_str!("../../tauri.offline.conf.json"),
    ] {
        let value: Value = serde_json::from_str(overlay).expect("parse config overlay");
        assert!(
            value["app"].get("security").is_none(),
            "platform or offline overlays must not override app.security"
        );
    }
}

#[test]
fn serde_lint_reports_known_bad_shapes() {
    use serde_lint::scan_serialize_items;

    // F1：外部标签枚举只有 rename_all，字段仍是 snake_case。
    let f1 = r#"#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum E { A { mime_type: String } }"#;
    let found = scan_serialize_items(f1, "fixture.rs");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].item, "E::A");
    assert!(found[0].detail.contains("mime_type"), "{found:?}");

    // F2：加上 rename_all_fields 后不报。
    let f2 = r#"#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum E { A { mime_type: String } }"#;
    assert_eq!(scan_serialize_items(f2, "fixture.rs"), Vec::new());

    // F3：没有 Serialize 不报。
    let f3 = "enum E { A { mime_type: String } }";
    assert_eq!(scan_serialize_items(f3, "fixture.rs"), Vec::new());

    // F4 / F4b：结构体含多词字段，有无 rename_all。
    let f4 = "#[derive(Serialize)]\nstruct S { mime_type: String }";
    let found = scan_serialize_items(f4, "fixture.rs");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].item, "S");
    let f4b = r#"#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct S { mime_type: String }"#;
    assert_eq!(scan_serialize_items(f4b, "fixture.rs"), Vec::new());

    // F5a / F5b：字段级 rename 豁免该字段。
    let f5a = r#"#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum E { A { #[serde(rename = "mimeType")] mime_type: String } }"#;
    assert_eq!(scan_serialize_items(f5a, "fixture.rs"), Vec::new());
    let f5b = r#"#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum E { A { #[serde(rename = "mimeType")] mime_type: String } }"#;
    assert_eq!(scan_serialize_items(f5b, "fixture.rs"), Vec::new());

    // 反向：测试模块里的类型不扫描。
    let in_tests =
        "#[cfg(test)]\nmod tests {\n    #[derive(Serialize)]\n    struct T { a_b: u8 }\n}\n";
    assert_eq!(scan_serialize_items(in_tests, "fixture.rs"), Vec::new());

    // 反向：测试模块里的字符串字面量 "{" 不能让花括号计数错位，模块之后的 F1 仍要被报出。
    let brace_in_string =
        format!("#[cfg(test)]\nmod tests {{\n    const X: &str = \"{{\";\n}}\n{f1}");
    let found = scan_serialize_items(&brace_in_string, "fixture.rs");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].item, "E::A");

    // 反向：原始字符串、字符字面量、注释里的花括号同样不影响计数。
    let tricky = format!(
        "#[cfg(test)]\nmod tests {{\n    const A: &str = r#\"}}}}\"#;\n    const B: char = '{{';\n    const C: char = '\\'';\n    // }}}}\n    /* }} */\n}}\n{f1}"
    );
    let found = scan_serialize_items(&tricky, "fixture.rs");
    assert_eq!(found.len(), 1, "{found:?}");
}

fn collect_rust_sources(directory: &Path, files: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(directory).expect("read source directory") {
        let path = entry.expect("read source entry").path();
        if path.is_dir() {
            collect_rust_sources(&path, files);
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            files.push(path);
        }
    }
}

#[test]
fn serialize_items_with_multiword_fields_declare_camel_case_renaming() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rust_sources(&source_root, &mut files);
    files.sort();
    println!("serde lint scanned {} rust files", files.len());
    assert!(
        files.len() >= 50,
        "serde lint scanned only {} files; is the source path wrong?",
        files.len()
    );

    let allowlist: Value =
        serde_json::from_str(SERDE_LINT_ALLOWLIST_JSON).expect("parse serde lint allowlist");
    let allowed: Vec<(String, String)> = allowlist["allow"]
        .as_array()
        .expect("allowlist.allow must be an array")
        .iter()
        .map(|entry| {
            (
                entry["item"].as_str().expect("allowlist item").to_string(),
                entry["reason"]
                    .as_str()
                    .expect("allowlist reason")
                    .to_string(),
            )
        })
        .collect();
    for (item, reason) in &allowed {
        assert!(
            !reason.trim().is_empty(),
            "allowlist entry {item} needs a reason"
        );
    }

    let mut reported: Vec<String> = Vec::new();
    let mut details: Vec<String> = Vec::new();
    for path in &files {
        let relative = path
            .strip_prefix(&source_root)
            .expect("file under src")
            .to_string_lossy()
            .replace('\\', "/");
        let source = fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        for violation in serde_lint::scan_serialize_items(&source, &relative) {
            let key = format!("{}::{}", violation.file, violation.item);
            if !allowed.iter().any(|(item, _)| *item == key) {
                details.push(format!(
                    "{} :: {} :: {}",
                    violation.file, violation.item, violation.detail
                ));
            }
            reported.push(key);
        }
    }
    for (item, _) in &allowed {
        assert!(
            reported.contains(item),
            "allowlist entry {item} is stale: the lint no longer reports it"
        );
    }
    assert!(
        details.is_empty(),
        "serde lint violations (Serialize items with multiword fields need camelCase renaming):\n{}",
        details.join("\n")
    );
}

#[test]
fn ipc_dto_variants_serialize_with_camel_case_field_names() {
    use std::collections::BTreeSet;

    let samples = fixtures::ipc_dto_samples();
    for dto in &samples {
        assert!(!dto.cases.is_empty(), "{} has no sample", dto.type_name);
        for (case, value) in &dto.cases {
            fixtures::assert_camel_case_keys(
                value,
                &format!("{}.{case}", dto.type_name),
                &["WorkspacePaneContentRef.unknown.raw"],
            );
        }
    }

    let find = |type_name: &str, case_name: &str| -> &Value {
        let dto = samples
            .iter()
            .find(|dto| dto.type_name == type_name)
            .unwrap_or_else(|| panic!("missing samples for {type_name}"));
        &dto.cases
            .iter()
            .find(|(case, _)| case == case_name)
            .unwrap_or_else(|| panic!("missing case {type_name}.{case_name}"))
            .1
    };
    let keys = |value: &Value| -> BTreeSet<String> {
        value
            .as_object()
            .expect("sample must be an object")
            .keys()
            .cloned()
            .collect()
    };
    let expected = |names: &[&str]| -> BTreeSet<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    };

    let image = find("ProjectFileOpenResult", "image");
    assert_eq!(keys(image), expected(&["kind", "mimeType", "base64Data"]));
    assert!(image.get("mime_type").is_none() && image.get("base64_data").is_none());
    let denied = find("ManagedUpdateStatus", "denied");
    assert_eq!(keys(denied), expected(&["status", "reasonKey"]));
    assert!(denied.get("reason_key").is_none());

    // 含 Option 字段的类型：Some 与 None 两种样本都存在，且 Some 的字段非 null、None 的字段为 null。
    let option_cases: &[(&str, &str, &str, &[&str])] = &[
        (
            "ProjectTextFileSaveResult",
            "savedWithWarning",
            "savedWithoutWarning",
            &["/warning"],
        ),
        (
            "PtyEvent",
            "exitedWithCode",
            "exitedWithoutCode",
            &["/exitCode"],
        ),
        (
            "PtySession",
            "endedFull",
            "runningMinimal",
            &["/endedAtMs", "/exitCode"],
        ),
        (
            "ExecutionTask",
            "failedFull",
            "runningMinimal",
            &["/finishedAtMs", "/exitCode", "/errorMessage"],
        ),
        (
            "LatestVersion",
            "latestFull",
            "latestMinimal",
            &["/latest", "/commitsBehind", "/error"],
        ),
        (
            "CliStatus",
            "availableFull",
            "missingMinimal",
            &[
                "/path",
                "/resolvedCommand",
                "/version",
                "/versionError",
                "/latestVersion",
            ],
        ),
        ("CacheStats", "stats", "statsEmpty", &["/newestEntryAtMs"]),
        (
            "WorkspaceLayoutStateRead",
            "readyFull",
            "missing",
            &["/revision", "/schemaVersion", "/updatedAtMs", "/layout"],
        ),
    ];
    for (type_name, some_case, none_case, pointers) in option_cases {
        for pointer in *pointers {
            let some = find(type_name, some_case)
                .pointer(pointer)
                .unwrap_or_else(|| panic!("{type_name}.{some_case} lacks {pointer}"));
            assert!(
                !some.is_null(),
                "{type_name}.{some_case}{pointer} must be Some"
            );
            let none = find(type_name, none_case)
                .pointer(pointer)
                .unwrap_or_else(|| panic!("{type_name}.{none_case} lacks {pointer}"));
            assert!(
                none.is_null(),
                "{type_name}.{none_case}{pointer} must be None"
            );
        }
    }
}

#[test]
fn golden_fixtures_match_serialized_dtos() {
    use std::collections::BTreeSet;

    const HINT: &str = "UPDATE_CONTRACT_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --locked golden_fixtures 重新生成";
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("contracts")
        .join("fixtures");
    // 只有显式设置环境变量才写文件；默认模式绝不创建或改写任何 fixture。
    let update = std::env::var_os("UPDATE_CONTRACT_FIXTURES").is_some();

    let mut expected_files = BTreeSet::new();
    for dto in fixtures::ipc_dto_samples() {
        let Some(file) = dto.fixture_file else {
            continue;
        };
        assert!(
            expected_files.insert(file.to_string()),
            "duplicate fixture file {file}"
        );
        let cases = dto
            .cases
            .iter()
            .map(|(name, value)| (name.as_str(), value.clone()))
            .collect();
        let expected = fixtures::render_fixture(&fixtures::golden_fixture(dto.type_name, cases));
        let path = directory.join(file);
        if update {
            fs::create_dir_all(&directory).expect("create fixture directory");
            fs::write(&path, &expected)
                .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
        }
        // Windows 的 autocrlf 检出会把仓库文件变成 CRLF，比较前归一为 LF。
        let actual = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {file}: {error}；{HINT}"))
            .replace("\r\n", "\n");
        if actual != expected {
            let line = actual
                .lines()
                .zip(expected.lines())
                .position(|(left, right)| left != right)
                .map_or_else(
                    || "长度不同".to_string(),
                    |index| format!("第 {} 行", index + 1),
                );
            panic!("fixture {file} 与 Rust 序列化结果不一致（{line}）；{HINT}");
        }
    }

    assert_eq!(expected_files.len(), 37, "fixture 映射表必须恰好 37 个文件");
    let found: BTreeSet<String> = fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("read fixture directory: {error}；{HINT}"))
        .map(|entry| entry.expect("read fixture entry").path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .map(|path| {
            path.file_name()
                .expect("fixture file name")
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(found, expected_files, "目录里的 fixture 与映射表不一致");
}

#[test]
fn handler_and_command_scanners_reject_unsupported_shapes() {
    // 带参数的命令属性同样被识别。
    assert_eq!(
        tauri_command_functions(
            "#[tauri::command(rename_all = \"snake_case\")]
pub async fn first() {}
#[tauri::command]
#[allow(unused)]
pub fn second() {}"
        )
        .expect("parameterized attribute"),
        vec!["first".to_string(), "second".to_string()]
    );
    // 注释里的命令属性不算，名字相近的属性不是命令属性。
    assert_eq!(
        tauri_command_functions(
            "// #[tauri::command]
// pub fn hidden() {}
#[tauri::command_x]
pub fn other() {}
#[tauri::command]
pub fn real() {}"
        )
        .expect("comments and lookalikes"),
        vec!["real".to_string()]
    );
    // 参数未闭合、属性后不是 pub fn，都必须报错而不是静默跳过。
    assert!(tauri_command_functions(
        "#[tauri::command(rename_all = \"x\"
pub fn a() {}"
    )
    .is_err());
    assert!(tauri_command_functions(
        "#[tauri::command]
fn private() {}"
    )
    .is_err());

    // 重复的 generate_handler! 标记必须报错（只看第一个会漏掉后面的注册）。
    assert!(parse_handler_commands(
        "generate_handler![commands::a::one]
generate_handler![commands::a::two]"
    )
    .is_err());

    // 字符串扫描器的前提被破坏时（字符字面量 '"'、原始字符串）必须报错。
    assert!(parse_handler_commands(
        "const Q: char = '\"';
generate_handler![commands::a::one]"
    )
    .is_err());
    assert!(parse_handler_commands(
        "const S: &str = r#\"x\"#;
generate_handler![commands::a::one]"
    )
    .is_err());
    assert!(tauri_command_functions(
        "const Q: char = '\"';
#[tauri::command]
pub fn a() {}"
    )
    .is_err());
    // 普通字符串、以 r 结尾的单词紧跟引号都不是原始字符串。
    assert!(reject_unsupported_literals("let error = \"for\";").is_ok());
}

#[test]
fn serde_lint_handles_generics_where_clauses_and_rename_all_forms() {
    use serde_lint::scan_serialize_items;

    // 泛型 + where 子句（含 Fn(u8) -> u8）的结构体不能被当成元组结构体漏掉。
    let generic_struct = r#"#[derive(Serialize)]
struct S<F> where F: Fn(u8) -> u8 { a_b: F }"#;
    let found = scan_serialize_items(generic_struct, "fixture.rs");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].item, "S");

    // 泛型枚举的结构体变体同样要检查。
    let generic_enum = "#[derive(Serialize)]
enum E<T> { A { a_b: T } }";
    let found = scan_serialize_items(generic_enum, "fixture.rs");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].item, "E::A");

    // 带 where 的元组结构体被跳过，并且后面的条目仍然被扫描到。
    let tuple_then_struct = r#"#[derive(Serialize)]
struct T<X>(X) where X: Clone;
#[derive(Serialize)]
struct S { a_b: u8 }"#;
    let found = scan_serialize_items(tuple_then_struct, "fixture.rs");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].item, "S");

    // rename_all(serialize = "camelCase") 的写法与 rename_all = "camelCase" 等价。
    let nested_form = r#"#[derive(Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "camelCase"))]
struct S { a_b: u8 }"#;
    assert_eq!(scan_serialize_items(nested_form, "fixture.rs"), Vec::new());

    // 变体级 rename_all 豁免该变体的字段。
    let variant_level = r#"#[derive(Serialize)]
enum E { #[serde(rename_all = "camelCase")] A { a_b: u8 } }"#;
    assert_eq!(
        scan_serialize_items(variant_level, "fixture.rs"),
        Vec::new()
    );

    // skip_serializing_if 不会豁免（字段仍会被序列化）；skip 会。
    let skip_if = r#"#[derive(Serialize)]
struct S { #[serde(skip_serializing_if = "Option::is_none")] a_b: Option<u8> }"#;
    assert_eq!(scan_serialize_items(skip_if, "fixture.rs").len(), 1);
    let skipped = r#"#[derive(Serialize)]
struct S { #[serde(skip)] a_b: u8 }"#;
    assert_eq!(scan_serialize_items(skipped, "fixture.rs"), Vec::new());
}

const ACCEPTANCE_GATE: &str = "#[cfg(feature = \"acceptance-hooks\")]";

/// 返回出现 `needle` 且“本行及其前 12 行”都没有验收 feature 门的行号（1 起算）。
fn find_ungated_marker_lines(source: &str, needle: &str) -> Vec<usize> {
    let lines: Vec<&str> = source.lines().collect();
    let mut violations = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !line.contains(needle) {
            continue;
        }
        let start = index.saturating_sub(12);
        let gated = lines[start..=index]
            .iter()
            .any(|candidate| candidate.contains(ACCEPTANCE_GATE));
        if !gated {
            violations.push(index + 1);
        }
    }
    violations
}

fn rust_source_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).expect("read source directory") {
        let path = entry.expect("read source entry").path();
        if path.is_dir() {
            files.extend(rust_source_files(&path));
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            files.push(path);
        }
    }
    files
}

/// 返回 `header` 所在行之后、下一个以 `[` 开头的行之前的文本。
fn toml_section<'a>(text: &'a str, header: &str) -> Option<&'a str> {
    let start = text.find(header)? + header.len();
    let rest = &text[start..];
    let mut offset = 0;
    for (index, line) in rest.split_inclusive('\n').enumerate() {
        // 第 0 段是 header 行的剩余部分，不是下一个段标题。
        if index > 0 && line.trim_start().starts_with('[') {
            return Some(&rest[..offset]);
        }
        offset += line.len();
    }
    Some(rest)
}

#[test]
fn acceptance_hooks_feature_is_opt_in_and_gated() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    // 检索串用 concat! 拼接，测试文件自己就不含完整字面量，不会命中自己。
    let marker = concat!("acceptance.", "force_destroy_windows");
    let menu_text = concat!("验收：强制销毁", "全部独立窗口");

    // ① feature 存在、是空列表，且不在 default 里。
    let cargo = fs::read_to_string(root.join("Cargo.toml")).expect("read Cargo.toml");
    let features =
        toml_section(&cargo, "[features]").expect("Cargo.toml must define a [features] section");
    assert!(
        features
            .lines()
            .any(|line| line.trim() == "acceptance-hooks = []"),
        "[features] must contain `acceptance-hooks = []`:\n{features}"
    );
    for line in features
        .lines()
        .filter(|line| line.trim_start().starts_with("default"))
    {
        assert!(
            !line.contains("acceptance-hooks"),
            "acceptance-hooks must not be a default feature: {line}"
        );
    }

    // ② 标记字符串与菜单文案只能出现在带 cfg 门的代码附近。
    let mut marker_occurrences = 0;
    for path in rust_source_files(&root.join("src")) {
        let source = fs::read_to_string(&path).expect("read Rust source");
        marker_occurrences += source.matches(marker).count();
        for needle in [marker, menu_text] {
            let violations = find_ungated_marker_lines(&source, needle);
            assert!(
                violations.is_empty(),
                "{} lines {violations:?} mention the acceptance hook without the feature gate within 12 lines",
                path.display()
            );
        }
    }
    // 防止扫描空转而“通过”：标记至少要在源码里出现一次。
    assert!(
        marker_occurrences >= 1,
        "the acceptance marker must exist (behind the gate) in src"
    );

    // ③ 发布与配置文件不得提到这个 feature。
    let mut guarded = vec![
        root.join("../.github/workflows/release.yml"),
        root.join("../package.json"),
    ];
    for entry in fs::read_dir(root).expect("read src-tauri directory") {
        let path = entry.expect("read src-tauri entry").path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name.starts_with("tauri") && name.ends_with(".conf.json") {
            guarded.push(path);
        }
    }
    for entry in fs::read_dir(root.join("capabilities")).expect("read capabilities directory") {
        let path = entry.expect("read capability entry").path();
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            guarded.push(path);
        }
    }
    for path in guarded {
        let text = fs::read_to_string(&path).expect("read guarded file");
        assert!(
            !text.contains("acceptance-hooks"),
            "{} must not mention the acceptance feature",
            path.display()
        );
    }
    assert!(
        !fs::read_to_string(root.join("tauri.conf.json"))
            .expect("read tauri.conf.json")
            .contains("acceptance"),
        "tauri.conf.json must not reference the acceptance feature"
    );
}

#[test]
fn acceptance_marker_scanner_flags_ungated_occurrences() {
    let gate = ACCEPTANCE_GATE;
    let needle = "NEEDLE";

    // 紧邻 cfg 门：通过。
    assert_eq!(
        find_ungated_marker_lines(&format!("{gate}\nconst A: &str = \"NEEDLE\";"), needle),
        Vec::<usize>::new()
    );
    // 没有 cfg 门：报告行号。
    assert_eq!(
        find_ungated_marker_lines("const A: &str = \"NEEDLE\";", needle),
        vec![1]
    );
    // 边界：cfg 在第 1 行、NEEDLE 在第 13 行，窗口（本行及其前 12 行）刚好包含 cfg。
    assert_eq!(
        find_ungated_marker_lines(&format!("{gate}{}NEEDLE", "\n".repeat(12)), needle),
        Vec::<usize>::new()
    );
    // 边界：NEEDLE 在第 14 行，cfg 落到窗口之外。
    assert_eq!(
        find_ungated_marker_lines(&format!("{gate}{}NEEDLE", "\n".repeat(13)), needle),
        vec![14]
    );
    // 两处出现，只有第二处没有门：只报第二处。
    assert_eq!(
        find_ungated_marker_lines(&format!("{gate}\nNEEDLE{}NEEDLE", "\n".repeat(20)), needle),
        vec![22]
    );
    // 反向：源码里没有 NEEDLE 时没有任何报告。
    assert_eq!(
        find_ungated_marker_lines("fn main() {}", needle),
        Vec::<usize>::new()
    );
}

#[test]
fn migrated_commands_use_the_unified_execution_helpers() {
    fn production(source: &str) -> &str {
        source.split("#[cfg(test)]").next().unwrap()
    }
    let fully_migrated = [
        ("session.rs", include_str!("../commands/session.rs")),
        ("files.rs", include_str!("../commands/files.rs")),
        ("cli_status.rs", include_str!("../commands/cli_status.rs")),
        ("install.rs", include_str!("../commands/install.rs")),
    ];
    for (name, source) in fully_migrated {
        let source = production(source);
        for forbidden in [
            "with_conn(",
            "with_cache(",
            "with_connection(",
            "with_cache_connection(",
            ".0.lock()",
            "spawn_blocking(",
        ] {
            assert!(
                !source.contains(forbidden),
                "commands/{name} must not contain `{forbidden}` after the migration"
            );
        }
    }

    let files = production(include_str!("../commands/files.rs"));
    assert!(files.contains("pub async fn grant_content_window_file"));
    assert!(!files.contains("pub fn grant_content_window_file"));

    let layout = production(include_str!("../commands/workspace_layout.rs"));
    for migrated in [
        "pub async fn get_workspace_layout",
        "pub async fn plan_apply_workspace_layout_preset",
        "pub async fn save_workspace_layout",
    ] {
        assert!(layout.contains(migrated), "missing `{migrated}`");
    }
    assert!(!layout.contains("pub fn get_workspace_layout"));
    assert!(!layout.contains("pub fn plan_apply_workspace_layout_preset"));
    assert!(!layout.contains("spawn_blocking("));

    let pty = production(include_str!("../commands/pty_session.rs"));
    assert!(
        !pty.contains("with_conn("),
        "create_pty_session must not use the legacy helper"
    );
    assert!(pty.contains("ensure_tool_configured"));
    assert!(pty.contains("open_ref("));
}

#[test]
fn pty_launch_validates_the_project_directory_exactly_once() {
    fn violations(source: &str, forbidden: &[&'static str]) -> Vec<&'static str> {
        forbidden
            .iter()
            .copied()
            .filter(|needle| source.contains(needle))
            .collect()
    }

    // The scan must be able to see a violation at all.
    assert_eq!(
        violations("fn f() { validate_path(x); }", &["validate_path("]),
        vec!["validate_path("]
    );

    let command = production_text(include_str!("../commands/pty_session.rs"));
    assert_eq!(
        command.matches("ProjectDirectory::open_ref(").count(),
        1,
        "create_pty_session opens the project exactly once"
    );
    assert_eq!(
        violations(
            &command,
            &[
                "validate_path(",
                "lookup_launch_directory(",
                "resolve_launch_directory(",
                "paths_equal(",
            ]
        ),
        Vec::<&str>::new()
    );

    for (name, source) in [
        (
            "pty_session_service.rs",
            include_str!("../services/pty_session_service.rs"),
        ),
        (
            "pty_session_service/flow.rs",
            include_str!("../services/pty_session_service/flow.rs"),
        ),
        (
            "pty_session_service/handoff.rs",
            include_str!("../services/pty_session_service/handoff.rs"),
        ),
        (
            "pty_session_service/input.rs",
            include_str!("../services/pty_session_service/input.rs"),
        ),
        (
            "pty_session_service/persistence.rs",
            include_str!("../services/pty_session_service/persistence.rs"),
        ),
        (
            "pty_session_service/ports.rs",
            include_str!("../services/pty_session_service/ports.rs"),
        ),
        (
            "pty_session_service/process.rs",
            include_str!("../services/pty_session_service/process.rs"),
        ),
        (
            "pty_session_service/registry.rs",
            include_str!("../services/pty_session_service/registry.rs"),
        ),
        (
            "pty_session_service/route.rs",
            include_str!("../services/pty_session_service/route.rs"),
        ),
        (
            "pty_session_service/session.rs",
            include_str!("../services/pty_session_service/session.rs"),
        ),
        (
            "pty_session_service/window.rs",
            include_str!("../services/pty_session_service/window.rs"),
        ),
    ] {
        let source = production_text(source);
        assert_eq!(
            violations(
                &source,
                &["paths_equal(", "directory_repo::get(", "validate_path("]
            ),
            Vec::<&str>::new(),
            "services/{name} must not validate the project directory again"
        );
    }
}

#[test]
fn create_pty_session_prepares_before_admitting_and_bounds_external_awaits() {
    /// Every marker must appear, in this order, and nothing may be awaited between the start
    /// permit and the blocking launch.
    fn check_order(body: &str) -> Result<(), String> {
        // Whitespace is normalized so rustfmt line breaks do not matter.
        let body = body
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace("( ", "(");
        let body = body.as_str();
        let mut at = 0;
        for marker in [
            "ProjectDirectory::open_ref(",
            "bounded(\"pty.session_belongs\"",
            "bounded(\"pty.resolve_payload\"",
            "admit(Operation::PtyStart)",
            "spawn_blocking(",
        ] {
            match body[at..].find(marker) {
                Some(found) => at += found + marker.len(),
                None => return Err(format!("`{marker}` is missing or out of order")),
            }
        }
        let admit = body.find("admit(Operation::PtyStart)").unwrap();
        let spawn = body[admit..].find("spawn_blocking(").unwrap() + admit;
        if body[admit..spawn].contains(".await") {
            return Err("an await sits between the start permit and the launch".to_string());
        }
        Ok(())
    }

    let command = production_text(include_str!("../commands/pty_session.rs"));
    let body = command
        .split("pub async fn create_pty_session")
        .nth(1)
        .expect("create_pty_session exists")
        .split("#[tauri::command]")
        .next()
        .unwrap();
    assert_eq!(check_order(body), Ok(()));

    // The check can see a violation: the permit taken before the payload is resolved.
    let misordered = "ProjectDirectory::open_ref(bounded(\"pty.session_belongs\" admit(Operation::PtyStart)                       bounded(\"pty.resolve_payload\" spawn_blocking(";
    assert!(check_order(misordered).is_err());
    let awaited = "ProjectDirectory::open_ref(bounded(\"pty.session_belongs\" bounded(\"pty.resolve_payload\"                    admit(Operation::PtyStart) x.await spawn_blocking(";
    // An external await without `bounded(` is a violation too.
    let unbounded = "ProjectDirectory::open_ref(\"pty.session_belongs\" bounded(\"pty.resolve_payload\"                      admit(Operation::PtyStart) spawn_blocking(";
    assert!(check_order(unbounded).is_err());
    assert!(check_order(awaited).is_err());
}

#[test]
fn execution_service_has_no_synchronous_database_access() {
    // Whitespace is stripped first so rustfmt line breaks (`state\n.0\n.lock()`) cannot hide a use.
    fn squash(source: &str) -> String {
        source.chars().filter(|c| !c.is_whitespace()).collect()
    }
    fn violations(source: &str) -> Vec<&'static str> {
        let source = squash(source);
        [
            "with_db(",
            "fnwith_db",
            ".0.lock()",
            "with_connection(",
            "with_conn(",
        ]
        .into_iter()
        .filter(|needle| source.contains(needle))
        .collect()
    }

    // The scan must be able to see a violation at all, including a formatted-apart one.
    assert!(violations("fn f() { with_db(app, |c| Ok(())) }").contains(&"with_db("));
    assert!(violations("let c = state\n    .0\n    .lock();").contains(&".0.lock()"));

    let source = production_text(include_str!("../services/execution_service.rs"));
    // The exit cleanup target runs on the exit thread and uses `Db::with_sync`; the whole
    // production text is scanned.
    assert_eq!(violations(&source), Vec::<&str>::new());
    let squashed = squash(&source);
    let calls = squashed.matches("db.call(").count() + squashed.matches("db_call(").count();
    assert!(
        calls >= 3,
        "database access goes through Db::call, found {calls}"
    );
}

// ---- m6-059: command execution policy (which commands may stay synchronous, which are migrated)

/// Commands that may stay synchronous: pure in-memory work or UI operations that must run on the
/// main thread. Each carries a `// sync:` reason comment between its attribute and its `fn`.
const SYNC_COMMANDS: [&str; 11] = [
    "acknowledge_pty_output",
    "report_pty_frontend_stage",
    "get_pty_session_window_status",
    "write_pty_session",
    "begin_pty_handoff",
    "stage_pty_handoff_snapshot",
    "cancel_pty_handoff",
    "set_tray_menu_labels",
    "revoke_content_window_file",
    "report_window_sync_failure",
    "take_startup_notices",
];

struct CommandInfo {
    name: String,
    is_async: bool,
    sync_reason: Option<String>,
    /// Signature and body.
    text: String,
}

fn tauri_commands(source: &str) -> Vec<CommandInfo> {
    let stripped = production_text(source);
    let lines: Vec<&str> = stripped.lines().collect();
    let mut commands = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim() != "#[tauri::command]" {
            index += 1;
            continue;
        }
        let mut sync_reason = None;
        let mut cursor = index + 1;
        while cursor < lines.len() {
            let line = lines[cursor].trim();
            if let Some(reason) = line.strip_prefix("// sync:") {
                sync_reason = Some(reason.trim().to_string());
            } else if line.starts_with("pub fn ") || line.starts_with("pub async fn ") {
                break;
            }
            cursor += 1;
        }
        if cursor >= lines.len() {
            break;
        }
        let header = lines[cursor].trim();
        let is_async = header.starts_with("pub async fn ");
        let name = header
            .trim_start_matches("pub async fn ")
            .trim_start_matches("pub fn ")
            .split('(')
            .next()
            .unwrap()
            .trim()
            .to_string();
        let mut text = String::new();
        let mut depth = 0usize;
        let mut opened = false;
        for line in &lines[cursor..] {
            for character in line.chars() {
                match character {
                    '{' => {
                        depth += 1;
                        opened = true;
                    }
                    '}' => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            text.push_str(line);
            text.push('\n');
            if opened && depth == 0 {
                break;
            }
        }
        commands.push(CommandInfo {
            name,
            is_async,
            sync_reason,
            text,
        });
        index = cursor + 1;
    }
    commands
}

fn command_files() -> Vec<(String, String)> {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&directory).expect("commands directory") {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if path.extension().is_some_and(|extension| extension == "rs") && name != "mod.rs" {
            let text = std::fs::read_to_string(&path)
                .unwrap()
                .replace("\r\n", "\n");
            files.push((name, text));
        }
    }
    files.sort();
    files
}

/// Whether a command's text touches storage, the filesystem or blocking primitives.
fn touches_storage(text: &str) -> bool {
    ["Db>", "std::fs", "canonicalize", "spawn_blocking", ".call("]
        .iter()
        .any(|needle| text.contains(needle))
}

#[test]
fn sync_commands_are_the_documented_in_memory_whitelist() {
    let mut sync_names = Vec::new();
    for (file, source) in command_files() {
        for command in tauri_commands(&source) {
            if command.is_async {
                continue;
            }
            assert!(
                SYNC_COMMANDS.contains(&command.name.as_str()),
                "{file}: `{}` is synchronous but not on the whitelist",
                command.name
            );
            let reason = command.sync_reason.as_deref().unwrap_or("");
            assert!(
                !reason.is_empty(),
                "{file}: `{}` needs a `// sync: <reason>` comment",
                command.name
            );
            assert!(
                !touches_storage(&command.text),
                "{file}: synchronous `{}` must not touch storage or blocking primitives",
                command.name
            );
            sync_names.push(command.name);
        }
    }
    sync_names.sort();
    let mut expected: Vec<String> = SYNC_COMMANDS.iter().map(|name| name.to_string()).collect();
    expected.sort();
    assert_eq!(sync_names, expected);

    // The check can see a violation: a synchronous command that reaches the database.
    assert!(touches_storage(
        "pub fn f(state: State<'_, Db>) -> Result<(), AppError> { Ok(()) }"
    ));
}

#[test]
fn migrated_commands_use_call_or_blocking() {
    const MIGRATED: &[(&str, &str)] = &[
        ("app_setting.rs", "get_close_behavior"),
        ("app_setting.rs", "set_close_behavior"),
        ("directory.rs", "list_directories"),
        ("directory.rs", "add_directory"),
        ("directory.rs", "update_directory"),
        ("directory.rs", "set_directory_pinned"),
        ("directory.rs", "reorder_directories"),
        ("directory.rs", "open_project_directory"),
        ("directory.rs", "remove_directory"),
        ("launch_history.rs", "list_launch_history"),
        ("launch_history.rs", "clear_launch_history"),
        ("launch_history.rs", "get_launch_history_limit"),
        ("launch_history.rs", "set_launch_history_limit"),
        ("workspace_layout.rs", "list_workspace_layout_presets"),
        ("workspace_layout.rs", "create_workspace_layout_preset"),
        ("workspace_layout.rs", "update_workspace_layout_preset"),
        ("workspace_layout.rs", "rename_workspace_layout_preset"),
        ("workspace_layout.rs", "delete_workspace_layout_preset"),
        ("workspace_layout.rs", "reset_workspace_layout"),
        ("execution.rs", "list_execution_tasks"),
        ("execution.rs", "get_execution_task"),
        ("execution.rs", "clear_execution_task"),
        ("execution.rs", "clear_execution_history"),
        ("pty_session.rs", "resize_pty_session"),
        ("pty_session.rs", "terminate_pty_session"),
        ("pty_session.rs", "reattach_pty_session"),
        ("pty_session.rs", "complete_pty_handoff"),
        ("pty_session.rs", "finalize_pty_handoff"),
    ];
    const PTY_CONTROL_COMMANDS: &[&str] = &[
        "resize_pty_session",
        "terminate_pty_session",
        "reattach_pty_session",
        "complete_pty_handoff",
        "finalize_pty_handoff",
    ];
    let files = command_files();
    for (file, name) in MIGRATED {
        let source = &files
            .iter()
            .find(|(candidate, _)| candidate == file)
            .unwrap_or_else(|| panic!("{file} is missing"))
            .1;
        let command = tauri_commands(source)
            .into_iter()
            .find(|command| command.name == *name)
            .unwrap_or_else(|| panic!("{file}: command `{name}` not found"));
        assert!(command.is_async, "{file}: `{name}` must be async");
        assert!(
            command.text.contains(".call(") || command.text.contains("blocking("),
            "{file}: `{name}` must use Db::call, CacheDb::call or blocking"
        );
        for legacy in [
            "with_conn(",
            "with_cache(",
            "with_connection(",
            "with_cache_connection(",
            "spawn_blocking(",
        ] {
            assert!(
                !command.text.contains(legacy),
                "{file}: `{name}` still uses `{legacy}`"
            );
        }
        if PTY_CONTROL_COMMANDS.contains(name) {
            assert!(
                command.text.contains("budgets::PTY_CONTROL"),
                "{file}: `{name}` must use the PTY_CONTROL budget"
            );
        }
    }

    // `cancel_execution_task` delegates to the execution manager (whose database access is async
    // inside the manager), so only its asynchrony is pinned here.
    let execution = &files
        .iter()
        .find(|(candidate, _)| candidate == "execution.rs")
        .unwrap()
        .1;
    let cancel = tauri_commands(execution)
        .into_iter()
        .find(|command| command.name == "cancel_execution_task")
        .expect("cancel_execution_task exists");
    assert!(cancel.is_async);
}

#[test]
fn main_window_label_matches_every_tauri_config() {
    let main = crate::models::window_kind::main_window_label();
    for (name, raw) in [
        ("tauri.conf.json", include_str!("../../tauri.conf.json")),
        (
            "tauri.macos.conf.json",
            include_str!("../../tauri.macos.conf.json"),
        ),
    ] {
        let config: serde_json::Value = serde_json::from_str(raw).unwrap();
        let windows = config["app"]["windows"]
            .as_array()
            .unwrap_or_else(|| panic!("{name} must declare app.windows"));
        assert_eq!(windows.len(), 1, "{name} declares exactly one window");
        assert_eq!(
            windows[0]["label"], main,
            "{name} must label its window explicitly with the contract main label"
        );
    }
    for (name, raw) in [
        (
            "tauri.windows.conf.json",
            include_str!("../../tauri.windows.conf.json"),
        ),
        (
            "tauri.offline.conf.json",
            include_str!("../../tauri.offline.conf.json"),
        ),
    ] {
        let config: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert!(
            config["app"]["windows"].is_null(),
            "{name} must not override app.windows (arrays are replaced wholesale)"
        );
    }
}

#[test]
fn macos_window_config_repeats_the_base_window_fields() {
    let base: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let macos: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.macos.conf.json")).unwrap();
    let base_window = &base["app"]["windows"][0];
    let macos_window = &macos["app"]["windows"][0];
    for field in [
        "label",
        "title",
        "width",
        "height",
        "minWidth",
        "minHeight",
        "dragDropEnabled",
    ] {
        assert!(
            !base_window[field].is_null(),
            "base window must define {field}"
        );
        assert_eq!(
            macos_window[field], base_window[field],
            "the macOS window replaces the whole array, so it must repeat {field}"
        );
    }
}

#[test]
fn service_code_does_not_branch_on_window_label_literals() {
    for (name, source) in [
        (
            "pty_session_service.rs",
            include_str!("../services/pty_session_service.rs"),
        ),
        (
            "pty_session_service/flow.rs",
            include_str!("../services/pty_session_service/flow.rs"),
        ),
        (
            "pty_session_service/handoff.rs",
            include_str!("../services/pty_session_service/handoff.rs"),
        ),
        (
            "pty_session_service/input.rs",
            include_str!("../services/pty_session_service/input.rs"),
        ),
        (
            "pty_session_service/persistence.rs",
            include_str!("../services/pty_session_service/persistence.rs"),
        ),
        (
            "pty_session_service/ports.rs",
            include_str!("../services/pty_session_service/ports.rs"),
        ),
        (
            "pty_session_service/process.rs",
            include_str!("../services/pty_session_service/process.rs"),
        ),
        (
            "pty_session_service/registry.rs",
            include_str!("../services/pty_session_service/registry.rs"),
        ),
        (
            "pty_session_service/route.rs",
            include_str!("../services/pty_session_service/route.rs"),
        ),
        (
            "pty_session_service/session.rs",
            include_str!("../services/pty_session_service/session.rs"),
        ),
        (
            "pty_session_service/window.rs",
            include_str!("../services/pty_session_service/window.rs"),
        ),
        (
            "content_window_grants.rs",
            include_str!("../services/content_window_grants.rs"),
        ),
    ] {
        let source = production_text(source);
        for forbidden in [
            "\"main\"",
            "starts_with(\"terminal-\")",
            "starts_with(\"workspace-content-\")",
        ] {
            assert!(
                !source.contains(forbidden),
                "services/{name} must not contain {forbidden}; use models::window_kind helpers"
            );
        }
    }
}

// ---- m6-033: error code and event contracts (red phase) ----

const ERROR_CODES_JSON: &str = include_str!("../../../contracts/error-codes.json");
const EVENTS_JSON: &str = include_str!("../../../contracts/events.json");

fn string_array(value: &serde_json::Value, what: &str) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{what} must be an array"))
        .iter()
        .map(|item| {
            item.as_str()
                .unwrap_or_else(|| panic!("{what} items must be strings"))
                .to_string()
        })
        .collect()
}

/// Removes every `#[cfg(test)]` item (up to its `;` or its first brace block), wherever it
/// appears, so production code placed after a test-only const or helper is still scanned.
/// Only an attribute that starts its own line counts; the same text inside a string literal
/// (for example the splitter in `commands/backup.rs`) is left alone.
fn production_text(source: &str) -> String {
    const ATTRIBUTE: &str = "#[cfg(test)]";
    let mut out = String::new();
    let mut rest = source;
    while let Some(at) = rest.find(ATTRIBUTE) {
        let line_start = rest[..at].rfind('\n').map_or(0, |newline| newline + 1);
        if !rest[line_start..at].trim().is_empty() {
            out.push_str(&rest[..at + ATTRIBUTE.len()]);
            rest = &rest[at + ATTRIBUTE.len()..];
            continue;
        }
        out.push_str(&rest[..at]);
        let item = &rest[at + ATTRIBUTE.len()..];
        let end = item_end(item).expect("cfg(test) item ends with a `;` or a brace block");
        rest = &item[end..];
    }
    out.push_str(rest);
    out
}

/// Byte offset just past a `#[cfg(test)]` item: its first top-level `;`, or the block it opens.
/// Semicolons inside parentheses or brackets (array types, signatures) do not end the item.
fn item_end(item: &str) -> Option<usize> {
    let mut nesting = 0usize;
    for (i, byte) in item.bytes().enumerate() {
        match byte {
            b'(' | b'[' => nesting += 1,
            b')' | b']' => nesting = nesting.saturating_sub(1),
            b';' if nesting == 0 => return Some(i + 1),
            b'{' if nesting == 0 => return block_end(item, i),
            _ => {}
        }
    }
    None
}

/// Byte offset just past the brace that closes the block opened at `open`.
/// Braces inside string, raw string, char literals and comments are not counted.
fn block_end(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'r' if i + 1 < bytes.len() && (bytes[i + 1] == b'"' || bytes[i + 1] == b'#') => {
                let hashes = bytes[i + 1..]
                    .iter()
                    .take_while(|byte| **byte == b'#')
                    .count();
                let quote = i + 1 + hashes;
                if quote < bytes.len() && bytes[quote] == b'"' {
                    let mut closing = vec![b'"'];
                    closing.extend(std::iter::repeat(b'#').take(hashes));
                    match text[quote + 1..].find(std::str::from_utf8(&closing).unwrap()) {
                        Some(offset) => i = quote + 1 + offset + closing.len() - 1,
                        None => return None,
                    }
                }
            }
            b'\'' => {
                if i + 3 < bytes.len() && bytes[i + 1] == b'\\' {
                    match text[i + 3..].find('\'') {
                        Some(offset) => i = i + 3 + offset,
                        None => return None,
                    }
                } else if i + 2 < bytes.len() && bytes[i + 2] == b'\'' {
                    i += 2;
                }
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => match text[i..].find('\n') {
                Some(offset) => i += offset,
                None => return None,
            },
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => match text[i + 2..].find("*/") {
                Some(offset) => i = i + 2 + offset + 1,
                None => return None,
            },
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Every non-test Rust source file under `src/` as (relative path, production text).
/// `contracts/` is skipped: it is compiled only for tests and holds frozen fixtures.
fn production_rust_sources() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                out.push(path);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&root, &mut files);
    files.sort();
    files
        .into_iter()
        .filter_map(|path| {
            let relative = path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if relative.starts_with("contracts/") {
                return None;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            Some((relative, production_text(&text)))
        })
        .collect()
}

#[test]
fn error_code_contract_matches_rust_registry() {
    let contract: serde_json::Value = serde_json::from_str(ERROR_CODES_JSON).unwrap();
    let mut codes = string_array(&contract["items"], "codes");
    codes.sort();
    let mut registry: Vec<String> = crate::error_codes::ALL
        .iter()
        .map(|code| code.as_str().to_string())
        .collect();
    registry.sort();
    assert_eq!(
        codes, registry,
        "contracts/error-codes.json codes must equal error_codes::ALL"
    );

    let dotted = |code: &str| {
        let mut parts = code.split('.');
        let first = parts.next().unwrap_or("");
        let rest: Vec<&str> = parts.collect();
        !first.is_empty()
            && first.chars().all(|c| c.is_ascii_lowercase())
            && !rest.is_empty()
            && rest.iter().all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            })
    };
    for code in codes
        .iter()
        .chain(string_array(&contract["frontendCodes"], "frontendCodes").iter())
        .chain(string_array(&contract["reservedCodes"], "reservedCodes").iter())
    {
        assert!(dotted(code), "{code} must be a domain.reason code");
    }

    let aliases = contract["aliases"]
        .as_object()
        .expect("aliases must be an object");
    assert!(!aliases.is_empty());
    for (alias, target) in aliases {
        let target = target.as_str().unwrap();
        assert!(
            codes.iter().any(|code| code == target),
            "alias {alias} targets unknown code {target}"
        );
        assert!(
            !codes.iter().any(|code| code == alias),
            "alias {alias} must not also be a code"
        );
    }
    for code in string_array(&contract["frontendCodes"], "frontendCodes")
        .iter()
        .chain(string_array(&contract["reservedCodes"], "reservedCodes").iter())
    {
        assert!(
            !codes.contains(code),
            "{code} must not be listed as a backend code"
        );
    }
}

#[test]
fn app_errors_use_registered_code_constants() {
    let sources = production_rust_sources();
    assert!(
        sources.len() > 50,
        "the scanner must read the production tree, found {}",
        sources.len()
    );
    for (path, text) in sources {
        for needle in ["AppError::coded(", "AppError::coded_with_params("] {
            let mut rest = text.as_str();
            while let Some(index) = rest.find(needle) {
                let after = rest[index + needle.len()..].trim_start();
                assert!(
                    !after.starts_with('"'),
                    "{path}: `{needle}` must take an error_codes constant, not a string literal"
                );
                rest = &rest[index + needle.len()..];
            }
        }
    }
}

/// `pty.handoff_expired` → `PtyHandoffExpired`: the variant name the registry generates.
fn variant_name_of(code: &str) -> String {
    code.split(['.', '_'])
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// Whether a non-test source outside the registry names `ErrorCode::<variant>` as a whole word.
fn has_producer_outside_registry(variant: &str, sources: &[(String, String)]) -> bool {
    let needle = format!("ErrorCode::{variant}");
    sources
        .iter()
        .filter(|(path, _)| path != "error_codes.rs")
        .any(|(_, text)| {
            text.match_indices(&needle).any(|(index, _)| {
                !text[index + needle.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            })
        })
}

/// Whether a production line builds an error without a code: `AppError::msg(`, or a literal code.
fn raw_error_construction(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for needle in [
        "AppError::msg(",
        "AppError::coded(",
        "AppError::coded_with_params(",
    ] {
        for (index, _) in text.match_indices(needle) {
            let after = text[index + needle.len()..].trim_start();
            if needle == "AppError::msg(" || after.starts_with('"') {
                found.push(needle.to_string());
            }
        }
    }
    found
}

#[test]
#[ignore = "待修复 077c：AppError::msg 在 077c 收口时删除"]
fn error_codes_are_never_raw_strings() {
    let sources = production_rust_sources();
    for (path, text) in &sources {
        assert!(
            raw_error_construction(text).is_empty(),
            "{path} builds an error without a registered code"
        );
    }
    // Reverse self-check: the scanner reports the two forms it is meant to catch.
    assert_eq!(raw_error_construction("AppError::msg(\"m\")").len(), 1);
    assert_eq!(
        raw_error_construction("AppError::coded(\"pty_x\", \"m\")").len(),
        1
    );
}

/// Codes registered before their producer lands. Each entry names the unit that adds the producer;
/// the test fails once a producer exists, so the entry is removed in that unit.
const PRODUCER_PENDING: &[(&str, &str)] = &[];

#[test]
fn every_error_code_has_a_producer_outside_the_registry() {
    let sources = production_rust_sources();
    let variants: Vec<String> = crate::error_codes::ALL
        .iter()
        .map(|code| variant_name_of(code.as_str()))
        .collect();
    // A stale exemption (misspelled or removed variant) must not pass silently.
    for (name, _) in PRODUCER_PENDING {
        assert!(
            variants.iter().any(|variant| variant == name),
            "PRODUCER_PENDING names {name}, which is not a registered variant"
        );
    }
    for code in crate::error_codes::ALL {
        let variant = variant_name_of(code.as_str());
        let pending = PRODUCER_PENDING.iter().any(|(name, _)| *name == variant);
        let produced = has_producer_outside_registry(&variant, &sources);
        if pending {
            assert!(
                !produced,
                "{variant} now has a producer: remove it from PRODUCER_PENDING"
            );
        } else {
            assert!(
                produced,
                "{} ({variant}) is registered but nothing outside error_codes.rs produces it",
                code.as_str()
            );
        }
    }
    // Reverse self-check: a variant nothing produces is reported as unproduced.
    assert!(!has_producer_outside_registry("NoSuchVariant", &sources));
}

#[test]
fn reserved_and_frontend_codes_have_no_rust_producer() {
    let contract: serde_json::Value = serde_json::from_str(ERROR_CODES_JSON).unwrap();
    let mut unproduced = string_array(&contract["reservedCodes"], "reservedCodes");
    unproduced.extend(string_array(&contract["frontendCodes"], "frontendCodes"));
    assert!(!unproduced.is_empty());
    for (path, text) in production_rust_sources() {
        for code in &unproduced {
            assert!(
                !text.contains(&format!("\"{code}\"")),
                "{path} spells the non-backend code {code}"
            );
        }
    }
}

#[test]
fn event_contract_matches_rust_event_constants() {
    let contract: serde_json::Value = serde_json::from_str(EVENTS_JSON).unwrap();
    let events = contract["items"]
        .as_array()
        .expect("events must be an array");
    let mut rust_emitted: Vec<String> = events
        .iter()
        .filter(|event| {
            string_array(&event["allowedSourceKinds"], "allowedSourceKinds")
                .contains(&"rust".to_string())
        })
        .map(|event| event["name"].as_str().unwrap().to_string())
        .collect();
    rust_emitted.sort();
    let mut constants: Vec<String> = crate::events::ALL
        .iter()
        .map(|name| name.to_string())
        .collect();
    constants.sort();
    assert_eq!(
        rust_emitted, constants,
        "events emitted by Rust must equal events::ALL"
    );
}

#[test]
fn rust_event_names_are_only_spelled_in_the_events_module() {
    let contract: serde_json::Value = serde_json::from_str(EVENTS_JSON).unwrap();
    let sources = production_rust_sources();
    assert!(
        sources.len() > 50,
        "the scanner must read the production tree, found {}",
        sources.len()
    );
    for event in contract["items"].as_array().unwrap() {
        let name = event["name"].as_str().unwrap();
        if !string_array(&event["allowedSourceKinds"], "allowedSourceKinds")
            .contains(&"rust".to_string())
        {
            continue;
        }
        let spelled: Vec<&String> = sources
            .iter()
            .filter(|(_, text)| text.contains(&format!("\"{name}\"")))
            .map(|(path, _)| path)
            .collect();
        assert_eq!(
            spelled,
            vec!["events.rs"],
            "{name} must be spelled only in events.rs, found in {spelled:?}"
        );
    }
    assert!(
        !sources
            .iter()
            .any(|(_, text)| text.contains("\"execution-task-persistence-failed\"")),
        "the dead persistence-failed event must be gone"
    );
}

#[test]
fn event_contract_entries_are_well_formed() {
    let kinds: serde_json::Value =
        serde_json::from_str(include_str!("../../../contracts/window-kinds.json")).unwrap();
    let kind_ids: Vec<String> = kinds["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|kind| kind["id"].as_str().unwrap().to_string())
        .collect();
    let contract: serde_json::Value = serde_json::from_str(EVENTS_JSON).unwrap();
    let mut seen = std::collections::HashSet::new();
    for event in contract["items"].as_array().unwrap() {
        let name = event["name"].as_str().unwrap();
        assert!(seen.insert(name.to_string()), "duplicate event {name}");
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
            "{name} must be kebab-case"
        );
        assert!(
            ["emit", "emit_to", "inbox", "relay"].contains(&event["mechanism"].as_str().unwrap()),
            "{name}"
        );
        assert!(
            ["rust-to-window", "window-to-window", "window-to-all"]
                .contains(&event["direction"].as_str().unwrap()),
            "{name}"
        );
        assert!(
            ["L1", "L2", "L3"].contains(&event["plannedLayer"].as_str().unwrap()),
            "{name}"
        );
        assert!(
            event["payloadVersion"].is_null() || event["payloadVersion"].is_u64(),
            "{name}"
        );
        for source in string_array(&event["allowedSourceKinds"], "allowedSourceKinds") {
            assert!(
                source == "rust" || kind_ids.contains(&source),
                "{name}: unknown source {source}"
            );
        }
        let targets = string_array(&event["allowedTargetKinds"], "allowedTargetKinds");
        assert!(!targets.is_empty(), "{name}");
        for target in targets {
            assert!(
                kind_ids.contains(&target),
                "{name}: unknown target {target}"
            );
        }
    }
}

#[test]
fn confirm_app_exit_takes_a_request_id_and_frontend_reads_the_payload_field() {
    const PTY_COMMAND: &str = include_str!("../commands/pty_session.rs");
    const APP_TSX: &str = include_str!("../../../src/App.tsx");
    const TAURI_TS: &str = include_str!("../../../src/lib/tauri.ts");
    const APP_COMMANDS: &str = include_str!("../../../contracts/app-commands.json");
    const DEFAULT_CAPABILITY: &str = include_str!("../../capabilities/default.json");
    const TERMINAL_CAPABILITY: &str = include_str!("../../capabilities/terminal-window.json");
    const WORKSPACE_CAPABILITY: &str =
        include_str!("../../capabilities/workspace-content-window.json");

    // (1) the command takes the request id as a parameter
    let start = PTY_COMMAND
        .find("pub async fn confirm_app_exit(")
        .expect("command exists");
    let params_end = PTY_COMMAND[start..]
        .find(") -> ")
        .expect("parameter list ends");
    let params = &PTY_COMMAND[start..start + params_end];
    assert!(
        params.contains("request_id: String"),
        "confirm_app_exit must take request_id"
    );

    // (2) the command is still registered for the main window only
    assert!(APP_COMMANDS.contains("\"confirm_app_exit\""));
    assert!(DEFAULT_CAPABILITY.contains("allow-confirm-app-exit"));
    assert!(
        !TERMINAL_CAPABILITY.contains("allow-confirm-app-exit"),
        "terminal windows must not confirm exits"
    );
    assert!(
        !WORKSPACE_CAPABILITY.contains("allow-confirm-app-exit"),
        "content windows must not confirm exits"
    );

    // (3) the frontend sends the id it received and drops malformed payloads
    assert!(
        APP_TSX.contains("requestId"),
        "App.tsx must carry requestId"
    );
    assert!(
        APP_TSX.contains("parseExitRequestedPayload"),
        "App.tsx must parse the exit payload"
    );
    assert!(
        APP_TSX.contains("app.exit_request_invalid"),
        "App.tsx must warn on invalid payloads"
    );
    assert!(
        TAURI_TS.contains("requestId: string"),
        "confirmAppExit must take requestId"
    );
    assert!(TAURI_TS.contains("invokeApp<void>(\"confirm_app_exit\", { requestId })"));
}

// ---- m6-059b: Db privacy, with_sync confinement and the PTY diagnostics log level

/// Files that may call `with_sync` (outside `runtime.rs`), each with the reason the caller is not
/// on an async worker. At most six files; every entry must actually use it.
const WITH_SYNC_ALLOWED_FILES: &[(&str, &str)] = &[
    (
        "services/pty_session_service/ports.rs",
        "the PTY monitor threads use these storage ports outside any async context",
    ),
    (
        "services/backup_service.rs",
        "backup creation and restore run inside blocking closures",
    ),
    (
        "services/config_service.rs",
        "configuration export and import run inside blocking closures",
    ),
    (
        "services/diagnostics_service.rs",
        "the diagnostics export runs inside a blocking closure",
    ),
    (
        "services/execution_service.rs",
        "the exit cleanup target runs on the exit thread",
    ),
];

/// Files that legitimately contain `.0.lock()` on a mutex that is not a database connection.
const NON_DATABASE_LOCK_FILES: &[(&str, &str)] = &[
    (
        "lib.rs",
        "CloseBehaviorState and TrayMenuLabelsState wrap a plain mutex",
    ),
    (
        "commands/app_setting.rs",
        "reads CloseBehaviorState, not a connection",
    ),
];

/// Every production source file under `src` as (path relative to `src` with `/`, text without
/// `#[cfg(test)]` items). Files that are tests as a whole and the contracts directory are skipped.
fn production_sources() -> Vec<(String, String)> {
    fn walk(directory: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(directory)
            .expect("source directory")
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, root, out);
                continue;
            }
            if path.extension().map_or(true, |extension| extension != "rs") {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if relative.starts_with("contracts/")
                || relative.ends_with("/tests.rs")
                || relative.ends_with("/test_support.rs")
            {
                continue;
            }
            let text = std::fs::read_to_string(&path)
                .unwrap()
                .replace("\r\n", "\n");
            out.push((relative, production_text(&text)));
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    walk(&root, &root, &mut sources);
    sources
}

/// Number of `.0.lock()` uses once whitespace is removed, so rustfmt line breaks cannot hide one.
fn direct_lock_hits(source: &str) -> usize {
    let squashed: String = source.chars().filter(|c| !c.is_whitespace()).collect();
    squashed.matches(".0.lock()").count()
}

/// Whether `needle` occurs in `text` as a whole identifier prefix (the character before it is not
/// part of an identifier).
fn contains_identifier(text: &str, needle: &str) -> bool {
    text.match_indices(needle).any(|(index, _)| {
        text[..index]
            .chars()
            .next_back()
            .map_or(true, |before| !(before.is_alphanumeric() || before == '_'))
    })
}

/// Text from the `{` after `marker` to its matching `}`.
fn brace_block_after(source: &str, marker: &str) -> Option<String> {
    let at = source.find(marker)?;
    let after = &source[at..];
    let open = after.find('{')?;
    let mut depth = 0usize;
    for (index, character) in after[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(after[open..open + index + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// The bodies of every `async fn` and every `async` / `async move` block in `source`.
fn async_fn_bodies(source: &str) -> Vec<String> {
    let mut bodies = Vec::new();
    for marker in ["async fn ", "async move {", "async {"] {
        let mut rest = source;
        while let Some(at) = rest.find(marker) {
            // `async move {` and `async {` end with the opening brace that starts the block.
            let from = if marker.ends_with('{') {
                at + marker.len() - 1
            } else {
                at + marker.len()
            };
            let after = &rest[from..];
            match brace_block_after(after, "") {
                Some(body) => {
                    let consumed = after.find(&body).unwrap() + body.len();
                    bodies.push(body);
                    rest = &after[consumed..];
                }
                None => break,
            }
        }
    }
    bodies
}

#[test]
fn no_direct_database_lock_outside_the_runtime_module() {
    let sources = production_sources();

    for (path, text) in &sources {
        if path == "runtime.rs" {
            continue;
        }
        for helper in [
            "fn with_conn",
            "fn with_connection",
            "fn with_cache",
            "fn with_cache_connection",
        ] {
            assert!(
                !contains_identifier(text, helper),
                "{path} still defines `{helper}`"
            );
        }
        for call in [
            "with_conn(",
            "with_connection(",
            "with_cache(",
            "with_cache_connection(",
        ] {
            assert!(
                !contains_identifier(text, call),
                "{path} still calls the legacy helper `{call}`"
            );
        }
        let hits = direct_lock_hits(text);
        let allowed = NON_DATABASE_LOCK_FILES
            .iter()
            .any(|(allowed_path, _)| allowed_path == path);
        assert!(
            hits == 0 || allowed,
            "{path} locks a connection directly (`.0.lock()`): use Db::call or Db::with_sync"
        );
    }

    // The exemption list cannot rot: every listed file really has such a lock.
    for (allowed_path, reason) in NON_DATABASE_LOCK_FILES {
        assert!(!reason.trim().is_empty());
        let text = &sources
            .iter()
            .find(|(path, _)| path == allowed_path)
            .unwrap_or_else(|| panic!("{allowed_path} is missing"))
            .1;
        assert!(
            direct_lock_hits(text) > 0,
            "{allowed_path} no longer needs its exemption"
        );
    }

    // The connection field of both wrappers is private.
    let runtime = &sources
        .iter()
        .find(|(path, _)| path == "runtime.rs")
        .expect("runtime.rs exists")
        .1;
    for declaration in ["pub struct Db(", "pub struct CacheDb("] {
        let at = runtime
            .find(declaration)
            .unwrap_or_else(|| panic!("`{declaration}` must be defined in runtime.rs"));
        let fields = &runtime[at + declaration.len()..];
        let fields = &fields[..fields.find(')').unwrap()];
        assert!(
            !fields.contains("pub"),
            "`{declaration}` must not expose its connection: {fields}"
        );
    }

    // The scan can see a violation, including one that rustfmt split across lines.
    assert!(direct_lock_hits("fn f(){ state\n    .0\n    .lock() }") > 0);
    assert!(direct_lock_hits("fn f(){ state.0.lock() }") > 0);
    assert!(contains_identifier(
        "let a = with_connection(&db, f);",
        "with_connection("
    ));
    assert!(!contains_identifier(
        "let a = db.with_connection_x(f);",
        "with_connection("
    ));
}

#[test]
fn with_sync_is_confined_to_the_allowed_files() {
    let sources = production_sources();
    assert!(
        WITH_SYNC_ALLOWED_FILES.len() <= 6,
        "with_sync callers are limited to six files"
    );
    for (path, reason) in WITH_SYNC_ALLOWED_FILES {
        assert!(!reason.trim().is_empty(), "{path} needs a reason");
    }

    let mut using: Vec<&str> = sources
        .iter()
        .filter(|(path, text)| {
            path != "runtime.rs" && (text.contains(".with_sync(") || text.contains(".with_sync::<"))
        })
        .map(|(path, _)| path.as_str())
        .collect();
    using.sort();
    let mut allowed: Vec<&str> = WITH_SYNC_ALLOWED_FILES
        .iter()
        .map(|(path, _)| *path)
        .collect();
    allowed.sort();
    // Equality covers both directions: no caller outside the list, and no listed file that has
    // stopped using it.
    assert_eq!(using, allowed);

    for (path, text) in &sources {
        for body in async_fn_bodies(text) {
            assert!(
                !body.contains(".with_sync(") && !body.contains(".with_sync::<"),
                "{path}: an async fn or block calls with_sync (use Db::call)"
            );
        }
    }

    // The scan can see a violation: an async fn, an `async move` block and the turbofish form.
    let bodies = async_fn_bodies("async fn f() { db.with_sync(\"op\", |c| Ok(())) }\nfn g() {}");
    assert_eq!(bodies.len(), 1);
    assert!(bodies[0].contains(".with_sync("));
    let blocks = async_fn_bodies(
        "fn g() { tokio::spawn(async move { db.with_sync::<(), _>(\"op\", |c| Ok(())) }); }",
    );
    assert_eq!(blocks.len(), 1);
    assert!(blocks[0].contains(".with_sync::<"));
}

#[test]
fn pty_diagnostics_thread_logs_at_debug_level() {
    let sources = production_sources();
    let service = &sources
        .iter()
        .find(|(path, _)| path == "services/pty_session_service.rs")
        .expect("pty_session_service.rs exists")
        .1;
    let body = brace_block_after(service, "fn spawn_session_diagnostics")
        .expect("spawn_session_diagnostics exists");
    assert!(body.contains("log::debug!"));
    assert!(body.contains("PTY output snapshot"));
    assert!(!body.contains("log::info!"));

    // No other info-level log carries the periodic snapshot text anywhere in the service.
    for (path, text) in &sources {
        if !path.starts_with("services/pty_session_service") {
            continue;
        }
        for (index, _) in text.match_indices("log::info!") {
            // Up to the end of the macro call; no fixed byte window, which could split a
            // multi-byte character in the Chinese comments.
            let statement = &text[index..];
            let statement = &statement[..statement.find(");").unwrap_or(statement.len())];
            assert!(
                !statement.contains("PTY output snapshot"),
                "{path}: the periodic snapshot must stay at debug level"
            );
        }
    }

    // The scan can see a violation.
    let info_body = brace_block_after(
        "fn spawn_session_diagnostics() { log::info!(\"PTY output snapshot\"); }",
        "fn spawn_session_diagnostics",
    )
    .unwrap();
    assert!(info_body.contains("log::info!"));
}

// ---- m6-060: child processes are created only through the supervised primitives

/// Files that may contain `.spawn()` or `kill_on_drop(` in production code, each with the reason.
/// PTY children are created by `portable_pty` and match neither string.
const SPAWN_ALLOWED_FILES: &[(&str, &str)] = &[
    (
        "platform/process.rs",
        "implementation of the supervised primitives (run_bounded and friends)",
    ),
    (
        "platform/execution_process.rs",
        "implementation of the attached creation (spawn_attached)",
    ),
    (
        "platform/opener.rs",
        "deliberately detached one-shot launch: opening the file manager",
    ),
    (
        "services/execution_service.rs",
        "streaming install/update tasks use their own process tree and reserved slot",
    ),
];

/// The legacy-spawn patterns a file must not contain unless it is on the allow list.
fn spawn_violations(source: &str) -> Vec<&'static str> {
    ["kill_on_drop(", ".spawn()", ".output()", ".status()"]
        .into_iter()
        .filter(|needle| source.contains(needle))
        .collect()
}

#[test]
fn codex_app_server_uses_the_shared_supervised_primitive() {
    let sources = production_sources();
    let source = &sources
        .iter()
        .find(|(path, _)| path == "services/cli_adapters/codex/app_server.rs")
        .expect("app_server.rs exists")
        .1;

    assert!(source.contains("spawn_supervised("));
    for forbidden in ["kill_on_drop(", "AppServerTreeGuard", "ProcessTree::new("] {
        assert!(
            !source.contains(forbidden),
            "app_server.rs must not contain `{forbidden}`: the process tree belongs to Supervised"
        );
    }

    // The scan can see a violation.
    assert!(spawn_violations("fn f(){ cmd.kill_on_drop(true); }").contains(&"kill_on_drop("));
}

#[test]
fn child_processes_are_spawned_only_through_the_supervised_primitives() {
    let sources = production_sources();
    for (path, reason) in SPAWN_ALLOWED_FILES {
        assert!(!reason.trim().is_empty(), "{path} needs a reason");
    }

    let mut using: Vec<&str> = sources
        .iter()
        .filter(|(_, text)| !spawn_violations(text).is_empty())
        .map(|(path, _)| path.as_str())
        .collect();
    using.sort();
    let mut allowed: Vec<&str> = SPAWN_ALLOWED_FILES.iter().map(|(path, _)| *path).collect();
    allowed.sort();
    // Equality covers both directions: no spawn site outside the list, and no listed file that
    // no longer spawns (the list cannot rot).
    assert_eq!(using, allowed);

    // The scan can see a violation in an ordinary service file.
    assert!(!spawn_violations("fn start() { Command::new(\"x\").spawn().unwrap(); }").is_empty());
}

// ---- m6-061: Rust notifications reach the main window only through its private inbox

#[test]
fn rust_to_window_events_use_the_inbox_mechanism() {
    let contract: serde_json::Value = serde_json::from_str(EVENTS_JSON).unwrap();
    let mut inbox_events = Vec::new();
    for event in contract["items"].as_array().unwrap() {
        let name = event["name"].as_str().unwrap();
        if event["direction"] == "rust-to-window" {
            assert_eq!(event["mechanism"], "inbox", "{name} must use the inbox");
            assert_eq!(
                event["allowedTargetKinds"],
                serde_json::json!(["main"]),
                "{name} targets only the main window"
            );
            assert_eq!(
                event["allowedSourceKinds"],
                serde_json::json!(["rust"]),
                "{name}"
            );
            inbox_events.push(name.to_string());
        } else {
            // Reverse: window-originated events are not inbox events in this layer.
            assert_ne!(event["mechanism"], "inbox", "{name}");
        }
    }
    inbox_events.sort();
    assert_eq!(
        inbox_events,
        vec![
            "app-exit-requested",
            "execution-task-log",
            "execution-task-updated",
            "pty-session-owner-lost",
            "workspace-content-window-lost",
            "workspace-data-restored",
        ]
    );
}

#[test]
fn production_code_does_not_use_tauri_event_emit_apis() {
    let sources = production_sources();
    assert!(
        sources.len() > 20,
        "the source scan read {} files",
        sources.len()
    );
    let mut violations = Vec::new();
    for (path, text) in &sources {
        for (index, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for needle in [".emit_to(", ".emit(", "emit_filter(", "Emitter"] {
                if line.contains(needle) {
                    violations.push(format!("{path}:{} contains `{needle}`", index + 1));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "Rust notifications go through notify_main: {violations:#?}"
    );
    let inbox = &sources
        .iter()
        .find(|(path, _)| path == "services/window_inbox.rs")
        .expect("window_inbox.rs exists")
        .1;
    assert!(inbox.contains("fn notify_main"));
}

// ---- m6-062: messages between windows go through the Rust relay

const WINDOW_MESSAGES_JSON: &str = include_str!("../../../contracts/window-messages.json");

#[test]
fn window_message_contract_is_well_formed() {
    let contract: serde_json::Value = serde_json::from_str(WINDOW_MESSAGES_JSON).unwrap();
    let messages = contract["items"].as_array().unwrap();
    assert_eq!(messages.len(), 20);
    let names: Vec<&str> = messages
        .iter()
        .map(|message| message["type"].as_str().unwrap())
        .collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted, "types are sorted");
    let unique: std::collections::BTreeSet<&str> = names.iter().copied().collect();
    assert_eq!(unique.len(), names.len(), "types are unique");

    for message in messages {
        let name = message["type"].as_str().unwrap();
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
            "{name} must be kebab-case"
        );
        for side in ["from", "to"] {
            let kinds = string_array(&message[side], side);
            assert!(!kinds.is_empty(), "{name}.{side} is empty");
            for kind in &kinds {
                assert!(
                    ["main", "terminal", "workspaceContent"].contains(&kind.as_str()),
                    "{name}.{side}: {kind}"
                );
            }
        }
        assert!(
            ["pty", "file", "app"].contains(&message["contentKind"].as_str().unwrap()),
            "{name}"
        );
        assert_eq!(message["payloadVersion"], 1, "{name}");
        let only_main = |side: &str| {
            string_array(&message[side], side)
                .iter()
                .all(|kind| kind == "main")
        };
        assert!(
            !(only_main("from") && only_main("to")),
            "{name}: main would only message itself"
        );
        // A window kind that both sends and receives a type could message itself or a sibling.
        let from_kinds = string_array(&message["from"], "from");
        let to_kinds = string_array(&message["to"], "to");
        assert!(
            from_kinds.iter().all(|kind| !to_kinds.contains(kind)),
            "{name}: from and to must not share a window kind"
        );
        let expected_kind = if name.starts_with("pty-") {
            "pty"
        } else if name.starts_with("workspace-file-window-") {
            "file"
        } else {
            "app"
        };
        assert_eq!(message["contentKind"], expected_kind, "{name}");
    }
}

#[test]
fn child_windows_cannot_emit_events_and_can_use_the_relay() {
    let kinds: serde_json::Value =
        serde_json::from_str(include_str!("../../../contracts/window-kinds.json")).unwrap();
    for (capability_json, kind_id) in [
        (
            include_str!("../../capabilities/terminal-window.json"),
            "terminal",
        ),
        (
            include_str!("../../capabilities/workspace-content-window.json"),
            "workspaceContent",
        ),
    ] {
        let capability: serde_json::Value = serde_json::from_str(capability_json).unwrap();
        let permissions: Vec<String> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| {
                permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap()
                    .to_string()
            })
            .collect();
        for required in [
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "allow-subscribe-window-inbox",
            "allow-send-window-message",
        ] {
            assert!(
                permissions.iter().any(|permission| permission == required),
                "{kind_id} must have {required}"
            );
        }
        for forbidden in [
            "core:event:allow-emit-to",
            "core:event:allow-emit",
            "core:event:default",
            "core:default",
        ] {
            assert!(
                !permissions.iter().any(|permission| permission == forbidden),
                "{kind_id} must not have {forbidden}"
            );
        }
        let kind = kinds["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|kind| kind["id"] == kind_id)
            .unwrap();
        let core = string_array(&kind["corePermissions"], "corePermissions");
        assert!(
            !core
                .iter()
                .any(|permission| permission == "core:event:allow-emit-to"),
            "{kind_id} corePermissions must not list core:event:allow-emit-to"
        );
        let commands = string_array(&kind["appCommands"], "appCommands");
        for command in ["subscribe_window_inbox", "send_window_message"] {
            assert!(
                commands.iter().any(|candidate| candidate == command),
                "{kind_id} appCommands must list {command}"
            );
        }
    }
    let main: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
    assert!(main["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|permission| permission == "allow-send-window-message"));
    let main_kind = kinds["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|kind| kind["id"] == "main")
        .unwrap();
    assert_eq!(main_kind["appCommands"], "all");
}

#[test]
fn event_contract_lists_the_relay_event_and_not_the_retired_ones() {
    let contract: serde_json::Value = serde_json::from_str(EVENTS_JSON).unwrap();
    let events = contract["items"].as_array().unwrap();
    let find = |name: &str| events.iter().find(|event| event["name"] == name);

    let relay = find("window-message").expect("window-message is registered");
    assert_eq!(relay["mechanism"], "relay");
    assert_eq!(relay["direction"], "window-to-window");
    assert_eq!(relay["plannedLayer"], "L2");
    let sources = string_array(&relay["allowedSourceKinds"], "allowedSourceKinds");
    for kind in ["rust", "main", "terminal", "workspaceContent"] {
        assert!(sources.iter().any(|source| source == kind), "{kind}");
    }
    for retired in [
        "workspace-content-window-event",
        "app-preferences-requested",
    ] {
        assert!(find(retired).is_none(), "{retired} is retired");
    }
    // The nine entries after m6-061, minus the two retired events, plus the relay event.
    assert_eq!(events.len(), 8);
    let preferences = find("app-preferences").expect("app-preferences stays registered");
    assert_eq!(preferences["mechanism"], "emit");
    assert_eq!(
        preferences["allowedSourceKinds"],
        serde_json::json!(["main"])
    );
}

// ---- m6-064: command caller checks (contracts/app-commands.json since m6-074c).

/// One entry of `contracts/app-commands.json`: `require` commands list the window kinds they accept.
struct CallerCheck {
    command: String,
    require: bool,
    kinds: BTreeSet<String>,
}

fn caller_checks() -> Vec<CallerCheck> {
    let contract: Value =
        serde_json::from_str(APP_COMMANDS_JSON).expect("parse app command contract");
    contract["items"]
        .as_array()
        .expect("commands must be an array")
        .iter()
        .map(|entry| CallerCheck {
            command: entry["name"].as_str().expect("command name").to_string(),
            require: match entry["callerCheck"].as_str() {
                Some("require") => true,
                Some("acl-only") => false,
                other => panic!("unknown callerCheck {other:?} for {}", entry["command"]),
            },
            kinds: entry
                .get("kinds")
                .map(|kinds| json_strings(kinds).into_iter().collect())
                .unwrap_or_default(),
        })
        .collect()
}

/// A command's parameter list and body, split out of `tauri_commands`.
struct CommandDef {
    file: String,
    name: String,
    signature: String,
    /// The text between the parameter list and the body, without the arrow (empty when the
    /// command returns nothing); m6-071 reads the DTO a command returns from it.
    return_type: String,
    body: String,
}

fn command_definitions() -> Vec<CommandDef> {
    let mut definitions = Vec::new();
    for (file, source) in command_files() {
        for command in tauri_commands(&source) {
            let text = &command.text;
            let open = text
                .find('(')
                .unwrap_or_else(|| panic!("{file}: `{}` has no parameter list", command.name));
            let mut depth = 0usize;
            let mut close = None;
            for (offset, character) in text[open..].char_indices() {
                match character {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(open + offset);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let close = close.unwrap_or_else(|| {
                panic!(
                    "{file}: `{}` has an unbalanced parameter list",
                    command.name
                )
            });
            let rest = &text[close + 1..];
            let brace = rest
                .find('{')
                .unwrap_or_else(|| panic!("{file}: `{}` has no body", command.name));
            definitions.push(CommandDef {
                file: file.clone(),
                name: command.name.clone(),
                signature: text[open + 1..close].to_string(),
                return_type: rest[..brace]
                    .trim()
                    .trim_start_matches("->")
                    .trim()
                    .to_string(),
                body: rest[brace + 1..].to_string(),
            });
        }
    }
    definitions
}

/// The window types a command signature must not use any more (the caller is a `CallerWindow`).
fn takes_raw_window(signature: &str) -> bool {
    if signature.contains("WebviewWindow") || signature.contains("tauri::Window") {
        return true;
    }
    signature.match_indices(": Window").any(|(at, needle)| {
        !signature[at + needle.len()..]
            .chars()
            .next()
            .is_some_and(|next| next.is_ascii_alphanumeric() || next == '_')
    })
}

/// The first statement of a body, with leading blank lines and `//` comment lines skipped.
fn first_statement(body: &str) -> String {
    let mut rest = body;
    loop {
        rest = rest.trim_start();
        match rest.strip_prefix("//") {
            Some(comment) => rest = comment.split_once('\n').map_or("", |(_, tail)| tail),
            None => break,
        }
    }
    rest.split(';')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn kind_id(variant: &str) -> &'static str {
    match variant {
        "WindowKind::Main" => "main",
        "WindowKind::Terminal" => "terminal",
        "WindowKind::WorkspaceContent" => "workspaceContent",
        other => panic!("unknown window kind variant {other:?}"),
    }
}

/// The window kinds the ACL (`window-kinds.json`) grants a command to.
fn acl_kinds(command: &str, manifest: &Value) -> BTreeSet<String> {
    let app_commands: Vec<String> = app_command_names();
    assert!(app_commands.iter().any(|name| name == command), "{command}");
    manifest["items"]
        .as_array()
        .expect("window kinds")
        .iter()
        .filter(|kind| match &kind["appCommands"] {
            Value::String(all) => all == "all",
            list => json_strings(list).iter().any(|name| name == command),
        })
        .map(|kind| kind["id"].as_str().expect("kind id").to_string())
        .collect()
}

#[test]
fn command_caller_check_contract_covers_every_registered_command() {
    let checks = caller_checks();
    let registered: Vec<String> = app_command_names();

    let names: Vec<String> = checks.iter().map(|check| check.command.clone()).collect();
    assert_eq!(names, sorted_strings(names.clone()), "dictionary order");
    assert_eq!(
        names.iter().collect::<BTreeSet<_>>().len(),
        names.len(),
        "no duplicates"
    );
    assert_eq!(sorted_strings(names), sorted_strings(registered.clone()));
    // m6-074c: the manifest is now the only file, so check it against the command sources directly.
    let defined: Vec<String> = command_definitions()
        .into_iter()
        .map(|command| command.name)
        .collect();
    assert_eq!(
        sorted_strings(defined),
        sorted_strings(registered),
        "contracts/app-commands.json 必须恰好列出源码里的全部命令"
    );
    let allowed = ["main", "terminal", "workspaceContent"];
    for check in &checks {
        if check.require {
            assert!(!check.kinds.is_empty(), "{}: kinds", check.command);
            assert!(
                check
                    .kinds
                    .iter()
                    .all(|kind| allowed.contains(&kind.as_str())),
                "{}: unknown kind",
                check.command
            );
        } else {
            assert!(
                check.kinds.is_empty(),
                "{}: acl-only has kinds",
                check.command
            );
        }
    }
    // Reverse: the contract is not trivially all acl-only, and the documented commands require.
    assert!(checks.iter().filter(|check| check.require).count() >= 24);
    for command in [
        "confirm_app_exit",
        "restore_backup",
        "import_config_from_path",
        "set_close_behavior",
        "grant_content_window_file",
        "revoke_content_window_file",
        "open_granted_file",
        "save_granted_text_file",
        "create_pty_session",
        "reattach_pty_session",
        "set_tray_menu_labels",
        "subscribe_window_inbox",
        "send_window_message",
    ] {
        let check = checks
            .iter()
            .find(|check| check.command == command)
            .unwrap_or_else(|| panic!("{command} is not in the contract"));
        assert!(check.require, "{command} must be `require`");
    }
}

#[test]
fn acl_only_commands_are_main_only_and_take_no_window_parameter() {
    let definitions = command_definitions();
    let registered: Vec<String> = app_command_names();
    // Reverse: the parser found every registered command (it cannot silently skip one).
    assert_eq!(definitions.len(), registered.len());

    let mut violations = Vec::new();
    for check in caller_checks().iter().filter(|check| !check.require) {
        let Some(definition) = definitions.iter().find(|d| d.name == check.command) else {
            violations.push(format!("{}: not found in commands/*.rs", check.command));
            continue;
        };
        if definition.signature.contains("CallerWindow") || takes_raw_window(&definition.signature)
        {
            violations.push(format!(
                "{}: an acl-only command takes a window parameter ({})",
                check.command, definition.file
            ));
        }
    }
    assert!(violations.is_empty(), "{violations:#?}");
}

#[test]
fn require_commands_take_a_caller_window_and_require_exactly_the_declared_kinds() {
    let definitions = command_definitions();
    let mut violations = Vec::new();
    let mut webview_in_require = 0;
    for check in caller_checks().iter().filter(|check| check.require) {
        let Some(definition) = definitions.iter().find(|d| d.name == check.command) else {
            violations.push(format!("{}: not found in commands/*.rs", check.command));
            continue;
        };
        if definition.signature.contains("WebviewWindow") {
            webview_in_require += 1;
        }
        let Some((before, _)) = definition.signature.split_once(": CallerWindow") else {
            violations.push(format!("{}: no `: CallerWindow` parameter", check.command));
            continue;
        };
        let name: String = before
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let statement = first_statement(&definition.body);
        let prefix = format!("{name}.require(&[");
        let Some(list) = statement.strip_prefix(&prefix) else {
            violations.push(format!(
                "{}: the first statement is not `{prefix}…` ({})",
                check.command, statement
            ));
            continue;
        };
        let Some((list, _)) = list.split_once("])?") else {
            violations.push(format!("{}: `require` is not `…])?`", check.command));
            continue;
        };
        let actual: BTreeSet<String> = list
            .split(',')
            .map(str::trim)
            .filter(|variant| !variant.is_empty())
            .map(|variant| kind_id(variant).to_string())
            .collect();
        if actual != check.kinds {
            violations.push(format!(
                "{}: requires {actual:?}, the contract declares {:?}",
                check.command, check.kinds
            ));
        }
    }
    assert!(violations.is_empty(), "{violations:#?}");
    assert_eq!(webview_in_require, 0);
}

#[test]
fn commands_take_no_raw_window_parameters_and_compare_no_labels() {
    let forbidden = [
        "ensure_main_window",
        ".label() ==",
        ".label() !=",
        ".label().as_str() ==",
        ".label().as_str() !=",
        "starts_with(\"terminal-\")",
        "starts_with(\"workspace-content-\")",
    ];
    let files = command_files();
    let mut violations = Vec::new();
    for (file, source) in &files {
        let production = production_text(source);
        for needle in forbidden {
            if production.contains(needle) {
                violations.push(format!("{file}: contains `{needle}`"));
            }
        }
    }
    for definition in command_definitions() {
        if takes_raw_window(&definition.signature) {
            violations.push(format!(
                "{}: `{}` takes a raw window parameter",
                definition.file, definition.name
            ));
        }
    }
    assert!(violations.is_empty(), "{violations:#?}");
    // Reverse: enough files were scanned, and the target check of `revoke_content_window_file`
    // (a label that is not the caller) was kept.
    assert!(files.len() >= 10, "{}", files.len());
    let (_, grants) = files
        .iter()
        .find(|(file, _)| file == "files.rs")
        .expect("files.rs");
    assert!(production_text(grants).contains("window_kind_of(&target_label)"));
}

#[test]
fn capability_window_globs_match_the_label_rules() {
    let manifest: Value = serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kinds");
    let windows = |file: &str| json_strings(&real_capability(file)["windows"]);

    assert_eq!(windows("default.json"), vec!["main".to_string()]);
    assert_eq!(
        kind_of(&manifest, "main")["label"].as_str(),
        Some("main"),
        "the main capability glob is the literal main label"
    );
    for (id, file) in [
        ("terminal", "terminal-window.json"),
        ("workspaceContent", "workspace-content-window.json"),
    ] {
        let kind = kind_of(&manifest, id);
        let prefix = kind["labelPrefix"].as_str().expect("label prefix");
        assert_eq!(windows(file), vec![format!("{prefix}*")], "{file}");
        assert_eq!(
            real_capability(file)["identifier"],
            kind["capability"],
            "{file}: identifier"
        );
    }
    // Reverse: no capability opens up to every window.
    for file in [
        "default.json",
        "terminal-window.json",
        "workspace-content-window.json",
    ] {
        assert!(
            windows(file)
                .iter()
                .all(|glob| glob != "*" && !glob.is_empty()),
            "{file}"
        );
    }
}

#[test]
fn caller_check_contract_matches_the_window_kind_acl() {
    let manifest: Value = serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kinds");
    let mut violations = Vec::new();
    let mut proper_subset = 0;
    for check in caller_checks() {
        let acl = acl_kinds(&check.command, &manifest);
        let children: BTreeSet<String> =
            acl.iter().filter(|kind| *kind != "main").cloned().collect();
        if check.require {
            if !check.kinds.is_subset(&acl) || !children.is_subset(&check.kinds) {
                violations.push(format!(
                    "{}: kinds {:?} vs ACL {acl:?}",
                    check.command, check.kinds
                ));
            }
            if check.kinds.is_subset(&acl) && check.kinds != acl {
                proper_subset += 1;
            }
        } else if acl != BTreeSet::from(["main".to_string()]) {
            violations.push(format!("{}: acl-only but ACL is {acl:?}", check.command));
        }
    }
    assert!(violations.is_empty(), "{violations:#?}");
    // Reverse: the rule is not an identity (the granted-file commands exclude `main` on purpose).
    assert!(proper_subset >= 2, "{proper_subset}");
}

#[test]
fn window_inbox_commands_accept_every_window_kind() {
    // B1920-17: the two commands any window may call. Because they accept every kind there is no
    // wrong-kind caller to reject, so a behavioural "not allowed" test cannot exist; what protects
    // them is that the guard exists and lists exactly all window kinds.
    let manifest: Value = serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kinds");
    let all_kinds: BTreeSet<String> = manifest["items"]
        .as_array()
        .expect("window kinds")
        .iter()
        .map(|kind| kind["id"].as_str().expect("kind id").to_string())
        .collect();
    let checks = caller_checks();
    for command in ["subscribe_window_inbox", "send_window_message"] {
        let check = checks
            .iter()
            .find(|check| check.command == command)
            .unwrap_or_else(|| panic!("{command}"));
        assert!(check.require, "{command}");
        assert_eq!(check.kinds, all_kinds, "{command}");
        assert_eq!(acl_kinds(command, &manifest), all_kinds, "{command}");
    }
}

// ---- m6-065: navigation guard (services/navigation_guard.rs).

#[test]
fn navigation_guard_plugin_is_registered_after_single_instance() {
    // Comment lines do not count as registrations.
    let code: String = LIB_RS
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join(" ");
    let registration = "services::navigation_guard::plugin()";
    assert_eq!(code.matches(registration).count(), 1);
    let single_instance = code
        .find("tauri_plugin_single_instance::init")
        .expect("single instance plugin is registered");
    let guard = code.find(registration).expect("the guard is registered");
    assert!(single_instance < guard, "single instance must stay first");
    // Reverse: the guard goes through the plugin only, never a second hook on the builder.
    assert!(!code.contains("on_navigation"));
}

#[test]
fn no_code_enables_new_window_creation() {
    let forbidden = [
        "on_new_window(",
        "with_new_window_req_handler",
        "NewWindowResponse::Allow",
        "NewWindowResponse::Create",
    ];
    let sources = production_rust_sources();
    let mut violations = Vec::new();
    for (file, text) in &sources {
        for (number, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for needle in forbidden {
                if line.contains(needle) {
                    violations.push(format!("{file}:{}: {needle}", number + 1));
                }
            }
        }
    }
    assert!(violations.is_empty(), "{violations:#?}");
    // Reverse: enough files were read, and the guard's own production code was among them.
    assert!(sources.len() > 20, "{}", sources.len());
    let guard = sources
        .iter()
        .find(|(file, _)| file == "services/navigation_guard.rs")
        .expect("navigation_guard.rs exists");
    assert!(guard.1.contains("fn plugin"));
}

// ---- m6-066: configuration switches that keep the CSP meaningful (tauri.conf.json, capabilities).

#[test]
fn tauri_config_keeps_global_tauri_and_asset_protocol_closed() {
    let config: Value = serde_json::from_str(TAURI_CONFIG_JSON).expect("parse tauri config");
    let app = &config["app"];
    assert!(
        matches!(app.get("withGlobalTauri"), None | Some(Value::Bool(false))),
        "withGlobalTauri must stay off: {:?}",
        app.get("withGlobalTauri")
    );
    let security = &app["security"];
    assert!(
        matches!(
            security.get("dangerousDisableAssetCspModification"),
            None | Some(Value::Bool(false))
        ),
        "dangerousDisableAssetCspModification must stay off"
    );
    if let Some(asset_protocol) = security.get("assetProtocol") {
        assert_ne!(
            asset_protocol.get("enable"),
            Some(&Value::Bool(true)),
            "the asset protocol must stay disabled"
        );
    }
    for overlay in [
        include_str!("../../tauri.macos.conf.json"),
        include_str!("../../tauri.windows.conf.json"),
        include_str!("../../tauri.offline.conf.json"),
    ] {
        let value: Value = serde_json::from_str(overlay).expect("parse config overlay");
        assert!(
            value["app"].get("withGlobalTauri").is_none(),
            "overlays must not set withGlobalTauri"
        );
        // Reverse: the overlay was really read.
        assert!(
            value.get("bundle").is_some(),
            "overlay without a bundle section"
        );
    }
    for capability in [
        include_str!("../../capabilities/default.json"),
        include_str!("../../capabilities/terminal-window.json"),
        include_str!("../../capabilities/workspace-content-window.json"),
    ] {
        let value: Value = serde_json::from_str(capability).expect("parse capability");
        assert!(
            value.get("remote").is_none(),
            "capabilities must not be remote"
        );
        // Reverse: the file was really read.
        assert!(!value["permissions"]
            .as_array()
            .expect("permissions")
            .is_empty());
    }
    // Reverse: the configuration was really read.
    assert!(!security["csp"].as_str().expect("csp").is_empty());
}

// ---- m6-068: provider capability contract (contracts/tool-capabilities.json).

#[test]
fn tool_capabilities_contract_matches_adapter_descriptors() {
    let contract: serde_json::Value =
        serde_json::from_str(TOOL_CAPABILITIES_JSON).expect("parse tool capabilities contract");
    assert_eq!(contract["formatVersion"], 1);
    let items = contract["items"]
        .as_array()
        .expect("items must be an array");
    assert_eq!(items.len(), crate::models::tool::ToolKey::ALL.len());
    for (item, tool_key) in items.iter().zip(crate::models::tool::ToolKey::ALL) {
        let actual =
            serde_json::to_value(crate::services::cli_adapters::get(tool_key).descriptor())
                .expect("serialize descriptor");
        assert_eq!(item, &actual, "{}", tool_key.as_str());
    }
    let keys: Vec<&str> = items
        .iter()
        .map(|item| item["toolKey"].as_str().expect("toolKey must be a string"))
        .collect();
    let tool_keys: serde_json::Value =
        serde_json::from_str(TOOL_KEYS_JSON).expect("parse tool keys");
    let tool_keys: Vec<&str> = tool_keys["items"]
        .as_array()
        .expect("tool keys")
        .iter()
        .map(|value| value.as_str().expect("tool key"))
        .collect();
    assert_eq!(keys, tool_keys, "契约顺序必须等于 tool-keys.json");
}

// ---- m6-070: contract manifest envelope, window kind roles, window chrome (contracts/*.json).

#[test]
fn contract_manifests_use_the_common_envelope() {
    const MANIFESTS: [(&str, &[&str]); 10] = [
        ("api-versions.json", &[]),
        ("app-commands.json", &[]),
        ("content-kinds.json", &[]),
        (
            "error-codes.json",
            &["aliases", "frontendCodes", "reservedCodes"],
        ),
        ("events.json", &[]),
        ("tool-capabilities.json", &[]),
        ("tool-keys.json", &[]),
        ("window-chrome.json", &[]),
        ("window-kinds.json", &[]),
        ("window-messages.json", &[]),
    ];
    const EXEMPT: [&str; 3] = [
        "rust-platform-tests.json",
        "serde-lint-allowlist.json",
        "window-label-fixtures.json",
    ];
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts");
    let mut names: Vec<String> = std::fs::read_dir(&directory)
        .expect("read contracts directory")
        .filter_map(|entry| {
            let entry = entry.expect("read contract entry");
            entry
                .file_type()
                .expect("contract file type")
                .is_file()
                .then(|| entry.file_name().to_string_lossy().to_string())
        })
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();

    let mut classified: Vec<String> = MANIFESTS
        .iter()
        .map(|(name, _)| (*name).to_string())
        .chain(EXEMPT.iter().map(|name| (*name).to_string()))
        .collect();
    classified.sort();
    assert_eq!(names, classified, "contracts/*.json 必须全部归类");

    for (name, allowed) in MANIFESTS {
        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join(name)).expect("read manifest"),
        )
        .expect("parse manifest");
        let object = value
            .as_object()
            .unwrap_or_else(|| panic!("{name} 不能是裸数组"));
        assert!(
            object
                .get("formatVersion")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|version| version >= 1),
            "{name} 缺少 formatVersion"
        );
        assert!(
            object.get("items").is_some_and(serde_json::Value::is_array),
            "{name} 的 items 必须是数组"
        );
        let mut extra: Vec<&str> = object
            .keys()
            .map(String::as_str)
            .filter(|key| *key != "formatVersion" && *key != "items")
            .collect();
        extra.sort();
        assert_eq!(extra, allowed, "{name} 的额外顶层键");
    }
}

#[test]
fn content_kinds_and_window_kinds_reference_each_other_consistently() {
    let content: serde_json::Value =
        serde_json::from_str(CONTENT_KINDS_JSON).expect("parse content kinds");
    let windows: serde_json::Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kinds");
    let content_items = content["items"].as_array().expect("content items");
    let window_items = windows["items"].as_array().expect("window items");
    let content_ids: Vec<&str> = content_items
        .iter()
        .map(|item| item["id"].as_str().expect("content id"))
        .collect();
    let window_ids: Vec<&str> = window_items
        .iter()
        .map(|item| item["id"].as_str().expect("window id"))
        .collect();

    for item in content_items {
        let id = item["id"].as_str().unwrap();
        let window = item["windowKind"].as_str().expect("windowKind");
        assert!(
            window_ids.contains(&window),
            "{id} 的 windowKind {window} 未登记"
        );
        assert!(item["dragAllowed"].is_boolean(), "{id} 缺少 dragAllowed");
        let owner = window_items
            .iter()
            .find(|candidate| candidate["id"] == window)
            .unwrap();
        assert!(
            owner["contentKinds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|kind| kind == id),
            "{window} 的 contentKinds 缺少 {id}"
        );
    }
    for item in window_items {
        for kind in item["contentKinds"].as_array().expect("contentKinds") {
            assert!(
                content_ids.contains(&kind.as_str().unwrap()),
                "{} 的 contentKinds 含未登记内容类型 {kind}",
                item["id"]
            );
            // A window kind lists only its own content kinds; the primary window hosts all of them.
            let owner = content_items
                .iter()
                .find(|candidate| candidate["id"] == *kind)
                .unwrap()["windowKind"]
                .clone();
            assert!(
                item["primary"] == true || owner == item["id"],
                "{} 不能列出属于 {owner} 的内容类型 {kind}",
                item["id"]
            );
        }
    }
    let primaries = window_items
        .iter()
        .filter(|item| item["primary"] == true)
        .count();
    assert_eq!(primaries, 1, "有且只有一个 primary 窗口类别");
}

#[test]
fn window_kind_roles_are_exclusive_where_the_policy_requires() {
    let windows: serde_json::Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kinds");
    let items = windows["items"].as_array().expect("items");
    let count = |field: &str| items.iter().filter(|item| item[field] == true).count();

    assert_eq!(count("primary"), 1);
    assert_eq!(count("ownsPty"), 1, "只有终端窗口类别拥有 PTY");
    assert_eq!(count("fileGrant"), 1, "只有内容窗口类别持有文件授权");
    for item in items {
        assert!(
            !(item["primary"] == true && item["ownsPty"] == true),
            "主窗口不能同时是 PTY 所有者类别"
        );
        if item["ownsPty"] == true {
            assert_eq!(item["ptyHost"], true, "拥有 PTY 的类别必须能承载 PTY");
        }
    }
}

#[test]
fn services_do_not_branch_on_window_kind_variants() {
    // `production_text` removes every `#[cfg(test)]` item, so test-only helpers declared earlier in a
    // file do not hide the production code after them (the first-marker split of the goal text does).
    let files: Vec<(String, String)> = production_rust_sources()
        .into_iter()
        .filter(|(path, _)| path.starts_with("services/") && !path.ends_with("/tests.rs"))
        .collect();
    assert!(
        files.len() >= 20,
        "扫描到的 services 文件数异常：{}",
        files.len()
    );

    let mut offenders = Vec::new();
    for (path, production) in &files {
        for pattern in ["WindowKind::Terminal", "WindowKind::WorkspaceContent"] {
            if production.contains(pattern) {
                offenders.push(format!("{path} 含 {pattern}"));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "services 不应按窗口类别变体分支：{offenders:?}"
    );
}

#[test]
fn production_code_does_not_add_main_window_label_literals() {
    // 基线 MAIN_LITERALS_RS 来自 m6-070 的前置检查 #15，只减不增。与文档的偏差：只统计生产文件
    // （`production_rust_sources` 已跳过整模块是 #[cfg(test)] 的 `contracts/`，这里再排除整文件都是
    // 测试的 `tests.rs`），否则这些测试文件里的 "main" 会占满上限，真正的生产代码新增字面量反而发现
    // 不了。排除后实测基线为 0。
    const MAIN_LITERALS_RS_BASELINE: usize = 0;
    let sources = production_rust_sources();
    assert!(
        sources.len() >= 50,
        "扫描到的源文件数异常：{}",
        sources.len()
    );

    let count: usize = sources
        .iter()
        .filter(|(path, _)| !path.ends_with("/tests.rs"))
        .map(|(_, production)| production.matches("\"main\"").count())
        .sum();
    assert!(
        count <= MAIN_LITERALS_RS_BASELINE,
        "生产代码里的 \"main\" 字面量增加到 {count}，上限 {MAIN_LITERALS_RS_BASELINE}"
    );
}

#[test]
fn window_chrome_contract_matches_the_macos_config() {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../contracts/window-chrome.json"))
            .expect("parse window chrome contract");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.macos.conf.json"))
            .expect("parse macOS config");
    let macos = contract["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["platform"] == "macos")
        .expect("macos entry");

    assert_eq!(
        macos["trafficLightPosition"],
        config["app"]["windows"][0]["trafficLightPosition"]
    );
    assert_eq!(config["app"]["windows"][0]["titleBarStyle"], "Overlay");
    assert_eq!(contract["items"].as_array().unwrap().len(), 3);
}

#[test]
fn command_definitions_extract_the_return_type() {
    // m6-071: `CommandDef.return_type` is the text between the parameter list and the body, without
    // the arrow; a command without a return type has an empty one.
    let definitions = command_definitions();
    let return_type = |name: &str| {
        definitions
            .iter()
            .find(|command| command.name == name)
            .unwrap_or_else(|| panic!("缺少命令 {name}"))
            .return_type
            .clone()
    };

    assert_eq!(
        return_type("list_directories"),
        "Result<Vec<Directory>, AppError>"
    );
    assert_eq!(
        return_type("get_close_behavior"),
        "Result<CloseBehavior, AppError>"
    );
    assert!(definitions
        .iter()
        .all(|command| !command.return_type.starts_with("->")));
    assert!(
        definitions
            .iter()
            .filter(|command| command.return_type.starts_with("Result<"))
            .count()
            >= 60,
        "大多数命令返回 Result<_, AppError>"
    );
}

#[test]
fn every_command_return_dto_has_a_golden_fixture() {
    const PRIMITIVES: [&str; 6] = ["()", "bool", "i64", "usize", "u32", "String"];

    fn payload_type(return_type: &str) -> Option<String> {
        if return_type.is_empty() {
            return None;
        }
        let mut text = return_type.trim().to_string();
        if let Some(rest) = text.strip_prefix("Result<") {
            let end = rest
                .rfind(", AppError>")
                .expect("commands must return Result<_, AppError>");
            text = rest[..end].trim().to_string();
        }
        loop {
            let inner = ["Vec<", "Option<"].iter().find_map(|prefix| {
                text.strip_prefix(prefix)
                    .and_then(|rest| rest.strip_suffix('>'))
                    .map(|rest| rest.trim().to_string())
            });
            match inner {
                Some(inner) => text = inner,
                None => break,
            }
        }
        Some(text.rsplit("::").next().unwrap_or(&text).to_string())
    }

    let samples = fixtures::ipc_dto_samples();
    let with_file: std::collections::BTreeSet<&str> = samples
        .iter()
        .filter(|sample| sample.fixture_file.is_some())
        .map(|sample| sample.type_name)
        .collect();
    let commands = command_definitions();
    assert!(
        commands.len() >= 60,
        "命令解析异常：只解析到 {} 个",
        commands.len()
    );

    let mut missing = std::collections::BTreeSet::new();
    for command in &commands {
        let Some(dto) = payload_type(&command.return_type) else {
            continue;
        };
        if PRIMITIVES.contains(&dto.as_str()) {
            continue;
        }
        if !with_file.contains(dto.as_str()) {
            missing.insert(format!("{}（命令 {}）", dto, command.name));
        }
    }
    assert!(
        missing.is_empty(),
        "这些命令返回的 DTO 没有 golden fixture：{missing:?}"
    );
}

#[test]
fn dto_samples_cover_option_fields_with_some_and_none() {
    let samples = fixtures::ipc_dto_samples();
    let cases_of = |type_name: &str| -> Vec<(String, serde_json::Value)> {
        samples
            .iter()
            .find(|sample| sample.type_name == type_name)
            .unwrap_or_else(|| panic!("缺少样本类型 {type_name}"))
            .cases
            .clone()
    };

    // Directory：lastUsedAt、note 同时有 Some 与 None。
    let directory = cases_of("Directory");
    for key in ["lastUsedAt", "note"] {
        assert!(
            directory.iter().any(|(_, value)| !value[key].is_null()),
            "Directory.{key} 缺 Some"
        );
        assert!(
            directory.iter().any(|(_, value)| value[key].is_null()),
            "Directory.{key} 缺 None"
        );
    }
    // LaunchHistoryEntry：errorCategory、ptySessionId 同时有 Some 与 None。
    let history = cases_of("LaunchHistoryEntry");
    for key in ["errorCategory", "ptySessionId"] {
        assert!(
            history.iter().any(|(_, value)| !value[key].is_null()),
            "LaunchHistoryEntry.{key} 缺 Some"
        );
        assert!(
            history.iter().any(|(_, value)| value[key].is_null()),
            "LaunchHistoryEntry.{key} 缺 None"
        );
    }
    // SessionPage：nextCursor 同时有 Some 与 None；items 里的 alias、lastActiveMs 同时有 Some 与 None。
    let pages = cases_of("SessionPage");
    assert!(pages
        .iter()
        .any(|(_, value)| !value["nextCursor"].is_null()));
    assert!(pages.iter().any(|(_, value)| value["nextCursor"].is_null()));
    let mut items = Vec::new();
    for (_, value) in &pages {
        for item in value["items"].as_array().cloned().unwrap_or_default() {
            items.push(item);
        }
    }
    for key in ["alias", "lastActiveMs"] {
        assert!(
            items.iter().any(|item| !item[key].is_null()),
            "SessionInfo.{key} 缺 Some"
        );
        assert!(
            items.iter().any(|item| item[key].is_null()),
            "SessionInfo.{key} 缺 None"
        );
    }
    // 每个新增类型都至少有一个 case，且 case 名唯一。
    for type_name in [
        "Directory",
        "BackupManifest",
        "WorkspaceLayoutPresetSummary",
        "LaunchHistoryEntry",
        "ProjectFileCasResidueListing",
        "SessionPage",
        "SessionSearchIndexRefresh",
        "SessionSearchResults",
        "ExecutionTaskDetail",
        "CloseBehavior",
        "ProjectDirectoryListing",
        "CacheStats",
        "PtyHandoff",
        "PtySession",
        "LatestVersion",
        "ExecutionLogChunk",
    ] {
        let cases = cases_of(type_name);
        assert!(!cases.is_empty(), "{type_name} 没有样本");
        let names: std::collections::BTreeSet<&str> =
            cases.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names.len(), cases.len(), "{type_name} 的 case 名重复");
    }
}

#[test]
fn event_payload_fixtures_cover_every_payload_event() {
    // 事件名 -> 载荷 fixture 文件；None 表示没有 Rust 载荷（单元值或前端定义的载荷）。
    const EVENT_PAYLOADS: [(&str, Option<&str>); 8] = [
        ("app-exit-requested", Some("exit-requested-payload.json")),
        ("app-preferences", None),
        ("execution-task-log", Some("execution-log-chunk.json")),
        ("execution-task-updated", Some("execution-task.json")),
        (
            "pty-session-owner-lost",
            Some("event-pty-session-owner-lost.json"),
        ),
        ("window-message", Some("event-inbox-message.json")),
        (
            "workspace-content-window-lost",
            Some("event-workspace-content-window-lost.json"),
        ),
        ("workspace-data-restored", None),
    ];
    let events: serde_json::Value = serde_json::from_str(EVENTS_JSON).expect("parse events");
    let mut contract: Vec<&str> = events["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["name"].as_str().expect("event name"))
        .collect();
    contract.sort();
    let mut table: Vec<&str> = EVENT_PAYLOADS.iter().map(|(name, _)| *name).collect();
    table.sort();
    assert_eq!(contract, table, "events.json 的事件集合必须等于映射表");

    let files: std::collections::BTreeSet<&str> = fixtures::ipc_dto_samples()
        .iter()
        .filter_map(|sample| sample.fixture_file)
        .collect();
    for (name, file) in EVENT_PAYLOADS {
        if let Some(file) = file {
            assert!(
                files.contains(file),
                "事件 {name} 的载荷 fixture {file} 没有登记"
            );
        }
    }
}

#[test]
fn layout_fixtures_are_accepted_or_rejected_consistently() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/fixtures/layouts");
    let read = |directory: &str| -> Vec<(String, String)> {
        let mut files: Vec<(String, String)> = std::fs::read_dir(root.join(directory))
            .unwrap_or_else(|error| panic!("读取 layouts/{directory} 失败：{error}"))
            .map(|entry| entry.expect("read entry").path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .map(|path| {
                (
                    path.file_name().unwrap().to_string_lossy().to_string(),
                    std::fs::read_to_string(&path).expect("read layout fixture"),
                )
            })
            .collect();
        files.sort();
        files
    };
    let valid = read("valid");
    let invalid = read("invalid");
    assert_eq!(valid.len(), 3, "valid 样例必须恰为 3 个");
    assert_eq!(invalid.len(), 8, "invalid 样例必须恰为 8 个");
    for (name, text) in &valid {
        assert!(
            crate::models::workspace_layout::WorkspaceLayoutDocument::from_json(text).is_ok(),
            "valid/{name} 应被 Rust 接受"
        );
    }
    for (name, text) in &invalid {
        assert!(
            crate::models::workspace_layout::WorkspaceLayoutDocument::from_json(text).is_err(),
            "invalid/{name} 应被 Rust 拒绝"
        );
    }
}

#[test]
fn golden_layout_fixtures_match_generated_documents() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/fixtures/layouts");
    let update = std::env::var_os("UPDATE_CONTRACT_FIXTURES").is_some();
    let documents = fixtures::layout_fixture_documents();
    assert_eq!(
        documents
            .iter()
            .filter(|(kind, _, _)| *kind == "valid")
            .count(),
        3
    );
    assert_eq!(
        documents
            .iter()
            .filter(|(kind, _, _)| *kind == "invalid")
            .count(),
        8
    );

    for (kind, name, value) in &documents {
        let expected = fixtures::render_fixture(value);
        let path = root.join(kind).join(format!("{name}.json"));
        if update {
            std::fs::create_dir_all(path.parent().unwrap())
                .expect("create layout fixture directory");
            std::fs::write(&path, &expected).expect("write layout fixture");
        }
        let actual = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("读取 {kind}/{name}.json 失败：{error}。运行 UPDATE_CONTRACT_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --locked golden_layout_fixtures 重新生成"))
            .replace("\r\n", "\n");
        assert_eq!(actual, expected, "{kind}/{name}.json 与生成结果不一致");
    }
    for kind in ["valid", "invalid"] {
        let mut on_disk: Vec<String> = std::fs::read_dir(root.join(kind))
            .expect("read layout fixture directory")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        on_disk.sort();
        let mut expected: Vec<String> = documents
            .iter()
            .filter(|(candidate, _, _)| candidate == &kind)
            .map(|(_, name, _)| format!("{name}.json"))
            .collect();
        expected.sort();
        assert_eq!(on_disk, expected, "{kind} 目录里不能有多余或缺少的文件");
    }
}

#[test]
fn api_versions_contract_matches_the_rust_protocol_constants() {
    let contract: serde_json::Value =
        serde_json::from_str(API_VERSIONS_JSON).expect("parse api versions contract");
    let version_of = |id: &str| -> u64 {
        contract["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["id"] == id)
            .unwrap_or_else(|| panic!("api-versions.json 缺少 {id}"))["version"]
            .as_u64()
            .expect("version must be a number")
    };

    assert_eq!(
        u64::from(crate::services::cli_adapters::PROVIDER_DESCRIPTOR_API_VERSION),
        version_of("providerDescriptor")
    );
    let messages: serde_json::Value =
        serde_json::from_str(WINDOW_MESSAGES_JSON).expect("parse window messages contract");
    for item in messages["items"].as_array().expect("messages") {
        assert_eq!(
            item["payloadVersion"].as_u64(),
            Some(version_of("windowMessage")),
            "{}",
            item["type"]
        );
    }
    let versions: Vec<&str> = contract["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    let mut sorted = versions.clone();
    sorted.sort();
    assert_eq!(versions, sorted, "api-versions.json 的条目必须按 id 排序");
    assert_eq!(versions.len(), 7);
}

#[test]
fn command_manifest_has_no_companion_caller_check_file() {
    let companion = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../contracts/command-caller-checks.json");
    assert!(
        !companion.exists(),
        "命令授权规则已并入 contracts/app-commands.json，伴随文件不应存在: {}",
        companion.display()
    );

    let manifest: serde_json::Value =
        serde_json::from_str(APP_COMMANDS_JSON).expect("parse app command contract");
    let items = manifest["items"].as_array().expect("items array");
    assert!(items.len() >= 70, "命令数量过少: {}", items.len());
    for item in items {
        let object = item.as_object().expect("every command item is an object");
        let name = object
            .get("name")
            .and_then(serde_json::Value::as_str)
            .expect("every command item has a name");
        assert!(
            object.contains_key("callerCheck"),
            "{name} 缺少 callerCheck"
        );
        assert!(
            !object.contains_key("command"),
            "{name} 仍带有旧字段 command"
        );
    }
}

/// PD-10: relative paths are compared in one place (`PathKey::of`). The three files that hold
/// project-relative paths must not fold case or branch on the platform themselves.
#[test]
fn relative_path_identity_has_no_platform_branching() {
    const FORBIDDEN: [&str; 5] = [
        "relative_path.to_lowercase()",
        "relative_path.to_ascii_lowercase()",
        "eq_ignore_ascii_case(",
        "cfg(windows)",
        "cfg(target_os = \"macos\")",
    ];
    let violations = |text: &str| -> Vec<&'static str> {
        FORBIDDEN
            .iter()
            .copied()
            .filter(|pattern| text.contains(pattern))
            .collect()
    };

    // Self-check: the scan must see a violation, or it would pass vacuously.
    assert_eq!(
        violations("let key = relative_path.to_lowercase();"),
        vec!["relative_path.to_lowercase()"]
    );

    for (name, source) in [
        (
            "models/workspace_layout.rs",
            include_str!("../models/workspace_layout.rs"),
        ),
        (
            "services/file_service.rs",
            include_str!("../services/file_service.rs"),
        ),
        (
            "services/workspace_layout_service.rs",
            include_str!("../services/workspace_layout_service.rs"),
        ),
    ] {
        assert_eq!(
            violations(&production_text(source)),
            Vec::<&str>::new(),
            "{name}: relative-path identity must go through PathKey::of"
        );
    }
}
