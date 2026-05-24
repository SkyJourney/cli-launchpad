use rusqlite::{params, Connection, OptionalExtension};

use crate::models::tool::{Tool, ToolKey};

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Tool> {
    let key_text: String = row.get("key")?;
    let key = ToolKey::from_key(&key_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown tool key: {key_text}").into(),
        )
    })?;
    Ok(Tool {
        id: row.get("id")?,
        key,
        display_name: row.get("display_name")?,
        executable: row.get("executable")?,
        global_args: row.get("global_args")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
    })
}

const SELECT: &str = "select id, key, display_name, executable, global_args, enabled from tools";

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Tool>> {
    let mut stmt = conn.prepare(&format!("{SELECT} order by id asc"))?;
    let rows = stmt.query_map([], map_row)?;
    rows.collect()
}

pub fn get_by_key(conn: &Connection, key: ToolKey) -> rusqlite::Result<Option<Tool>> {
    conn.query_row(
        &format!("{SELECT} where key = ?1"),
        params![key.as_str()],
        map_row,
    )
    .optional()
}
