use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Result};
use rusqlite::Connection;

use crate::models::tool::ToolKey;

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
    (12, include_str!("../../migrations/0012_hermes_agent.sql")),
    (
        13,
        include_str!("../../migrations/0013_launch_history_details.sql"),
    ),
    (
        14,
        include_str!("../../migrations/0014_tool_key_foreign_keys.sql"),
    ),
    (15, include_str!("../../migrations/0015_legacy_cleanup.sql")),
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
    apply_migrations_to(connection, latest_schema_version())?;
    sync_tool_registry(connection)
}

/// Registers every Rust tool key in `tools`. Runs after the migrations on every open, so adding
/// a tool to `ToolKey` needs no migration file: the foreign keys that reference `tools(key)` are
/// satisfied by this sync.
fn sync_tool_registry(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("insert or ignore into tools (key) values (?1)")?;
    for tool_key in ToolKey::ALL {
        statement.execute([tool_key.as_str()])?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn apply_migrations_through(
    connection: &Connection,
    target_version: i64,
) -> rusqlite::Result<()> {
    apply_migrations_to(connection, target_version)
}

fn apply_migrations_to(connection: &Connection, target_version: i64) -> rusqlite::Result<()> {
    let current = schema_version(connection)?;

    for (version, sql) in MIGRATIONS {
        if *version > current && *version <= target_version {
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
        let mut statement = connection
            .prepare("select key from tools order by key")
            .expect("prepare seeded tools query");
        let seeded_keys: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .expect("query seeded tools")
            .collect::<rusqlite::Result<_>>()
            .expect("read seeded tool keys");
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/tool-keys.json"))
                .expect("parse ToolKey contract");
        let mut contract_keys: Vec<String> = manifest["items"]
            .as_array()
            .expect("tool keys must be an items array")
            .iter()
            .map(|key| key.as_str().expect("tool key").to_string())
            .collect();
        contract_keys.sort();
        assert_eq!(seeded_keys, contract_keys);
    }

    #[test]
    fn tool_key_enum_and_database_constraints_accept_the_same_values() {
        let connection = memory_db();
        let directory = crate::db::directory_repo::add(
            &connection,
            "tool key contract",
            "C:\\Projects\\tool-key-contract",
            None,
        )
        .expect("insert directory");

        for (index, tool_key) in crate::models::tool::ToolKey::ALL.into_iter().enumerate() {
            crate::db::session_alias_repo::save(
                &connection,
                tool_key,
                &format!("{}-session", tool_key.as_str()),
                "contract",
            )
            .expect("database should accept every Rust tool key as an alias");
            crate::db::pty_session_repo::insert_running(
                &connection,
                &format!("session-{index}"),
                directory.id,
                tool_key,
                &directory.path,
                index as i64,
            )
            .expect("database should accept every Rust tool key as a PTY identity");
        }

        assert!(connection
            .execute(
                "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) values ('unknown', 'unknown-session', 'contract', 0)",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "insert into pty_sessions (session_id, directory_id, tool_key, working_directory, state, started_at_ms) values ('unknown-session', ?1, 'unknown', ?2, 'running', 0)",
                rusqlite::params![directory.id, directory.path],
            )
            .is_err());
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
    fn migrations_remove_the_legacy_launch_target_setting() {
        let connection = memory_db();
        let rows: i64 = connection
            .query_row(
                "select count(*) from application_settings where key = 'launch_target'",
                [],
                |row| row.get(0),
            )
            .expect("count launch target rows");
        assert_eq!(rows, 0);
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
        assert_eq!(count, ToolKey::ALL.len() as i64);
    }

    /// A representative 0.2.4 (schema 8) database: projects, an alias, history and a task.
    fn legacy_schema_eight_database() -> Connection {
        let connection = Connection::open_in_memory().expect("open schema 8 database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        for (version, sql) in &MIGRATIONS[..8] {
            connection
                .execute_batch(&format!(
                    "BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"
                ))
                .expect("apply the 0.2.4 schema");
        }

        connection
            .execute(
                "insert into directories (id, name, path, sort_order, pinned, last_used_at, note) values (41, 'Existing project', 'C:\\Projects\\existing', 7, 1, '2026-09-30T12:00:00Z', 'kept note')",
                [],
            )
            .expect("seed 0.2.4 project");
        connection
            .execute(
                "update shell_profiles set name = 'Existing PowerShell', shell_exe = 'pwsh-custom.exe' where id = 1",
                [],
            )
            .expect("seed existing terminal profile");
        connection
            .execute(
                "insert into directory_tool_args (directory_id, tool_key, args) values (41, 'claude', '--legacy-project')",
                [],
            )
            .expect("seed legacy project arguments");
        connection
            .execute(
                "update application_settings set value = 'quit' where key = 'close_behavior'",
                [],
            )
            .expect("set existing desktop behavior");
        connection
            .execute(
                "update application_settings set value = 'auto' where key = 'launch_target'",
                [],
            )
            .expect("set existing launch target");
        connection
            .execute(
                "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) values ('claude', 'legacy-session', 'My session', 123)",
                [],
            )
            .expect("seed legacy session alias");
        connection
            .execute(
                "insert into launch_history (directory_id, tool_key, action, success, launched_at) values (41, 'claude', 'resume', 1, '2026-09-30 12:00:00')",
                [],
            )
            .expect("seed launch history");
        connection
            .execute(
                "insert into execution_tasks (id, tool_key, kind, source, program, args_json, preview, status, started_at_ms, finished_at_ms) values ('old-task', 'claude', 'update', 'official', 'claude', '[]', 'claude update', 'succeeded', 10, 20)",
                [],
            )
            .expect("seed execution history");
        connection
            .execute(
                "insert into execution_task_logs (task_id, sequence, stream, content, created_at_ms) values ('old-task', 1, 'stdout', 'completed', 20)",
                [],
            )
            .expect("seed execution log");
        connection
    }

    #[test]
    fn upgrades_a_representative_024_schema_eight_database_to_current_schema() {
        let connection = legacy_schema_eight_database();

        assert_eq!(schema_version(&connection).unwrap(), 8);
        apply_migrations(&connection).expect("upgrade 0.2.4 database");

        assert_eq!(schema_version(&connection).unwrap(), 15);
        let project: (String, String, i64, String) = connection
            .query_row(
                "select name, path, pinned, note from directories where id = 41",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read migrated project");
        assert_eq!(
            project,
            (
                "Existing project".to_string(),
                "C:\\Projects\\existing".to_string(),
                1,
                "kept note".to_string()
            )
        );
        assert_eq!(
            connection
                .query_row(
                    "select count(*) from sqlite_master where type = 'table' and name = 'directory_tool_args'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "select value from application_settings where key = 'close_behavior'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "quit"
        );
        assert_eq!(
            connection
                .query_row(
                    "select count(*) from application_settings where key = 'launch_target'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "select count(*) from sqlite_master where type = 'table' and name = 'shell_profiles'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            crate::db::session_alias_repo::list_for_tool(
                &connection,
                crate::models::tool::ToolKey::Claude
            )
            .unwrap()
            .get("legacy-session")
            .map(String::as_str),
            Some("My session")
        );
        assert_eq!(
            connection
                .query_row(
                    "select action, success from launch_history where directory_id = 41",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap(),
            ("resume".to_string(), 1)
        );
        assert_eq!(
            connection
                .query_row(
                    "select content from execution_task_logs where task_id = 'old-task'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "completed"
        );
        assert_eq!(
            connection
                .query_row("select count(*) from tools", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            ToolKey::ALL.len() as i64
        );
        assert_eq!(
            connection
                .query_row(
                    "select count(*) from sqlite_master where type = 'table' and name in ('workspace_state', 'workspace_layout_presets')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );

        apply_migrations(&connection).expect("re-running migrations is safe");
        assert_eq!(schema_version(&connection).unwrap(), 15);
        assert_eq!(
            connection
                .query_row("select count(*) from directories", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn tool_key_foreign_key_migration_preserves_aliases_and_pty_sessions() {
        let connection = Connection::open_in_memory().expect("open schema 13 database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        apply_migrations_through(&connection, 13).expect("create schema 13");
        let directory = crate::db::directory_repo::add(
            &connection,
            "migration fixture",
            "C:\\Projects\\migration-fixture",
            None,
        )
        .expect("insert project");
        crate::db::session_alias_repo::save(
            &connection,
            crate::models::tool::ToolKey::Hermes,
            "legacy-session",
            "legacy alias",
        )
        .expect("insert legacy alias");
        crate::db::pty_session_repo::insert_running(
            &connection,
            "legacy-pty-session",
            directory.id,
            crate::models::tool::ToolKey::Hermes,
            &directory.path,
            123,
        )
        .expect("insert legacy PTY session");

        apply_migrations(&connection).expect("upgrade to tool registry foreign keys");

        assert_eq!(schema_version(&connection).unwrap(), 15);
        assert_eq!(
            crate::db::session_alias_repo::list_for_tool(
                &connection,
                crate::models::tool::ToolKey::Hermes,
            )
            .unwrap()
            .get("legacy-session")
            .map(String::as_str),
            Some("legacy alias")
        );
        assert!(
            crate::db::pty_session_repo::get_by_id(&connection, "legacy-pty-session")
                .unwrap()
                .is_some()
        );
        let foreign_key_violations: i64 = connection
            .query_row("select count(*) from pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("check migrated foreign keys");
        assert_eq!(foreign_key_violations, 0);
        let tool_key_references: i64 = connection
            .query_row(
                "select count(*) from pragma_foreign_key_list('session_aliases') where \"from\" = 'tool_key' and \"table\" = 'tools' and \"to\" = 'key'",
                [],
                |row| row.get(0),
            )
            .expect("check alias tool key foreign key");
        assert_eq!(tool_key_references, 1);
        let pty_tool_key_references: i64 = connection
            .query_row(
                "select count(*) from pragma_foreign_key_list('pty_sessions') where \"from\" = 'tool_key' and \"table\" = 'tools' and \"to\" = 'key'",
                [],
                |row| row.get(0),
            )
            .expect("check PTY tool key foreign key");
        assert_eq!(pty_tool_key_references, 1);
        for unused_column in ["global_args", "enabled"] {
            let column_exists: i64 = connection
                .query_row(
                    "select count(*) from pragma_table_info('tools') where name = ?1",
                    [unused_column],
                    |row| row.get(0),
                )
                .expect("check cleaned tools schema");
            assert_eq!(column_exists, 0, "unused column {unused_column} remains");
        }
        let pty_index_exists: i64 = connection
            .query_row(
                "select count(*) from sqlite_master where type = 'index' and name = 'pty_sessions_directory_state_idx'",
                [],
                |row| row.get(0),
            )
            .expect("check PTY index");
        assert_eq!(pty_index_exists, 1);
        let pty_trigger_exists: i64 = connection
            .query_row(
                "select count(*) from sqlite_master where type = 'trigger' and name = 'prevent_directory_delete_with_running_pty'",
                [],
                |row| row.get(0),
            )
            .expect("check PTY directory guard");
        assert_eq!(pty_trigger_exists, 1);
        assert!(connection
            .execute("delete from directories where id = ?1", [directory.id])
            .is_err());
    }

    #[test]
    fn workspace_layout_migration_adds_versioned_tables_without_project_foreign_keys() {
        let connection = memory_db();
        assert_eq!(schema_version(&connection).unwrap(), 15);

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
    fn hermes_migration_preserves_existing_sessions_and_accepts_hermes() {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable fk");
        for (version, sql) in &MIGRATIONS[..11] {
            connection
                .execute_batch(&format!(
                    "BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"
                ))
                .expect("apply migrations through workspace layouts");
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

        apply_migrations(&connection).expect("apply Hermes migration");

        assert_eq!(schema_version(&connection).unwrap(), 15);
        assert_eq!(
            connection
                .query_row("select count(*) from tools", [], |row| row.get::<_, i64>(0))
                .expect("count tool identities"),
            ToolKey::ALL.len() as i64
        );
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
            crate::models::tool::ToolKey::Hermes,
            "hermes-session",
            "Hermes alias",
        )
        .expect("insert Hermes alias");
        crate::db::pty_session_repo::insert_running(
            &connection,
            "hermes-pty",
            directory.id,
            crate::models::tool::ToolKey::Hermes,
            &directory.path,
            2,
        )
        .expect("insert Hermes pty");
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

    fn table_columns(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("pragma table_info({table})"))
            .expect("prepare table_info");
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .collect::<rusqlite::Result<_>>()
            .expect("read column names")
    }

    fn count(connection: &Connection, sql: &str) -> i64 {
        connection
            .query_row(sql, [], |row| row.get(0))
            .expect("count rows")
    }

    fn foreign_key_violations(connection: &Connection) -> usize {
        let mut statement = connection
            .prepare("pragma foreign_key_check")
            .expect("prepare foreign_key_check");
        statement
            .query_map([], |_| Ok(()))
            .expect("run foreign_key_check")
            .count()
    }

    #[test]
    fn migration_0015_removes_the_legacy_objects_on_a_fresh_database() {
        let connection = memory_db();
        assert_eq!(
            count(
                &connection,
                "select count(*) from sqlite_master where type = 'table' and name in ('shell_profiles', 'directory_tool_args')",
            ),
            0
        );
        assert_eq!(
            count(
                &connection,
                "select count(*) from application_settings where key = 'launch_target'",
            ),
            0
        );
        assert_eq!(
            table_columns(&connection, "directories"),
            ["id", "name", "path", "sort_order", "pinned", "note"]
        );
        assert_eq!(foreign_key_violations(&connection), 0);
        // Reverse: the setting the migration keeps is still there, and the version moved.
        assert_eq!(
            count(
                &connection,
                "select count(*) from application_settings where key = 'close_behavior'",
            ),
            1
        );
        assert_eq!(schema_version(&connection).unwrap(), 15);
    }

    #[test]
    fn migration_0015_keeps_tools_as_a_tool_key_registry() {
        let connection = memory_db();
        assert_eq!(table_columns(&connection, "tools"), ["id", "key"]);

        let mut statement = connection
            .prepare("select key from tools order by key")
            .expect("prepare tools query");
        let seeded: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .expect("query tools")
            .collect::<rusqlite::Result<_>>()
            .expect("read tool keys");
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../contracts/tool-keys.json"))
                .expect("parse ToolKey contract");
        let mut contract: Vec<String> = manifest["items"]
            .as_array()
            .expect("tool keys must be an items array")
            .iter()
            .map(|key| key.as_str().expect("tool key").to_string())
            .collect();
        contract.sort();
        assert_eq!(seeded, contract);

        // Reverse: an unknown key is refused by the foreign key, a known key is accepted.
        assert!(connection
            .execute(
                "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) values ('not-a-tool', 'g2-unknown', 'x', 1)",
                [],
            )
            .is_err());
        connection
            .execute(
                "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) values ('claude', 'g2-known', 'x', 1)",
                [],
            )
            .expect("a known tool key is accepted");
    }

    #[test]
    fn a_failing_migration_0015_leaves_the_schema_14_database_untouched() {
        // PD-05: 0015 deletes data, so a failure half-way must not commit its first statements.
        let directory = tempdir().expect("temp dir");
        let path = directory.path().join("failing-0015.sqlite");
        let (tool_args_before, shell_profiles_before, launch_target_before) = {
            let connection = open_database(&path).expect("open database");
            apply_migrations_through(&connection, 14).expect("apply schema 14");
            connection
                .execute(
                    "insert into directories (id, name, path, pinned, note, last_used_at) values (7, 'Kept', 'C:\\Projects\\kept', 1, 'keep', '2026-10-01T00:00:00Z')",
                    [],
                )
                .expect("seed project");
            connection
                .execute(
                    "insert into directory_tool_args (directory_id, tool_key, args) values (7, 'claude', '--legacy')",
                    [],
                )
                .expect("seed legacy tool args");
            // 0015 drops this column after it has already dropped the legacy tables and deleted
            // the launch_target setting, so removing it first makes the migration fail half-way.
            connection
                .execute("alter table tools drop column executable", [])
                .expect("sabotage the schema");
            (
                count(&connection, "select count(*) from directory_tool_args"),
                count(&connection, "select count(*) from shell_profiles"),
                count(
                    &connection,
                    "select count(*) from application_settings where key = 'launch_target'",
                ),
            )
        };
        assert_eq!(tool_args_before, 1);
        assert!(shell_profiles_before >= 1);
        assert_eq!(launch_target_before, 1);

        {
            let connection = open_database(&path).expect("reopen the database");
            assert!(
                apply_migrations(&connection).is_err(),
                "0015 must fail on the sabotaged schema"
            );
            // The failed migration must not be committed by closing the connection.
        }

        let connection = open_database(&path).expect("reopen after the failed upgrade");
        assert_eq!(schema_version(&connection).unwrap(), 14);
        assert_eq!(
            count(&connection, "select count(*) from directory_tool_args"),
            tool_args_before
        );
        assert_eq!(
            count(&connection, "select count(*) from shell_profiles"),
            shell_profiles_before
        );
        assert_eq!(
            count(
                &connection,
                "select count(*) from application_settings where key = 'launch_target'",
            ),
            launch_target_before
        );
        assert_eq!(
            count(&connection, "select count(*) from directories where id = 7"),
            1
        );
    }

    #[test]
    fn upgrading_a_schema_14_database_removes_legacy_objects_and_keeps_project_data() {
        let connection = Connection::open_in_memory().expect("open schema 14 database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        apply_migrations_through(&connection, 14).expect("apply schema 14");
        connection
            .execute(
                "insert into directories (id, name, path, pinned, note, last_used_at) values (7, 'Kept', 'C:\\Projects\\kept', 1, 'keep', '2026-10-01T00:00:00Z')",
                [],
            )
            .expect("seed project");
        connection
            .execute(
                "insert into directory_tool_args (directory_id, tool_key, args) values (7, 'claude', '--legacy')",
                [],
            )
            .expect("seed legacy tool args");
        connection
            .execute(
                "update shell_profiles set name = 'Legacy shell' where id = 1",
                [],
            )
            .expect("touch legacy shell profile");
        connection
            .execute(
                "update application_settings set value = 'quit' where key = 'close_behavior'",
                [],
            )
            .expect("set close behavior");
        connection
            .execute(
                "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) values ('claude', 'old-session', 'Old alias', 10)",
                [],
            )
            .expect("seed alias");
        assert_eq!(schema_version(&connection).unwrap(), 14);

        apply_migrations(&connection).expect("upgrade to schema 15");
        assert_eq!(schema_version(&connection).unwrap(), 15);

        let project: (String, String, i64, String) = connection
            .query_row(
                "select name, path, pinned, note from directories where id = 7",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read kept project");
        assert_eq!(
            project,
            (
                "Kept".to_string(),
                "C:\\Projects\\kept".to_string(),
                1,
                "keep".to_string()
            )
        );
        assert_eq!(
            count(
                &connection,
                "select count(*) from application_settings where key = 'close_behavior' and value = 'quit'",
            ),
            1
        );
        let alias: String = connection
            .query_row(
                "select alias from session_aliases where session_id = 'old-session'",
                [],
                |row| row.get(0),
            )
            .expect("read alias");
        assert_eq!(alias, "Old alias");
        assert_eq!(
            count(
                &connection,
                "select count(*) from sqlite_master where type = 'table' and name in ('shell_profiles', 'directory_tool_args')",
            ),
            0
        );
        assert_eq!(
            count(
                &connection,
                "select count(*) from application_settings where key = 'launch_target'",
            ),
            0
        );
        assert_eq!(
            table_columns(&connection, "directories"),
            ["id", "name", "path", "sort_order", "pinned", "note"]
        );
        assert_eq!(foreign_key_violations(&connection), 0);

        // Reverse: running the migrations again changes nothing.
        apply_migrations(&connection).expect("re-running migrations is safe");
        assert_eq!(schema_version(&connection).unwrap(), 15);
        assert_eq!(
            count(&connection, "select count(*) from directories where id = 7"),
            1
        );
    }

    /// Asserts the four tables that reference `tools(key)` refuse `tool_key` values outside the registry.
    fn assert_tool_key_inserts(
        connection: &Connection,
        tool_key: &str,
        directory_id: i64,
    ) -> Vec<rusqlite::Result<usize>> {
        let session = format!("fk-{tool_key}");
        vec![
            connection.execute(
                "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) values (?1, ?2, 'x', 1)",
                rusqlite::params![tool_key, session],
            ),
            connection.execute(
                "insert into pty_sessions (session_id, directory_id, tool_key, working_directory, state, started_at_ms) values (?1, ?2, ?3, 'C:\\Projects\\fk', 'running', 1)",
                rusqlite::params![format!("pty-{session}"), directory_id, tool_key],
            ),
            connection.execute(
                "insert into launch_history (directory_id, tool_key, action, success, launched_at) values (?1, ?2, 'launch', 0, '2026-10-07 00:00:00')",
                rusqlite::params![directory_id, tool_key],
            ),
            connection.execute(
                "insert into execution_tasks (id, tool_key, kind, source, program, args_json, preview, status, started_at_ms) values (?1, ?2, 'update', 'official', 'x', '[]', 'x', 'running', 1)",
                rusqlite::params![format!("task-{session}"), tool_key],
            ),
        ]
    }

    fn assert_unknown_tool_key_is_rejected(connection: &Connection, directory_id: i64) {
        for result in assert_tool_key_inserts(connection, "unknown", directory_id) {
            let error = result.expect_err("an unknown tool key must be rejected");
            assert!(
                matches!(
                    error,
                    rusqlite::Error::SqliteFailure(ref failure, _)
                        if failure.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
                ),
                "{error:?}"
            );
        }
        // Reverse: the same statements with a registered key succeed.
        for result in assert_tool_key_inserts(connection, "claude", directory_id) {
            result.expect("a registered tool key is accepted");
        }
    }

    #[test]
    fn unknown_tool_keys_are_rejected_by_foreign_keys_on_fresh_and_upgraded_databases() {
        let fresh = memory_db();
        fresh
            .execute(
                "insert into directories (id, name, path) values (900, 'Fresh project', 'C:\\Projects\\fresh')",
                [],
            )
            .expect("seed fresh project");
        assert_unknown_tool_key_is_rejected(&fresh, 900);
        assert_eq!(foreign_key_violations(&fresh), 0);

        let upgraded = legacy_schema_eight_database();
        apply_migrations(&upgraded).expect("upgrade 0.2.4 database");
        assert_unknown_tool_key_is_rejected(&upgraded, 41);
        assert_eq!(foreign_key_violations(&upgraded), 0);
        assert_eq!(
            upgraded
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .expect("read foreign_keys"),
            1
        );

        // The production opener is what enables foreign keys: check the connection it returns.
        let directory = tempfile::tempdir().expect("temp dir");
        let opened = open_database(&directory.path().join("fk.db")).expect("open database");
        assert_eq!(
            opened
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .expect("read foreign_keys"),
            1
        );
    }
}
