use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::models::session::{SessionInfo, SessionPage, SessionSearchIndexSource};
use crate::models::tool::ToolKey;
use crate::services::session_service::{
    epoch_to_ms, home_dir, index_source, non_empty_field, non_empty_string, page_local,
    paths_match, percent_decode, read_search_metadata_file, truncate_chars, SearchDocument,
    SearchSource, MAX_SEARCH_FIELD_CHARS, MAX_SEARCH_SESSIONS_PER_TOOL, TITLE_MAX_CHARS,
};
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

pub(crate) fn search_antigravity_rows(
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

pub(crate) fn workspace_matches(workspace_uris: &str, directory_path: &str) -> bool {
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
    if decoded.as_bytes().first() == Some(&b'/')
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

pub(crate) async fn list_sessions_page(
    directory_path: String,
    cursor: Option<String>,
    limit: usize,
) -> Result<SessionPage> {
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

pub(crate) async fn search_index_source(directory_path: String) -> SessionSearchIndexSource {
    let result = crate::services::session_service::spawn_search_index_blocking(move || {
        search_antigravity_documents(&directory_path)
    })
    .await;
    index_source(ToolKey::Antigravity, result)
}

pub(crate) async fn session_belongs_to_directory(
    directory_path: String,
    session_id: String,
) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        antigravity_session_belongs(&directory_path, &session_id)
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?
}
