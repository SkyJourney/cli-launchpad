use crate::platform::home::home_dir;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::models::session::{SessionInfo, SessionPage, SessionSearchIndexSource};
use crate::models::tool::ToolKey;
use crate::services::session_service::{
    mtime_ms, non_empty_field, read_search_metadata_file, safe_session_id, truncate_chars,
    SearchDocument, SearchSource, MAX_CLAUDE_PREVIEW_SCAN_BYTES, MAX_SEARCH_DIRECTORY_ENTRIES,
    MAX_SEARCH_FIELD_CHARS, MAX_SEARCH_METADATA_LINE_BYTES, MAX_SEARCH_PREVIEW_BYTES_PER_SESSION,
    MAX_SEARCH_SESSIONS_PER_TOOL, TITLE_MAX_CHARS,
};

/// Claude Code stores sessions under `~/.claude/projects/<slug>/`, where the
/// slug replaces every non-alphanumeric path character with `-`.
fn claude_slug(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn project_dir_for_home(home: &Path, directory_path: &str) -> std::path::PathBuf {
    home.join(".claude")
        .join("projects")
        .join(claude_slug(directory_path))
}

fn project_dir(directory_path: &str) -> Result<std::path::PathBuf> {
    Ok(project_dir_for_home(&home_dir()?, directory_path))
}

fn list_sessions_in(dir: &Path) -> Result<Vec<SessionInfo>> {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let indexed_titles = index_titles(&dir);

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let title = indexed_titles
            .get(session_id)
            .cloned()
            .or_else(|| title_from_transcript(&path))
            .unwrap_or_else(|| "(无标题会话)".to_string());
        sessions.push(SessionInfo {
            tool_key: ToolKey::Claude,
            session_id: session_id.to_string(),
            title: truncate_chars(&title, TITLE_MAX_CHARS),
            alias: None,
            last_active_ms: mtime_ms(&path),
        });
    }
    Ok(sessions)
}

pub(super) async fn list_sessions_page(
    directory_path: String,
    cursor: Option<String>,
    limit: usize,
    context: crate::services::cli_adapters::AdapterContext,
) -> Result<SessionPage> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = project_dir_for_home(&context.home, &directory_path);
        crate::services::session_service::page_local(
            list_sessions_in(&dir)?,
            cursor.as_deref(),
            limit,
        )
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?
}

pub(super) async fn search_index_source(
    directory_path: String,
    context: crate::services::cli_adapters::AdapterContext,
) -> SessionSearchIndexSource {
    let result = crate::services::session_service::spawn_search_index_blocking(move || {
        search_documents_for_home(&directory_path, &context.home)
    })
    .await;
    crate::services::session_service::index_source(ToolKey::Claude, result)
}

pub(super) async fn session_belongs_to_directory(
    directory_path: String,
    session_id: String,
) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || session_belongs(&directory_path, &session_id))
        .await
        .map_err(|error| anyhow!(error.to_string()))?
}

fn search_documents_for_home(directory_path: &str, home: &Path) -> Result<SearchSource> {
    let dir = project_dir_for_home(home, directory_path);
    search_documents_in(&dir)
}

fn search_documents_in(dir: &Path) -> Result<SearchSource> {
    const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SearchSource::default());
        }
        Err(error) => return Err(error.into()),
    };
    let (summaries, mut incomplete) =
        match read_search_metadata_file(&dir.join("sessions-index.json"), MAX_INDEX_BYTES) {
            Ok(Some(bytes)) => match search_summaries(&bytes) {
                Ok(summaries) => (summaries, false),
                Err(_) => (HashMap::new(), true),
            },
            Ok(None) => (HashMap::new(), false),
            Err(error) => {
                log::warn!("Claude Code 会话索引不可用：{error}");
                (HashMap::new(), true)
            }
        };

    let mut source = SearchSource::default();
    let mut inspected_entries = 0;
    let mut preview_bytes_scanned = 0_u64;
    for entry in entries {
        inspected_entries += 1;
        if inspected_entries > MAX_SEARCH_DIRECTORY_ENTRIES {
            incomplete = true;
            break;
        }
        if source.documents.len() >= MAX_SEARCH_SESSIONS_PER_TOOL {
            incomplete = true;
            break;
        }
        let Ok(entry) = entry else {
            incomplete = true;
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            incomplete = true;
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if !safe_session_id(session_id) {
            continue;
        }
        let mut fields = summaries.get(session_id).cloned().unwrap_or_default();
        if fields.is_empty() {
            let remaining_source_budget =
                MAX_CLAUDE_PREVIEW_SCAN_BYTES.saturating_sub(preview_bytes_scanned);
            let budget = remaining_source_budget.min(MAX_SEARCH_PREVIEW_BYTES_PER_SESSION);
            if budget == 0 {
                incomplete = true;
            } else {
                match search_first_user_message(&path, budget) {
                    Ok((title, bytes_read)) => {
                        preview_bytes_scanned = preview_bytes_scanned.saturating_add(bytes_read);
                        if let Some(title) = title {
                            fields.push(truncate_chars(&title, MAX_SEARCH_FIELD_CHARS));
                        }
                    }
                    Err(_) => {
                        incomplete = true;
                        preview_bytes_scanned = MAX_CLAUDE_PREVIEW_SCAN_BYTES;
                        log::debug!("跳过无法安全读取的 Claude 会话预览");
                    }
                }
            }
        }
        let title = fields
            .first()
            .cloned()
            .unwrap_or_else(|| "(无标题会话)".to_string());
        source.documents.push(SearchDocument {
            session: SessionInfo {
                tool_key: ToolKey::Claude,
                session_id: session_id.to_string(),
                title: truncate_chars(&title, TITLE_MAX_CHARS),
                alias: None,
                last_active_ms: mtime_ms(&path),
            },
            fields,
        });
    }
    source.incomplete = incomplete;
    Ok(source)
}

fn search_summaries(bytes: &[u8]) -> Result<HashMap<String, Vec<String>>> {
    let index: Value = serde_json::from_slice(bytes)?;
    let entries = index
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Claude Code sessions-index.json 缺少 entries"))?;
    Ok(entries
        .iter()
        .filter(|entry| entry.get("isSidechain").and_then(Value::as_bool) != Some(true))
        .filter_map(|entry| {
            let id = entry.get("sessionId")?.as_str()?.to_string();
            let fields = [
                non_empty_field(entry, "summary"),
                non_empty_field(entry, "firstPrompt"),
            ]
            .into_iter()
            .flatten()
            .map(|field| truncate_chars(&field, MAX_SEARCH_FIELD_CHARS))
            .collect::<Vec<_>>();
            (!fields.is_empty()).then_some((id, fields))
        })
        .collect())
}

fn index_titles(dir: &Path) -> HashMap<String, String> {
    let Ok(contents) = fs::read_to_string(dir.join("sessions-index.json")) else {
        return HashMap::new();
    };
    let Ok(index) = serde_json::from_str::<Value>(&contents) else {
        return HashMap::new();
    };
    index
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("isSidechain").and_then(Value::as_bool) != Some(true))
        .filter_map(|entry| {
            let id = entry.get("sessionId")?.as_str()?.to_string();
            let title = non_empty_field(entry, "summary")
                .or_else(|| non_empty_field(entry, "firstPrompt"))?;
            Some((id, title))
        })
        .collect()
}

fn session_belongs(directory_path: &str, session_id: &str) -> Result<bool> {
    Ok(project_dir(directory_path)?
        .join(format!("{session_id}.jsonl"))
        .is_file())
}

fn title_from_transcript(path: &Path) -> Option<String> {
    let reader = BufReader::new(File::open(path).ok()?);
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("isMeta").and_then(Value::as_bool) == Some(true)
            || value.get("type").and_then(Value::as_str) != Some("user")
        {
            continue;
        }
        if let Some(text) = message_text(&value) {
            return Some(text);
        }
    }
    None
}

fn search_first_user_message(path: &Path, max_bytes: u64) -> Result<(Option<String>, u64)> {
    const MAX_LINES: usize = 20;

    let mut reader = BufReader::new(File::open(path)?);
    let mut bytes_read = 0_u64;
    for line_index in 0..MAX_LINES {
        let remaining = max_bytes.saturating_sub(bytes_read);
        if remaining == 0 {
            return Err(anyhow!("Claude 会话预览超出扫描字节上限"));
        }
        let line_limit = MAX_SEARCH_METADATA_LINE_BYTES.min(remaining);
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take(line_limit + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok((None, bytes_read));
        }
        if read as u64 > line_limit {
            return Err(anyhow!("Claude 会话预览单行超出扫描字节上限"));
        }
        bytes_read = bytes_read.saturating_add(read as u64);
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if value.get("isMeta").and_then(Value::as_bool) == Some(true)
            || value.get("type").and_then(Value::as_str) != Some("user")
        {
            continue;
        }
        if let Some(text) = message_text(&value) {
            return Ok((Some(text), bytes_read));
        }
        if line_index + 1 == MAX_LINES {
            return Err(anyhow!("Claude 会话预览超过扫描行数上限"));
        }
    }
    Err(anyhow!("Claude 会话预览超过扫描行数上限"))
}

fn message_text(entry: &Value) -> Option<String> {
    super::super::super::session_service::extract_text_content(
        entry.get("message")?.get("content")?,
    )
}

#[cfg(test)]
mod context_tests {
    use super::*;

    #[tokio::test]
    async fn list_sessions_uses_the_injected_context_home() {
        let root = tempfile::tempdir().unwrap();
        let project = root
            .path()
            .join(".claude")
            .join("projects")
            .join(claude_slug("C:/workspace"));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("session-123.jsonl"), "\n").unwrap();
        let context = crate::services::cli_adapters::AdapterContext {
            resolved_path: None,
            home: root.path().to_path_buf(),
            budget: std::time::Duration::from_secs(1),
        };

        let page = list_sessions_page("C:/workspace".to_string(), None, 10, context)
            .await
            .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].session_id, "session-123");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::{
        index_titles as claude_index_titles, search_documents_in as search_claude_documents_in,
    };

    #[test]
    fn slug_matches_known_example() {
        assert_eq!(
            claude_slug("C:\\Projects\\cli-launchpad"),
            "C--Projects-cli-launchpad"
        );
    }

    #[test]
    fn claude_search_indexes_summary_and_first_prompt_but_not_jsonl_body() {
        let directory = tempfile::tempdir().unwrap();
        let session_id = "session-1";
        fs::write(
            directory.path().join(format!("{session_id}.jsonl")),
            r#"{"type":"user","message":{"content":"private body phrase"}}"#,
        )
        .unwrap();
        fs::write(
            directory.path().join("sessions-index.json"),
            r#"{"entries":[{"sessionId":"session-1","summary":"safe metadata title","firstPrompt":"private prompt phrase"},{"sessionId":"session-2","summary":"sidechain title","isSidechain":true}]}"#,
        )
        .unwrap();

        let source = search_claude_documents_in(directory.path()).unwrap();

        assert_eq!(source.documents.len(), 1);
        assert_eq!(source.documents[0].session.title, "safe metadata title");
        assert_eq!(
            source.documents[0].fields,
            vec!["safe metadata title", "private prompt phrase"]
        );
        assert!(!source.documents[0]
            .fields
            .iter()
            .any(|field| field.contains("private body")));
    }

    #[test]
    fn claude_search_uses_a_bounded_first_user_message_when_index_metadata_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("session-fallback.jsonl"),
            concat!(
                "{\"type\":\"system\",\"message\":{\"content\":\"ignored\"}}\n",
                "{\"type\":\"user\",\"message\":{\"content\":\"first user message title\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"content\":\"later body text\"}}\n"
            ),
        )
        .unwrap();

        let source = search_claude_documents_in(directory.path()).unwrap();

        assert_eq!(source.documents.len(), 1);
        assert_eq!(
            source.documents[0].session.title,
            "first user message title"
        );
        assert_eq!(source.documents[0].fields, vec!["first user message title"]);
    }

    #[test]
    fn claude_search_marks_an_oversized_preview_source_incomplete() {
        let directory = tempfile::tempdir().unwrap();
        let session_path = directory.path().join("oversized.jsonl");
        fs::write(
            &session_path,
            format!(
                "{}\n",
                "x".repeat(MAX_SEARCH_METADATA_LINE_BYTES as usize + 1)
            ),
        )
        .unwrap();

        let source = search_claude_documents_in(directory.path()).unwrap();

        assert!(source.incomplete);
        assert_eq!(source.documents.len(), 1);
        assert_eq!(source.documents[0].session.title, "(无标题会话)");
        assert!(source.documents[0].fields.is_empty());
    }

    #[test]
    fn claude_index_prefers_summary_over_first_prompt() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("sessions-index.json"),
            r#"{"entries":[{"sessionId":"one","summary":"简洁标题","firstPrompt":"很长的第一句话"},{"sessionId":"two","summary":"","firstPrompt":"回退标题"}]}"#,
        )
        .unwrap();
        let titles = claude_index_titles(directory.path());
        assert_eq!(titles.get("one").map(String::as_str), Some("简洁标题"));
        assert_eq!(titles.get("two").map(String::as_str), Some("回退标题"));
    }

    #[test]
    fn claude_message_text_reads_array_blocks() {
        let entry: Value = serde_json::from_str(
            r#"{"type":"user","message":{"content":[{"type":"text","text":"hello world"}]}}"#,
        )
        .unwrap();
        assert_eq!(message_text(&entry).as_deref(), Some("hello world"));
    }
}
