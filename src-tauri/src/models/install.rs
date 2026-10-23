use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
    #[serde(default)]
    pub fingerprint: String,
    /// Human-readable source/origin shown in the UI.
    pub source: String,
    /// Human-readable command preview shown before execution.
    pub preview: String,
}

impl InstallPlan {
    pub fn calculated_fingerprint(&self) -> String {
        let normalized = serde_json::to_vec(&(
            self.tool_key,
            self.kind,
            &self.program,
            &self.args,
            &self.source,
        ))
        .expect("install plan fingerprint fields are serializable");
        format!("{:x}", Sha256::digest(normalized))
    }

    pub fn refresh_fingerprint(&mut self) {
        self.fingerprint = self.calculated_fingerprint();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ManagedUpdateStatus {
    Allowed,
    Denied {
        /// 旧版本把字段写成 `reason_key` 并存进了 JSON 缓存，仍要能读。
        #[serde(alias = "reason_key")]
        reason_key: String,
    },
    NotApplicable,
}

impl Default for ManagedUpdateStatus {
    fn default() -> Self {
        Self::NotApplicable
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateAvailability {
    Available,
    UpToDate,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    pub tool_key: ToolKey,
    pub latest: Option<String>,
    #[serde(default)]
    pub update_availability: UpdateAvailability,
    /// Number of upstream commits behind the configured branch, when known.
    #[serde(default)]
    pub commits_behind: Option<u32>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub from_cache: bool,
    #[serde(default)]
    pub managed_update: ManagedUpdateStatus,
}

#[cfg(test)]
mod tests {
    use super::{InstallKind, InstallPlan, LatestVersion, ManagedUpdateStatus, UpdateAvailability};
    use crate::models::tool::ToolKey;

    fn plan() -> InstallPlan {
        InstallPlan {
            tool_key: ToolKey::Codex,
            kind: InstallKind::Update,
            program: "codex".to_string(),
            args: vec!["update".to_string()],
            fingerprint: String::new(),
            source: "native updater".to_string(),
            preview: "codex update".to_string(),
        }
    }

    #[test]
    fn install_plan_fingerprint_is_stable_for_the_confirmed_command() {
        let first = plan().calculated_fingerprint();
        let second = plan().calculated_fingerprint();
        assert_eq!(first, second);
    }

    #[test]
    fn install_plan_fingerprint_changes_when_the_executable_changes() {
        let first = plan().calculated_fingerprint();
        let mut changed = plan();
        changed.program = "C:/different/codex.exe".to_string();
        assert_ne!(first, changed.calculated_fingerprint());
    }

    #[test]
    fn older_latest_version_cache_defaults_new_policy_fields_safely() {
        let cached: LatestVersion = serde_json::from_str(
            r#"{"toolKey":"grok","latest":"1.0.44","error":null,"fromCache":false}"#,
        )
        .unwrap();

        assert_eq!(cached.managed_update, ManagedUpdateStatus::NotApplicable);
        assert_eq!(cached.update_availability, UpdateAvailability::Unknown);
        assert_eq!(cached.commits_behind, None);
    }

    #[test]
    fn managed_update_status_reads_legacy_snake_case_cache() {
        let expected = ManagedUpdateStatus::Denied {
            reason_key: "k".to_string(),
        };
        // 旧版本把 reason_key 写进了 JSON 缓存；新版本仍要能读。
        let legacy: ManagedUpdateStatus =
            serde_json::from_str(r#"{"status":"denied","reason_key":"k"}"#).unwrap();
        assert_eq!(legacy, expected);
        let current: ManagedUpdateStatus =
            serde_json::from_str(r#"{"status":"denied","reasonKey":"k"}"#).unwrap();
        assert_eq!(current, expected);

        let serialized = serde_json::to_string(&expected).unwrap();
        assert!(serialized.contains("reasonKey"), "{serialized}");
        assert!(!serialized.contains("reason_key"), "{serialized}");
    }

    const PLAN_WITHOUT_EFFECTS: &str = r#"{"toolKey":"claude","kind":"update","program":"claude","args":["update"],"fingerprint":"f","source":"s","preview":"p"}"#;

    #[test]
    fn install_plan_serializes_without_an_effects_field() {
        let plan: InstallPlan =
            serde_json::from_str(PLAN_WITHOUT_EFFECTS).expect("plan without effects");
        let value = serde_json::to_value(&plan).expect("serialize plan");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("plan object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "args",
                "fingerprint",
                "kind",
                "preview",
                "program",
                "source",
                "toolKey"
            ]
        );
        assert!(value.get("effects").is_none());
    }

    #[test]
    fn install_plan_ignores_a_legacy_effects_key() {
        let with_null = PLAN_WITHOUT_EFFECTS.replace('}', ",\"effects\":null}");
        let with_text = PLAN_WITHOUT_EFFECTS.replace('}', ",\"effects\":\"old text\"}");
        for json in [with_null, with_text] {
            let plan: InstallPlan = serde_json::from_str(&json).expect("legacy payload");
            assert_eq!(plan.program, "claude");
        }
    }
}
