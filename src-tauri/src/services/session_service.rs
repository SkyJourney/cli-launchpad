use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::db::directory_repo;
use crate::models::session::{
    SessionInfo, SessionPage, SessionSearchIndexDocument, SessionSearchIndexSource,
    SessionSearchResults,
};
use crate::models::tool::ToolKey;
use crate::platform::path_identity;
use crate::services::codex_app_server;

const TITLE_MAX_CHARS: usize = 100;
const MAX_PAGE_SIZE: usize = 50;
const OFFSET_CURSOR_PREFIX: &str = "offset:";
const CODEX_CURSOR_PREFIX: &str = "codex:";
const MAX_GROK_GROUP_ENTRIES: usize = 4_096;
const MAX_GROK_SESSION_ENTRIES: usize = 20_000;
const MAX_GROK_SUMMARY_BYTES: u64 = 256 * 1024;
const MAX_GROK_SEARCH_SUMMARIES_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GROK_CWD_BYTES: u64 = 4 * 1024;
const MAX_SEARCH_QUERY_CHARS: usize = 200;
const MAX_SEARCH_FIELD_CHARS: usize = 4_000;
const MAX_SEARCH_SESSIONS_PER_TOOL: usize = 5_000;
const MAX_SEARCH_DIRECTORY_ENTRIES: usize = 20_000;
const MAX_SEARCH_METADATA_LINE_BYTES: u64 = 64 * 1024;
const MAX_SEARCH_PREVIEW_BYTES_PER_SESSION: u64 = 64 * 1024;
const MAX_CLAUDE_PREVIEW_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CODEX_METADATA_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CODEX_SEARCH_PAGES: usize = 10;
const CODEX_SEARCH_PAGE_SIZE: usize = 50;
const CODEX_SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

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
    match tool_key {
        ToolKey::Claude => {
            let directory_path = directory_path.to_string();
            let cursor = cursor.map(str::to_string);
            tauri::async_runtime::spawn_blocking(move || {
                page_local(
                    list_claude_sessions(&directory_path)?,
                    cursor.as_deref(),
                    limit,
                )
            })
            .await
            .map_err(|error| anyhow!(error.to_string()))?
        }
        ToolKey::Codex => list_codex_page(directory_path, cursor, limit).await,
        ToolKey::Antigravity => {
            let directory_path = directory_path.to_string();
            let cursor = cursor.map(str::to_string);
            tauri::async_runtime::spawn_blocking(move || {
                page_local(
                    list_antigravity_sessions(&directory_path)?,
                    cursor.as_deref(),
                    limit,
                )
            })
            .await
            .map_err(|error| anyhow!(error.to_string()))?
        }
        ToolKey::Grok => {
            let directory_path = directory_path.to_string();
            let cursor = cursor.map(str::to_string);
            tauri::async_runtime::spawn_blocking(move || {
                page_local(
                    list_grok_sessions(&directory_path)?,
                    cursor.as_deref(),
                    limit,
                )
            })
            .await
            .map_err(|error| anyhow!(error.to_string()))?
        }
    }
}

#[derive(Debug, Clone)]
struct SearchDocument {
    session: SessionInfo,
    fields: Vec<String>,
}

#[derive(Debug, Default)]
struct SearchSource {
    documents: Vec<SearchDocument>,
    incomplete: bool,
}

pub async fn refresh_search_index(directory_path: &str) -> Result<Vec<SessionSearchIndexSource>> {
    let directory_for_local = directory_path.to_string();
    let local_sources = tauri::async_runtime::spawn_blocking(move || {
        (
            search_claude_documents(&directory_for_local),
            search_antigravity_documents(&directory_for_local),
            search_grok_documents(&directory_for_local),
        )
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?;

    let codex_source =
        match tokio::time::timeout(CODEX_SEARCH_TIMEOUT, search_codex_documents(directory_path))
            .await
        {
            Ok(Ok(source)) => Ok(source),
            Ok(Err(error)) => {
                log::warn!("Codex 会话搜索失败，改用本地会话 metadata：{error}");
                let path = directory_path.to_string();
                tauri::async_runtime::spawn_blocking(move || search_codex_rollout_metadata(&path))
                    .await
                    .map_err(|join_error| anyhow!(join_error.to_string()))
                    .and_then(|source| source)
            }
            Err(_) => {
                log::warn!("Codex 会话搜索超时，改用本地会话 metadata");
                let path = directory_path.to_string();
                tauri::async_runtime::spawn_blocking(move || search_codex_rollout_metadata(&path))
                    .await
                    .map_err(|join_error| anyhow!(join_error.to_string()))
                    .and_then(|source| source)
            }
        };

    Ok(vec![
        index_source(ToolKey::Claude, local_sources.0),
        index_source(ToolKey::Codex, codex_source),
        index_source(ToolKey::Antigravity, local_sources.1),
        index_source(ToolKey::Grok, local_sources.2),
    ])
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

fn index_source(tool_key: ToolKey, source: Result<SearchSource>) -> SessionSearchIndexSource {
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
    if !safe_session_id(session_id) {
        return Ok(false);
    }
    let directory_path = directory_path.to_string();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn_blocking(move || match tool_key {
        ToolKey::Claude => claude_session_belongs(&directory_path, &session_id),
        ToolKey::Codex => Ok(list_codex_sessions_legacy(&directory_path)?
            .iter()
            .any(|session| session.session_id == session_id)),
        ToolKey::Antigravity => antigravity_session_belongs(&directory_path, &session_id),
        ToolKey::Grok => grok_session_belongs(&directory_path, &session_id),
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?
}

fn home_dir() -> Result<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| anyhow!("无法确定用户主目录，不能读取会话历史"))
}

fn grok_sessions_dir() -> Result<PathBuf> {
    let grok_home = std::env::var_os("GROK_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| home_dir().map(|home| home.join(".grok")))?;
    Ok(grok_home.join("sessions"))
}

fn search_grok_documents(directory_path: &str) -> Result<SearchSource> {
    let sessions_dir = grok_sessions_dir()?;
    search_grok_documents_in(
        &sessions_dir,
        directory_path,
        MAX_GROK_SEARCH_SUMMARIES_BYTES,
    )
}

fn search_grok_documents_in(
    sessions_dir: &Path,
    directory_path: &str,
    max_total_bytes: u64,
) -> Result<SearchSource> {
    let groups = grok_session_group_dirs(&sessions_dir, directory_path)?;
    let mut source = SearchSource::default();
    let mut seen_ids = HashSet::new();
    let mut inspected_entries = 0;
    let mut bytes_scanned = 0_u64;

    'groups: for group in groups {
        let entries = match fs::read_dir(&group) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            inspected_entries += 1;
            if inspected_entries > MAX_GROK_SESSION_ENTRIES {
                source.incomplete = true;
                break 'groups;
            }
            if source.documents.len() >= MAX_SEARCH_SESSIONS_PER_TOOL {
                source.incomplete = true;
                break 'groups;
            }
            let remaining_budget = max_total_bytes.saturating_sub(bytes_scanned);
            if remaining_budget == 0 {
                source.incomplete = true;
                break 'groups;
            }
            let Ok(entry) = entry else {
                source.incomplete = true;
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                source.incomplete = true;
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            match grok_search_document_from_summary_bounded(
                &entry.path(),
                directory_path,
                remaining_budget.min(MAX_GROK_SUMMARY_BYTES),
            ) {
                Ok((Some(document), bytes_read)) => {
                    bytes_scanned = bytes_scanned.saturating_add(bytes_read);
                    if seen_ids.insert(document.session.session_id.clone()) {
                        source.documents.push(document);
                    }
                }
                Ok((None, bytes_read)) => {
                    bytes_scanned = bytes_scanned.saturating_add(bytes_read);
                }
                Err(_) => source.incomplete = true,
            };
        }
    }
    Ok(source)
}

fn list_grok_sessions(directory_path: &str) -> Result<Vec<SessionInfo>> {
    list_grok_sessions_in(&grok_sessions_dir()?, directory_path)
}

fn list_grok_sessions_in(sessions_dir: &Path, directory_path: &str) -> Result<Vec<SessionInfo>> {
    let groups = grok_session_group_dirs(sessions_dir, directory_path)?;
    let mut sessions = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut inspected_entries = 0;

    for group in groups {
        let entries = match fs::read_dir(&group) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            inspected_entries += 1;
            if inspected_entries > MAX_GROK_SESSION_ENTRIES {
                return Err(anyhow!("Grok Build 项目会话目录数量超出安全上限"));
            }
            let Ok(entry) = entry else {
                continue;
            };
            if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                continue;
            }
            let Some(session) = grok_session_from_summary(&entry.path(), directory_path) else {
                continue;
            };
            if seen_ids.insert(session.session_id.clone()) {
                sessions.push(session);
            }
        }
    }
    Ok(sessions)
}

fn grok_session_belongs(directory_path: &str, session_id: &str) -> Result<bool> {
    grok_session_belongs_in(&grok_sessions_dir()?, directory_path, session_id)
}

fn grok_session_belongs_in(
    sessions_dir: &Path,
    directory_path: &str,
    session_id: &str,
) -> Result<bool> {
    if uuid::Uuid::parse_str(session_id).is_err() {
        return Ok(false);
    }
    Ok(list_grok_sessions_in(sessions_dir, directory_path)?
        .iter()
        .any(|session| session.session_id.eq_ignore_ascii_case(session_id)))
}

fn grok_session_group_dirs(sessions_dir: &Path, directory_path: &str) -> Result<Vec<PathBuf>> {
    let direct_name = encode_grok_cwd_group(directory_path);
    if direct_name.len() <= 255 {
        let direct_path = sessions_dir.join(direct_name);
        if fs::symlink_metadata(&direct_path).is_ok_and(|metadata| metadata.file_type().is_dir()) {
            return Ok(vec![direct_path]);
        }
    }

    let entries = match fs::read_dir(sessions_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut groups = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_GROK_GROUP_ENTRIES {
            return Err(anyhow!("Grok Build 会话工作目录数量超出安全上限"));
        }
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            continue;
        }

        let group_path = entry.path();
        let encoded_path_matches = entry
            .file_name()
            .to_str()
            .and_then(percent_decode)
            .is_some_and(|path| paths_match(&path, directory_path));
        let cwd_file_matches = !encoded_path_matches
            && read_grok_file(&group_path.join(".cwd"), MAX_GROK_CWD_BYTES)
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .is_some_and(|path| {
                    paths_match(path.trim_end_matches(['\r', '\n']), directory_path)
                });
        if encoded_path_matches || cwd_file_matches {
            groups.push(group_path);
        }
    }
    Ok(groups)
}

fn encode_grok_cwd_group(directory_path: &str) -> String {
    let mut encoded = String::with_capacity(directory_path.len());
    for byte in directory_path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
            encoded.push(char::from(b"0123456789ABCDEF"[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

fn grok_session_from_summary(session_dir: &Path, directory_path: &str) -> Option<SessionInfo> {
    grok_search_document_from_summary(session_dir, directory_path).map(|document| document.session)
}

fn grok_search_document_from_summary(
    session_dir: &Path,
    directory_path: &str,
) -> Option<SearchDocument> {
    grok_search_document_from_summary_bounded(session_dir, directory_path, MAX_GROK_SUMMARY_BYTES)
        .ok()?
        .0
}

fn grok_search_document_from_summary_bounded(
    session_dir: &Path,
    directory_path: &str,
    max_bytes: u64,
) -> Result<(Option<SearchDocument>, u64)> {
    let Some(session_id) = session_dir.file_name().and_then(|name| name.to_str()) else {
        return Ok((None, 0));
    };
    let Ok(normalized_id) = uuid::Uuid::parse_str(session_id).map(|id| id.to_string()) else {
        return Ok((None, 0));
    };
    let summary_path = session_dir.join("summary.json");
    let Some(bytes) = read_search_metadata_file(&summary_path, max_bytes)? else {
        return Ok((None, 0));
    };
    let bytes_read = bytes.len() as u64;
    let value: Value = serde_json::from_slice(&bytes)?;
    let info = value
        .get("info")
        .ok_or_else(|| anyhow!("Grok Build 会话摘要缺少 info metadata"))?;
    let summary_id = non_empty_field(info, "id")
        .or_else(|| non_empty_field(info, "session_id"))
        .or_else(|| non_empty_field(info, "sessionId"))
        .ok_or_else(|| anyhow!("Grok Build 会话摘要缺少会话 ID"))?;
    let summary_id = uuid::Uuid::parse_str(&summary_id)
        .context("Grok Build 会话摘要中的会话 ID 无效")?
        .to_string();
    if summary_id != normalized_id {
        return Ok((None, bytes_read));
    }
    let cwd = non_empty_field(info, "cwd")
        .or_else(|| non_empty_field(info, "working_directory"))
        .or_else(|| non_empty_field(info, "workingDirectory"))
        .ok_or_else(|| anyhow!("Grok Build 会话摘要缺少工作目录"))?;
    if !paths_match(&cwd, directory_path) {
        return Ok((None, bytes_read));
    }

    let generated_title = non_empty_field(&value, "generated_title");
    let session_summary = non_empty_field(&value, "session_summary");
    let title = generated_title
        .clone()
        .or_else(|| session_summary.clone())
        .unwrap_or_else(|| "(Grok Build 会话)".to_string());
    let fields = [generated_title, session_summary]
        .into_iter()
        .flatten()
        .map(|field| truncate_chars(&field, MAX_SEARCH_FIELD_CHARS))
        .collect();
    Ok((
        Some(SearchDocument {
            session: SessionInfo {
                tool_key: ToolKey::Grok,
                session_id: normalized_id,
                title: truncate_chars(&title, TITLE_MAX_CHARS),
                alias: None,
                last_active_ms: mtime_ms(&summary_path),
            },
            fields,
        }),
        bytes_read,
    ))
}

fn read_grok_file(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .ok()?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= max_bytes).then_some(bytes)
}

fn read_search_metadata_file(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>> {
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

fn page_local(
    mut sessions: Vec<SessionInfo>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SessionPage> {
    sessions.sort_by(|a, b| b.last_active_ms.cmp(&a.last_active_ms));
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

/// Claude Code stores sessions under `~/.claude/projects/<slug>/`, where the
/// slug replaces every non-alphanumeric path character with `-`.
fn claude_slug(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_project_dir(directory_path: &str) -> Result<PathBuf> {
    Ok(home_dir()?
        .join(".claude")
        .join("projects")
        .join(claude_slug(directory_path)))
}

fn list_claude_sessions(directory_path: &str) -> Result<Vec<SessionInfo>> {
    let dir = claude_project_dir(directory_path)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let indexed_titles = claude_index_titles(&dir);

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
            .or_else(|| claude_title(&path))
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

fn search_claude_documents(directory_path: &str) -> Result<SearchSource> {
    let dir = claude_project_dir(directory_path)?;
    search_claude_documents_in(&dir)
}

fn search_claude_documents_in(dir: &Path) -> Result<SearchSource> {
    const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;

    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SearchSource::default());
        }
        Err(error) => return Err(error.into()),
    };
    let (summaries, mut incomplete) =
        match read_search_metadata_file(&dir.join("sessions-index.json"), MAX_INDEX_BYTES) {
            Ok(Some(bytes)) => match claude_search_summaries(&bytes) {
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
                match claude_search_first_user_message(&path, budget) {
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

fn claude_search_summaries(bytes: &[u8]) -> Result<HashMap<String, Vec<String>>> {
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

fn claude_index_titles(dir: &Path) -> HashMap<String, String> {
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

fn claude_session_belongs(directory_path: &str, session_id: &str) -> Result<bool> {
    Ok(claude_project_dir(directory_path)?
        .join(format!("{session_id}.jsonl"))
        .is_file())
}

fn claude_title(path: &Path) -> Option<String> {
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

fn claude_search_first_user_message(path: &Path, max_bytes: u64) -> Result<(Option<String>, u64)> {
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
    extract_text_content(entry.get("message")?.get("content")?)
}

fn extract_text_content(content: &Value) -> Option<String> {
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

async fn list_codex_page(
    directory_path: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SessionPage> {
    if cursor.is_some_and(|value| value.starts_with(OFFSET_CURSOR_PREFIX)) {
        return list_codex_fallback_page(directory_path, cursor, limit).await;
    }

    let app_cursor = decode_codex_cursor(cursor)?;
    match list_codex_app_page(directory_path, app_cursor.as_deref(), limit).await {
        Ok(page) => Ok(page),
        Err(error) if cursor.is_none() => {
            log::warn!("Codex App Server 会话读取失败，回退 JSONL：{error}");
            list_codex_fallback_page(directory_path, None, limit).await
        }
        Err(error) => Err(error),
    }
}

async fn search_codex_documents(directory_path: &str) -> Result<SearchSource> {
    let mut source = SearchSource::default();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();

    for page_index in 0..MAX_CODEX_SEARCH_PAGES {
        let result = codex_app_server::request(
            "thread/list",
            json!({
                "cursor": cursor.as_deref(),
                "limit": CODEX_SEARCH_PAGE_SIZE,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "cwd": directory_path,
                "archived": false
            }),
        )
        .await?;
        let data = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("Codex thread/list 响应缺少 data"))?;
        for thread in data {
            if source.documents.len() >= MAX_SEARCH_SESSIONS_PER_TOOL {
                source.incomplete = true;
                return Ok(source);
            }
            if let Some(document) = codex_search_document(thread) {
                source.documents.push(document);
            }
        }
        let next_cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(next_cursor) = next_cursor else {
            return Ok(source);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(anyhow!("Codex thread/list 返回了重复分页游标"));
        }
        cursor = Some(next_cursor);
        if page_index + 1 == MAX_CODEX_SEARCH_PAGES {
            source.incomplete = true;
        }
    }
    Ok(source)
}

fn codex_search_document(thread: &Value) -> Option<SearchDocument> {
    let session_id = thread.get("id")?.as_str()?;
    if !safe_session_id(session_id) {
        return None;
    }
    let name =
        non_empty_field(thread, "name").map(|name| truncate_chars(&name, MAX_SEARCH_FIELD_CHARS));
    let preview = non_empty_field(thread, "preview")
        .map(|preview| truncate_chars(&preview, MAX_SEARCH_FIELD_CHARS));
    let title = name
        .clone()
        .or_else(|| preview.clone())
        .unwrap_or_else(|| "(Codex 会话)".to_string());
    Some(SearchDocument {
        session: SessionInfo {
            tool_key: ToolKey::Codex,
            session_id: session_id.to_string(),
            title: truncate_chars(&title, TITLE_MAX_CHARS),
            alias: None,
            last_active_ms: thread
                .get("updatedAt")
                .and_then(json_number_i64)
                .map(epoch_to_ms),
        },
        fields: [name, preview].into_iter().flatten().collect(),
    })
}

async fn list_codex_app_page(
    directory_path: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SessionPage> {
    let result = codex_app_server::request(
        "thread/list",
        json!({
            "cursor": cursor,
            "limit": limit,
            "sortKey": "updated_at",
            "sortDirection": "desc",
            "cwd": directory_path,
            "archived": false
        }),
    )
    .await?;

    let data = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Codex thread/list 响应缺少 data"))?;
    let items = data
        .iter()
        .filter_map(|thread| {
            let session_id = thread.get("id")?.as_str()?.to_string();
            let title = non_empty_field(thread, "name")
                .or_else(|| non_empty_field(thread, "preview"))
                .unwrap_or_else(|| "(Codex 会话)".to_string());
            Some(SessionInfo {
                tool_key: ToolKey::Codex,
                session_id,
                title: truncate_chars(&title, TITLE_MAX_CHARS),
                alias: None,
                last_active_ms: thread
                    .get("updatedAt")
                    .and_then(json_number_i64)
                    .map(epoch_to_ms),
            })
        })
        .collect();
    let next_cursor = result
        .get("nextCursor")
        .and_then(Value::as_str)
        .map(encode_codex_cursor);
    Ok(SessionPage { items, next_cursor })
}

fn encode_codex_cursor(cursor: &str) -> String {
    format!(
        "{CODEX_CURSOR_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(cursor.as_bytes())
    )
}

fn decode_codex_cursor(cursor: Option<&str>) -> Result<Option<String>> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let encoded = cursor
        .strip_prefix(CODEX_CURSOR_PREFIX)
        .ok_or_else(|| anyhow!("无效的 Codex 会话分页游标"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| anyhow!("无效的 Codex 会话分页游标"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| anyhow!("无效的 Codex 会话分页游标"))
}

async fn list_codex_fallback_page(
    directory_path: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SessionPage> {
    let directory_path = directory_path.to_string();
    let cursor = cursor.map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || {
        page_local(
            list_codex_sessions_legacy(&directory_path)?,
            cursor.as_deref(),
            limit,
        )
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?
}

fn list_codex_sessions_legacy(directory_path: &str) -> Result<Vec<SessionInfo>> {
    let root = home_dir()?.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files, 0)?;
    Ok(files
        .into_iter()
        .filter_map(|path| parse_codex_rollout(&path, directory_path))
        .collect())
}

fn search_codex_rollout_metadata(directory_path: &str) -> Result<SearchSource> {
    const MAX_ROLLOUT_FILES: usize = 10_000;
    const MAX_DIRECTORY_ENTRIES: usize = 20_000;

    let root = home_dir()?.join(".codex").join("sessions");
    let mut files = Vec::new();
    let mut visited_entries = 0;
    let scan_incomplete = collect_rollout_files_bounded(
        &root,
        &mut files,
        0,
        &mut visited_entries,
        MAX_ROLLOUT_FILES,
        MAX_DIRECTORY_ENTRIES,
    )?;
    let mut source = SearchSource::default();
    let mut bytes_scanned = 0_u64;
    source.incomplete = scan_incomplete;
    for path in files {
        if source.documents.len() >= MAX_SEARCH_SESSIONS_PER_TOOL {
            source.incomplete = true;
            break;
        }
        let budget = MAX_CODEX_METADATA_SCAN_BYTES
            .saturating_sub(bytes_scanned)
            .min(MAX_SEARCH_PREVIEW_BYTES_PER_SESSION);
        if budget == 0 {
            source.incomplete = true;
            break;
        }
        match parse_codex_rollout_search(&path, directory_path, budget) {
            Ok((Some(document), bytes_read)) => {
                bytes_scanned = bytes_scanned.saturating_add(bytes_read);
                source.documents.push(document);
            }
            Ok((None, bytes_read)) => {
                bytes_scanned = bytes_scanned.saturating_add(bytes_read);
            }
            Err(_) => {
                source.incomplete = true;
                break;
            }
        }
    }
    Ok(source)
}

fn collect_rollout_files_bounded(
    dir: &Path,
    out: &mut Vec<PathBuf>,
    depth: usize,
    visited_entries: &mut usize,
    max_files: usize,
    max_entries: usize,
) -> Result<bool> {
    if depth > 5 {
        return Ok(false);
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut incomplete = false;
    for entry in entries {
        *visited_entries += 1;
        if *visited_entries > max_entries || out.len() >= max_files {
            return Ok(true);
        }
        let Ok(entry) = entry else {
            incomplete = true;
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            incomplete = true;
            continue;
        };
        if file_type.is_dir() {
            incomplete |= collect_rollout_files_bounded(
                &entry.path(),
                out,
                depth + 1,
                visited_entries,
                max_files,
                max_entries,
            )?;
        } else if file_type.is_file()
            && entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("jsonl")
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("rollout-"))
        {
            out.push(entry.path());
        }
    }
    Ok(incomplete)
}

#[cfg(test)]
fn parse_codex_rollout_metadata(path: &Path, directory_path: &str) -> Result<Option<SessionInfo>> {
    const MAX_METADATA_LINES: usize = 200;
    const MAX_METADATA_LINE_BYTES: u64 = 64 * 1024;

    let mut reader = BufReader::new(File::open(path)?);
    let mut session_id = None;
    let mut cwd = None;
    for line_index in 0..MAX_METADATA_LINES {
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take(MAX_METADATA_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if read as u64 > MAX_METADATA_LINE_BYTES {
            return Err(anyhow!("Codex rollout metadata 行超出安全上限"));
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let payload = value.get("payload").unwrap_or(&value);
        session_id = payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| uuid_from_filename(path));
        cwd = payload
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string);
        if session_id.is_some() && cwd.is_some() {
            break;
        }
        if line_index + 1 == MAX_METADATA_LINES {
            return Err(anyhow!("Codex rollout metadata 超出扫描行数上限"));
        }
    }
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    if !paths_match(&cwd, directory_path) {
        return Ok(None);
    }
    let Some(session_id) = session_id.or_else(|| uuid_from_filename(path)) else {
        return Ok(None);
    };
    if !safe_session_id(&session_id) {
        return Ok(None);
    }
    Ok(Some(SessionInfo {
        tool_key: ToolKey::Codex,
        session_id,
        title: "(Codex 会话)".to_string(),
        alias: None,
        last_active_ms: mtime_ms(path),
    }))
}

fn collect_rollout_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) -> Result<()> {
    if depth > 5 {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_files(&path, out, depth + 1)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with("rollout-") {
                out.push(path);
            }
        }
    }
    Ok(())
}

const CODEX_META_SCAN_LINES: usize = 200;

fn parse_codex_rollout(path: &Path, directory_path: &str) -> Option<SessionInfo> {
    let reader = BufReader::new(File::open(path).ok()?);
    let mut id = None;
    let mut cwd_matched = false;
    let mut title = None;

    for line in reader
        .lines()
        .map_while(Result::ok)
        .take(CODEX_META_SCAN_LINES)
    {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !cwd_matched {
            if let Some(cwd) = find_string_field(&value, "cwd") {
                if !paths_match(&cwd, directory_path) {
                    return None;
                }
                cwd_matched = true;
            }
        }
        if id.is_none() {
            id = find_string_field(&value, "id");
        }
        if title.is_none() {
            title = codex_user_text(&value);
        }
        if cwd_matched && id.is_some() && title.is_some() {
            break;
        }
    }

    if !cwd_matched {
        return None;
    }
    let session_id = id.or_else(|| uuid_from_filename(path))?;
    Some(SessionInfo {
        tool_key: ToolKey::Codex,
        session_id,
        title: title
            .map(|value| truncate_chars(&value, TITLE_MAX_CHARS))
            .unwrap_or_else(|| "(Codex 会话)".to_string()),
        alias: None,
        last_active_ms: mtime_ms(path),
    })
}

fn parse_codex_rollout_search(
    path: &Path,
    directory_path: &str,
    max_bytes: u64,
) -> Result<(Option<SearchDocument>, u64)> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut bytes_read = 0_u64;
    let mut id = None;
    let mut cwd_matched = false;
    let mut title = None;

    for _ in 0..CODEX_META_SCAN_LINES {
        let remaining = max_bytes.saturating_sub(bytes_read);
        if remaining == 0 {
            return Err(anyhow!("Codex 会话 metadata 超出扫描字节上限"));
        }
        let line_limit = MAX_SEARCH_METADATA_LINE_BYTES.min(remaining);
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take(line_limit + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        if read as u64 > line_limit {
            return Err(anyhow!("Codex 会话 metadata 单行超出扫描字节上限"));
        }
        bytes_read = bytes_read.saturating_add(read as u64);
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if !cwd_matched {
            if let Some(cwd) = find_string_field(&value, "cwd") {
                if !paths_match(&cwd, directory_path) {
                    return Ok((None, bytes_read));
                }
                cwd_matched = true;
            }
        }
        if id.is_none() {
            id = find_string_field(&value, "id");
        }
        if title.is_none() {
            title =
                codex_user_text(&value).map(|text| truncate_chars(&text, MAX_SEARCH_FIELD_CHARS));
        }
        if cwd_matched && id.is_some() && title.is_some() {
            break;
        }
    }

    if !cwd_matched {
        return Ok((None, bytes_read));
    }
    let Some(session_id) = id.or_else(|| uuid_from_filename(path)) else {
        return Ok((None, bytes_read));
    };
    if !safe_session_id(&session_id) {
        return Ok((None, bytes_read));
    }
    let title = title.unwrap_or_else(|| "(Codex 会话)".to_string());
    let fields = (title != "(Codex 会话)")
        .then(|| title.clone())
        .into_iter()
        .collect();
    Ok((
        Some(SearchDocument {
            session: SessionInfo {
                tool_key: ToolKey::Codex,
                session_id,
                title: truncate_chars(&title, TITLE_MAX_CHARS),
                alias: None,
                last_active_ms: mtime_ms(path),
            },
            fields,
        }),
        bytes_read,
    ))
}

fn list_antigravity_sessions(directory_path: &str) -> Result<Vec<SessionInfo>> {
    let home = home_dir()?;
    let db_path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("conversation_summaries.db");
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let metadata = antigravity_metadata_summaries(&home);
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("无法只读打开 Antigravity 会话索引")?;
    let mut statement = connection.prepare(
        "select conversation_id, title, preview, cast(last_modified_time as integer), workspace_uris
         from conversation_summaries",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;

    let mut sessions = Vec::new();
    for row in rows {
        let (session_id, title, preview, modified, workspace_uris) = row?;
        if !workspace_uris
            .as_deref()
            .is_some_and(|uris| workspace_matches(uris, directory_path))
        {
            continue;
        }
        let title = non_empty_string(title)
            .or_else(|| metadata.get(&session_id).cloned())
            .or_else(|| non_empty_string(preview))
            .unwrap_or_else(|| "(Antigravity 会话)".to_string());
        sessions.push(SessionInfo {
            tool_key: ToolKey::Antigravity,
            session_id,
            title: truncate_chars(&title, TITLE_MAX_CHARS),
            alias: None,
            last_active_ms: modified.map(epoch_to_ms),
        });
    }
    Ok(sessions)
}

fn search_antigravity_rows(
    connection: &Connection,
    directory_path: &str,
    summaries: &HashMap<String, String>,
    mut incomplete: bool,
) -> Result<SearchSource> {
    let mut statement = connection.prepare(
        "select conversation_id, title, preview, cast(last_modified_time as integer), workspace_uris
         from conversation_summaries",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;

    let mut source = SearchSource::default();
    for (index, row) in rows.enumerate() {
        if index >= MAX_SEARCH_SESSIONS_PER_TOOL {
            incomplete = true;
            break;
        }
        let (session_id, title, preview, modified, workspace_uris) = row?;
        if !workspace_uris
            .as_deref()
            .is_some_and(|uris| workspace_matches(uris, directory_path))
        {
            continue;
        }
        let summary = summaries.get(&session_id).cloned();
        let title =
            non_empty_string(title).map(|title| truncate_chars(&title, MAX_SEARCH_FIELD_CHARS));
        let preview = non_empty_string(preview)
            .map(|preview| truncate_chars(&preview, MAX_SEARCH_FIELD_CHARS));
        let display_title = title
            .clone()
            .or_else(|| summary.clone())
            .or_else(|| preview.clone())
            .unwrap_or_else(|| "(Antigravity 会话)".to_string());
        source.documents.push(SearchDocument {
            session: SessionInfo {
                tool_key: ToolKey::Antigravity,
                session_id,
                title: truncate_chars(&display_title, TITLE_MAX_CHARS),
                alias: None,
                last_active_ms: modified.map(epoch_to_ms),
            },
            fields: [title, summary, preview].into_iter().flatten().collect(),
        });
    }
    source.incomplete = incomplete;
    Ok(source)
}

fn search_antigravity_documents(directory_path: &str) -> Result<SearchSource> {
    const MAX_SUMMARIES_BYTES: u64 = 16 * 1024 * 1024;

    let home = home_dir()?;
    let db_path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("conversation_summaries.db");
    if !db_path.is_file() {
        return Ok(SearchSource::default());
    }

    let metadata_path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("cache")
        .join("conversation_metadata.json");
    let (summaries, incomplete) =
        match read_search_metadata_file(&metadata_path, MAX_SUMMARIES_BYTES) {
            Ok(Some(bytes)) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => {
                    let object = value
                        .get("conversations")
                        .and_then(Value::as_object)
                        .or_else(|| value.as_object());
                    let summaries = object
                        .into_iter()
                        .flatten()
                        .filter_map(|(id, item)| {
                            non_empty_field(item, "summary").map(|summary| {
                                (id.clone(), truncate_chars(&summary, MAX_SEARCH_FIELD_CHARS))
                            })
                        })
                        .collect::<HashMap<_, _>>();
                    (summaries, false)
                }
                Err(_) => (HashMap::new(), true),
            },
            Ok(None) => (HashMap::new(), false),
            Err(error) => {
                log::warn!("Antigravity 会话摘要不可用：{error}");
                (HashMap::new(), true)
            }
        };

    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("无法只读打开 Antigravity 会话索引")?;
    search_antigravity_rows(&connection, directory_path, &summaries, incomplete)
}

fn antigravity_session_belongs(directory_path: &str, session_id: &str) -> Result<bool> {
    Ok(list_antigravity_sessions(directory_path)?
        .iter()
        .any(|session| session.session_id == session_id))
}

fn antigravity_metadata_summaries(home: &Path) -> HashMap<String, String> {
    let path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("cache")
        .join("conversation_metadata.json");
    let Ok(contents) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return HashMap::new();
    };
    let object = value
        .get("conversations")
        .and_then(Value::as_object)
        .or_else(|| value.as_object());
    object
        .into_iter()
        .flatten()
        .filter_map(|(id, item)| Some((id.clone(), non_empty_field(item, "summary")?)))
        .collect()
}

fn workspace_matches(workspace_uris: &str, directory_path: &str) -> bool {
    let Ok(uris) = serde_json::from_str::<Vec<String>>(workspace_uris) else {
        return false;
    };
    uris.iter().any(|uri| {
        file_uri_to_path(uri)
            .as_deref()
            .is_some_and(|path| paths_match(path, directory_path))
    })
}

fn file_uri_to_path(uri: &str) -> Option<String> {
    let encoded = uri.strip_prefix("file://")?;
    let mut decoded = percent_decode(encoded)?;
    if decoded.as_bytes().get(0) == Some(&b'/')
        && decoded.as_bytes().get(2) == Some(&b':')
        && decoded
            .as_bytes()
            .get(1)
            .is_some_and(u8::is_ascii_alphabetic)
    {
        decoded.remove(0);
    }
    Some(decoded)
}

fn percent_decode(value: &str) -> Option<String> {
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

fn find_string_field(value: &Value, key: &str) -> Option<String> {
    if let Some(found) = value.get(key).and_then(Value::as_str) {
        return Some(found.to_string());
    }
    value
        .get("payload")
        .and_then(|payload| payload.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn codex_user_text(value: &Value) -> Option<String> {
    let candidate = if value.get("role").is_some() {
        value
    } else {
        value.get("payload")?
    };
    if candidate.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    extract_text_content(candidate.get("content")?)
}

fn uuid_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts: Vec<&str> = stem.split('-').collect();
    parts
        .windows(5)
        .find(|window| is_uuid_groups(window))
        .map(|window| window.join("-"))
}

fn is_uuid_groups(groups: &[&str]) -> bool {
    const EXPECTED: [usize; 5] = [8, 4, 4, 4, 12];
    groups.len() == 5
        && groups
            .iter()
            .zip(EXPECTED)
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn safe_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn paths_match(a: &str, b: &str) -> bool {
    path_identity::paths_equal(a, b)
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

fn epoch_to_ms(value: i64) -> i64 {
    if value.unsigned_abs() < 100_000_000_000 {
        value.saturating_mul(1_000)
    } else {
        value
    }
}

fn json_number_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_f64().map(|value| value as i64))
}

fn non_empty_field(value: &Value, key: &str) -> Option<String> {
    non_empty_string(value.get(key)?.as_str().map(str::to_string))
}

fn non_empty_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn truncate_chars(value: &str, max: usize) -> String {
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
