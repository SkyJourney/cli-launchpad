use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

use crate::models::session::{SessionInfo, SessionPage, SessionSearchIndexSource};
use crate::models::tool::ToolKey;
use crate::services::session_service::{
    epoch_to_ms, extract_text_content, home_dir, index_source, mtime_ms, non_empty_field,
    page_local, paths_match, safe_session_id, truncate_chars, SearchDocument, SearchSource,
    MAX_SEARCH_FIELD_CHARS, MAX_SEARCH_METADATA_LINE_BYTES, MAX_SEARCH_PREVIEW_BYTES_PER_SESSION,
    MAX_SEARCH_SESSIONS_PER_TOOL, TITLE_MAX_CHARS,
};

const CODEX_CURSOR_PREFIX: &str = "codex:";
const OFFSET_CURSOR_PREFIX: &str = "offset:";
const MAX_CODEX_METADATA_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CODEX_SEARCH_PAGES: usize = 10;
const CODEX_SEARCH_PAGE_SIZE: usize = 50;
const CODEX_SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
async fn list_codex_page(
    directory_path: &str,
    cursor: Option<&str>,
    limit: usize,
    context: &crate::services::cli_adapters::AdapterContext,
) -> Result<SessionPage> {
    if cursor.is_some_and(|value| value.starts_with(OFFSET_CURSOR_PREFIX)) {
        return list_codex_fallback_page(directory_path, cursor, limit, &context.home).await;
    }

    let app_cursor = decode_codex_cursor(cursor)?;
    match list_codex_app_page(directory_path, app_cursor.as_deref(), limit, context).await {
        Ok(page) => Ok(page),
        Err(error) if cursor.is_none() => {
            log::warn!("Codex App Server 会话读取失败，回退 JSONL：{error}");
            list_codex_fallback_page(directory_path, None, limit, &context.home).await
        }
        Err(error) => Err(error),
    }
}

async fn search_codex_documents(
    directory_path: &str,
    context: &crate::services::cli_adapters::AdapterContext,
) -> Result<SearchSource> {
    let mut source = SearchSource::default();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();

    for page_index in 0..MAX_CODEX_SEARCH_PAGES {
        let result = super::app_server::request(
            context.resolved_path.as_deref(),
            "thread/list",
            json!({
                "cursor": cursor.as_deref(),
                "limit": CODEX_SEARCH_PAGE_SIZE,
                "sortKey": "updated_at",
                "sortDirection": "desc",
                "cwd": directory_path,
                "archived": false
            }),
            context.budget,
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

pub(crate) fn codex_search_document(thread: &Value) -> Option<SearchDocument> {
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
    context: &crate::services::cli_adapters::AdapterContext,
) -> Result<SessionPage> {
    let result = super::app_server::request(
        context.resolved_path.as_deref(),
        "thread/list",
        json!({
            "cursor": cursor,
            "limit": limit,
            "sortKey": "updated_at",
            "sortDirection": "desc",
            "cwd": directory_path,
            "archived": false
        }),
        context.budget,
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

pub(crate) fn encode_codex_cursor(cursor: &str) -> String {
    format!(
        "{CODEX_CURSOR_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(cursor.as_bytes())
    )
}

pub(crate) fn decode_codex_cursor(cursor: Option<&str>) -> Result<Option<String>> {
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
    home: &Path,
) -> Result<SessionPage> {
    let directory_path = directory_path.to_string();
    let cursor = cursor.map(str::to_string);
    let home = home.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        page_local(
            list_codex_sessions_in(&directory_path, &home)?,
            cursor.as_deref(),
            limit,
        )
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?
}

fn list_codex_sessions_legacy(directory_path: &str) -> Result<Vec<SessionInfo>> {
    list_codex_sessions_in(directory_path, &home_dir()?)
}

fn list_codex_sessions_in(directory_path: &str, home: &Path) -> Result<Vec<SessionInfo>> {
    let root = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files, 0)?;
    Ok(files
        .into_iter()
        .filter_map(|path| parse_codex_rollout(&path, directory_path))
        .collect())
}

fn search_codex_rollout_metadata_in(directory_path: &str, home: &Path) -> Result<SearchSource> {
    const MAX_ROLLOUT_FILES: usize = 10_000;
    const MAX_DIRECTORY_ENTRIES: usize = 20_000;

    let root = home.join(".codex").join("sessions");
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
pub(crate) fn parse_codex_rollout_metadata(
    path: &Path,
    directory_path: &str,
) -> Result<Option<SessionInfo>> {
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

pub(crate) fn parse_codex_rollout_search(
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

pub(crate) fn uuid_from_filename(path: &Path) -> Option<String> {
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

fn json_number_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_f64().map(|value| value as i64))
}

pub(crate) async fn list_sessions_page(
    directory_path: String,
    cursor: Option<String>,
    limit: usize,
    context: crate::services::cli_adapters::AdapterContext,
) -> Result<SessionPage> {
    list_codex_page(&directory_path, cursor.as_deref(), limit, &context).await
}

pub(crate) async fn search_index_source(
    directory_path: String,
    context: crate::services::cli_adapters::AdapterContext,
) -> SessionSearchIndexSource {
    let result = match tokio::time::timeout(
        context.budget.min(CODEX_SEARCH_TIMEOUT),
        search_codex_documents(&directory_path, &context),
    )
    .await
    {
        Ok(Ok(source)) => Ok(source),
        Ok(Err(error)) => {
            log::warn!("Codex 会话搜索失败，改用本地会话 metadata：{error}");
            let path = directory_path.clone();
            let home = context.home.clone();
            crate::services::session_service::spawn_search_index_blocking(move || {
                search_codex_rollout_metadata_in(&path, &home)
            })
            .await
        }
        Err(_) => {
            log::warn!("Codex 会话搜索超时，改用本地会话 metadata");
            let home = context.home.clone();
            crate::services::session_service::spawn_search_index_blocking(move || {
                search_codex_rollout_metadata_in(&directory_path, &home)
            })
            .await
        }
    };
    index_source(ToolKey::Codex, result)
}

pub(crate) async fn session_belongs_to_directory(
    directory_path: String,
    session_id: String,
) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(list_codex_sessions_legacy(&directory_path)?
            .iter()
            .any(|session| session.session_id == session_id))
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?
}
