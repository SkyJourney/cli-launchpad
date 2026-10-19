use rusqlite::{params, OptionalExtension};

use crate::models::cache::CacheKey;
use crate::runtime::CacheConn;

pub fn get(
    connection: &CacheConn<'_>,
    key: &CacheKey,
    minimum_time_ms: Option<i64>,
) -> rusqlite::Result<Option<String>> {
    let key = key.as_key();
    match minimum_time_ms {
        Some(minimum_time_ms) => connection
            .query_row(
                "select value_json from cache_entries where key = ?1 and created_at_ms >= ?2",
                params![key, minimum_time_ms],
                |row| row.get(0),
            )
            .optional(),
        None => connection
            .query_row(
                "select value_json from cache_entries where key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional(),
    }
}

pub fn put(
    connection: &CacheConn<'_>,
    key: &CacheKey,
    value_json: &str,
    created_at_ms: i64,
) -> rusqlite::Result<()> {
    connection.execute(
        "insert into cache_entries (key, value_json, created_at_ms) values (?1, ?2, ?3) \
         on conflict(key) do update set value_json = excluded.value_json, created_at_ms = excluded.created_at_ms",
        params![key.as_key(), value_json, created_at_ms],
    )?;
    Ok(())
}

pub fn remove(connection: &CacheConn<'_>, key: &CacheKey) -> rusqlite::Result<()> {
    connection.execute(
        "delete from cache_entries where key = ?1",
        params![key.as_key()],
    )?;
    Ok(())
}

pub fn clear(connection: &CacheConn<'_>) -> rusqlite::Result<()> {
    connection.execute("delete from cache_entries", [])?;
    clear_session_search(connection)?;
    connection.execute_batch("vacuum")?;
    Ok(())
}

pub fn clear_session_search(connection: &CacheConn<'_>) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute("delete from session_search_documents", [])?;
    transaction.execute("delete from session_search_sources", [])?;
    transaction.commit()
}

/// Number of entries and the newest write time; the session counter is gone with its prefix.
pub fn stats(connection: &CacheConn<'_>) -> rusqlite::Result<(i64, Option<i64>)> {
    connection.query_row(
        "select count(*), max(created_at_ms) from cache_entries",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}
