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
    super::file_service::replace_file(Path::new(destination), &serde_json::to_vec_pretty(&report)?)
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

const MAX_WINDOW_SYNC_LABEL_CHARS: usize = 128;
const MAX_WINDOW_SYNC_CODE_CHARS: usize = 64;
const MAX_WINDOW_SYNC_MESSAGE_CHARS: usize = 512;

/// Records a window synchronisation failure reported by a renderer. Every field is
/// cleaned first, so text supplied by the renderer cannot forge extra log lines.
pub fn log_window_sync_failure(window_label: &str, code: &str, message: &str) {
    log::warn!("{}", window_sync_failure_line(window_label, code, message));
}

fn window_sync_failure_line(window_label: &str, code: &str, message: &str) -> String {
    format!(
        "window sync failure window={} code={} message={}",
        clean_text(window_label, MAX_WINDOW_SYNC_LABEL_CHARS),
        clean_code(code),
        clean_text(message, MAX_WINDOW_SYNC_MESSAGE_CHARS)
    )
}

/// Codes are dotted lower-case identifiers; any other character becomes `_`.
fn clean_code(code: &str) -> String {
    let cleaned: String = code
        .chars()
        .take(MAX_WINDOW_SYNC_CODE_CHARS)
        .map(|character| match character {
            'a'..='z' | '0'..='9' | '_' | '.' => character,
            _ => '_',
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

/// Free text keeps its characters but loses control characters (including line
/// breaks), and is cut to `max_chars` characters.
fn clean_text(text: &str, max_chars: usize) -> String {
    text.chars()
        .take(max_chars)
        .map(|character| {
            if character.is_control() || is_line_or_bidi_control(character) {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Unicode line separators and bidirectional controls can make a viewer show
/// text on another line or in another order, so they are cleaned like controls.
fn is_line_or_bidi_control(character: char) -> bool {
    matches!(
        character,
        '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
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

    #[test]
    fn window_sync_codes_keep_only_dotted_lower_case_identifiers() {
        assert_eq!(
            clean_code("window.theme_sync_failed"),
            "window.theme_sync_failed"
        );
        let cleaned = clean_code("Window Theme\n[INFO] forged");
        assert!(cleaned.chars().all(|character| matches!(
            character,
            'a'..='z' | '0'..='9' | '_' | '.'
        )));
        assert_eq!(clean_code(""), "unknown");
        assert_eq!(
            clean_code(&"a".repeat(200)).chars().count(),
            MAX_WINDOW_SYNC_CODE_CHARS
        );
    }

    #[test]
    fn window_sync_free_text_drops_line_breaks_and_is_bounded() {
        assert_eq!(
            clean_text(
                "first\nforged [INFO] line\r\n",
                MAX_WINDOW_SYNC_MESSAGE_CHARS
            ),
            "first forged [INFO] line"
        );
        assert_eq!(
            clean_text("a\u{2028}b\u{202E}c", MAX_WINDOW_SYNC_MESSAGE_CHARS),
            "a b c"
        );
        let long = "字".repeat(600);
        assert_eq!(
            clean_text(&long, MAX_WINDOW_SYNC_MESSAGE_CHARS)
                .chars()
                .count(),
            MAX_WINDOW_SYNC_MESSAGE_CHARS
        );
    }

    #[test]
    fn window_sync_failure_line_is_one_line_tagged_with_the_window_label() {
        let line =
            window_sync_failure_line("main", "window.set_focus_failed", "无法聚焦\n[WARN] forged");
        assert!(!line.contains('\n'), "{line}");
        assert_eq!(
            line,
            "window sync failure window=main code=window.set_focus_failed message=无法聚焦 [WARN] forged"
        );
    }
}
