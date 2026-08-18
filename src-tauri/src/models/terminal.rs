use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalDistribution {
    Stable,
    Preview,
    Canary,
    Unpackaged,
}

impl TerminalDistribution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Preview => "preview",
            Self::Canary => "canary",
            Self::Unpackaged => "unpackaged",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellFamily {
    Pwsh,
    WindowsPowerShell,
    Cmd,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfilePreservation {
    Exact,
    CommandContinuation,
    AppearanceOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfileTarget {
    pub target_id: String,
    pub name: String,
    pub guid: String,
    pub source: Option<String>,
    pub is_default: bool,
    pub shell_family: ShellFamily,
    pub preservation: ProfilePreservation,
    pub preservation_reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalHost {
    pub id: String,
    pub distribution: TerminalDistribution,
    pub display_name: String,
    pub executable_path: String,
    pub version: Option<String>,
    pub supports_append_command_line: bool,
    pub settings_path: Option<String>,
    pub profiles: Vec<TerminalProfileTarget>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectShellTarget {
    pub target_id: String,
    pub display_name: String,
    pub shell_family: ShellFamily,
    pub executable_path: String,
    pub priority: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEnvironment {
    pub windows_terminal_hosts: Vec<WindowsTerminalHost>,
    pub direct_shells: Vec<DirectShellTarget>,
    pub recommended_target_id: Option<String>,
    pub warnings: Vec<String>,
}
