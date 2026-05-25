use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Result};
use rusqlite::Connection;

/// Ordered migrations. Each entry is (target user_version, sql).
/// New migrations append to this list; the runner applies any whose
/// version exceeds the database's current `user_version`.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../migrations/0001_initial.sql")),
    (2, include_str!("../../migrations/0002_shell_kind.sql")),
    (
        3,
        include_str!("../../migrations/0003_fix_antigravity_command.sql"),
    ),
];

pub fn open_database(path: &Path) -> Result<Connection> {
    let already_exists = path.is_file();
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(Duration::from_secs(5))?;
    if already_exists {
        ensure_integrity(&connection)?;
    }
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(connection)
}

/// Open the database at `path` and apply any pending migrations.
pub fn init_database(path: &Path) -> Result<Connection> {
    let connection = open_database(path)?;
    apply_migrations(&connection)?;
    Ok(connection)
}

pub fn ensure_integrity(connection: &Connection) -> Result<()> {
    let result: String = connection.query_row("pragma quick_check", [], |row| row.get(0))?;
    if result != "ok" {
        bail!("数据库完整性检查失败：{result}");
    }
    Ok(())
}

pub(crate) fn apply_migrations(connection: &Connection) -> rusqlite::Result<()> {
    let current: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;

    for (version, sql) in MIGRATIONS {
        if *version > current {
            // Apply the migration and bump user_version atomically so a crash
            // between the two cannot leave a half-migrated database. PRAGMA does
            // not support bound parameters; `version` is a trusted constant.
            connection.execute_batch(&format!(
                "BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"
            ))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable fk");
        apply_migrations(&connection).expect("apply migrations");
        connection
    }

    #[test]
    fn migrations_set_user_version() {
        let connection = memory_db();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, MIGRATIONS.last().unwrap().0);
    }

    #[test]
    fn migrations_seed_default_tools() {
        let connection = memory_db();
        let count: i64 = connection
            .query_row("select count(*) from tools", [], |row| row.get(0))
            .expect("count tools");
        assert_eq!(count, 3);
    }

    #[test]
    fn migrations_are_idempotent() {
        let connection = memory_db();
        apply_migrations(&connection).expect("re-apply migrations");
        let count: i64 = connection
            .query_row("select count(*) from tools", [], |row| row.get(0))
            .expect("count tools");
        assert_eq!(count, 3);
    }

    #[test]
    fn corrupt_existing_database_is_rejected() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("broken.db");
        std::fs::write(&path, b"not a sqlite database").unwrap();

        assert!(init_database(&path).is_err());
    }
}
