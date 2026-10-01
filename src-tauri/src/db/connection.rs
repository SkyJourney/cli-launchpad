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
    (
        4,
        include_str!("../../migrations/0004_safe_launch_history.sql"),
    ),
    (
        5,
        include_str!("../../migrations/0005_application_settings.sql"),
    ),
    (6, include_str!("../../migrations/0006_execution_tasks.sql")),
    (7, include_str!("../../migrations/0007_launch_target.sql")),
    (8, include_str!("../../migrations/0008_session_aliases.sql")),
    (9, include_str!("../../migrations/0009_pty_sessions.sql")),
    (10, include_str!("../../migrations/0010_grok_build.sql")),
    (
        11,
        include_str!("../../migrations/0011_workspace_layouts.sql"),
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
#[cfg(test)]
pub fn init_database(path: &Path) -> Result<Connection> {
    let connection = open_database(path)?;
    apply_migrations(&connection)?;
    Ok(connection)
}

pub fn schema_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.pragma_query_value(None, "user_version", |row| row.get(0))
}

pub fn has_pending_migrations(connection: &Connection) -> rusqlite::Result<bool> {
    Ok(schema_version(connection)? < latest_schema_version())
}

pub fn ensure_supported_schema(connection: &Connection) -> Result<()> {
    let version = schema_version(connection)?;
    if version > latest_schema_version() {
        bail!(
            "数据库来自更新版本的应用（schema {version}），当前版本仅支持到 schema {}",
            latest_schema_version()
        );
    }
    Ok(())
}

pub fn latest_schema_version() -> i64 {
    MIGRATIONS.last().map_or(0, |migration| migration.0)
}

pub fn ensure_integrity(connection: &Connection) -> Result<()> {
    let result: String = connection.query_row("pragma quick_check", [], |row| row.get(0))?;
    if result != "ok" {
        bail!("数据库完整性检查失败：{result}");
    }
    Ok(())
}

pub(crate) fn apply_migrations(connection: &Connection) -> rusqlite::Result<()> {
    let current = schema_version(connection)?;

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
        assert_eq!(count, 4);
    }

    #[test]
    fn migrations_seed_default_close_behavior() {
        let connection = memory_db();
        let value: String = connection
            .query_row(
                "select value from application_settings where key = 'close_behavior'",
                [],
                |row| row.get(0),
            )
            .expect("read close behavior");
        assert_eq!(value, "minimize_to_tray");
    }

    #[test]
    fn migrations_create_execution_task_tables() {
        let connection = memory_db();
        let count: i64 = connection
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name in ('execution_tasks', 'execution_task_logs')",
                [],
                |row| row.get(0),
            )
            .expect("count execution task tables");
        assert_eq!(count, 2);
    }

    #[test]
    fn migrations_seed_automatic_launch_target() {
        let connection = memory_db();
        let value: String = connection
            .query_row(
                "select value from application_settings where key = 'launch_target'",
                [],
                |row| row.get(0),
            )
            .expect("read launch target");
        assert_eq!(value, "auto");
    }

    #[test]
    fn migrations_create_sparse_session_alias_table() {
        let connection = memory_db();
        let count: i64 = connection
            .query_row("select count(*) from session_aliases", [], |row| row.get(0))
            .expect("count session aliases");
        assert_eq!(count, 0);
    }

    #[test]
    fn migrations_create_pty_session_table_with_project_restriction() {
        let connection = memory_db();
        let columns: i64 = connection
            .query_row(
                "select count(*) from pragma_table_info('pty_sessions') where name in ('session_id', 'directory_id', 'tool_key', 'working_directory', 'state', 'started_at_ms', 'ended_at_ms', 'exit_code')",
                [],
                |row| row.get(0),
            )
            .expect("count PTY session columns");
        assert_eq!(columns, 8);
        let directory =
            crate::db::directory_repo::add(&connection, "test project", "C:\\Projects\\test", None)
                .expect("insert directory");
        crate::db::pty_session_repo::insert_running(
            &connection,
            "session-1",
            directory.id,
            crate::models::tool::ToolKey::Claude,
            &directory.path,
            10,
        )
        .expect("insert PTY session");
        assert!(
            crate::db::directory_repo::has_running_pty_session(&connection, directory.id)
                .expect("query active PTY")
        );
        assert!(crate::db::directory_repo::remove(&connection, directory.id).is_err());
        assert_eq!(
            crate::db::pty_session_repo::mark_running_ended(&connection, 20)
                .expect("mark stale PTY ended"),
            1
        );
        assert!(crate::db::directory_repo::remove(&connection, directory.id).is_ok());
    }

    #[test]
    fn migrations_are_idempotent() {
        let connection = memory_db();
        apply_migrations(&connection).expect("re-apply migrations");
        let count: i64 = connection
            .query_row("select count(*) from tools", [], |row| row.get(0))
            .expect("count tools");
        assert_eq!(count, 4);
    }

    #[test]
    fn workspace_layout_migration_adds_versioned_tables_without_project_foreign_keys() {
        let connection = memory_db();
        assert_eq!(schema_version(&connection).unwrap(), 11);

        let current_columns: i64 = connection
            .query_row(
                "select count(*) from pragma_table_info('workspace_state') where name in ('id', 'schema_version', 'revision', 'payload_json', 'updated_at_ms')",
                [],
                |row| row.get(0),
            )
            .expect("count current workspace columns");
        let preset_columns: i64 = connection
            .query_row(
                "select count(*) from pragma_table_info('workspace_layout_presets') where name in ('id', 'name', 'schema_version', 'payload_json', 'created_at_ms', 'updated_at_ms')",
                [],
                |row| row.get(0),
            )
            .expect("count preset columns");
        assert_eq!(current_columns, 5);
        assert_eq!(preset_columns, 6);

        let foreign_keys: i64 = connection
            .query_row(
                "select count(*) from pragma_foreign_key_list('workspace_state')",
                [],
                |row| row.get(0),
            )
            .expect("count workspace foreign keys");
        assert_eq!(foreign_keys, 0);
    }

    #[test]
    fn workspace_layout_migration_preserves_sessions_and_allows_orphaned_layout_references() {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable fk");
        for (version, sql) in &MIGRATIONS[..10] {
            connection
                .execute_batch(&format!(
                    "BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"
                ))
                .expect("apply migration before workspace layouts");
        }

        let directory = crate::db::directory_repo::add(
            &connection,
            "layout project",
            "C:\\Projects\\layout",
            None,
        )
        .expect("insert directory");
        crate::db::pty_session_repo::insert_running(
            &connection,
            "session-before-layout-migration",
            directory.id,
            crate::models::tool::ToolKey::Claude,
            &directory.path,
            10,
        )
        .expect("insert existing PTY metadata");
        apply_migrations(&connection).expect("apply workspace layout migration");

        let session_count: i64 = connection
            .query_row(
                "select count(*) from pty_sessions where session_id = 'session-before-layout-migration'",
                [],
                |row| row.get(0),
            )
            .expect("read preexisting PTY metadata");
        assert_eq!(session_count, 1);

        connection
            .execute(
                "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, 1, 0, '{}', 20)",
                [],
            )
            .expect("insert layout without directory foreign key");
        crate::db::pty_session_repo::mark_running_ended(&connection, 30)
            .expect("end preexisting PTY");
        crate::db::directory_repo::remove(&connection, directory.id)
            .expect("remove project referenced by PTY metadata");

        let layout_count: i64 = connection
            .query_row("select count(*) from workspace_state", [], |row| row.get(0))
            .expect("layout remains after project removal");
        assert_eq!(layout_count, 1);
    }

    #[test]
    fn workspace_layout_migration_enforces_preset_names_and_payload_size() {
        let connection = memory_db();
        connection
            .execute(
                "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values ('preset-1', 'Team Workspace', 1, '{}', 1, 1)",
                [],
            )
            .expect("insert first preset");
        assert!(connection
            .execute(
                "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values ('preset-2', 'team workspace', 1, '{}', 1, 1)",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values ('preset-3', '   ', 1, '{}', 1, 1)",
                [],
            )
            .is_err());

        let oversized = "x".repeat(2 * 1024 * 1024 + 1);
        assert!(connection
            .execute(
                "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values ('preset-4', 'Too Large', 1, ?1, 1, 1)",
                [&oversized],
            )
            .is_err());
    }

    #[test]
    fn grok_migration_preserves_existing_session_metadata_and_accepts_grok() {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable fk");
        for (version, sql) in &MIGRATIONS[..9] {
            connection
                .execute_batch(&format!(
                    "BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"
                ))
                .expect("apply legacy migrations");
        }

        let directory = crate::db::directory_repo::add(
            &connection,
            "existing project",
            "C:\\Projects\\existing",
            None,
        )
        .expect("insert directory");
        crate::db::session_alias_repo::save(
            &connection,
            crate::models::tool::ToolKey::Claude,
            "old-session",
            "Existing alias",
        )
        .expect("insert existing alias");
        crate::db::pty_session_repo::insert_running(
            &connection,
            "old-pty",
            directory.id,
            crate::models::tool::ToolKey::Claude,
            &directory.path,
            1,
        )
        .expect("insert existing pty");

        apply_migrations(&connection).expect("apply Grok migration");

        assert_eq!(
            crate::db::session_alias_repo::list_for_tool(
                &connection,
                crate::models::tool::ToolKey::Claude
            )
            .expect("read existing alias")
            .get("old-session")
            .map(String::as_str),
            Some("Existing alias")
        );
        assert_eq!(
            crate::db::pty_session_repo::list_for_directory(&connection, directory.id)
                .expect("read existing pty")[0]
                .session_id,
            "old-pty"
        );
        crate::db::session_alias_repo::save(
            &connection,
            crate::models::tool::ToolKey::Grok,
            "grok-session",
            "Grok alias",
        )
        .expect("insert Grok alias");
        crate::db::pty_session_repo::insert_running(
            &connection,
            "grok-pty",
            directory.id,
            crate::models::tool::ToolKey::Grok,
            &directory.path,
            2,
        )
        .expect("insert Grok pty");
    }

    #[test]
    fn corrupt_existing_database_is_rejected() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("broken.db");
        std::fs::write(&path, b"not a sqlite database").unwrap();

        assert!(init_database(&path).is_err());
    }

    #[test]
    fn database_from_future_version_is_rejected() {
        let connection = memory_db();
        connection
            .pragma_update(None, "user_version", latest_schema_version() + 1)
            .unwrap();
        assert!(ensure_supported_schema(&connection).is_err());
    }
}
