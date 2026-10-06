use std::sync::OnceLock;

use serde::Deserialize;

const WINDOW_KINDS_JSON: &str = include_str!("../../../contracts/window-kinds.json");

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
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

#[cfg(test)]
mod tests {
    use super::{create_window_label, is_detached_window_label, window_kind_of, WindowKind};

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
}
