use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    Install,
    Update,
}

impl InstallKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Update => "update",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "install" => Some(Self::Install),
            "update" => Some(Self::Update),
            _ => None,
        }
    }
}

/// A structured install/update command, modelled as program + args so the
/// business layer never concatenates free-form shell strings.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub tool_key: ToolKey,
    pub kind: InstallKind,
    pub program: String,
    pub args: Vec<String>,
    /// Human-readable source/origin shown in the UI.
    pub source: String,
    /// Human-readable command preview shown before execution.
    pub preview: String,
    /// Optional read-only details that explain the effect of an operation.
    #[serde(default)]
    pub effects: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    pub tool_key: ToolKey,
    pub latest: Option<String>,
    /// Branch-based update state for tools without a semantic latest version.
    #[serde(default)]
    pub update_available: Option<bool>,
    /// Number of upstream commits behind the configured branch, when known.
    #[serde(default)]
    pub commits_behind: Option<u32>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub from_cache: bool,
    /// Whether Launchpad may run the tool's built-in updater. Grok is allowed
    /// only when its native installer source and executable location agree.
    #[serde(default)]
    pub managed_update_allowed: bool,
    /// Why a managed update is unavailable, when source verification failed.
    #[serde(default)]
    pub management_message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::LatestVersion;

    #[test]
    fn older_latest_version_cache_defaults_grok_update_gate_to_closed() {
        let cached: LatestVersion = serde_json::from_str(
            r#"{"toolKey":"grok","latest":"1.0.44","error":null,"fromCache":false}"#,
        )
        .unwrap();

        assert!(!cached.managed_update_allowed);
        assert_eq!(cached.management_message, None);
        assert_eq!(cached.update_available, None);
        assert_eq!(cached.commits_behind, None);
    }
}
