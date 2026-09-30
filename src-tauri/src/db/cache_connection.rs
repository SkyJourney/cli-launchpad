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

create table if not exists session_search_documents (
  directory_id integer not null,
  tool_key text not null,
  session_id text not null,
  title text not null,
  search_text text not null,
  last_active_ms integer,
  primary key (directory_id, tool_key, session_id)
);

create table if not exists session_search_sources (
  directory_id integer not null,
  tool_key text not null,
  incomplete integer not null,
  refreshed_at_ms integer not null,
  primary key (directory_id, tool_key)
);

create virtual table if not exists session_search_fts using fts5(
  search_text,
  content='session_search_documents',
  content_rowid='rowid',
  tokenize='trigram'
);

create trigger if not exists session_search_documents_ai after insert on session_search_documents begin
  insert into session_search_fts(rowid, search_text) values (new.rowid, new.search_text);
end;

create trigger if not exists session_search_documents_ad after delete on session_search_documents begin
  insert into session_search_fts(session_search_fts, rowid, search_text)
  values ('delete', old.rowid, old.search_text);
end;

create trigger if not exists session_search_documents_au after update on session_search_documents begin
  insert into session_search_fts(session_search_fts, rowid, search_text)
  values ('delete', old.rowid, old.search_text);
  insert into session_search_fts(rowid, search_text) values (new.rowid, new.search_text);
end;
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

pub fn init_ephemeral_cache() -> Result<Connection> {
    let connection = Connection::open_in_memory()?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
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
    let result: String = connection.query_row("pragma quick_check", [], |row| row.get(0))?;
    anyhow::ensure!(result == "ok", "缓存数据库完整性检查失败：{result}");
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
