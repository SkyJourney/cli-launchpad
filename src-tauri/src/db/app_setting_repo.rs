use rusqlite::{params, Connection, OptionalExtension};

use crate::models::app_setting::CloseBehavior;

const CLOSE_BEHAVIOR_KEY: &str = "close_behavior";
const LAUNCH_TARGET_KEY: &str = "launch_target";

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

pub fn get_launch_target(conn: &Connection) -> rusqlite::Result<String> {
    Ok(conn
        .query_row(
            "select value from application_settings where key = ?1",
            [LAUNCH_TARGET_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| "auto".to_string()))
}

pub fn set_launch_target(conn: &Connection, target_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "insert into application_settings (key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value",
        params![LAUNCH_TARGET_KEY, target_id],
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
    fn launch_target_defaults_to_auto_and_persists() {
        let connection = settings_db();
        assert_eq!(get_launch_target(&connection).unwrap(), "auto");
        set_launch_target(&connection, "direct:pwsh").unwrap();
        assert_eq!(get_launch_target(&connection).unwrap(), "direct:pwsh");
    }
}
