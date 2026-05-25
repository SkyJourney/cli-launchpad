use anyhow::Result;
use rusqlite::Connection;

use crate::db::{directory_repo, directory_tool_args_repo, tool_repo};
use crate::models::config_bundle::{
    ConfigBundle, ExportedDirectory, ExportedTool, ExportedToolArgs, CONFIG_BUNDLE_VERSION,
};

/// Snapshot directories (with per-tool args) and tool global args into a bundle.
pub fn export(conn: &Connection) -> Result<ConfigBundle> {
    let mut directories = Vec::new();
    for directory in directory_repo::list(conn)? {
        let tool_args = directory_tool_args_repo::list_for_directory(conn, directory.id)?
            .into_iter()
            .map(|entry| ExportedToolArgs {
                tool_key: entry.tool_key,
                args: entry.args,
            })
            .collect();
        directories.push(ExportedDirectory {
            name: directory.name,
            path: directory.path,
            pinned: directory.pinned,
            note: directory.note,
            tool_args,
        });
    }

    let tools = tool_repo::list(conn)?
        .into_iter()
        .map(|tool| ExportedTool {
            key: tool.key,
            global_args: tool.global_args,
        })
        .collect();
    Ok(ConfigBundle {
        version: CONFIG_BUNDLE_VERSION,
        directories,
        tools,
        shell_profiles: Vec::new(),
    })
}

pub fn export_json(conn: &Connection) -> Result<String> {
    Ok(serde_json::to_string_pretty(&export(conn)?)?)
}

/// Export the config bundle as JSON to a file path.
pub fn export_to_path(conn: &Connection, path: &str) -> Result<()> {
    std::fs::write(path, export_json(conn)?)?;
    Ok(())
}

/// Import a config bundle from a JSON file path.
pub fn import_from_path(conn: &Connection, path: &str) -> Result<()> {
    let json = std::fs::read_to_string(path)?;
    import_json(conn, &json)
}

/// Merge a bundle into the database within a transaction, so a mid-way failure
/// rolls back rather than leaving a half-imported state.
pub fn import(conn: &Connection, bundle: &ConfigBundle) -> Result<()> {
    if bundle.version > CONFIG_BUNDLE_VERSION {
        anyhow::bail!("配置文件来自更新版本的应用，当前版本无法安全导入");
    }
    conn.execute_batch("BEGIN")?;
    match import_inner(conn, bundle) {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Update tool global args by key, add any missing directories (matched by
/// path), and apply their per-tool args. Existing directories keep their
/// identity; pinned/note are refreshed.
fn import_inner(conn: &Connection, bundle: &ConfigBundle) -> Result<()> {
    for tool in &bundle.tools {
        tool_repo::update_global_args(conn, tool.key, &tool.global_args)?;
    }

    for directory in &bundle.directories {
        let id = match directory_repo::get_by_path(conn, &directory.path)? {
            Some(existing) => {
                directory_repo::set_pinned_and_note(
                    conn,
                    existing.id,
                    directory.pinned,
                    directory.note.as_deref(),
                )?;
                existing.id
            }
            None => {
                let added = directory_repo::add(
                    conn,
                    &directory.name,
                    &directory.path,
                    directory.note.as_deref(),
                )?;
                if directory.pinned {
                    directory_repo::set_pinned(conn, added.id, true)?;
                }
                added.id
            }
        };

        for entry in &directory.tool_args {
            directory_tool_args_repo::save(conn, id, entry.tool_key, &entry.args)?;
        }
    }

    Ok(())
}

pub fn import_json(conn: &Connection, json: &str) -> Result<()> {
    let bundle: ConfigBundle = serde_json::from_str(json)?;
    import(conn, &bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection;
    use crate::models::tool::ToolKey;

    fn seeded_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection::apply_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn export_import_round_trips() {
        let source = seeded_db();
        let directory =
            directory_repo::add(&source, "demo", "C:\\Projects\\demo", Some("note")).unwrap();
        directory_repo::set_pinned(&source, directory.id, true).unwrap();
        directory_tool_args_repo::save(&source, directory.id, ToolKey::Claude, "--model x")
            .unwrap();
        tool_repo::update_global_args(&source, ToolKey::Codex, "--global").unwrap();

        let json = export_json(&source).unwrap();

        // Import into a fresh database and re-export; the bundles must match.
        let target = seeded_db();
        import_json(&target, &json).unwrap();
        let reexported = export_json(&target).unwrap();

        assert_eq!(json, reexported);
    }

    #[test]
    fn import_is_idempotent_on_existing_paths() {
        let db = seeded_db();
        let directory = directory_repo::add(&db, "demo", "C:\\Projects\\demo", None).unwrap();
        directory_tool_args_repo::save(&db, directory.id, ToolKey::Claude, "--model x").unwrap();

        let json = export_json(&db).unwrap();
        import_json(&db, &json).unwrap();

        // Still a single directory, not duplicated.
        assert_eq!(directory_repo::list(&db).unwrap().len(), 1);
    }

    #[test]
    fn version_one_bundle_without_shell_profiles_remains_importable() {
        let db = seeded_db();
        let json = r#"{"version":1,"directories":[],"tools":[]}"#;
        import_json(&db, json).unwrap();
    }

    #[test]
    fn imported_shell_execution_fields_are_ignored() {
        let db = seeded_db();
        let json = r#"{"version":2,"directories":[],"tools":[],"shellProfiles":[{"name":"bad","terminalExe":"evil.exe","shellExe":"evil.exe","shellArgs":"-Command bad","initScript":"Start-Process calc","isDefault":true,"kind":"cmd"}]}"#;
        import_json(&db, json).unwrap();
        let exported = export_json(&db).unwrap();
        assert!(exported.contains("\"shellProfiles\": []"));
    }
}
