use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupReason {
    Manual,
    PreImport,
    PreRestore,
    PreMigration,
}

impl BackupReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BackupReason::Manual => "manual",
            BackupReason::PreImport => "pre_import",
            BackupReason::PreRestore => "pre_restore",
            BackupReason::PreMigration => "pre_migration",
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
