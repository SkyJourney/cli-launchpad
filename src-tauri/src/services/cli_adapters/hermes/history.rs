use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use rusqlite::{Connection, OpenFlags};

use crate::models::session::{SessionInfo, SessionPage, SessionSearchIndexSource};
use crate::models::tool::ToolKey;
#[cfg(not(windows))]
use crate::services::session_service::home_dir;
use crate::services::session_service::{
    index_source, page_local, paths_match, read_search_metadata_file, truncate_chars,
    SearchDocument, SearchSource, MAX_SEARCH_FIELD_CHARS, TITLE_MAX_CHARS,
};

const MAX_HERMES_SESSION_ROWS: usize = 5_000;
const MAX_HERMES_PATH_CHARS: usize = 4_096;
const MAX_HERMES_PREVIEW_CHARS: usize = 1_000;
const MAX_HERMES_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
const HERMES_DB_BUSY_TIMEOUT: Duration = Duration::from_millis(250);

pub(crate) fn valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 200
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn hermes_home() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("HERMES_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }

    #[cfg(windows)]
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("无法确定 Hermes Agent 的 Windows 数据目录"))?
        .join("hermes");
    #[cfg(not(windows))]
    let root = home_dir()?.join(".hermes");

    resolve_active_profile(&root)
}

fn resolve_active_profile(root: &Path) -> Result<PathBuf> {
    let active_profile = root.join("active_profile");
    let Some(bytes) = read_search_metadata_file(&active_profile, 256)? else {
        return Ok(root.to_path_buf());
    };
    let value = String::from_utf8(bytes).context("Hermes Agent active_profile 不是有效 UTF-8")?;
    let profile = value.trim().trim_start_matches('\u{feff}');
    if profile.is_empty() || profile.eq_ignore_ascii_case("default") {
        return Ok(root.to_path_buf());
    }
    if !valid_profile_name(profile) {
        anyhow::bail!("Hermes Agent active_profile 名称无效");
    }
    Ok(root.join("profiles").join(profile))
}

fn valid_profile_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn hermes_db_path() -> Result<PathBuf> {
    Ok(hermes_home()?.join("state.db"))
}

fn open_read_only(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("无法只读打开 Hermes Agent 会话数据库：{}", path.display()))?;
    connection.busy_timeout(HERMES_DB_BUSY_TIMEOUT)?;
    Ok(connection)
}

fn list_sessions(directory_path: &str) -> Result<Vec<SessionInfo>> {
    let path = hermes_db_path()?;
    list_sessions_from_db(&path, directory_path, false).map(|source| {
        source
            .documents
            .into_iter()
            .map(|document| document.session)
            .collect()
    })
}

fn search_documents(directory_path: &str) -> Result<SearchSource> {
    let path = hermes_db_path()?;
    list_sessions_from_db(&path, directory_path, true)
}

fn list_sessions_from_db(
    path: &Path,
    directory_path: &str,
    include_preview: bool,
) -> Result<SearchSource> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => anyhow::bail!("Hermes Agent 会话数据库路径不是普通文件"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SearchSource::default())
        }
        Err(error) => return Err(error).context("无法检查 Hermes Agent 会话数据库"),
    }
    let connection = open_read_only(path)?;
    let session_columns = table_columns(&connection, "sessions")?;
    if !session_columns.contains("id") || !session_columns.contains("source") {
        anyhow::bail!("Hermes Agent 会话表缺少必要字段");
    }

    let title = bounded_optional_column(&session_columns, "title", TITLE_MAX_CHARS + 1);
    let cwd = bounded_optional_column(&session_columns, "cwd", MAX_HERMES_PATH_CHARS + 1);
    let repo_root =
        bounded_optional_column(&session_columns, "git_repo_root", MAX_HERMES_PATH_CHARS + 1);
    let started_at = optional_column(&session_columns, "started_at");
    let preview = if include_preview {
        first_user_message_expression(&connection)
    } else {
        "NULL".to_string()
    };
    let sql = format!(
        "select substr(id, 1, 201), {title}, {cwd}, {repo_root}, {started_at}, {preview}
         from sessions where source = 'cli'
         order by {started_at} desc limit {}",
        MAX_HERMES_SESSION_ROWS + 1
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query([])?;
    let mut source = SearchSource::default();
    let mut seen = HashSet::new();
    let mut preview_bytes = 0usize;
    let mut rows_scanned = 0usize;

    while let Some(row) = rows.next()? {
        rows_scanned += 1;
        if rows_scanned > MAX_HERMES_SESSION_ROWS {
            source.incomplete = true;
            break;
        }
        let session_id: String = row.get(0)?;
        if !valid_session_id(&session_id) || !seen.insert(session_id.clone()) {
            continue;
        }
        let cwd: Option<String> = row.get(2)?;
        let repo_root: Option<String> = row.get(3)?;
        if cwd
            .as_deref()
            .is_some_and(|path| path.chars().count() > MAX_HERMES_PATH_CHARS)
            || repo_root
                .as_deref()
                .is_some_and(|path| path.chars().count() > MAX_HERMES_PATH_CHARS)
        {
            source.incomplete = true;
            continue;
        }
        let owner_path = repo_root
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .or_else(|| cwd.as_deref().filter(|path| !path.trim().is_empty()));
        if !owner_path.is_some_and(|owner| paths_match(owner, directory_path)) {
            continue;
        }

        let raw_title: Option<String> = row.get(1)?;
        let raw_preview: Option<String> = if include_preview { row.get(5)? } else { None };
        let preview = raw_preview
            .and_then(|value| normalize_preview(&value))
            .map(|value| truncate_chars(&value, MAX_SEARCH_FIELD_CHARS));
        if let Some(value) = preview.as_ref() {
            preview_bytes = preview_bytes.saturating_add(value.len());
            if preview_bytes > MAX_HERMES_PREVIEW_BYTES {
                source.incomplete = true;
                break;
            }
        }
        let title = raw_title
            .filter(|value| !value.trim().is_empty())
            .map(|value| truncate_chars(value.trim(), TITLE_MAX_CHARS))
            .or_else(|| {
                preview
                    .as_ref()
                    .map(|value| truncate_chars(value, TITLE_MAX_CHARS))
            })
            .unwrap_or_else(|| "(Hermes Agent 会话)".to_string());
        let last_active_ms = read_timestamp_ms(row, 4)?;
        source.documents.push(SearchDocument {
            session: SessionInfo {
                tool_key: ToolKey::Hermes,
                session_id,
                title,
                alias: None,
                last_active_ms,
            },
            fields: preview.into_iter().collect(),
        });
    }
    Ok(source)
}

fn table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut statement = connection.prepare(&format!("pragma table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.filter_map(std::result::Result::ok).collect())
}

fn optional_column(columns: &HashSet<String>, name: &str) -> String {
    if columns.contains(name) {
        name.to_string()
    } else {
        "NULL".to_string()
    }
}

fn bounded_optional_column(columns: &HashSet<String>, name: &str, max_chars: usize) -> String {
    if columns.contains(name) {
        format!("substr({name}, 1, {max_chars})")
    } else {
        "NULL".to_string()
    }
}

fn first_user_message_expression(connection: &Connection) -> String {
    let Ok(columns) = table_columns(connection, "messages") else {
        return "NULL".to_string();
    };
    if !["session_id", "role", "content", "timestamp"]
        .iter()
        .all(|column| columns.contains(*column))
    {
        return "NULL".to_string();
    }
    let id_order = if columns.contains("id") {
        ", id asc"
    } else {
        ""
    };
    format!(
        "(select substr(content, 1, {MAX_HERMES_PREVIEW_CHARS}) from messages
         where messages.session_id = sessions.id and role = 'user' and content is not null
         order by timestamp asc{id_order} limit 1)"
    )
}

fn normalize_preview(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with(['[', '{']) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return crate::services::session_service::extract_text_content(&json);
        }
    }
    Some(trimmed.to_string())
}

fn read_timestamp_ms(row: &rusqlite::Row<'_>, index: usize) -> Result<Option<i64>> {
    let value = row.get_ref(index)?;
    let seconds = match value {
        rusqlite::types::ValueRef::Null => return Ok(None),
        rusqlite::types::ValueRef::Integer(value) => value as f64,
        rusqlite::types::ValueRef::Real(value) => value,
        rusqlite::types::ValueRef::Text(value) => std::str::from_utf8(value)?
            .parse::<f64>()
            .ok()
            .unwrap_or_default(),
        rusqlite::types::ValueRef::Blob(_) => return Ok(None),
    };
    if !seconds.is_finite() || seconds <= 0.0 {
        return Ok(None);
    }
    Ok(Some((seconds * 1_000.0).round() as i64))
}

pub(crate) async fn list_sessions_page(
    directory_path: String,
    cursor: Option<String>,
    limit: usize,
) -> Result<SessionPage> {
    tauri::async_runtime::spawn_blocking(move || {
        page_local(list_sessions(&directory_path)?, cursor.as_deref(), limit)
    })
    .await
    .map_err(|error| anyhow!("Hermes Agent 会话读取任务异常：{error}"))?
}

pub(crate) async fn search_index_source(directory_path: String) -> SessionSearchIndexSource {
    let result = tauri::async_runtime::spawn_blocking(move || search_documents(&directory_path))
        .await
        .map_err(|error| anyhow!("Hermes Agent 搜索索引任务异常：{error}"))
        .and_then(|source| source);
    index_source(ToolKey::Hermes, result)
}

pub(crate) async fn session_belongs_to_directory(
    directory_path: String,
    session_id: String,
) -> Result<bool> {
    if !valid_session_id(&session_id) {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(list_sessions(&directory_path)?
            .iter()
            .any(|session| session.session_id == session_id))
    })
    .await
    .map_err(|error| anyhow!("Hermes Agent 会话归属验证任务异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_db(path: &Path) -> Connection {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "create table sessions (
                    id text primary key, source text not null, title text, cwd text,
                    git_repo_root text, started_at real
                 );
                 create table messages (
                    id integer primary key, session_id text, role text, content text,
                    timestamp real
                 );",
            )
            .unwrap();
        connection
    }

    #[test]
    fn active_profile_resolution_is_bounded_and_never_enumerates_profiles() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("hermes");
        std::fs::create_dir_all(root.join("profiles").join("work")).unwrap();
        std::fs::write(root.join("active_profile"), "work\n").unwrap();
        assert_eq!(
            resolve_active_profile(&root).unwrap(),
            root.join("profiles").join("work")
        );

        std::fs::write(root.join("active_profile"), "../outside\n").unwrap();
        assert!(resolve_active_profile(&root).is_err());

        std::fs::write(root.join("active_profile"), "default\n").unwrap();
        assert_eq!(resolve_active_profile(&root).unwrap(), root);

        std::fs::write(root.join("active_profile"), [0xff, 0xfe]).unwrap();
        assert!(resolve_active_profile(&root).is_err());
    }

    #[test]
    fn reads_only_cli_sessions_for_exact_project_and_bounded_preview() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("state.db");
        let connection = create_db(&db);
        connection
            .execute(
                "insert into sessions values ('session-a','cli','Hello','C:/repo','C:/repo',10.5),
                    ('session-b','telegram','Message session','C:/repo','C:/repo',11),
                    ('session-c','cli','Prefix collision','C:/repo-other','C:/repo-other',12),
                    ('session-d','cli',null,'C:/repo','C:/repo',13)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into messages(session_id, role, content, timestamp)
                 values ('session-a','user','first prompt',1),
                        ('session-d','user','fallback title',1)",
                [],
            )
            .unwrap();
        drop(connection);

        let source = list_sessions_from_db(&db, "C:/repo", true).unwrap();
        assert_eq!(source.documents.len(), 2);
        assert_eq!(source.documents[0].session.session_id, "session-d");
        assert_eq!(source.documents[0].session.title, "fallback title");
        assert_eq!(source.documents[1].session.title, "Hello");
        assert_eq!(source.documents[1].fields, vec!["first prompt"]);
        assert!(source
            .documents
            .iter()
            .all(|document| document.session.tool_key == ToolKey::Hermes));
    }

    #[test]
    fn tolerates_optional_columns_and_missing_database_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("minimal.db");
        let connection = Connection::open(&db).unwrap();
        connection
            .execute_batch("create table sessions (id text primary key, source text not null);")
            .unwrap();
        connection
            .execute("insert into sessions values ('minimal-session','cli')", [])
            .unwrap();
        drop(connection);

        let source = list_sessions_from_db(&db, "C:/repo", true).unwrap();
        assert!(source.documents.is_empty());
        assert!(!source.incomplete);
        assert!(
            list_sessions_from_db(&temp.path().join("missing.db"), "C:/repo", true)
                .unwrap()
                .documents
                .is_empty()
        );
    }

    #[test]
    fn rejects_unsafe_session_ids_but_allows_cli_identifier_separators() {
        assert!(valid_session_id("01a0f70b-4c58-7171-b1ea-d7ec040bd888"));
        assert!(valid_session_id("agent:work:session_1"));
        assert!(!valid_session_id("../outside"));
        assert!(!valid_session_id("bad\nidentifier"));
        assert!(!valid_session_id(&"a".repeat(201)));
    }

    #[test]
    fn opens_the_live_database_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("state.db");
        drop(create_db(&db));
        let connection = open_read_only(&db).unwrap();
        assert!(connection
            .execute("insert into sessions(id, source) values ('x','cli')", [])
            .is_err());
    }

    #[test]
    fn marks_hermes_history_incomplete_when_scan_budget_is_exceeded() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("state.db");
        let connection = create_db(&db);
        connection
            .execute_batch(&format!(
                "with recursive sessions(n) as (
                    select 1 union all select n + 1 from sessions where n < {}
                 )
                 insert into sessions(id, source, cwd, git_repo_root, started_at)
                 select 'session-' || n, 'cli', 'C:/other', 'C:/other', n from sessions;",
                MAX_HERMES_SESSION_ROWS + 1
            ))
            .unwrap();
        drop(connection);

        let source = list_sessions_from_db(&db, "C:/repo", false).unwrap();
        assert!(source.documents.is_empty());
        assert!(source.incomplete);
    }
}
