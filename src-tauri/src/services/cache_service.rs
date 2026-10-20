use crate::util::time::checked_now_ms;
use std::fs;
use std::path::Path;

use anyhow::Result;
use serde::{de::DeserializeOwned, Serialize};

use crate::models::cache::{CacheKey, CacheStats};
use crate::runtime::CacheConn;

pub fn get_fresh<T: DeserializeOwned>(
    connection: &CacheConn<'_>,
    key: &CacheKey,
    ttl_ms: i64,
) -> Result<Option<T>> {
    let minimum_time = checked_now_ms()? - ttl_ms;
    let value = crate::db::cache_repo::get(connection, key, Some(minimum_time))?;
    decode_or_remove(connection, key, value)
}

pub fn get_any<T: DeserializeOwned>(
    connection: &CacheConn<'_>,
    key: &CacheKey,
) -> Result<Option<T>> {
    let value = crate::db::cache_repo::get(connection, key, None)?;
    decode_or_remove(connection, key, value)
}

pub fn put<T: Serialize>(connection: &CacheConn<'_>, key: &CacheKey, value: &T) -> Result<()> {
    crate::db::cache_repo::put(
        connection,
        key,
        &serde_json::to_string(value)?,
        checked_now_ms()?,
    )?;
    Ok(())
}

pub fn clear(connection: &CacheConn<'_>) -> Result<()> {
    crate::db::cache_repo::clear(connection)?;
    Ok(())
}

/// A project was removed: drop its search index rows.
pub fn invalidate_directory(connection: &CacheConn<'_>, directory_id: i64) -> Result<()> {
    crate::db::session_search_repo::remove_directory(connection, directory_id)?;
    Ok(())
}

/// The main database was replaced (backup restore): drop everything derived from project data.
pub fn invalidate_after_data_replaced(connection: &CacheConn<'_>) -> Result<()> {
    crate::db::cache_repo::clear_session_search(connection)?;
    Ok(())
}

pub fn stats(connection: &CacheConn<'_>, database_path: &Path) -> Result<CacheStats> {
    let (entry_count, newest_entry_at_ms) = crate::db::cache_repo::stats(connection)?;
    Ok(CacheStats {
        size_bytes: fs::metadata(database_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        entry_count,
        newest_entry_at_ms,
    })
}

fn decode_or_remove<T: DeserializeOwned>(
    connection: &CacheConn<'_>,
    key: &CacheKey,
    value: Option<String>,
) -> Result<Option<T>> {
    let Some(json) = value else {
        return Ok(None);
    };
    match serde_json::from_str(&json) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            crate::db::cache_repo::remove(connection, key)?;
            log::warn!("invalid cache entry discarded key={}", key.as_key());
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
        let cache = crate::runtime::CacheConn::for_test(&connection);
        put(&cache, &CacheKey::CliStatusAll, &vec!["ok"]).unwrap();
        assert_eq!(
            get_fresh::<Vec<String>>(&cache, &CacheKey::CliStatusAll, 10_000)
                .unwrap()
                .unwrap(),
            vec!["ok"]
        );
        clear(&cache).unwrap();
        assert!(get_any::<Vec<String>>(&cache, &CacheKey::CliStatusAll)
            .unwrap()
            .is_none());
    }

    #[test]
    fn malformed_entry_is_discarded_as_cache_miss() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        let cache = crate::runtime::CacheConn::for_test(&connection);
        let key = CacheKey::LatestVersion(ToolKey::Codex);
        connection
            .execute(
                "insert into cache_entries (key, value_json, created_at_ms) values (?1, '{', 1)",
                rusqlite::params![key.as_key()],
            )
            .unwrap();

        assert!(get_any::<Vec<String>>(&cache, &key).unwrap().is_none());
        assert_eq!(stats(&cache, &path).unwrap().entry_count, 0);
    }

    use crate::models::cache::CacheKey;
    use crate::models::tool::ToolKey;
    use rusqlite::Connection;
    fn index_one_document(connection: &Connection, directory_id: i64) {
        crate::db::session_search_repo::refresh(
            connection,
            directory_id,
            &[crate::models::session::SessionSearchIndexSource {
                tool_key: crate::models::tool::ToolKey::Claude,
                documents: Some(vec![crate::models::session::SessionSearchIndexDocument {
                    tool_key: crate::models::tool::ToolKey::Claude,
                    session_id: "s1".to_string(),
                    title: "query title".to_string(),
                    last_active_ms: Some(1),
                    fields: vec!["query title".to_string()],
                }]),
                incomplete: false,
            }],
        )
        .unwrap();
    }

    fn search_count(connection: &Connection, directory_id: i64) -> usize {
        crate::db::session_search_repo::search(
            connection,
            directory_id,
            "query",
            &std::collections::HashMap::new(),
        )
        .unwrap()
        .items
        .len()
    }

    #[test]
    fn cache_stats_report_entries_and_newest_time_without_a_sessions_count() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        let cache = crate::runtime::CacheConn::for_test(&connection);
        put(&cache, &CacheKey::CliStatusAll, &vec!["a"]).unwrap();
        put(&cache, &CacheKey::LatestVersion(ToolKey::Codex), &vec!["b"]).unwrap();

        let stats = stats(&cache, &path).unwrap();

        assert_eq!(stats.entry_count, 2);
        assert!(stats.newest_entry_at_ms.is_some());
        assert!(stats.size_bytes > 0);
        let value = serde_json::to_value(&stats).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["entryCount", "newestEntryAtMs", "sizeBytes"]);
        // Reverse: the removed session counter is not reported.
        assert!(value.get("sessionEntryCount").is_none());
    }

    #[test]
    fn invalidating_a_removed_directory_clears_only_its_search_rows() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        let cache = crate::runtime::CacheConn::for_test(&connection);
        index_one_document(&connection, 1);
        index_one_document(&connection, 2);
        assert_eq!(search_count(&connection, 1), 1);
        assert_eq!(search_count(&connection, 2), 1);
        put(&cache, &CacheKey::CliStatusAll, &"live").unwrap();

        invalidate_directory(&cache, 1).unwrap();

        assert_eq!(search_count(&connection, 1), 0);
        assert_eq!(search_count(&connection, 2), 1);
        // Reverse: a live status entry is not dropped together with one project.
        assert_eq!(
            get_any::<String>(&cache, &CacheKey::CliStatusAll)
                .unwrap()
                .as_deref(),
            Some("live")
        );
    }

    #[test]
    fn invalidating_after_data_replaced_clears_search_and_keeps_live_entries() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        let connection = cache_connection::init_cache(&path).unwrap();
        let cache = crate::runtime::CacheConn::for_test(&connection);
        index_one_document(&connection, 1);
        index_one_document(&connection, 2);
        put(&cache, &CacheKey::CliStatusAll, &"live-all").unwrap();
        put(
            &cache,
            &CacheKey::LatestVersion(ToolKey::Codex),
            &"live-codex",
        )
        .unwrap();
        assert_eq!(search_count(&connection, 1), 1);
        assert_eq!(search_count(&connection, 2), 1);

        invalidate_after_data_replaced(&cache).unwrap();

        assert_eq!(search_count(&connection, 1), 0);
        assert_eq!(search_count(&connection, 2), 0);
        assert_eq!(
            get_any::<String>(&cache, &CacheKey::CliStatusAll)
                .unwrap()
                .as_deref(),
            Some("live-all")
        );
        assert_eq!(
            get_any::<String>(&cache, &CacheKey::LatestVersion(ToolKey::Codex))
                .unwrap()
                .as_deref(),
            Some("live-codex")
        );
    }
}
