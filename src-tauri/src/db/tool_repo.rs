use rusqlite::{params, Connection};

use crate::models::tool::ToolKey;

pub fn exists(conn: &Connection, key: ToolKey) -> rusqlite::Result<bool> {
    conn.query_row(
        "select exists(select 1 from tools where key = ?1)",
        params![key.as_str()],
        |row| row.get(0),
    )
}
