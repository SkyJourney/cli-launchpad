use rusqlite::{params, Connection};

use crate::models::launch_history::{LaunchAction, LaunchHistoryEntry};
use crate::models::tool::ToolKey;

pub fn record(
    connection: &Connection,
    directory_id: i64,
    directory_path: Option<&str>,
    tool_key: ToolKey,
    action: LaunchAction,
    success: bool,
    error_category: Option<&str>,
    pty_session_id: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        "insert into launch_history
         (directory_id, directory_path, tool_key, action, success, error_category, pty_session_id)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            directory_id,
            directory_path,
            tool_key.as_str(),
            action.as_str(),
            i64::from(success),
            error_category,
            pty_session_id
        ],
    )?;
    prune_to_limit(connection)?;
    Ok(())
}

pub fn list_recent(connection: &Connection) -> rusqlite::Result<Vec<LaunchHistoryEntry>> {
    let limit = crate::db::app_setting_repo::get_launch_history_limit(connection)?;
    let mut statement = connection.prepare(
        "select h.id, d.name, coalesce(h.directory_path, d.path), h.tool_key, h.action,
                h.success, h.error_category, h.launched_at, h.pty_session_id
         from launch_history h join directories d on d.id = h.directory_id
         order by h.id desc limit ?1",
    )?;
    let rows = statement.query_map([limit], |row| {
        let key: String = row.get(3)?;
        let action: String = row.get(4)?;
        Ok(LaunchHistoryEntry {
            id: row.get(0)?,
            directory_name: row.get(1)?,
            directory_path: row.get(2)?,
            tool_key: ToolKey::from_key(&key).ok_or(rusqlite::Error::InvalidQuery)?,
            action: match action.as_str() {
                "launch" => LaunchAction::Launch,
                "resume" => LaunchAction::Resume,
                _ => return Err(rusqlite::Error::InvalidQuery),
            },
            success: row.get::<_, i64>(5)? != 0,
            error_category: row.get(6)?,
            launched_at: row.get(7)?,
            pty_session_id: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn prune_to_limit(connection: &Connection) -> rusqlite::Result<()> {
    let limit = crate::db::app_setting_repo::get_launch_history_limit(connection)?;
    connection.execute(
        "delete from launch_history where id not in
         (select id from launch_history order by id desc limit ?1)",
        [limit],
    )?;
    Ok(())
}

pub fn clear(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute("delete from launch_history", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{app_setting_repo, connection, directory_repo};

    fn history_db() -> (Connection, crate::models::directory::Directory) {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection::apply_migrations(&connection).unwrap();
        let directory = directory_repo::add(&connection, "demo", "C:\\demo", None).unwrap();
        (connection, directory)
    }

    #[test]
    fn history_records_details_and_can_be_cleared() {
        let (connection, directory) = history_db();
        record(
            &connection,
            directory.id,
            Some(&directory.path),
            ToolKey::Claude,
            LaunchAction::Launch,
            true,
            None,
            Some("pty-session-1"),
        )
        .unwrap();
        let entries = list_recent(&connection).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].success);
        assert_eq!(entries[0].directory_path, "C:\\demo");
        assert_eq!(entries[0].pty_session_id.as_deref(), Some("pty-session-1"));

        clear(&connection).unwrap();
        assert!(list_recent(&connection).unwrap().is_empty());
    }

    #[test]
    fn history_prunes_to_selected_retention_limit() {
        let (connection, directory) = history_db();
        app_setting_repo::set_launch_history_limit(&connection, 50).unwrap();
        for index in 0..55 {
            record(
                &connection,
                directory.id,
                Some(&directory.path),
                ToolKey::Claude,
                LaunchAction::Launch,
                true,
                None,
                Some(&format!("pty-{index}")),
            )
            .unwrap();
        }
        let entries = list_recent(&connection).unwrap();
        assert_eq!(entries.len(), 50);
        assert_eq!(
            entries.first().unwrap().pty_session_id.as_deref(),
            Some("pty-54")
        );
        assert_eq!(
            entries.last().unwrap().pty_session_id.as_deref(),
            Some("pty-5")
        );
    }
}
