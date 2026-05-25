use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

use crate::db::connection;

use super::storage_service::StoragePaths;

const MAX_LOG_FILES: usize = 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticLog {
    filename: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
    exported_at_ms: i64,
    app_version: &'static str,
    platform: &'static str,
    storage_root: String,
    database_path: String,
    database_size_bytes: u64,
    schema_version: i64,
    logs: Vec<DiagnosticLog>,
}

pub fn cleanup_logs(paths: &StoragePaths) -> Result<()> {
    let mut files = log_paths(paths)?;
    files.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    let excess = files.len().saturating_sub(MAX_LOG_FILES);
    for path in files.into_iter().take(excess) {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn export_to_path(
    connection: &Connection,
    storage: &StoragePaths,
    destination: &str,
) -> Result<()> {
    let logs = log_paths(storage)?
        .into_iter()
        .filter_map(|path| {
            let filename = path.file_name()?.to_str()?.to_string();
            let content = fs::read_to_string(path).ok()?;
            Some(DiagnosticLog { filename, content })
        })
        .collect();
    let report = DiagnosticReport {
        exported_at_ms: now_ms()?,
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        storage_root: storage.root.display().to_string(),
        database_path: storage.database_path.display().to_string(),
        database_size_bytes: fs::metadata(&storage.database_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        schema_version: connection::schema_version(connection)?,
        logs,
    };
    fs::write(destination, serde_json::to_vec_pretty(&report)?)?;
    Ok(())
}

fn log_paths(paths: &StoragePaths) -> Result<Vec<std::path::PathBuf>> {
    Ok(fs::read_dir(&paths.logs_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_app_log(path))
        .collect())
}

fn is_app_log(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("cli-launchpad"))
}

fn now_ms() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    fn paths() -> (tempfile::TempDir, StoragePaths) {
        let directory = tempdir().unwrap();
        let paths = StoragePaths::from_root(directory.path().join(".cli-launchpad"));
        paths.create_directories().unwrap();
        (directory, paths)
    }

    #[test]
    fn cleanup_keeps_only_ten_log_files() {
        let (_directory, paths) = paths();
        for index in 0..12 {
            fs::write(
                paths.logs_dir.join(format!("cli-launchpad.{index}.log")),
                "log",
            )
            .unwrap();
        }
        cleanup_logs(&paths).unwrap();
        assert_eq!(log_paths(&paths).unwrap().len(), MAX_LOG_FILES);
    }

    #[test]
    fn diagnostics_contains_schema_and_logs() {
        let (directory, paths) = paths();
        fs::write(paths.logs_dir.join("cli-launchpad.log"), "started").unwrap();
        let connection = db::connection::init_database(&paths.database_path).unwrap();
        let output = directory.path().join("diagnostics.json");
        export_to_path(&connection, &paths, output.to_str().unwrap()).unwrap();
        let text = fs::read_to_string(output).unwrap();
        assert!(text.contains("schemaVersion"));
        assert!(text.contains("started"));
    }
}
