use serde::Serialize;

use crate::models::install::ManagedUpdateStatus;
use crate::models::tool::ToolKey;

pub const PROVIDER_DESCRIPTOR_API_VERSION: u32 = 1;

/// How a provider reports "an update exists".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateSemantics {
    /// Compare the detected version with a published latest version.
    Version,
    /// The provider reports its own branch based update state.
    Branch,
}

/// Whether the app may run the provider's update on the user's behalf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ManagedUpdatePolicy {
    /// Always allowed.
    Always,
    /// Allowed only after the installation source was verified.
    SourceVerified { denied_reason_key: &'static str },
}

impl ManagedUpdatePolicy {
    /// `Some(true)` means verified, `Some(false)` means verified-as-unmanaged,
    /// `None` means no verification evidence (treated like a denial).
    pub fn status(self, source_verified: Option<bool>) -> ManagedUpdateStatus {
        match self {
            Self::Always => ManagedUpdateStatus::Allowed,
            Self::SourceVerified { .. } if source_verified == Some(true) => {
                ManagedUpdateStatus::Allowed
            }
            Self::SourceVerified { denied_reason_key } => ManagedUpdateStatus::Denied {
                reason_key: denied_reason_key.to_string(),
            },
        }
    }

    /// The version query itself failed, so nothing is known about the source.
    pub fn status_after_failed_query(self) -> ManagedUpdateStatus {
        match self {
            Self::Always => ManagedUpdateStatus::Allowed,
            Self::SourceVerified { .. } => ManagedUpdateStatus::NotApplicable,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub history: bool,
    pub resume: bool,
    pub update_semantics: UpdateSemantics,
    pub managed_update: ManagedUpdatePolicy,
    /// Locale key namespace of the install effects notice, e.g. `grok`.
    pub install_effects_key: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub tool_key: ToolKey,
    pub api_version: u32,
    pub capabilities: ProviderCapabilities,
}
