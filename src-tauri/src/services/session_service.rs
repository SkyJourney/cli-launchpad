use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::db::directory_repo;
use crate::models::session::{SessionInfo, SessionPage};
use crate::models::tool::ToolKey;
use crate::services::codex_app_server;

const TITLE_MAX_CHARS: usize = 100;
const MAX_PAGE_SIZE: usize = 50;
const OFFSET_CURSOR_PREFIX: &str = "offset:";
const CODEX_CURSOR_PREFIX: &str = "codex:";

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
    normalize_path(a) == normalize_path(b)
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
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
    fn file_uri_matches_windows_path_and_decodes_spaces() {
        let uris = r#"["file:///C:/Projects/My%20App"]"#;
        assert!(workspace_matches(uris, "c:\\projects\\my app\\"));
    }

    #[test]
    fn paths_match_ignores_separators_and_case() {
        assert!(paths_match("C:/Projects/Demo", "c:\\projects\\demo\\"));
        assert!(!paths_match("C:\\a", "C:\\b"));
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
