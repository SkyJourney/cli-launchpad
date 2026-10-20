//! Helpers shared by the CLI adapters' session history readers. They were moved out of the
//! session coordinator, which keeps the orchestration and imports only what it still uses.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::models::session::{
    SessionInfo, SessionPage, SessionSearchIndexDocument, SessionSearchIndexSource,
};
use crate::models::tool::ToolKey;
use crate::platform::path_identity;

pub(crate) const TITLE_MAX_CHARS: usize = 100;

const OFFSET_CURSOR_PREFIX: &str = "offset:";

const MAX_CONCURRENT_SEARCH_INDEX_SCANS: usize = 2;

static SEARCH_INDEX_SEMAPHORE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

pub(crate) const MAX_SEARCH_FIELD_CHARS: usize = 4_000;

pub(crate) const MAX_SEARCH_SESSIONS_PER_TOOL: usize = 5_000;

pub(crate) const MAX_SEARCH_DIRECTORY_ENTRIES: usize = 20_000;

pub(crate) const MAX_SEARCH_METADATA_LINE_BYTES: u64 = 64 * 1024;

pub(crate) const MAX_SEARCH_PREVIEW_BYTES_PER_SESSION: u64 = 64 * 1024;

pub(crate) const MAX_CLAUDE_PREVIEW_SCAN_BYTES: u64 = 64 * 1024 * 1024;

pub(crate) async fn acquire_search_index_permit() -> Option<tokio::sync::OwnedSemaphorePermit> {
    SEARCH_INDEX_SEMAPHORE
        .get_or_init(|| {
            Arc::new(tokio::sync::Semaphore::new(
                MAX_CONCURRENT_SEARCH_INDEX_SCANS,
            ))
        })
        .clone()
        .acquire_owned()
        .await
        .ok()
}

pub(crate) async fn spawn_search_index_blocking<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let permit = acquire_search_index_permit()
        .await
        .ok_or_else(|| anyhow!("会话搜索索引并发限流器不可用"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| anyhow!("会话搜索索引阻塞任务异常：{error}"))?
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
        && !value.starts_with('-')
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Canonical lowercase hyphenated UUID: 8-4-4-4-12 hex digits, 36 bytes.
pub(crate) fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
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
