use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{
    pty_session::{PtySession, PtySessionState},
    tool::ToolKey,
};

fn pty_session_state(row: &rusqlite::Row<'_>) -> rusqlite::Result<PtySessionState> {
    let state_text: String = row.get("state")?;
    PtySessionState::from_db_str(&state_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown pty session state: {state_text}").into(),
        )
    })
}

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
        state: pty_session_state(row)?,
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
        "insert into pty_sessions (session_id, directory_id, tool_key, working_directory, state, started_at_ms) values (?1, ?2, ?3, ?4, ?6, ?5)",
        params![session_id, directory_id, tool_key.as_str(), working_directory, started_at_ms, PtySessionState::Running.as_str()],
    )?;
    Ok(())
}

pub fn finish(
    connection: &Connection,
    session_id: &str,
    state: PtySessionState,
    ended_at_ms: i64,
    exit_code: Option<i64>,
) -> rusqlite::Result<()> {
    connection.execute(
        "update pty_sessions set state = ?2, ended_at_ms = ?3, exit_code = ?4 where session_id = ?1 and state = ?5",
        params![session_id, state.as_str(), ended_at_ms, exit_code, PtySessionState::Running.as_str()],
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
        "update pty_sessions set state = ?1, ended_at_ms = ?2, exit_code = null where state = ?3",
        params![
            PtySessionState::Exited.as_str(),
            ended_at_ms,
            PtySessionState::Running.as_str()
        ],
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
        "update pty_sessions set state = ?1, ended_at_ms = ?2, exit_code = null where directory_id = ?3 and state = ?4",
        params![PtySessionState::Exited.as_str(), ended_at_ms, directory_id, PtySessionState::Running.as_str()],
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
        finish(&connection, "a2", PtySessionState::Terminated, 5, Some(1)).unwrap();
        insert_running(&connection, "b1", two.id, ToolKey::Claude, &two.path, 3).unwrap();

        assert_eq!(
            mark_directory_running_ended(&connection, one.id, 99).unwrap(),
            1
        );

        let settled = get_by_id(&connection, "a1").unwrap().unwrap();
        assert_eq!(settled.state, PtySessionState::Exited);
        assert_eq!(settled.ended_at_ms, Some(99));
        assert_eq!(settled.exit_code, None);
        let kept = get_by_id(&connection, "a2").unwrap().unwrap();
        assert_eq!(kept.state, PtySessionState::Terminated);
        assert_eq!(kept.ended_at_ms, Some(5));
        let other = get_by_id(&connection, "b1").unwrap().unwrap();
        assert_eq!(other.state, PtySessionState::Running);
        assert_eq!(other.ended_at_ms, None);
        assert_eq!(
            mark_directory_running_ended(&connection, one.id, 100).unwrap(),
            0
        );
    }

    #[test]
    fn state_enum_matches_the_sql_check_constraint() {
        let connection = database();
        let sql: String = connection
            .query_row(
                "select sql from sqlite_master where type = 'table' and name = 'pty_sessions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let marker = "state text not null check (state in (";
        let start = sql
            .find(marker)
            .unwrap_or_else(|| panic!("缺少 state 的 CHECK 约束：{sql}"))
            + marker.len();
        let end = start + sql[start..].find(')').unwrap();
        let mut allowed: Vec<String> = sql[start..end]
            .split(',')
            .map(|item| item.trim().trim_matches('\'').to_string())
            .collect();
        allowed.sort();
        let mut expected: Vec<String> = PtySessionState::ALL
            .iter()
            .map(|state| state.as_str().to_string())
            .collect();
        expected.sort();
        assert_eq!(allowed, expected);
        // 反向：约束恰好四个值。
        assert_eq!(allowed.len(), 4);
    }

    #[test]
    fn finish_persists_the_enum_state_and_only_from_running() {
        let connection = database();
        let directory = directory_repo::add(&connection, "one", "C:\\Projects\\one", None).unwrap();
        insert_running(
            &connection,
            "s1",
            directory.id,
            ToolKey::Claude,
            &directory.path,
            1,
        )
        .unwrap();
        finish(&connection, "s1", PtySessionState::Terminated, 5, Some(1)).unwrap();
        let settled = get_by_id(&connection, "s1").unwrap().unwrap();
        assert_eq!(settled.state, PtySessionState::Terminated);
        assert_eq!(settled.ended_at_ms, Some(5));
        assert_eq!(settled.exit_code, Some(1));

        // 反向：只有 running 的记录会被更新，第二次 finish 不改变已结束的记录。
        finish(&connection, "s1", PtySessionState::Failed, 9, None).unwrap();
        let kept = get_by_id(&connection, "s1").unwrap().unwrap();
        assert_eq!(kept.state, PtySessionState::Terminated);
        assert_eq!(kept.ended_at_ms, Some(5));

        // mark_running_ended 把另一个仍在运行的会话写成 Exited。
        insert_running(
            &connection,
            "s2",
            directory.id,
            ToolKey::Claude,
            &directory.path,
            2,
        )
        .unwrap();
        assert_eq!(mark_running_ended(&connection, 20).unwrap(), 1);
        assert_eq!(
            get_by_id(&connection, "s2").unwrap().unwrap().state,
            PtySessionState::Exited
        );
    }
}
