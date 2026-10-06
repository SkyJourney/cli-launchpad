use rusqlite::{params, Connection, OptionalExtension};

use crate::models::app_setting::CloseBehavior;

const CLOSE_BEHAVIOR_KEY: &str = "close_behavior";
const LAUNCH_HISTORY_LIMIT_KEY: &str = "launch_history_limit";
pub const DEFAULT_LAUNCH_HISTORY_LIMIT: i64 = 100;
pub const LAUNCH_HISTORY_LIMIT_OPTIONS: [i64; 4] = [50, 100, 200, 500];

pub fn get_launch_history_limit(conn: &Connection) -> rusqlite::Result<i64> {
    let value = conn
        .query_row(
            "select value from application_settings where key = ?1",
            [LAUNCH_HISTORY_LIMIT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| LAUNCH_HISTORY_LIMIT_OPTIONS.contains(value))
        .unwrap_or(DEFAULT_LAUNCH_HISTORY_LIMIT))
}

pub fn set_launch_history_limit(conn: &Connection, limit: i64) -> rusqlite::Result<()> {
    if !LAUNCH_HISTORY_LIMIT_OPTIONS.contains(&limit) {
        return Err(rusqlite::Error::InvalidParameterName(
            "unsupported launch history limit".to_string(),
        ));
    }
    conn.execute(
        "insert into application_settings (key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value",
        params![LAUNCH_HISTORY_LIMIT_KEY, limit.to_string()],
    )?;
    Ok(())
}

pub fn get_close_behavior(conn: &Connection) -> rusqlite::Result<CloseBehavior> {
    let value = conn
        .query_row(
            "select value from application_settings where key = ?1",
            [CLOSE_BEHAVIOR_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(value
        .as_deref()
        .and_then(CloseBehavior::parse)
        .unwrap_or_default())
}

pub fn set_close_behavior(
    conn: &Connection,
    close_behavior: CloseBehavior,
) -> rusqlite::Result<()> {
    conn.execute(
        "insert into application_settings (key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value",
        params![CLOSE_BEHAVIOR_KEY, close_behavior.as_str()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;

    fn settings_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!(
                "../../migrations/0005_application_settings.sql"
            ))
            .unwrap();
        connection
    }

    #[test]
    fn defaults_to_minimize_to_tray() {
        assert_eq!(
            get_close_behavior(&settings_db()).unwrap(),
            CloseBehavior::MinimizeToTray
        );
    }

    #[test]
    fn persists_updated_close_behavior() {
        let connection = settings_db();
        set_close_behavior(&connection, CloseBehavior::Quit).unwrap();
        assert_eq!(
            get_close_behavior(&connection).unwrap(),
            CloseBehavior::Quit
        );
    }

    #[test]
    fn launch_history_limit_defaults_and_persists_supported_values() {
        let connection = settings_db();
        assert_eq!(
            get_launch_history_limit(&connection).unwrap(),
            DEFAULT_LAUNCH_HISTORY_LIMIT
        );
        set_launch_history_limit(&connection, 200).unwrap();
        assert_eq!(get_launch_history_limit(&connection).unwrap(), 200);
        assert!(set_launch_history_limit(&connection, 75).is_err());
    }
}
