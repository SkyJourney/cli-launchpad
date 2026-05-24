use rusqlite::{params, Connection, OptionalExtension};

use crate::models::shell_profile::ShellProfile;

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ShellProfile> {
    Ok(ShellProfile {
        id: row.get("id")?,
        name: row.get("name")?,
        terminal_exe: row.get("terminal_exe")?,
        shell_exe: row.get("shell_exe")?,
        shell_args: row.get("shell_args")?,
        init_script: row.get("init_script")?,
        is_default: row.get::<_, i64>("is_default")? != 0,
        kind: row.get("kind")?,
    })
}

const SELECT: &str = "select id, name, terminal_exe, shell_exe, shell_args, init_script, is_default, kind from shell_profiles";

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<ShellProfile>> {
    let mut stmt = conn.prepare(&format!("{SELECT} order by is_default desc, id asc"))?;
    let rows = stmt.query_map([], map_row)?;
    rows.collect()
}

pub fn get_default(conn: &Connection) -> rusqlite::Result<Option<ShellProfile>> {
    conn.query_row(
        &format!("{SELECT} order by is_default desc, id asc limit 1"),
        [],
        map_row,
    )
    .optional()
}

pub fn save(conn: &Connection, profile: &ShellProfile) -> rusqlite::Result<()> {
    conn.execute(
        "update shell_profiles set name = ?2, terminal_exe = ?3, shell_exe = ?4, \
         shell_args = ?5, init_script = ?6, is_default = ?7, kind = ?8 where id = ?1",
        params![
            profile.id,
            profile.name,
            profile.terminal_exe,
            profile.shell_exe,
            profile.shell_args,
            profile.init_script,
            i64::from(profile.is_default),
            profile.kind,
        ],
    )?;
    Ok(())
}

/// Update only the launch mode of the default profile.
pub fn set_default_kind(conn: &Connection, kind: &str) -> rusqlite::Result<()> {
    conn.execute(
        "update shell_profiles set kind = ?1 where id = (select id from shell_profiles order by is_default desc, id asc limit 1)",
        params![kind],
    )?;
    Ok(())
}
