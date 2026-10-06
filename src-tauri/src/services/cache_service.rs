use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rusqlite::Connection;
use serde::{de::DeserializeOwned, Serialize};

use crate::models::cache::CacheStats;

pub fn get_fresh<T: DeserializeOwned>(
    connection: &Connection,
    key: &str,
    ttl_ms: i64,
) -> Result<Option<T>> {
    let minimum_time = now_ms()? - ttl_ms;
    let value = crate::db::cache_repo::get(connection, key, Some(minimum_time))?;
    decode_or_remove(connection, key, value)
}

pub fn get_any<T: DeserializeOwned>(connection: &Connection, key: &str) -> Result<Option<T>> {
    let value = crate::db::cache_repo::get(connection, key, None)?;
    decode_or_remove(connection, key, value)
}

pub fn put<T: Serialize>(connection: &Connection, key: &str, value: &T) -> Result<()> {
    crate::db::cache_repo::put(connection, key, &serde_json::to_string(value)?, now_ms()?)?;
    Ok(())
}

pub fn clear(connection: &Connection) -> Result<()> {
    crate::db::cache_repo::clear(connection)?;
    Ok(())
}

pub fn clear_session_search(connection: &Connection) -> Result<()> {
    crate::db::cache_repo::clear_session_search(connection)?;
    Ok(())
}

pub fn remove_prefix(connection: &Connection, prefix: &str) -> Result<()> {
    crate::db::cache_repo::remove_prefix(connection, prefix)?;
    Ok(())
}

pub fn remove_workspace_file_index_for_directory(
    connection: &Connection,
    directory_id: i64,
) -> Result<()> {
    // Old index keys used `workspace-file-index:{id}` without a delimiter.
    // Delete that exact legacy key, then clear only the delimited namespace;
    // the old cache format is intentionally not read or migrated.
    crate::db::cache_repo::remove(connection, &format!("workspace-file-index:{directory_id}"))?;
    remove_prefix(connection, &format!("workspace-file-index:{directory_id}:"))
}

pub fn stats(connection: &Connection, database_path: &Path) -> Result<CacheStats> {
    let (entry_count, session_entry_count, newest_entry_at_ms) =
        crate::db::cache_repo::stats(connection)?;
    Ok(CacheStats {
        size_bytes: fs::metadata(database_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        entry_count,
        session_entry_count,
        newest_entry_at_ms,
    })
}

fn now_ms() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

fn decode_or_remove<T: DeserializeOwned>(
    connection: &Connection,
    key: &str,
    value: Option<String>,
) -> Result<Option<T>> {
    let Some(json) = value else {
        return Ok(None);
    };
    match serde_json::from_str(&json) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            crate::db::cache_repo::remove(connection, key)?;
            log::warn!("invalid cache entry discarded key={key}");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::cache_connection;
    use tempfile::tempdir;

    #[test]
    fn cache_round_trip_and_clear() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        put(&connection, "status", &vec!["ok"]).unwrap();
        assert_eq!(
            get_fresh::<Vec<String>>(&connection, "status", 10_000)
                .unwrap()
                .unwrap(),
            vec!["ok"]
        );
        clear(&connection).unwrap();
        assert!(get_any::<Vec<String>>(&connection, "status")
            .unwrap()
            .is_none());
    }

    #[test]
    fn malformed_entry_is_discarded_as_cache_miss() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        connection
            .execute(
                "insert into cache_entries (key, value_json, created_at_ms) values ('broken', '{', 1)",
                [],
            )
            .unwrap();

        assert!(get_any::<Vec<String>>(&connection, "broken")
            .unwrap()
            .is_none());
        assert_eq!(stats(&connection, &path).unwrap().entry_count, 0);
    }

    #[test]
    fn restore_invalidation_removes_session_and_workspace_index_caches() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        put(&connection, "sessions:project-1", &vec!["stale"]).unwrap();
        put(&connection, "workspace-file-index:1", &vec!["stale"]).unwrap();
        put(&connection, "cli-status", &vec!["keep"]).unwrap();

        remove_prefix(&connection, "sessions:").unwrap();
        remove_prefix(&connection, "workspace-file-index:").unwrap();
        clear_session_search(&connection).unwrap();

        assert!(get_any::<Vec<String>>(&connection, "sessions:project-1")
            .unwrap()
            .is_none());
        assert!(
            get_any::<Vec<String>>(&connection, "workspace-file-index:1")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            get_any::<Vec<String>>(&connection, "cli-status")
                .unwrap()
                .unwrap(),
            vec!["keep"]
        );
    }

    #[test]
    fn removing_directory_index_cache_keeps_prefix_collision_directory() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        put(&connection, "workspace-file-index:1", &vec!["legacy"]).unwrap();
        put(&connection, "workspace-file-index:1:root", &vec!["stale"]).unwrap();
        put(&connection, "workspace-file-index:10:root", &vec!["keep"]).unwrap();

        remove_workspace_file_index_for_directory(&connection, 1).unwrap();

        assert!(
            get_any::<Vec<String>>(&connection, "workspace-file-index:1")
                .unwrap()
                .is_none()
        );
        assert!(
            get_any::<Vec<String>>(&connection, "workspace-file-index:1:root")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            get_any::<Vec<String>>(&connection, "workspace-file-index:10:root")
                .unwrap()
                .unwrap(),
            vec!["keep"]
        );
    }
}
