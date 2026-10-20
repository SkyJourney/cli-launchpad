use crate::db::tx::with_tx;
use rusqlite::TransactionBehavior;
use std::fs;
use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;

/// `user_version` of a cache file whose legacy prefix rows (`sessions:`, `workspace-file-index:`) are gone.
const LEGACY_PREFIX_CLEANUP_VERSION: i64 = 1;

const SCHEMA: &str = "
create table if not exists cache_entries (
  key text primary key,
  value_json text not null,
  created_at_ms integer not null
);

create table if not exists session_search_documents (
  directory_id integer not null,
  tool_key text not null,
  session_id text not null,
  title text not null,
  search_text text not null,
  last_active_ms integer,
  primary key (directory_id, tool_key, session_id)
);

create table if not exists session_search_sources (
  directory_id integer not null,
  tool_key text not null,
  incomplete integer not null,
  refreshed_at_ms integer not null,
  primary key (directory_id, tool_key)
);

create virtual table if not exists session_search_fts using fts5(
  search_text,
  content='session_search_documents',
  content_rowid='rowid',
  tokenize='trigram'
);

create trigger if not exists session_search_documents_ai after insert on session_search_documents begin
  insert into session_search_fts(rowid, search_text) values (new.rowid, new.search_text);
end;

create trigger if not exists session_search_documents_ad after delete on session_search_documents begin
  insert into session_search_fts(session_search_fts, rowid, search_text)
  values ('delete', old.rowid, old.search_text);
end;

create trigger if not exists session_search_documents_au after update on session_search_documents begin
  insert into session_search_fts(session_search_fts, rowid, search_text)
  values ('delete', old.rowid, old.search_text);
  insert into session_search_fts(rowid, search_text) values (new.rowid, new.search_text);
end;
";

pub fn init_cache(path: &Path) -> Result<Connection> {
    match open_and_init(path) {
        Ok(connection) => Ok(connection),
        Err(_) if path.exists() => {
            let corrupt = path.with_extension("corrupt");
            let _ = fs::remove_file(&corrupt);
            remove_sqlite_sidecars(path);
            fs::rename(path, corrupt)?;
            open_and_init(path)
        }
        Err(error) => Err(error),
    }
}

pub fn init_ephemeral_cache() -> Result<Connection> {
    let connection = Connection::open_in_memory()?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
}

fn remove_sqlite_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let sidecar = path.with_file_name(format!(
            "{}{suffix}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        let _ = fs::remove_file(sidecar);
    }
}

fn open_and_init(path: &Path) -> Result<Connection> {
    let mut connection = Connection::open(path)?;
    connection.execute_batch(SCHEMA)?;
    let result: String = connection.query_row("pragma quick_check", [], |row| row.get(0))?;
    anyhow::ensure!(result == "ok", "缓存数据库完整性检查失败：{result}");
    if let Err(error) = remove_legacy_prefix_rows_once(&mut connection) {
        // The transaction rolled back and `user_version` stays 0, so the next start retries. The cache
        // itself is intact, so the file is kept rather than quarantined as corrupt.
        log::warn!("cache legacy row cleanup skipped: {error}");
    }
    Ok(connection)
}

/// Removes the key prefixes that no code writes any more. Runs once per cache file: the row
/// delete and the `user_version` bump share one transaction, so a crash cannot leave them apart.
fn remove_legacy_prefix_rows_once(connection: &mut Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version >= LEGACY_PREFIX_CLEANUP_VERSION {
        return Ok(());
    }
    with_tx(connection, TransactionBehavior::Deferred, |transaction| {
        transaction.execute(
            "delete from cache_entries where key like 'sessions:%' or key like 'workspace-file-index:%'",
            [],
        )?;
        transaction.pragma_update(None, "user_version", LEGACY_PREFIX_CLEANUP_VERSION)?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn corrupt_cache_is_replaced() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        fs::write(&path, "broken").unwrap();

        let connection = init_cache(&path).unwrap();
        let count: i64 = connection
            .query_row("select count(*) from cache_entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert!(path.with_extension("corrupt").is_file());
    }

    fn user_version(connection: &Connection) -> i64 {
        connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    fn cache_key_count(connection: &Connection, key: &str) -> i64 {
        connection
            .query_row(
                "select count(*) from cache_entries where key = ?1",
                [key],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// A cache file as the previous release left it: the schema, no `user_version`, and legacy rows.
    fn legacy_cache_file(directory: &tempfile::TempDir) -> std::path::PathBuf {
        let path = directory.path().join("cache.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        for key in [
            "sessions:1",
            "workspace-file-index:1",
            "workspace-file-index:1:root",
            "cli-status:all",
        ] {
            connection
                .execute(
                    "insert into cache_entries (key, value_json, created_at_ms) values (?1, '\"x\"', 1)",
                    [key],
                )
                .unwrap();
        }
        path
    }

    #[test]
    fn init_cache_removes_legacy_prefix_rows_once() {
        let directory = tempdir().unwrap();
        let path = legacy_cache_file(&directory);
        {
            // Reverse baseline: before the first start the rows are there and no version is set.
            let before = Connection::open(&path).unwrap();
            assert_eq!(user_version(&before), 0);
            assert_eq!(cache_key_count(&before, "sessions:1"), 1);
            assert_eq!(cache_key_count(&before, "workspace-file-index:1"), 1);
        }

        let connection = init_cache(&path).unwrap();

        assert_eq!(cache_key_count(&connection, "sessions:1"), 0);
        assert_eq!(cache_key_count(&connection, "workspace-file-index:1"), 0);
        assert_eq!(
            cache_key_count(&connection, "workspace-file-index:1:root"),
            0
        );
        // Live keys are not touched by the cleanup.
        assert_eq!(cache_key_count(&connection, "cli-status:all"), 1);
        assert_eq!(user_version(&connection), 1);
    }

    #[test]
    fn init_cache_keeps_live_entries_when_removing_legacy_rows() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(SCHEMA).unwrap();
            for key in [
                "cli-status:claude",
                "cli-status:all",
                "latest-version:codex",
                "sessions:2",
            ] {
                connection
                    .execute(
                        "insert into cache_entries (key, value_json, created_at_ms) values (?1, '\"x\"', 1)",
                        [key],
                    )
                    .unwrap();
            }
            connection
                .execute(
                    "insert into session_search_documents (directory_id, tool_key, session_id, title, search_text, last_active_ms) values (1, 'claude', 's1', 't', 'query text', 1)",
                    [],
                )
                .unwrap();
        }

        let connection = init_cache(&path).unwrap();
        assert_eq!(cache_key_count(&connection, "cli-status:claude"), 1);
        assert_eq!(cache_key_count(&connection, "cli-status:all"), 1);
        assert_eq!(cache_key_count(&connection, "latest-version:codex"), 1);
        assert_eq!(cache_key_count(&connection, "sessions:2"), 0);
        let documents: i64 = connection
            .query_row("select count(*) from session_search_documents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(documents, 1);
        assert_eq!(user_version(&connection), 1);

        // A row written after the one-time cleanup survives the next start: the cleanup ran once.
        connection
            .execute(
                "insert into cache_entries (key, value_json, created_at_ms) values ('sessions:3', '\"x\"', 1)",
                [],
            )
            .unwrap();
        drop(connection);
        let restarted = init_cache(&path).unwrap();
        assert_eq!(cache_key_count(&restarted, "sessions:3"), 1);
        assert_eq!(user_version(&restarted), 1);
    }

    #[test]
    fn failed_legacy_row_cleanup_keeps_the_cache_file_and_retries_on_next_start() {
        let directory = tempdir().unwrap();
        let path = legacy_cache_file(&directory);
        {
            // Make the cleanup's delete fail: the trigger aborts on the first deleted row.
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "create trigger block_cleanup before delete on cache_entries begin select raise(abort, 'injected'); end;",
                )
                .unwrap();
        }

        let connection = init_cache(&path).unwrap();

        // A failed cleanup does not quarantine the file: the legacy rows and the version are unchanged.
        assert!(!path.with_extension("corrupt").exists());
        assert_eq!(cache_key_count(&connection, "sessions:1"), 1);
        assert_eq!(user_version(&connection), 0);
        drop(connection);

        // The next start, without the trigger, completes the cleanup.
        Connection::open(&path)
            .unwrap()
            .execute_batch("drop trigger block_cleanup")
            .unwrap();
        let restarted = init_cache(&path).unwrap();
        assert_eq!(cache_key_count(&restarted, "sessions:1"), 0);
        assert_eq!(user_version(&restarted), 1);
    }
}
