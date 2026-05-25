use rusqlite::{params, Connection};

use crate::models::launch_history::{LaunchAction, LaunchHistoryEntry};
use crate::models::tool::ToolKey;

pub fn record(
    connection: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
    action: LaunchAction,
    success: bool,
    error_category: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        "insert into launch_history (directory_id, tool_key, action, success, error_category) \
         values (?1, ?2, ?3, ?4, ?5)",
        params![
            directory_id,
            tool_key.as_str(),
            action.as_str(),
            i64::from(success),
            error_category
        ],
    )?;
    Ok(())
}

pub fn list_recent(connection: &Connection) -> rusqlite::Result<Vec<LaunchHistoryEntry>> {
    let mut statement = connection.prepare(
        "select h.id, d.name, h.tool_key, h.action, h.success, h.error_category, h.launched_at \
         from launch_history h join directories d on d.id = h.directory_id \
         order by h.id desc limit 50",
    )?;
    let rows = statement.query_map([], |row| {
        let key: String = row.get(2)?;
        let action: String = row.get(3)?;
        Ok(LaunchHistoryEntry {
            id: row.get(0)?,
            directory_name: row.get(1)?,
            tool_key: ToolKey::from_key(&key).ok_or(rusqlite::Error::InvalidQuery)?,
            action: match action.as_str() {
                "launch" => LaunchAction::Launch,
                "resume" => LaunchAction::Resume,
                _ => return Err(rusqlite::Error::InvalidQuery),
            },
            success: row.get::<_, i64>(4)? != 0,
            error_category: row.get(5)?,
            launched_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn clear(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute("delete from launch_history", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connection, directory_repo};

    #[test]
    fn history_records_safe_action_metadata_and_can_be_cleared() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection::apply_migrations(&connection).unwrap();
        let directory = directory_repo::add(&connection, "demo", "C:\\demo", None).unwrap();

        record(
            &connection,
            directory.id,
            ToolKey::Claude,
            LaunchAction::Launch,
            false,
            Some("launch_failed"),
        )
        .unwrap();
        let entries = list_recent(&connection).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].success);
        assert_eq!(entries[0].error_category.as_deref(), Some("launch_failed"));

        clear(&connection).unwrap();
        assert!(list_recent(&connection).unwrap().is_empty());
    }
}
