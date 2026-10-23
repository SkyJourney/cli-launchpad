use serde::{Deserialize, Serialize};

/// Whether two project-relative paths name the same file on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileIdentityComparison {
    Same,
    Different,
    /// At least one of the files cannot be identified (missing, unreadable).
    Unavailable,
}
