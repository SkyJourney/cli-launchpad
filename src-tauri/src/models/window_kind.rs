use std::sync::OnceLock;

use serde::Deserialize;

const WINDOW_KINDS_JSON: &str = include_str!("../../../contracts/window-kinds.json");

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum WindowKind {
    Main,
    Terminal,
    WorkspaceContent,
}

#[derive(Deserialize)]
struct WindowKindsManifest {
    kinds: Vec<WindowKindDefinition>,
}

#[derive(Deserialize)]
struct WindowKindDefinition {
    id: WindowKind,
    label: Option<String>,
    #[serde(rename = "labelPrefix")]
    label_prefix: Option<String>,
}

fn definitions() -> &'static [WindowKindDefinition] {
    static DEFINITIONS: OnceLock<Vec<WindowKindDefinition>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| {
        serde_json::from_str::<WindowKindsManifest>(WINDOW_KINDS_JSON)
            .expect("window-kinds.json must be valid")
            .kinds
    })
}

pub fn window_kind_of(label: &str) -> Option<WindowKind> {
    definitions().iter().find_map(|definition| {
        if definition.label.as_deref() == Some(label) {
            return Some(definition.id);
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
            .then_some(definition.id)
    })
}

#[allow(dead_code)] // Kept as the Rust-side counterpart to the shared TypeScript label factory.
pub fn create_window_label(kind: WindowKind) -> String {
    let definition = definitions()
        .iter()
        .find(|definition| definition.id == kind)
        .expect("window kind must be registered");
    match (&definition.label, &definition.label_prefix) {
        (Some(label), None) => label.clone(),
        (None, Some(prefix)) => format!("{prefix}{}", uuid::Uuid::new_v4()),
        _ => panic!("window kind must have exactly one label rule"),
    }
}

#[allow(dead_code)] // Kept as the Rust-side counterpart to the shared TypeScript predicate.
pub fn is_detached_window_label(label: &str) -> bool {
    matches!(
        window_kind_of(label),
        Some(WindowKind::Terminal | WindowKind::WorkspaceContent)
    )
}

use crate::AppError;

// m6-033 moves these into the error code registry.
const CODE_WINDOW_LABEL_INVALID: &str = "window.label_invalid";
const CODE_WINDOW_NOT_ALLOWED: &str = "window.not_allowed";

/// The main window's label, read from `contracts/window-kinds.json`.
pub fn main_window_label() -> &'static str {
    definitions()
        .iter()
        .find(|definition| definition.id == WindowKind::Main)
        .and_then(|definition| definition.label.as_deref())
        .expect("window-kinds.json must declare the main window label")
}

pub fn is_main_label(label: &str) -> bool {
    label == main_window_label()
}

/// Prefix check (no UUID validation) kept for hot paths that already receive
/// labels validated at the command boundary by `WindowLabel::parse`.
pub fn is_terminal_label(label: &str) -> bool {
    definitions()
        .iter()
        .find(|definition| definition.id == WindowKind::Terminal)
        .and_then(|definition| definition.label_prefix.as_deref())
        .is_some_and(|prefix| label.starts_with(prefix))
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
            .ok_or_else(|| AppError::coded(CODE_WINDOW_LABEL_INVALID, "窗口标识无效"))?;
        Ok(Self {
            raw: raw.to_string(),
            kind,
        })
    }

    pub fn kind(&self) -> WindowKind {
        self.kind
    }

    pub fn as_str(&self) -> &str {
        &self.raw
    }

    #[cfg(test)]
    pub fn is_main(&self) -> bool {
        self.kind == WindowKind::Main
    }
}

impl std::fmt::Display for WindowLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.raw)
    }
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

    pub fn require(&self, allowed: &[WindowKind]) -> Result<(), AppError> {
        if allowed.contains(&self.0.kind()) {
            Ok(())
        } else {
            Err(AppError::coded(
                CODE_WINDOW_NOT_ALLOWED,
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
    use super::{create_window_label, is_detached_window_label, window_kind_of, WindowKind};

    const WINDOW_LABEL_FIXTURES_JSON: &str =
        include_str!("../../../contracts/window-label-fixtures.json");

    #[test]
    fn window_label_fixture_vectors_match_rust_registry() {
        let fixtures: serde_json::Value =
            serde_json::from_str(WINDOW_LABEL_FIXTURES_JSON).expect("parse label fixtures");
        let accept = fixtures["accept"]
            .as_object()
            .expect("accept must be an object");
        assert_eq!(accept.len(), 3, "accept must cover exactly three kinds");
        for (key, kind) in [
            ("main", WindowKind::Main),
            ("terminal", WindowKind::Terminal),
            ("workspaceContent", WindowKind::WorkspaceContent),
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
        assert_eq!(window_kind_of("main"), Some(WindowKind::Main));
        assert_eq!(
            window_kind_of("terminal-8e783338-f464-4b10-b15e-b534748c6241"),
            Some(WindowKind::Terminal)
        );
        assert_eq!(
            window_kind_of("workspace-content-8e783338-f464-4b10-b15e-b534748c6241"),
            Some(WindowKind::WorkspaceContent)
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
        let terminal = create_window_label(WindowKind::Terminal);
        let file = create_window_label(WindowKind::WorkspaceContent);

        assert_eq!(window_kind_of(&terminal), Some(WindowKind::Terminal));
        assert_eq!(window_kind_of(&file), Some(WindowKind::WorkspaceContent));
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
            ("main", WindowKind::Main),
            ("terminal", WindowKind::Terminal),
            ("workspaceContent", WindowKind::WorkspaceContent),
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
        assert_eq!(main.kind(), WindowKind::Main);
        let terminal = WindowLabel::parse("terminal-8e783338-f464-4b10-b15e-b534748c6241").unwrap();
        assert!(!terminal.is_main());
        assert_eq!(terminal.kind(), WindowKind::Terminal);
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
            .require(&[WindowKind::WorkspaceContent, WindowKind::Main])
            .is_ok());
        let error = caller
            .require(&[WindowKind::Main, WindowKind::Terminal])
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
        use super::{is_main_label, is_terminal_label, main_window_label};
        assert_eq!(main_window_label(), "main");
        assert!(is_main_label("main"));
        assert!(!is_main_label("Main"));
        assert!(!is_main_label("main "));
        assert!(is_terminal_label(
            "terminal-8e783338-f464-4b10-b15e-b534748c6241"
        ));
        assert!(
            is_terminal_label("terminal-anything"),
            "prefix semantics are kept on purpose"
        );
        assert!(!is_terminal_label(
            "workspace-content-11111111-2222-4333-8444-555555555555"
        ));
        assert!(!is_terminal_label("main"));
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
        let denied = content.require(&[WindowKind::Main]).unwrap_err();
        let InvokeError(value) = InvokeError::from(denied);
        assert_eq!(value["code"], "window.not_allowed");
        assert!(value["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty()));
    }
}
