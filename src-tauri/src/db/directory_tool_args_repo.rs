use rusqlite::{params, Connection, OptionalExtension};

use crate::models::directory_tool_args::DirectoryToolArgs;
use crate::models::tool::ToolKey;

pub fn get(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "select args from directory_tool_args where directory_id = ?1 and tool_key = ?2",
        params![directory_id, tool_key.as_str()],
        |row| row.get(0),
    )
    .optional()
}

pub fn list_for_directory(
    conn: &Connection,
    directory_id: i64,
) -> rusqlite::Result<Vec<DirectoryToolArgs>> {
    let mut stmt = conn.prepare(
        "select directory_id, tool_key, args from directory_tool_args where directory_id = ?1",
    )?;
    let rows = stmt.query_map(params![directory_id], |row| {
        let key_text: String = row.get("tool_key")?;
        let tool_key = ToolKey::from_key(&key_text).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                format!("unknown tool key: {key_text}").into(),
            )
        })?;
        Ok(DirectoryToolArgs {
            directory_id: row.get("directory_id")?,
            tool_key,
            args: row.get("args")?,
        })
    })?;
    rows.collect()
}

pub fn save(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
    args: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "insert into directory_tool_args (directory_id, tool_key, args) values (?1, ?2, ?3) \
         on conflict(directory_id, tool_key) do update set args = excluded.args",
        params![directory_id, tool_key.as_str(), args],
    )?;
    Ok(())
}
