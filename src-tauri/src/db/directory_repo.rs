use rusqlite::{params, Connection, OptionalExtension};

use crate::models::directory::Directory;

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Directory> {
    Ok(Directory {
        id: row.get("id")?,
        name: row.get("name")?,
        path: row.get("path")?,
        sort_order: row.get("sort_order")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        last_used_at: row.get("last_used_at")?,
        note: row.get("note")?,
    })
}

const SELECT: &str =
    "select id, name, path, sort_order, pinned, last_used_at, note from directories";

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Directory>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT} order by pinned desc, sort_order asc, last_used_at desc, name asc"
    ))?;
    let rows = stmt.query_map([], map_row)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Directory>> {
    conn.query_row(&format!("{SELECT} where id = ?1"), params![id], map_row)
        .optional()
}

pub fn get_by_path(conn: &Connection, path: &str) -> rusqlite::Result<Option<Directory>> {
    conn.query_row(&format!("{SELECT} where path = ?1"), params![path], map_row)
        .optional()
}

pub fn add(
    conn: &Connection,
    name: &str,
    path: &str,
    note: Option<&str>,
) -> rusqlite::Result<Directory> {
    conn.execute(
        "insert into directories (name, path, note) values (?1, ?2, ?3)",
        params![name, path, note],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn update(conn: &Connection, id: i64, name: &str, note: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "update directories set name = ?2, note = ?3 where id = ?1",
        params![id, name, note],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("delete from directories where id = ?1", params![id])?;
    Ok(())
}

pub fn set_pinned_and_note(
    conn: &Connection,
    id: i64,
    pinned: bool,
    note: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "update directories set pinned = ?2, note = ?3 where id = ?1",
        params![id, i64::from(pinned), note],
    )?;
    Ok(())
}

pub fn set_pinned(conn: &Connection, id: i64, pinned: bool) -> rusqlite::Result<()> {
    conn.execute(
        "update directories set pinned = ?2 where id = ?1",
        params![id, i64::from(pinned)],
    )?;
    Ok(())
}

pub fn touch_last_used(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "update directories set last_used_at = datetime('now') where id = ?1",
        params![id],
    )?;
    Ok(())
}
