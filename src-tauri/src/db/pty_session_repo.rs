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

/// Settles the `running` rows of one directory. Memory is the authority for liveness, so a row
/// still marked `running` after the in-memory table reported nothing is stale.
pub fn mark_directory_running_ended(
    connection: &Connection,
    directory_id: i64,
    ended_at_ms: i64,
) -> rusqlite::Result<usize> {
    connection.execute(
        "update pty_sessions set state = 'exited', ended_at_ms = ?2, exit_code = null where directory_id = ?1 and state = 'running'",
        params![directory_id, ended_at_ms],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connection, directory_repo};

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        connection
    }

    #[test]
    fn mark_directory_running_ended_updates_only_matching_rows() {
        let connection = database();
        let one = directory_repo::add(&connection, "one", "C:\\Projects\\one", None).unwrap();
        let two = directory_repo::add(&connection, "two", "C:\\Projects\\two", None).unwrap();
        insert_running(&connection, "a1", one.id, ToolKey::Claude, &one.path, 1).unwrap();
        insert_running(&connection, "a2", one.id, ToolKey::Claude, &one.path, 2).unwrap();
        finish(&connection, "a2", "terminated", 5, Some(1)).unwrap();
        insert_running(&connection, "b1", two.id, ToolKey::Claude, &two.path, 3).unwrap();

        assert_eq!(
            mark_directory_running_ended(&connection, one.id, 99).unwrap(),
            1
        );

        let settled = get_by_id(&connection, "a1").unwrap().unwrap();
        assert_eq!(settled.state, "exited");
        assert_eq!(settled.ended_at_ms, Some(99));
        assert_eq!(settled.exit_code, None);
        let kept = get_by_id(&connection, "a2").unwrap().unwrap();
        assert_eq!(kept.state, "terminated");
        assert_eq!(kept.ended_at_ms, Some(5));
        let other = get_by_id(&connection, "b1").unwrap().unwrap();
        assert_eq!(other.state, "running");
        assert_eq!(other.ended_at_ms, None);
        assert_eq!(
            mark_directory_running_ended(&connection, one.id, 100).unwrap(),
            0
        );
    }
}
