use std::fs;
use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;

const SCHEMA: &str = "
create table if not exists cache_entries (
  key text primary key,
  value_json text not null,
  created_at_ms integer not null
);
";

pub fn init_cache(path: &Path) -> Result<Connection> {
    match open_and_init(path) {
        Ok(connection) => Ok(connection),
        Err(_) if path.exists() => {
            let corrupt = path.with_extension("corrupt");
            let _ = fs::remove_file(&corrupt);
            remove_sqlite_sidecars(path);
            fs::rename(path, corrupt)?;
            open_and_init(path)
        }
        Err(error) => Err(error),
    }
}

fn remove_sqlite_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let sidecar = path.with_file_name(format!(
            "{}{suffix}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        let _ = fs::remove_file(sidecar);
    }
}

fn open_and_init(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn corrupt_cache_is_replaced() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("cache.db");
        fs::write(&path, "broken").unwrap();

        let connection = init_cache(&path).unwrap();
        let count: i64 = connection
            .query_row("select count(*) from cache_entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert!(path.with_extension("corrupt").is_file());
    }
}
