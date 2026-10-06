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
        "insert into directories (name, path, sort_order, note)
         select ?1, ?2, coalesce(max(sort_order), -1) + 1, ?3
         from directories where pinned = 0",
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

pub fn has_running_pty_session(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "select exists(select 1 from pty_sessions where directory_id = ?1 and state = 'running')",
        params![id],
        |row| row.get(0),
    )
}

pub fn set_pinned_and_note(
    conn: &Connection,
    id: i64,
    pinned: bool,
    note: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "update directories
         set pinned = ?2,
             sort_order = case when pinned != ?2
               then (select coalesce(max(sort_order), -1) + 1
                     from directories where pinned = ?2)
               else sort_order end,
             note = ?3
         where id = ?1",
        params![id, i64::from(pinned), note],
    )?;
    Ok(())
}

pub fn set_pinned(conn: &Connection, id: i64, pinned: bool) -> rusqlite::Result<()> {
    conn.execute(
        "update directories
         set pinned = ?2,
             sort_order = (select coalesce(max(sort_order), -1) + 1
                           from directories where pinned = ?2)
         where id = ?1 and pinned != ?2",
        params![id, i64::from(pinned)],
    )?;
    Ok(())
}

pub fn reorder(conn: &mut Connection, ordered_ids: &[i64]) -> rusqlite::Result<()> {
    let transaction = conn.transaction()?;
    for (sort_order, id) in ordered_ids.iter().enumerate() {
        transaction.execute(
            "update directories set sort_order = ?2 where id = ?1",
            params![id, sort_order as i64],
        )?;
    }
    transaction.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().expect("open database");
        crate::db::connection::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    #[test]
    fn reorder_persists_the_requested_directory_order() {
        let mut connection = database();
        let first = add(&connection, "first", "C:\\first", None).unwrap();
        let second = add(&connection, "second", "C:\\second", None).unwrap();
        let third = add(&connection, "third", "C:\\third", None).unwrap();

        reorder(&mut connection, &[third.id, first.id, second.id]).unwrap();

        let ordered_ids = list(&connection)
            .unwrap()
            .into_iter()
            .map(|directory| directory.id)
            .collect::<Vec<_>>();
        assert_eq!(ordered_ids, vec![third.id, first.id, second.id]);
    }

    #[test]
    fn adding_and_pin_changes_append_to_their_destination_group() {
        let connection = database();
        let first = add(&connection, "first", "C:\\first", None).unwrap();
        let second = add(&connection, "second", "C:\\second", None).unwrap();
        let third = add(&connection, "third", "C:\\third", None).unwrap();

        set_pinned(&connection, first.id, true).unwrap();
        set_pinned(&connection, second.id, true).unwrap();
        set_pinned(&connection, first.id, false).unwrap();

        let ordered = list(&connection).unwrap();
        assert_eq!(ordered[0].id, second.id);
        assert!(ordered[0].pinned);
        assert_eq!(ordered[1].id, third.id);
        assert_eq!(ordered[2].id, first.id);
        assert!(!ordered[1].pinned);
        assert!(!ordered[2].pinned);

        let fourth = add(&connection, "fourth", "C:\\fourth", None).unwrap();
        assert_eq!(list(&connection).unwrap().last().unwrap().id, fourth.id);
    }
}
