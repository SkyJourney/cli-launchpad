use rusqlite::{Connection, Result};

pub fn open_database(path: &str) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(connection)
}

