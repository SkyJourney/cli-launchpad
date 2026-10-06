use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::models::session::{SessionInfo, SessionPage, SessionSearchIndexSource};
use crate::models::tool::ToolKey;
use crate::services::session_service::{
    home_dir, index_source, mtime_ms, non_empty_field, page_local, paths_match, percent_decode,
    read_search_metadata_file, truncate_chars, SearchDocument, SearchSource,
    MAX_SEARCH_FIELD_CHARS, MAX_SEARCH_SESSIONS_PER_TOOL, TITLE_MAX_CHARS,
};

const MAX_GROK_GROUP_ENTRIES: usize = 4_096;
const MAX_GROK_SESSION_ENTRIES: usize = 20_000;
pub(crate) const MAX_GROK_SUMMARY_BYTES: u64 = 256 * 1024;
const MAX_GROK_SEARCH_SUMMARIES_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GROK_CWD_BYTES: u64 = 4 * 1024;
fn grok_sessions_dir() -> Result<PathBuf> {
    grok_sessions_dir_in(&home_dir()?)
}

fn grok_sessions_dir_in(home: &Path) -> Result<PathBuf> {
    let grok_home = std::env::var_os("GROK_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".grok"));
    Ok(grok_home.join("sessions"))
}

fn search_grok_documents_with_home(directory_path: &str, home: &Path) -> Result<SearchSource> {
    let sessions_dir = grok_sessions_dir_in(home)?;
    search_grok_documents_in(
        &sessions_dir,
        directory_path,
        MAX_GROK_SEARCH_SUMMARIES_BYTES,
    )
}

pub(crate) fn search_grok_documents_in(
    sessions_dir: &Path,
    directory_path: &str,
    max_total_bytes: u64,
) -> Result<SearchSource> {
    let groups = grok_session_group_dirs(sessions_dir, directory_path)?;
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

pub(crate) fn list_grok_sessions_in(
    sessions_dir: &Path,
    directory_path: &str,
) -> Result<Vec<SessionInfo>> {
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

pub(crate) fn grok_session_belongs_in(
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

pub(crate) fn encode_grok_cwd_group(directory_path: &str) -> String {
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

pub(crate) fn grok_search_document_from_summary(
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

pub(crate) async fn list_sessions_page(
    directory_path: String,
    cursor: Option<String>,
    limit: usize,
    context: crate::services::cli_adapters::AdapterContext,
) -> Result<SessionPage> {
    tauri::async_runtime::spawn_blocking(move || {
        page_local(
            list_grok_sessions_in(&grok_sessions_dir_in(&context.home)?, &directory_path)?,
            cursor.as_deref(),
            limit,
        )
    })
    .await
    .map_err(|error| anyhow!(error.to_string()))?
}

pub(crate) async fn search_index_source(
    directory_path: String,
    context: crate::services::cli_adapters::AdapterContext,
) -> SessionSearchIndexSource {
    let result = crate::services::session_service::spawn_search_index_blocking(move || {
        search_grok_documents_with_home(&directory_path, &context.home)
    })
    .await;
    index_source(ToolKey::Grok, result)
}

pub(crate) async fn session_belongs_to_directory(
    directory_path: String,
    session_id: String,
) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || grok_session_belongs(&directory_path, &session_id))
        .await
        .map_err(|error| anyhow!(error.to_string()))?
}
