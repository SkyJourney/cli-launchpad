use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{pty_session::PtySession, tool::ToolKey};

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PtySession> {
    let key_text: String = row.get("tool_key")?;
    let tool_key = ToolKey::from_key(&key_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown tool key: {key_text}").into(),
        )
    })?;
    Ok(PtySession {
        session_id: row.get("session_id")?,
        directory_id: row.get("directory_id")?,
        tool_key,
        working_directory: row.get("working_directory")?,
        state: row.get("state")?,
        started_at_ms: row.get("started_at_ms")?,
        ended_at_ms: row.get("ended_at_ms")?,
        exit_code: row.get("exit_code")?,
    })
}

const SELECT: &str = "select session_id, directory_id, tool_key, working_directory, state, started_at_ms, ended_at_ms, exit_code from pty_sessions";

pub fn insert_running(
    connection: &Connection,
    session_id: &str,
    directory_id: i64,
    tool_key: ToolKey,
    working_directory: &str,
    started_at_ms: i64,
) -> rusqlite::Result<()> {
    connection.execute(
        "insert into pty_sessions (session_id, directory_id, tool_key, working_directory, state, started_at_ms) values (?1, ?2, ?3, ?4, 'running', ?5)",
        params![session_id, directory_id, tool_key.as_str(), working_directory, started_at_ms],
    )?;
    Ok(())
}

pub fn finish(
    connection: &Connection,
    session_id: &str,
    state: &str,
    ended_at_ms: i64,
    exit_code: Option<i64>,
) -> rusqlite::Result<()> {
    connection.execute(
        "update pty_sessions set state = ?2, ended_at_ms = ?3, exit_code = ?4 where session_id = ?1 and state = 'running'",
        params![session_id, state, ended_at_ms, exit_code],
    )?;
    Ok(())
}

#[cfg(test)]
pub fn list_for_directory(
    connection: &Connection,
    directory_id: i64,
) -> rusqlite::Result<Vec<PtySession>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT} where directory_id = ?1 order by started_at_ms desc"
    ))?;
    let rows = statement.query_map(params![directory_id], map_row)?;
    rows.collect()
}

pub fn get_by_id(
    connection: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<PtySession>> {
    connection
        .query_row(
            &format!("{SELECT} where session_id = ?1"),
            params![session_id],
            map_row,
        )
        .optional()
}

pub fn mark_running_ended(connection: &Connection, ended_at_ms: i64) -> rusqlite::Result<usize> {
    connection.execute(
        "update pty_sessions set state = 'exited', ended_at_ms = ?1, exit_code = null where state = 'running'",
        params![ended_at_ms],
    )
}
