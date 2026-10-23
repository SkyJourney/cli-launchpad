use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const WINDOW_KINDS_JSON: &str = include_str!("../../../contracts/window-kinds.json");

/// A window kind, identified by its id in `contracts/window-kinds.json`.
///
/// The contract is the single source of truth: a kind is valid exactly when the contract lists it,
/// so adding a kind does not require a Rust enum variant. The three kinds the Rust side names
/// directly are constants; any other kind is obtained with [`WindowKind::from_id`].
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct WindowKind(&'static str);

impl WindowKind {
    pub const TERMINAL: WindowKind = WindowKind("terminal");
    pub const WORKSPACE_CONTENT: WindowKind = WindowKind("workspaceContent");

    /// The main application window: the one kind the contract marks `primary`.
    pub fn main() -> WindowKind {
        definitions()
            .iter()
            .find(|definition| definition.primary)
            .map(|definition| WindowKind(definition.id.as_str()))
            .expect("window-kinds.json must declare the primary window kind")
    }

    /// The kind the contract lists under `id`, or `None` when the contract has no such kind.
    pub fn from_id(id: &str) -> Option<WindowKind> {
        definitions()
            .iter()
            .find(|definition| definition.id == id)
            .map(|definition| WindowKind(definition.id.as_str()))
    }
}

impl Serialize for WindowKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for WindowKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        WindowKind::from_id(&id)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown window kind `{id}`")))
    }
}

#[derive(Deserialize)]
struct WindowKindsManifest {
    items: Vec<WindowKindDefinition>,
}

#[derive(Deserialize)]
struct WindowKindDefinition {
    id: String,
    label: Option<String>,
    #[serde(rename = "labelPrefix")]
    label_prefix: Option<String>,
    primary: bool,
    #[serde(rename = "ptyHost")]
    pty_host: bool,
    #[serde(rename = "ownsPty")]
    owns_pty: bool,
    #[serde(rename = "fileGrant")]
    file_grant: bool,
    #[cfg(test)]
    #[serde(rename = "contentKinds")]
    content_kinds: Vec<String>,
    /// `"all"` for the main window, otherwise the list of app commands the window may invoke.
    #[serde(rename = "appCommands")]
    app_commands: serde_json::Value,
}

impl WindowKindDefinition {
    /// Whether the contract grants this window kind the named app command.
    fn grants_command(&self, command: &str) -> bool {
        match &self.app_commands {
            serde_json::Value::String(grant) => grant == "all",
            serde_json::Value::Array(commands) => {
                commands.iter().any(|name| name.as_str() == Some(command))
            }
            _ => false,
        }
    }
}

impl WindowKind {
    fn definition(self) -> &'static WindowKindDefinition {
        definitions()
            .iter()
            .find(|definition| definition.id == self.0)
            .expect("window kind must be registered")
    }

    /// The single main application window.
    pub fn is_primary(self) -> bool {
        self.definition().primary
    }

    /// Windows of this kind can show a PTY terminal view.
    pub fn is_pty_host(self) -> bool {
        self.definition().pty_host
    }

    /// Destroying a window of this kind must hand its PTY sessions back.
    pub fn owns_pty(self) -> bool {
        self.definition().owns_pty
    }

    /// Windows of this kind hold file grants.
    pub fn has_file_grant(self) -> bool {
        self.definition().file_grant
    }

    #[cfg(test)]
    pub fn content_kinds(self) -> &'static [String] {
        &self.definition().content_kinds
    }
}

fn definitions() -> &'static [WindowKindDefinition] {
    static DEFINITIONS: OnceLock<Vec<WindowKindDefinition>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| {
        serde_json::from_str::<WindowKindsManifest>(WINDOW_KINDS_JSON)
            .expect("window-kinds.json must be valid")
            .items
    })
}

pub fn window_kind_of(label: &str) -> Option<WindowKind> {
    definitions().iter().find_map(|definition| {
        if definition.label.as_deref() == Some(label) {
            return Some(WindowKind(definition.id.as_str()));
        }
        let prefix = definition.label_prefix.as_deref()?;
        let suffix = label.strip_prefix(prefix)?;
        let parsed = uuid::Uuid::parse_str(suffix).ok()?;
        let canonical = parsed.hyphenated().to_string();
        let bytes = parsed.as_bytes();
        let version = bytes[6] >> 4;
        let variant = bytes[8] >> 6;
        (suffix.len() == 36
            && canonical.eq_ignore_ascii_case(suffix)
            && (1..=8).contains(&version)
            && variant == 0b10)
            .then_some(WindowKind(definition.id.as_str()))
    })
}

// Rust-side counterpart to the shared TypeScript label factory; only the tests create labels.
#[cfg(test)]
pub fn create_window_label(kind: WindowKind) -> String {
    let definition = definitions()
        .iter()
        .find(|definition| definition.id == kind.0)
        .expect("window kind must be registered");
    match (&definition.label, &definition.label_prefix) {
        (Some(label), None) => label.clone(),
        (None, Some(prefix)) => format!("{prefix}{}", uuid::Uuid::new_v4()),
        _ => panic!("window kind must have exactly one label rule"),
    }
}

// Rust-side counterpart to the shared TypeScript predicate. The production caller is the
// acceptance hook, so the function exists only where that hook or the tests are compiled.
#[cfg(any(test, feature = "acceptance-hooks"))]
pub fn is_detached_window_label(label: &str) -> bool {
    window_kind_of(label).is_some_and(|kind| !kind.is_primary())
}

use crate::error_codes::ErrorCode;
use crate::AppError;

// m6-033 moves these into the error code registry.

/// The main window's label, read from `contracts/window-kinds.json`.
pub fn main_window_label() -> &'static str {
    definitions()
        .iter()
        .find(|definition| definition.primary)
        .and_then(|definition| definition.label.as_deref())
        .expect("window-kinds.json must declare the main window label")
}

/// A window label that is known to belong to a registered window kind.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WindowLabel {
    raw: String,
    kind: WindowKind,
}

impl WindowLabel {
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        let kind = window_kind_of(raw)
            .ok_or_else(|| AppError::coded(ErrorCode::WindowLabelInvalid, "窗口标识无效"))?;
        Ok(Self {
            raw: raw.to_string(),
            kind,
        })
    }

    /// The main window's label. The label comes from `contracts/window-kinds.json`, so it is
    /// canonical by construction and needs no parsing.
    pub fn main() -> Self {
        Self {
            raw: main_window_label().to_string(),
            kind: WindowKind::main(),
        }
    }

    pub fn kind(&self) -> WindowKind {
        self.kind
    }

    pub fn as_str(&self) -> &str {
        &self.raw
    }

    pub fn is_main(&self) -> bool {
        self.kind == WindowKind::main()
    }
}

impl std::fmt::Display for WindowLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.raw)
    }
}

/// Builds a label for tests; the label must be canonical.
#[cfg(test)]
pub(crate) fn test_label(raw: &str) -> WindowLabel {
    WindowLabel::parse(raw).expect("test labels are canonical")
}

/// The window that invoked a command, resolved and validated at the command boundary.
pub struct CallerWindow(WindowLabel);

impl CallerWindow {
    pub fn from_label(raw: &str) -> Result<Self, AppError> {
        WindowLabel::parse(raw).map(Self)
    }

    pub fn label(&self) -> &WindowLabel {
        &self.0
    }

    /// Whether the calling window's contract entry grants `command` (W1: parallel to `require`).
    pub fn require_command(&self, command: &str) -> Result<(), AppError> {
        if self.0.kind().definition().grants_command(command) {
            Ok(())
        } else {
            Err(AppError::coded(
                ErrorCode::WindowNotAllowed,
                "当前窗口不允许执行该操作",
            ))
        }
    }

    pub fn require(&self, allowed: &[WindowKind]) -> Result<(), AppError> {
        if allowed.contains(&self.0.kind()) {
            Ok(())
        } else {
            Err(AppError::coded(
                ErrorCode::WindowNotAllowed,
                "当前窗口不允许执行该操作",
            ))
        }
    }
}

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for CallerWindow {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let window =
            <tauri::WebviewWindow<R> as tauri::ipc::CommandArg<'de, R>>::from_command(command)?;
        Self::from_label(window.label()).map_err(tauri::ipc::InvokeError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_window_label, is_detached_window_label, test_label, window_kind_of, CallerWindow,
        WindowKind, WindowLabel,
    };

    const WINDOW_LABEL_FIXTURES_JSON: &str =
        include_str!("../../../contracts/window-label-fixtures.json");

    #[test]
    fn contract_grants_app_commands_per_window_kind() {
        // 主窗口为 "all"；终端与内容窗口只拿到契约声明的命令。
        assert!(WindowKind::main()
            .definition()
            .grants_command("terminate_pty_session"));
        assert!(WindowKind::TERMINAL
            .definition()
            .grants_command("write_pty_session"));
        assert!(WindowKind::WORKSPACE_CONTENT
            .definition()
            .grants_command("send_window_message"));
        assert!(!WindowKind::WORKSPACE_CONTENT
            .definition()
            .grants_command("write_pty_session"));
        assert!(!WindowKind::TERMINAL
            .definition()
            .grants_command("no_such_command"));

        let main = CallerWindow::from_label("main").expect("main label");
        assert!(main.require_command("terminate_pty_session").is_ok());
        assert!(main.require_command("no_such_command").is_ok());
    }

    #[test]
    fn role_queries_match_the_contract_roles() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/window-kinds.json"))
                .expect("parse window kinds");
        let items = manifest["items"].as_array().expect("items");
        assert_eq!(items.len(), 3);
        for item in items {
            let kind: WindowKind =
                serde_json::from_value(item["id"].clone()).expect("window kind id");
            assert_eq!(kind.is_primary(), item["primary"].as_bool().unwrap());
            assert_eq!(kind.is_pty_host(), item["ptyHost"].as_bool().unwrap());
            assert_eq!(kind.owns_pty(), item["ownsPty"].as_bool().unwrap());
            assert_eq!(kind.has_file_grant(), item["fileGrant"].as_bool().unwrap());
            let contract_kinds: Vec<&str> = item["contentKinds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            assert_eq!(
                kind.content_kinds()
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                contract_kinds
            );
        }
        // 固定语义：只有 main 是 primary；只有 terminal 拥有 PTY；只有 workspaceContent 持有文件授权。
        assert!(WindowKind::main().is_primary());
        assert!(!WindowKind::TERMINAL.is_primary() && !WindowKind::WORKSPACE_CONTENT.is_primary());
        assert!(WindowKind::TERMINAL.owns_pty() && !WindowKind::main().owns_pty());
        assert!(WindowKind::WORKSPACE_CONTENT.has_file_grant());
        assert!(!WindowKind::TERMINAL.has_file_grant() && !WindowKind::main().has_file_grant());
        assert!(WindowKind::main().is_pty_host() && WindowKind::TERMINAL.is_pty_host());
        assert!(!WindowKind::WORKSPACE_CONTENT.is_pty_host());
    }

    #[test]
    fn detached_labels_are_the_non_primary_kinds() {
        assert!(!is_detached_window_label("main"));
        assert!(is_detached_window_label(
            "terminal-8e783338-f464-4b10-b15e-b534748c6241"
        ));
        assert!(is_detached_window_label(
            "workspace-content-8e783338-f464-4b10-b15e-b534748c6241"
        ));
        assert!(!is_detached_window_label("settings"));
        assert_eq!(super::main_window_label(), "main");
    }

    #[test]
    fn window_label_fixture_vectors_match_rust_registry() {
        let fixtures: serde_json::Value =
            serde_json::from_str(WINDOW_LABEL_FIXTURES_JSON).expect("parse label fixtures");
        let accept = fixtures["accept"]
            .as_object()
            .expect("accept must be an object");
        assert_eq!(accept.len(), 3, "accept must cover exactly three kinds");
        for (key, kind) in [
            ("main", WindowKind::main()),
            ("terminal", WindowKind::TERMINAL),
            ("workspaceContent", WindowKind::WORKSPACE_CONTENT),
        ] {
            let labels = accept[key]
                .as_array()
                .expect("accept entries must be arrays");
            assert!(
                !labels.is_empty(),
                "{key} needs at least one accepted label"
            );
            for label in labels {
                let label = label.as_str().expect("label must be a string");
                assert_eq!(window_kind_of(label), Some(kind), "{label:?}");
            }
        }
        let rejected = fixtures["reject"]
            .as_array()
            .expect("reject must be an array");
        assert!(!rejected.is_empty());
        for label in rejected {
            let label = label.as_str().expect("label must be a string");
            assert_eq!(window_kind_of(label), None, "{label:?}");
        }
    }

    #[test]
    fn resolves_registered_window_labels() {
        assert_eq!(window_kind_of("main"), Some(WindowKind::main()));
        assert_eq!(
            window_kind_of("terminal-8e783338-f464-4b10-b15e-b534748c6241"),
            Some(WindowKind::TERMINAL)
        );
        assert_eq!(
            window_kind_of("workspace-content-8e783338-f464-4b10-b15e-b534748c6241"),
            Some(WindowKind::WORKSPACE_CONTENT)
        );
        assert_eq!(window_kind_of("terminal-invalid!"), None);
        assert_eq!(
            window_kind_of("terminal-8e783338f4644b10b15eb534748c6241"),
            None
        );
        assert_eq!(
            window_kind_of("terminal-8e783338-f464-0b10-b15e-b534748c6241"),
            None
        );
        assert_eq!(window_kind_of("unknown-window"), None);
    }

    #[test]
    fn creates_detached_labels_from_the_registered_prefix() {
        let terminal = create_window_label(WindowKind::TERMINAL);
        let file = create_window_label(WindowKind::WORKSPACE_CONTENT);

        assert_eq!(window_kind_of(&terminal), Some(WindowKind::TERMINAL));
        assert_eq!(window_kind_of(&file), Some(WindowKind::WORKSPACE_CONTENT));
        assert!(!is_detached_window_label("main"));
        assert!(is_detached_window_label(&terminal));
        assert!(is_detached_window_label(&file));
    }

    #[test]
    fn window_label_parse_matches_the_shared_fixture_vectors() {
        use super::WindowLabel;
        let fixtures: serde_json::Value =
            serde_json::from_str(WINDOW_LABEL_FIXTURES_JSON).expect("parse label fixtures");
        for (key, kind) in [
            ("main", WindowKind::main()),
            ("terminal", WindowKind::TERMINAL),
            ("workspaceContent", WindowKind::WORKSPACE_CONTENT),
        ] {
            for label in fixtures["accept"][key].as_array().expect("accept arrays") {
                let label = label.as_str().expect("label string");
                let parsed = WindowLabel::parse(label)
                    .unwrap_or_else(|error| panic!("{label:?} must parse but got {error}"));
                assert_eq!(parsed.kind(), kind, "{label:?}");
                assert_eq!(parsed.as_str(), label);
            }
        }
        for label in fixtures["reject"].as_array().expect("reject array") {
            let label = label.as_str().expect("label string");
            let error = match WindowLabel::parse(label) {
                Ok(_) => panic!("{label:?} must be rejected"),
                Err(error) => error,
            };
            assert_eq!(
                serde_json::to_value(&error).unwrap()["code"],
                "window.label_invalid",
                "{label:?}"
            );
        }
    }

    #[test]
    fn window_label_exposes_kind_and_main_flag() {
        use super::WindowLabel;
        let main = WindowLabel::parse("main").unwrap();
        assert!(main.is_main());
        assert_eq!(main.kind(), WindowKind::main());
        let terminal = WindowLabel::parse("terminal-8e783338-f464-4b10-b15e-b534748c6241").unwrap();
        assert!(!terminal.is_main());
        assert_eq!(terminal.kind(), WindowKind::TERMINAL);
        assert_eq!(
            WindowLabel::parse("terminal-8e783338-f464-4b10-b15e-b534748c6241").unwrap(),
            terminal
        );
        assert_ne!(main, terminal);
        assert_eq!(terminal.to_string(), terminal.as_str());
    }

    #[test]
    fn caller_window_require_allows_only_the_listed_kinds() {
        use super::CallerWindow;
        let caller =
            CallerWindow::from_label("workspace-content-11111111-2222-4333-8444-555555555555")
                .unwrap();
        assert!(caller
            .require(&[WindowKind::WORKSPACE_CONTENT, WindowKind::main()])
            .is_ok());
        let error = caller
            .require(&[WindowKind::main(), WindowKind::TERMINAL])
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["code"],
            "window.not_allowed"
        );
        assert!(
            caller.require(&[]).is_err(),
            "an empty allow list admits nobody"
        );
        assert!(CallerWindow::from_label("settings").is_err());
    }

    #[test]
    fn main_label_helpers_read_the_contract() {
        use super::main_window_label;
        assert_eq!(main_window_label(), "main");
        // The classifier helpers are gone (m6-102): the window class comes from `WindowLabel::kind`,
        // and the canonical-UUID rule for terminals is covered by WL-B.
    }

    #[test]
    fn caller_window_errors_reach_the_frontend_with_their_codes() {
        use super::CallerWindow;
        use tauri::ipc::InvokeError;

        let invalid = CallerWindow::from_label("settings").err().unwrap();
        let InvokeError(value) = InvokeError::from(invalid);
        assert_eq!(value["code"], "window.label_invalid");

        let content =
            CallerWindow::from_label("workspace-content-11111111-2222-4333-8444-555555555555")
                .unwrap();
        let denied = content.require(&[WindowKind::main()]).unwrap_err();
        let InvokeError(value) = InvokeError::from(denied);
        assert_eq!(value["code"], "window.not_allowed");
        assert!(value["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty()));
    }

    #[test]
    fn window_label_main_constructor_matches_the_contract() {
        // m6-102 WL-A: the constructor agrees with the contract and with parsing.
        assert_eq!(WindowLabel::main().kind(), WindowKind::main());
        assert_eq!(WindowLabel::main().as_str(), super::main_window_label());
        assert!(WindowLabel::main().is_main());
        assert_eq!(
            WindowLabel::main(),
            WindowLabel::parse(super::main_window_label()).unwrap()
        );
        // Reverse: a terminal label is never the main window.
        assert_ne!(
            WindowLabel::main(),
            test_label("terminal-8e783338-f464-4b10-b15e-b534748c6241")
        );
    }

    #[test]
    fn a_terminal_looking_label_without_a_canonical_uuid_is_not_a_window_label() {
        // m6-102 WL-B: parsing is canonical-UUID only, so the old prefix meaning is gone.
        for raw in [
            "terminal-anything",
            "terminal-a",
            "workspace-content-invalid",
            "settings",
        ] {
            let error = WindowLabel::parse(raw).expect_err(raw);
            assert_eq!(
                serde_json::to_value(&error).unwrap()["code"],
                "window.label_invalid",
                "{raw}"
            );
        }
        // Reverse: the canonical terminal label is accepted.
        let terminal = WindowLabel::parse("terminal-8e783338-f464-4b10-b15e-b534748c6241").unwrap();
        assert_eq!(terminal.kind(), WindowKind::TERMINAL);
    }
}
