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
const CONTENT_KINDS_JSON: &str = include_str!("../../../contracts/content-kinds.json");
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
    let contract: Vec<String> =
        serde_json::from_str(TOOL_KEYS_JSON).expect("parse ToolKey contract");
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
    assert_eq!(contract["adapterApiVersion"], 2);
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

    assert_eq!(json_strings(&contract["kinds"]), serialized_kinds);
}

#[test]
fn window_kind_contract_matches_rust_registry() {
    use crate::models::window_kind::{window_kind_of, WindowKind};

    let manifest: Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse WindowKind contract");
    let kinds = manifest["kinds"]
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
    let commands: Vec<String> =
        serde_json::from_str(APP_COMMANDS_JSON).expect("parse app command contract");
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

    let app_commands: Vec<String> =
        serde_json::from_str(APP_COMMANDS_JSON).expect("parse app command contract");
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
    manifest["kinds"]
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
    let contract: Vec<String> =
        serde_json::from_str(APP_COMMANDS_JSON).expect("parse app command contract");
    assert_eq!(
        sorted_strings(parse_handler_commands(LIB_RS).expect("parse lib.rs")),
        sorted_strings(contract)
    );
}

#[test]
fn capability_comparator_rejects_extra_plugin_and_object_permissions() {
    let manifest: Value =
        serde_json::from_str(WINDOW_KINDS_JSON).expect("parse window kind contract");
    let app_commands: Vec<String> =
        serde_json::from_str(APP_COMMANDS_JSON).expect("parse app command contract");
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
        sorted_strings(json_strings(&contract["kinds"]))
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
            "InstallPlan",
            "installFull",
            "installMinimal",
            &["/effects"],
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

    assert_eq!(expected_files.len(), 12, "fixture 映射表必须恰好 12 个文件");
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
    assert!(pty.contains("lookup_launch_directory"));
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
    // Removes every `#[cfg(test)]` item (its first brace block), wherever it appears,
    // so production code placed after a test helper is still checked.
    fn production(source: &str) -> String {
        let mut out = String::new();
        let mut rest = source;
        while let Some(at) = rest.find("#[cfg(test)]") {
            out.push_str(&rest[..at]);
            let item = &rest[at..];
            let open = item.find('{').expect("cfg(test) item has a body");
            let mut depth = 0usize;
            let mut end = None;
            for (i, ch) in item[open..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(open + i + 1);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            rest = &item[end.expect("balanced braces")..];
        }
        out.push_str(rest);
        out
    }
    for (name, source) in [
        (
            "pty_session_service.rs",
            include_str!("../services/pty_session_service.rs"),
        ),
        (
            "content_window_grants.rs",
            include_str!("../services/content_window_grants.rs"),
        ),
    ] {
        let source = production(source);
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
