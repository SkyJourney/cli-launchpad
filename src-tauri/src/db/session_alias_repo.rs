use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::models::tool::ToolKey;

pub fn list_for_tool(
    connection: &Connection,
    tool_key: ToolKey,
) -> rusqlite::Result<HashMap<String, String>> {
    let mut statement =
        connection.prepare("select session_id, alias from session_aliases where tool_key = ?1")?;
    let rows = statement.query_map(params![tool_key.as_str()], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

pub fn save(
    connection: &Connection,
    tool_key: ToolKey,
    session_id: &str,
    alias: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) \
         values (?1, ?2, ?3, ?4) \
         on conflict(tool_key, session_id) do update set \
         alias = excluded.alias, updated_at_ms = excluded.updated_at_ms",
        params![tool_key.as_str(), session_id, alias, now_ms()],
    )?;
    Ok(())
}

pub fn delete(
    connection: &Connection,
    tool_key: ToolKey,
    session_id: &str,
) -> rusqlite::Result<bool> {
    Ok(connection.execute(
        "delete from session_aliases where tool_key = ?1 and session_id = ?2",
        params![tool_key.as_str(), session_id],
    )? > 0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        connection
    }

    #[test]
    fn saves_updates_lists_and_deletes_only_explicit_aliases() {
        let connection = database();

        save(&connection, ToolKey::Claude, "session-one", "部署排查").unwrap();
        save(&connection, ToolKey::Codex, "session-one", "代码审查").unwrap();
        save(&connection, ToolKey::Claude, "session-one", "部署复盘").unwrap();

        let claude_aliases = list_for_tool(&connection, ToolKey::Claude).unwrap();
        assert_eq!(
            claude_aliases.get("session-one").map(String::as_str),
            Some("部署复盘")
        );
        assert!(!claude_aliases.contains_key("never-renamed"));
        assert_eq!(claude_aliases.len(), 1);
        assert_eq!(list_for_tool(&connection, ToolKey::Codex).unwrap().len(), 1);

        assert!(delete(&connection, ToolKey::Claude, "session-one").unwrap());
        assert!(!delete(&connection, ToolKey::Claude, "session-one").unwrap());
        assert_eq!(
            list_for_tool(&connection, ToolKey::Claude).unwrap().len(),
            0
        );
        assert_eq!(
            list_for_tool(&connection, ToolKey::Codex)
                .unwrap()
                .get("session-one")
                .map(String::as_str),
            Some("代码审查")
        );
    }

    #[test]
    fn database_constraints_reject_blank_values() {
        let connection = database();

        assert!(save(&connection, ToolKey::Claude, "", "标题").is_err());
        assert!(save(&connection, ToolKey::Claude, "session", "  ").is_err());
    }
}
