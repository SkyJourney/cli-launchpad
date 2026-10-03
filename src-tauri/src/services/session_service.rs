use std::collections::HashMap;
#[cfg(test)]
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde_json::Value;

use crate::db::directory_repo;
use crate::models::session::{
    SessionInfo, SessionPage, SessionSearchIndexDocument, SessionSearchIndexSource,
    SessionSearchResults,
};
use crate::models::tool::ToolKey;
use crate::platform::path_identity;

pub(crate) const TITLE_MAX_CHARS: usize = 100;
const MAX_PAGE_SIZE: usize = 50;
const OFFSET_CURSOR_PREFIX: &str = "offset:";
const MAX_SEARCH_QUERY_CHARS: usize = 200;
pub(crate) const MAX_SEARCH_FIELD_CHARS: usize = 4_000;
pub(crate) const MAX_SEARCH_SESSIONS_PER_TOOL: usize = 5_000;
pub(crate) const MAX_SEARCH_DIRECTORY_ENTRIES: usize = 20_000;
pub(crate) const MAX_SEARCH_METADATA_LINE_BYTES: u64 = 64 * 1024;
pub(crate) const MAX_SEARCH_PREVIEW_BYTES_PER_SESSION: u64 = 64 * 1024;
pub(crate) const MAX_CLAUDE_PREVIEW_SCAN_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(test)]
use crate::services::cli_adapters::claude::history::{
    claude_slug, index_titles as claude_index_titles, message_text,
    search_documents_in as search_claude_documents_in,
};

#[cfg(test)]
use crate::services::cli_adapters::codex::history::{
    codex_search_document, decode_codex_cursor, encode_codex_cursor, parse_codex_rollout_metadata,
    parse_codex_rollout_search, uuid_from_filename,
};

#[cfg(test)]
use crate::services::cli_adapters::antigravity::history::{
    search_antigravity_rows, workspace_matches,
};

#[cfg(test)]
use crate::services::cli_adapters::grok::history::{
    encode_grok_cwd_group, grok_search_document_from_summary, grok_session_belongs_in,
    list_grok_sessions_in, search_grok_documents_in, MAX_GROK_SUMMARY_BYTES,
};

/// Resolve a directory id to its filesystem path (the input to session reading).
pub fn directory_path(conn: &Connection, directory_id: i64) -> Result<String> {
    directory_repo::get(conn, directory_id)?
        .map(|directory| directory.path)
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))
}

pub async fn list_sessions(
    tool_key: ToolKey,
    directory_path: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SessionPage> {
    let limit = limit.clamp(1, MAX_PAGE_SIZE);
    let adapter = crate::services::cli_adapters::get(tool_key);
    let directory_path = directory_path.to_string();
    let cursor = cursor.map(str::to_string);
    tokio::spawn(async move { adapter.list_sessions(directory_path, cursor, limit).await })
        .await
        .map_err(|error| anyhow!("{} 会话适配器异常：{error}", tool_key.as_str()))?
}

#[derive(Debug, Clone)]
pub(crate) struct SearchDocument {
    pub(crate) session: SessionInfo,
    pub(crate) fields: Vec<String>,
}

#[derive(Debug, Default)]
pub(crate) struct SearchSource {
    pub(crate) documents: Vec<SearchDocument>,
    pub(crate) incomplete: bool,
}

pub async fn refresh_search_index(directory_path: &str) -> Result<Vec<SessionSearchIndexSource>> {
    let mut tasks = tokio::task::JoinSet::new();
    let mut task_tools = HashMap::new();
    for adapter in crate::services::cli_adapters::all() {
        let tool_key = adapter.tool_key();
        let path = directory_path.to_string();
        let task = tasks.spawn(async move {
            let source = adapter.search_index_source(path).await;
            (tool_key, source)
        });
        task_tools.insert(task.id(), tool_key);
    }

    let mut sources = Vec::with_capacity(ToolKey::ALL.len());
    while let Some(result) = tasks.join_next_with_id().await {
        match result {
            Ok((id, (expected_tool, source))) => {
                task_tools.remove(&id);
                if source.tool_key == expected_tool {
                    sources.push(source);
                } else {
                    log::warn!(
                        "session adapter returned mismatched tool expected={} actual={}",
                        expected_tool.as_str(),
                        source.tool_key.as_str()
                    );
                    sources.push(SessionSearchIndexSource {
                        tool_key: expected_tool,
                        documents: None,
                        incomplete: true,
                    });
                }
            }
            Err(error) => {
                if let Some(tool_key) = task_tools.remove(&error.id()) {
                    log::warn!(
                        "{} 会话索引适配器异常，保留上次可用索引：{error}",
                        tool_key.as_str()
                    );
                    sources.push(SessionSearchIndexSource {
                        tool_key,
                        documents: None,
                        incomplete: true,
                    });
                }
            }
        }
    }
    sources.sort_by_key(|source| {
        ToolKey::ALL
            .iter()
            .position(|tool_key| *tool_key == source.tool_key)
            .unwrap_or(usize::MAX)
    });
    Ok(sources)
}

pub fn search_indexed_sessions(
    connection: &Connection,
    directory_id: i64,
    query: &str,
    aliases: &HashMap<ToolKey, HashMap<String, String>>,
) -> Result<SessionSearchResults> {
    let query = normalize_search_query(query)?;
    crate::db::session_search_repo::search(connection, directory_id, &query, aliases)
}

pub(crate) fn index_source(
    tool_key: ToolKey,
    source: Result<SearchSource>,
) -> SessionSearchIndexSource {
    match source {
        Ok(source) => SessionSearchIndexSource {
            tool_key,
            documents: Some(
                source
                    .documents
                    .into_iter()
                    .map(|document| SessionSearchIndexDocument {
                        tool_key: document.session.tool_key,
                        session_id: document.session.session_id,
                        title: document.session.title,
                        last_active_ms: document.session.last_active_ms,
                        fields: document.fields,
                    })
                    .collect(),
            ),
            incomplete: source.incomplete,
        },
        Err(_error) => {
            log::warn!("{} 会话搜索索引刷新失败", tool_key.as_str());
            SessionSearchIndexSource {
                tool_key,
                documents: None,
                incomplete: true,
            }
        }
    }
}

fn normalize_search_query(query: &str) -> Result<String> {
    let query = query.trim();
    if query.is_empty() {
        return Err(anyhow!("会话搜索内容不能为空"));
    }
    if query.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(anyhow!(
            "会话搜索内容不能超过 {MAX_SEARCH_QUERY_CHARS} 个字符"
        ));
    }
    Ok(query.to_lowercase())
}

#[cfg(test)]
fn finalize_search_documents(
    mut documents: Vec<SearchDocument>,
    incomplete_tools: &mut Vec<ToolKey>,
    max_results: usize,
) -> Vec<SessionInfo> {
    documents.sort_by(|left, right| {
        right
            .session
            .last_active_ms
            .cmp(&left.session.last_active_ms)
            .then_with(|| {
                left.session
                    .tool_key
                    .as_str()
                    .cmp(right.session.tool_key.as_str())
            })
            .then_with(|| left.session.session_id.cmp(&right.session.session_id))
    });
    let mut seen = HashSet::new();
    documents.retain(|document| {
        seen.insert((
            document.session.tool_key,
            document.session.session_id.clone(),
        ))
    });

    if documents.len() > max_results {
        for document in documents.iter().skip(max_results) {
            let tool_key = document.session.tool_key;
            if !incomplete_tools.contains(&tool_key) {
                incomplete_tools.push(tool_key);
            }
        }
        documents.truncate(max_results);
    }

    documents
        .into_iter()
        .map(|document| document.session)
        .collect()
}

#[cfg(test)]
fn append_search_source(
    tool_key: ToolKey,
    source: Result<SearchSource>,
    aliases: &HashMap<ToolKey, HashMap<String, String>>,
    query: &str,
    matches: &mut Vec<SearchDocument>,
    incomplete_tools: &mut Vec<ToolKey>,
) {
    let source = match source {
        Ok(source) => source,
        Err(error) => {
            log::warn!("{} 会话 metadata 搜索失败：{error}", tool_key.as_str());
            incomplete_tools.push(tool_key);
            return;
        }
    };
    if source.incomplete {
        incomplete_tools.push(tool_key);
    }
    let query_aliases = aliases.get(&tool_key);
    for mut document in source.documents {
        if document.session.tool_key != tool_key {
            continue;
        }
        document.session.alias = query_aliases
            .and_then(|tool_aliases| tool_aliases.get(&document.session.session_id))
            .cloned();
        let alias_matches = document
            .session
            .alias
            .as_deref()
            .is_some_and(|alias| alias.to_lowercase().contains(query));
        if alias_matches
            || document
                .fields
                .iter()
                .any(|field| field.to_lowercase().contains(query))
        {
            matches.push(document);
        }
    }
}

pub fn apply_aliases(page: &mut SessionPage, aliases: &HashMap<String, String>) {
    for session in &mut page.items {
        session.alias = aliases.get(&session.session_id).cloned();
    }
}

pub fn normalize_alias(alias: &str) -> Result<String> {
    let alias = alias.trim();
    if alias.is_empty() {
        return Err(anyhow!("会话别名不能为空"));
    }
    if alias.chars().count() > TITLE_MAX_CHARS {
        return Err(anyhow!("会话别名不能超过 {TITLE_MAX_CHARS} 个字符"));
    }
    Ok(alias.to_string())
}

pub async fn session_belongs_to_directory(
    tool_key: ToolKey,
    directory_path: &str,
    session_id: &str,
) -> Result<bool> {
    if !crate::services::cli_adapters::valid_session_id(tool_key, session_id) {
        return Ok(false);
    }
    let adapter = crate::services::cli_adapters::get(tool_key);
    let directory_path = directory_path.to_string();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        adapter
            .session_belongs_to_directory(directory_path, session_id)
            .await
    })
    .await
    .map_err(|error| anyhow!("{} 会话归属验证适配器异常：{error}", tool_key.as_str()))?
}

pub(crate) fn home_dir() -> Result<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| anyhow!("无法确定用户主目录，不能读取会话历史"))
}

pub(crate) fn read_search_metadata_file(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Err(anyhow!("会话 metadata 文件类型或大小超出安全范围"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(anyhow!("会话 metadata 文件大小超出安全范围"));
    }
    Ok(Some(bytes))
}

pub(crate) fn page_local(
    mut sessions: Vec<SessionInfo>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SessionPage> {
    sessions.sort_by_key(|session| std::cmp::Reverse(session.last_active_ms));
    let offset = parse_offset_cursor(cursor)?;
    let total = sessions.len();
    let items: Vec<_> = sessions.into_iter().skip(offset).take(limit).collect();
    let consumed = offset.saturating_add(items.len());
    let next_cursor = (consumed < total).then(|| format!("{OFFSET_CURSOR_PREFIX}{consumed}"));
    Ok(SessionPage { items, next_cursor })
}

fn parse_offset_cursor(cursor: Option<&str>) -> Result<usize> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .strip_prefix(OFFSET_CURSOR_PREFIX)
        .ok_or_else(|| anyhow!("无效的会话分页游标"))?
        .parse::<usize>()
        .map_err(|_| anyhow!("无效的会话分页游标"))
}

pub(crate) fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_value(*bytes.get(index + 1)?)?;
            let low = hex_value(*bytes.get(index + 2)?)?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn extract_text_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(items) = content.as_array() {
        for item in items {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

pub(crate) fn safe_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn paths_match(a: &str, b: &str) -> bool {
    path_identity::paths_equal(a, b)
}

pub(crate) fn mtime_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

pub(crate) fn epoch_to_ms(value: i64) -> i64 {
    if value.unsigned_abs() < 100_000_000_000 {
        value.saturating_mul(1_000)
    } else {
        value
    }
}

pub(crate) fn non_empty_field(value: &Value, key: &str) -> Option<String> {
    non_empty_string(value.get(key)?.as_str().map(str::to_string))
}

pub(crate) fn non_empty_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

pub(crate) fn truncate_chars(value: &str, max: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max {
        value.to_string()
    } else {
        let mut truncated: String = chars[..max].iter().collect();
        truncated.push('…');
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_known_example() {
        assert_eq!(
            claude_slug("C:\\Projects\\cli-launchpad"),
            "C--Projects-cli-launchpad"
        );
    }

    #[test]
    fn search_query_is_bounded_and_normalized() {
        assert_eq!(
            normalize_search_query("  Mixed Case  ").unwrap(),
            "mixed case"
        );
        assert!(normalize_search_query(" \t ").is_err());
        assert!(normalize_search_query(&"字".repeat(MAX_SEARCH_QUERY_CHARS + 1)).is_err());
    }

    #[test]
    fn search_result_snapshot_sorts_deduplicates_and_marks_truncated_tools() {
        let document = |tool_key, session_id: &str, last_active_ms| SearchDocument {
            session: SessionInfo {
                tool_key,
                session_id: session_id.to_string(),
                title: session_id.to_string(),
                alias: None,
                last_active_ms,
            },
            fields: Vec::new(),
        };
        let mut incomplete_tools = Vec::new();

        let items = finalize_search_documents(
            vec![
                document(ToolKey::Claude, "claude-old", Some(10)),
                document(ToolKey::Codex, "codex-new", Some(30)),
                document(ToolKey::Claude, "claude-old", Some(20)),
                document(ToolKey::Grok, "grok-middle", Some(20)),
            ],
            &mut incomplete_tools,
            2,
        );

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].session_id, "codex-new");
        assert_eq!(items[1].session_id, "claude-old");
        assert_eq!(items[1].last_active_ms, Some(20));
        assert_eq!(incomplete_tools, vec![ToolKey::Grok]);
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
    fn codex_search_uses_thread_name_and_preview_metadata() {
        let thread: Value = serde_json::from_str(
            r#"{"id":"session-1","name":"safe thread name","preview":"private preview phrase","updatedAt":1000}"#,
        )
        .unwrap();

        let document = codex_search_document(&thread).unwrap();

        assert_eq!(
            document.fields,
            vec!["safe thread name", "private preview phrase"]
        );
        assert_eq!(document.session.title, "safe thread name");
        assert!(document
            .fields
            .iter()
            .any(|field| field == "private preview phrase"));
    }

    #[test]
    fn codex_rollout_fallback_only_accepts_project_session_metadata() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        let other_project = temporary.path().join("other-project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other_project).unwrap();
        let project_path = project.to_string_lossy().to_string();
        let other_project_path = other_project.to_string_lossy().to_string();
        let rollout = temporary
            .path()
            .join("rollout-2026-01-01T00-00-00-7f9f9a2e-1b3c-4c7a-9b0e-abcdef012345.jsonl");
        let metadata_line = serde_json::json!({
            "timestamp": "2026-01-01T00:00:00Z",
            "type": "session_meta",
            "payload": {"id": "session-1", "cwd": project_path}
        });
        let body_line = serde_json::json!({
            "type": "response_item",
            "payload": {"role": "user", "content": "private body phrase"}
        });
        fs::write(&rollout, format!("{metadata_line}\n{body_line}\n")).unwrap();

        let session = parse_codex_rollout_metadata(&rollout, &project_path)
            .unwrap()
            .unwrap();
        assert_eq!(session.session_id, "session-1");
        assert_eq!(session.title, "(Codex 会话)");
        assert!(parse_codex_rollout_metadata(&rollout, &other_project_path)
            .unwrap()
            .is_none());
    }

    #[test]
    fn codex_search_fallback_indexes_the_bounded_first_user_message() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let project_path = project.to_string_lossy().to_string();
        let rollout = temporary.path().join("rollout-session.jsonl");
        let metadata = serde_json::json!({
            "type": "session_meta",
            "payload": {"id": "session-1", "cwd": project_path}
        });
        let user = serde_json::json!({
            "type": "response_item",
            "payload": {"role": "user", "content": "first codex prompt"}
        });
        fs::write(&rollout, format!("{metadata}\n{user}\n")).unwrap();

        let (document, bytes_read) = parse_codex_rollout_search(
            &rollout,
            &project_path,
            MAX_SEARCH_PREVIEW_BYTES_PER_SESSION,
        )
        .unwrap();
        let document = document.unwrap();

        assert!(bytes_read > 0);
        assert_eq!(document.session.title, "first codex prompt");
        assert_eq!(document.fields, vec!["first codex prompt"]);
    }

    #[test]
    fn codex_search_fallback_rejects_oversized_lines() {
        let temporary = tempfile::tempdir().unwrap();
        let rollout = temporary.path().join("rollout-large.jsonl");
        fs::write(
            &rollout,
            format!(
                "{}\n",
                "x".repeat(MAX_SEARCH_METADATA_LINE_BYTES as usize + 1)
            ),
        )
        .unwrap();

        assert!(parse_codex_rollout_search(
            &rollout,
            "C:\\Projects\\example",
            MAX_SEARCH_PREVIEW_BYTES_PER_SESSION
        )
        .is_err());
    }

    #[test]
    fn antigravity_search_indexes_title_summary_and_preview_for_current_project() {
        let temporary = tempfile::tempdir().unwrap();
        let project_path = temporary.path().join("project");
        let other_path = temporary.path().join("other");
        fs::create_dir_all(&project_path).unwrap();
        fs::create_dir_all(&other_path).unwrap();
        let project_path = project_path.to_string_lossy().replace('\\', "/");
        let other_path = other_path.to_string_lossy().replace('\\', "/");
        let project_uri = if cfg!(windows) {
            format!("file:///{project_path}")
        } else {
            format!("file://{project_path}")
        };
        let other_uri = if cfg!(windows) {
            format!("file:///{other_path}")
        } else {
            format!("file://{other_path}")
        };
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "create table conversation_summaries (
                    conversation_id text, title text, preview text,
                    last_modified_time integer, workspace_uris text
                );",
            )
            .unwrap();
        connection
            .execute(
                "insert into conversation_summaries values (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "current",
                    "visible title",
                    "private preview",
                    10,
                    serde_json::json!([project_uri]).to_string()
                ],
            )
            .unwrap();
        connection
            .execute(
                "insert into conversation_summaries values (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "other",
                    "other title",
                    "private preview",
                    20,
                    serde_json::json!([other_uri]).to_string()
                ],
            )
            .unwrap();
        let summaries = HashMap::from([("current".to_string(), "visible summary".to_string())]);

        let source =
            search_antigravity_rows(&connection, &project_path, &summaries, false).unwrap();

        assert_eq!(source.documents.len(), 1);
        assert_eq!(
            source.documents[0].fields,
            vec!["visible title", "visible summary", "private preview"]
        );
        assert_eq!(source.documents[0].session.title, "visible title");
    }

    #[test]
    fn aliases_are_searchable_but_orphan_aliases_are_not_returned() {
        let source = SearchSource {
            documents: vec![SearchDocument {
                session: SessionInfo {
                    tool_key: ToolKey::Grok,
                    session_id: "present".to_string(),
                    title: "original title".to_string(),
                    alias: None,
                    last_active_ms: Some(10),
                },
                fields: vec!["safe summary".to_string()],
            }],
            incomplete: false,
        };
        let aliases = HashMap::from([(
            ToolKey::Grok,
            HashMap::from([
                ("present".to_string(), "My Custom Alias".to_string()),
                ("orphan".to_string(), "orphan alias".to_string()),
            ]),
        )]);
        let mut matches = Vec::new();
        let mut incomplete_tools = Vec::new();

        append_search_source(
            ToolKey::Grok,
            Ok(source),
            &aliases,
            "my custom alias",
            &mut matches,
            &mut incomplete_tools,
        );

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].session.session_id, "present");
        assert_eq!(matches[0].session.alias.as_deref(), Some("My Custom Alias"));
        assert!(incomplete_tools.is_empty());
    }

    #[test]
    fn local_pagination_uses_bounded_offset_cursor() {
        let sessions: Vec<SessionInfo> = (0..12)
            .map(|index| SessionInfo {
                tool_key: ToolKey::Claude,
                session_id: index.to_string(),
                title: index.to_string(),
                alias: None,
                last_active_ms: Some(index),
            })
            .collect();
        let first = page_local(sessions.clone(), None, 10).unwrap();
        assert_eq!(first.items.len(), 10);
        assert_eq!(first.next_cursor.as_deref(), Some("offset:10"));
        let second = page_local(sessions, first.next_cursor.as_deref(), 10).unwrap();
        assert_eq!(second.items.len(), 2);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn codex_cursor_round_trips_as_opaque_value() {
        let encoded = encode_codex_cursor("cursor/with + symbols=");
        assert_eq!(
            decode_codex_cursor(Some(&encoded)).unwrap().as_deref(),
            Some("cursor/with + symbols=")
        );
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
    fn grok_history_reads_only_bounded_summary_metadata_for_the_matching_project() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        let other_project = temporary.path().join("other-project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other_project).unwrap();
        let project_path = project.to_string_lossy().to_string();
        let other_project_path = other_project.to_string_lossy().to_string();
        let sessions_dir = temporary.path().join("sessions");
        let session_id = "019f9a55-1234-7abc-8def-123456789abc";
        let session_dir = write_grok_session_fixture(
            &sessions_dir,
            None,
            session_id,
            session_id,
            &project_path,
            "本地摘要标题",
        );
        fs::write(session_dir.join("updates.jsonl"), "私有对话正文，不应读取").unwrap();
        write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-abcdef012345",
            "019f9a55-1234-7abc-8def-abcdef012345",
            &other_project_path,
            "其他项目标题",
        );

        let sessions = list_grok_sessions_in(&sessions_dir, &project_path).unwrap();
        let search_document =
            grok_search_document_from_summary(&session_dir, &project_path).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].tool_key, ToolKey::Grok);
        assert_eq!(sessions[0].session_id, session_id);
        assert_eq!(sessions[0].title, "本地摘要标题");
        assert!(sessions[0].last_active_ms.is_some());
        assert!(!sessions[0].title.contains("私有对话正文"));
        assert_eq!(
            search_document.fields,
            vec!["本地摘要标题", "metadata only"]
        );
        assert!(!search_document
            .fields
            .iter()
            .any(|field| field.contains("私有对话正文")));
        assert!(grok_session_belongs_in(&sessions_dir, &project_path, session_id).unwrap());
        assert!(!grok_session_belongs_in(&sessions_dir, &other_project_path, session_id).unwrap());
        assert!(!grok_session_belongs_in(&sessions_dir, &project_path, "not-a-uuid").unwrap());
    }

    #[test]
    fn grok_search_respects_aggregate_summary_read_budget() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let project_path = project.to_string_lossy().to_string();
        let sessions_dir = temporary.path().join("sessions");
        let first = write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-123456789ad1",
            "019f9a55-1234-7abc-8def-123456789ad1",
            &project_path,
            "bounded summary",
        );
        write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-123456789ad2",
            "019f9a55-1234-7abc-8def-123456789ad2",
            &project_path,
            "bounded summary",
        );
        let summary_size = fs::metadata(first.join("summary.json")).unwrap().len();

        let source =
            search_grok_documents_in(&sessions_dir, &project_path, summary_size.saturating_add(1))
                .unwrap();

        assert_eq!(source.documents.len(), 1);
        assert!(source.incomplete);
    }

    #[test]
    fn grok_search_marks_corrupt_summaries_incomplete() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let project_path = project.to_string_lossy().to_string();
        let sessions_dir = temporary.path().join("sessions");
        let corrupt = write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-123456789ad3",
            "019f9a55-1234-7abc-8def-123456789ad3",
            &project_path,
            "will be replaced",
        );
        fs::write(corrupt.join("summary.json"), b"not json").unwrap();

        let source = search_grok_documents_in(&sessions_dir, &project_path, u64::MAX).unwrap();

        assert!(source.documents.is_empty());
        assert!(source.incomplete);
    }

    #[test]
    fn grok_history_matches_long_working_directory_groups_through_bounded_cwd_metadata() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("long-path-project");
        fs::create_dir_all(&project).unwrap();
        let project_path = project.to_string_lossy().to_string();
        let sessions_dir = temporary.path().join("sessions");
        let session_dir = write_grok_session_fixture(
            &sessions_dir,
            Some("project-slug-hash"),
            "019f9a55-1234-7abc-8def-123456789abd",
            "019f9a55-1234-7abc-8def-123456789abd",
            &project_path,
            "长路径会话",
        );
        fs::write(
            session_dir.parent().unwrap().join(".cwd"),
            format!("{project_path}\r\n"),
        )
        .unwrap();

        let sessions = list_grok_sessions_in(&sessions_dir, &project_path).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "长路径会话");
    }

    #[test]
    fn grok_history_skips_corrupt_oversized_mismatched_and_wrong_cwd_summaries() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        let other_project = temporary.path().join("other-project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other_project).unwrap();
        let project_path = project.to_string_lossy().to_string();
        let other_project_path = other_project.to_string_lossy().to_string();
        let sessions_dir = temporary.path().join("sessions");

        let corrupt = write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-123456789abe",
            "019f9a55-1234-7abc-8def-123456789abe",
            &project_path,
            "ignored",
        );
        fs::write(corrupt.join("summary.json"), b"not json").unwrap();

        let oversized = write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-123456789abf",
            "019f9a55-1234-7abc-8def-123456789abf",
            &project_path,
            "ignored",
        );
        fs::write(
            oversized.join("summary.json"),
            vec![b'x'; (MAX_GROK_SUMMARY_BYTES + 1) as usize],
        )
        .unwrap();

        write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-123456789ac0",
            "019f9a55-1234-7abc-8def-123456789ac1",
            &project_path,
            "mismatched id",
        );
        write_grok_session_fixture(
            &sessions_dir,
            None,
            "019f9a55-1234-7abc-8def-123456789ac2",
            "019f9a55-1234-7abc-8def-123456789ac2",
            &other_project_path,
            "wrong cwd",
        );

        assert!(list_grok_sessions_in(&sessions_dir, &project_path)
            .unwrap()
            .is_empty());
    }

    fn write_grok_session_fixture(
        sessions_dir: &Path,
        group_name: Option<&str>,
        directory_session_id: &str,
        metadata_session_id: &str,
        cwd: &str,
        title: &str,
    ) -> PathBuf {
        let group_name = group_name
            .map(str::to_string)
            .unwrap_or_else(|| encode_grok_cwd_group(cwd));
        let session_dir = sessions_dir.join(group_name).join(directory_session_id);
        fs::create_dir_all(&session_dir).unwrap();
        let summary = serde_json::json!({
            "info": { "id": metadata_session_id, "cwd": cwd },
            "generated_title": title,
            "session_summary": "metadata only"
        });
        fs::write(
            session_dir.join("summary.json"),
            serde_json::to_vec(&summary).unwrap(),
        )
        .unwrap();
        session_dir
    }

    #[test]
    #[cfg(windows)]
    fn file_uri_matches_windows_path_and_decodes_spaces() {
        let uris = r#"["file:///C:/Projects/My%20App"]"#;
        assert!(workspace_matches(uris, "c:\\projects\\my app\\"));
    }

    #[test]
    #[cfg(windows)]
    fn paths_match_ignores_separators_and_case() {
        assert!(paths_match("C:/Projects/Demo", "c:\\projects\\demo\\"));
        assert!(!paths_match("C:\\a", "C:\\b"));
    }

    #[test]
    #[cfg(not(windows))]
    fn file_uri_matches_unix_path_and_preserves_case() {
        let uris = r#"["file:///Users/me/Projects/My%20App"]"#;
        assert!(workspace_matches(uris, "/Users/me/Projects/My App/"));
        assert!(!workspace_matches(uris, "/Users/me/projects/My App/"));
    }

    #[test]
    fn claude_message_text_reads_array_blocks() {
        let entry: Value = serde_json::from_str(
            r#"{"type":"user","message":{"content":[{"type":"text","text":"hello world"}]}}"#,
        )
        .unwrap();
        assert_eq!(message_text(&entry).as_deref(), Some("hello world"));
    }

    #[test]
    fn truncate_appends_ellipsis() {
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        assert_eq!(truncate_chars("ab", 3), "ab");
    }

    #[test]
    fn uuid_extracted_from_rollout_name() {
        let path =
            Path::new("rollout-2025-06-01T12-00-00-7f9f9a2e-1b3c-4c7a-9b0e-abcdef012345.jsonl");
        assert_eq!(
            uuid_from_filename(path).as_deref(),
            Some("7f9f9a2e-1b3c-4c7a-9b0e-abcdef012345")
        );
    }

    #[test]
    fn rejects_path_like_session_ids() {
        assert!(safe_session_id("7f9f9a2e-1b3c-4c7a-9b0e-abcdef012345"));
        assert!(!safe_session_id("../outside"));
        assert!(!safe_session_id("folder\\outside"));
    }

    #[test]
    fn aliases_only_override_sessions_present_in_the_page() {
        let mut page = SessionPage {
            items: vec![SessionInfo {
                tool_key: ToolKey::Claude,
                session_id: "matched".to_string(),
                title: "原始标题".to_string(),
                alias: None,
                last_active_ms: None,
            }],
            next_cursor: None,
        };
        let aliases = HashMap::from([
            ("matched".to_string(), "手动标题".to_string()),
            ("orphan".to_string(), "不应出现".to_string()),
        ]);

        apply_aliases(&mut page, &aliases);

        assert_eq!(page.items[0].title, "原始标题");
        assert_eq!(page.items[0].alias.as_deref(), Some("手动标题"));
        assert_eq!(page.items.len(), 1);
    }

    #[test]
    fn alias_normalization_trims_and_rejects_invalid_values() {
        assert_eq!(normalize_alias("  简洁标题  ").unwrap(), "简洁标题");
        assert!(normalize_alias("  ").is_err());
        assert!(normalize_alias(&"长".repeat(TITLE_MAX_CHARS + 1)).is_err());
    }
}
