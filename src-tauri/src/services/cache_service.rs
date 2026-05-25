use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use crate::models::cache::CacheStats;

pub fn get_fresh<T: DeserializeOwned>(
    connection: &Connection,
    key: &str,
    ttl_ms: i64,
) -> Result<Option<T>> {
    let minimum_time = now_ms()? - ttl_ms;
    let value: Option<String> = connection
        .query_row(
            "select value_json from cache_entries where key = ?1 and created_at_ms >= ?2",
            params![key, minimum_time],
            |row| row.get(0),
        )
        .optional()?;
    decode_or_remove(connection, key, value)
}

pub fn get_any<T: DeserializeOwned>(connection: &Connection, key: &str) -> Result<Option<T>> {
    let value: Option<String> = connection
        .query_row(
            "select value_json from cache_entries where key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    decode_or_remove(connection, key, value)
}

pub fn put<T: Serialize>(connection: &Connection, key: &str, value: &T) -> Result<()> {
    connection.execute(
        "insert into cache_entries (key, value_json, created_at_ms) values (?1, ?2, ?3) \
         on conflict(key) do update set value_json = excluded.value_json, created_at_ms = excluded.created_at_ms",
        params![key, serde_json::to_string(value)?, now_ms()?],
    )?;
    Ok(())
}

pub fn clear(connection: &Connection) -> Result<()> {
    connection.execute("delete from cache_entries", [])?;
    connection.execute_batch("vacuum")?;
    Ok(())
}

pub fn stats(connection: &Connection, database_path: &Path) -> Result<CacheStats> {
    let (entry_count, session_entry_count, newest_entry_at_ms) = connection.query_row(
        "select count(*), sum(case when key like 'sessions:%' then 1 else 0 end), max(created_at_ms) from cache_entries",
        [],
        |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get(2)?)),
    )?;
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
            connection.execute("delete from cache_entries where key = ?1", params![key])?;
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
}
