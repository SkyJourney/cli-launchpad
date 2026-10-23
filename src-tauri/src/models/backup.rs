use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupReason {
    Manual,
    PreImport,
    PreRestore,
    PreMigration,
    /// Taken once before a layout whose case duplicates were merged is first written (PD-10).
    PreCaseMerge,
}

impl BackupReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BackupReason::Manual => "manual",
            BackupReason::PreImport => "pre_import",
            BackupReason::PreRestore => "pre_restore",
            BackupReason::PreMigration => "pre_migration",
            BackupReason::PreCaseMerge => "pre_case_merge",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub id: String,
    pub created_at_ms: i64,
    pub reason: BackupReason,
    pub schema_version: i64,
    pub database_filename: String,
    pub size_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::BackupReason;

    #[test]
    fn pre_case_merge_reason_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(BackupReason::PreCaseMerge).unwrap(),
            "pre_case_merge"
        );
        assert_eq!(BackupReason::PreCaseMerge.as_str(), "pre_case_merge");
        let parsed: BackupReason =
            serde_json::from_value(serde_json::json!("pre_case_merge")).unwrap();
        assert!(matches!(parsed, BackupReason::PreCaseMerge));
        // Reverse: the old reasons keep their spelling.
        assert_eq!(BackupReason::PreMigration.as_str(), "pre_migration");
    }
}
