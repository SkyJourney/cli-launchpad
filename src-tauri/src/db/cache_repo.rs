use rusqlite::{params, Connection, OptionalExtension};

pub fn get(
    connection: &Connection,
    key: &str,
    minimum_time_ms: Option<i64>,
) -> rusqlite::Result<Option<String>> {
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
    connection: &Connection,
    key: &str,
    value_json: &str,
    created_at_ms: i64,
) -> rusqlite::Result<()> {
    connection.execute(
        "insert into cache_entries (key, value_json, created_at_ms) values (?1, ?2, ?3) \
         on conflict(key) do update set value_json = excluded.value_json, created_at_ms = excluded.created_at_ms",
        params![key, value_json, created_at_ms],
    )?;
    Ok(())
}

pub fn remove(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("delete from cache_entries where key = ?1", params![key])?;
    Ok(())
}

pub fn clear(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute("delete from cache_entries", [])?;
    clear_session_search(connection)?;
    connection.execute_batch("vacuum")?;
    Ok(())
}

pub fn clear_session_search(connection: &Connection) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute("delete from session_search_documents", [])?;
    transaction.execute("delete from session_search_sources", [])?;
    transaction.commit()
}

pub fn remove_prefix(connection: &Connection, prefix: &str) -> rusqlite::Result<()> {
    connection.execute(
        "delete from cache_entries where key like ?1",
        params![format!("{prefix}%")],
    )?;
    Ok(())
}

pub fn stats(connection: &Connection) -> rusqlite::Result<(i64, i64, Option<i64>)> {
    connection.query_row(
        "select count(*), sum(case when key like 'sessions:%' then 1 else 0 end), max(created_at_ms) from cache_entries",
        [],
        |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get(2)?)),
    )
}
