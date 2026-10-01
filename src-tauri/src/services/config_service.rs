use anyhow::Result;
use rusqlite::Connection;

use crate::db::{app_setting_repo, directory_repo};
use crate::models::config_bundle::{ConfigBundle, ExportedDirectory, CONFIG_BUNDLE_VERSION};

/// Snapshot project configuration into a bundle.
pub fn export(conn: &Connection) -> Result<ConfigBundle> {
    let directories = directory_repo::list(conn)?
        .into_iter()
        .map(|directory| ExportedDirectory {
            name: directory.name,
            path: directory.path,
            pinned: directory.pinned,
            note: directory.note,
        });
    Ok(ConfigBundle {
        version: CONFIG_BUNDLE_VERSION,
        directories: directories.collect(),
        shell_profiles: Vec::new(),
        close_behavior: Some(app_setting_repo::get_close_behavior(conn)?),
    })
}

pub fn export_json(conn: &Connection) -> Result<String> {
    Ok(serde_json::to_string_pretty(&export(conn)?)?)
}

/// Export the config bundle as JSON to a file path.
pub fn export_to_path(conn: &Connection, path: &str) -> Result<()> {
    super::file_service::replace_file(std::path::Path::new(path), export_json(conn)?.as_bytes())
}

/// Import a config bundle from a JSON file path.
pub fn read_bundle_from_path(path: &str) -> Result<ConfigBundle> {
    let json = std::fs::read_to_string(path)?;
    let bundle: ConfigBundle = serde_json::from_str(&json)?;
    if bundle.version > CONFIG_BUNDLE_VERSION {
        anyhow::bail!("配置文件来自更新版本的应用，当前版本无法安全导入");
    }
    Ok(bundle)
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

/// Add any missing directories (matched by path), and refresh pinned/note
/// values for existing directories. Legacy tool argument fields are ignored.
fn import_inner(conn: &Connection, bundle: &ConfigBundle) -> Result<()> {
    if let Some(close_behavior) = bundle.close_behavior {
        app_setting_repo::set_close_behavior(conn, close_behavior)?;
    }

    for directory in &bundle.directories {
        let path = super::directory_service::normalized_configured_path(&directory.path)?;
        match directory_repo::get_by_path(conn, &path)? {
            Some(existing) => {
                directory_repo::set_pinned_and_note(
                    conn,
                    existing.id,
                    directory.pinned,
                    directory.note.as_deref(),
                )?;
            }
            None => {
                let added =
                    directory_repo::add(conn, &directory.name, &path, directory.note.as_deref())?;
                if directory.pinned {
                    directory_repo::set_pinned(conn, added.id, true)?;
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
pub fn import_json(conn: &Connection, json: &str) -> Result<()> {
    let bundle: ConfigBundle = serde_json::from_str(json)?;
    import(conn, &bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection;
    use crate::models::app_setting::CloseBehavior;

    fn seeded_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection::apply_migrations(&conn).unwrap();
        conn
    }

    fn absolute_test_path(name: &str) -> String {
        #[cfg(windows)]
        {
            format!(r"C:\Projects\{name}")
        }
        #[cfg(not(windows))]
        {
            format!("/cli-launchpad-tests/{name}")
        }
    }

    #[test]
    fn export_import_round_trips() {
        let source = seeded_db();
        let path = absolute_test_path("demo");
        let directory = directory_repo::add(&source, "demo", &path, Some("note")).unwrap();
        directory_repo::set_pinned(&source, directory.id, true).unwrap();
        app_setting_repo::set_close_behavior(&source, CloseBehavior::Quit).unwrap();

        let json = export_json(&source).unwrap();
        assert!(json.contains("\"version\": 4"));
        assert!(!json.contains("\"toolArgs\""));
        assert!(!json.contains("\"tools\""));

        // Import into a fresh database and re-export; the bundles must match.
        let target = seeded_db();
        import_json(&target, &json).unwrap();
        let reexported = export_json(&target).unwrap();

        assert_eq!(json, reexported);
    }

    #[test]
    fn config_bundle_excludes_workspace_layouts_and_import_does_not_replace_them() {
        let db = seeded_db();
        db.execute(
            "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, 1, 4, '{\"tree\":\"current\"}', 10)",
            [],
        )
        .unwrap();
        db.execute(
            "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values ('preset-1', 'Saved Layout', 1, '{\"tree\":\"named\"}', 10, 10)",
            [],
        )
        .unwrap();

        let exported = export_json(&db).unwrap();
        let exported_value: serde_json::Value = serde_json::from_str(&exported).unwrap();
        assert!(exported_value.get("workspaceState").is_none());
        assert!(exported_value.get("workspaceLayoutPresets").is_none());

        import_json(
            &db,
            r#"{"version":4,"directories":[],"shellProfiles":[],"workspaceState":{"tree":"imported"},"workspaceLayoutPresets":[]}"#,
        )
        .unwrap();

        let current_payload: String = db
            .query_row(
                "select payload_json from workspace_state where id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let (preset_name, preset_payload): (String, String) = db
            .query_row(
                "select name, payload_json from workspace_layout_presets where id = 'preset-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(current_payload, r#"{"tree":"current"}"#);
        assert_eq!(preset_name, "Saved Layout");
        assert_eq!(preset_payload, r#"{"tree":"named"}"#);
    }

    #[test]
    fn import_is_idempotent_on_existing_paths() {
        let db = seeded_db();
        let path = absolute_test_path("demo");
        directory_repo::add(&db, "demo", &path, None).unwrap();
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
        assert_eq!(
            app_setting_repo::get_close_behavior(&db).unwrap(),
            CloseBehavior::MinimizeToTray
        );
    }

    #[test]
    fn imported_shell_execution_fields_are_ignored() {
        let db = seeded_db();
        let json = r#"{"version":2,"directories":[],"tools":[],"shellProfiles":[{"name":"bad","terminalExe":"evil.exe","shellExe":"evil.exe","shellArgs":"-Command bad","initScript":"Start-Process calc","isDefault":true,"kind":"cmd"}]}"#;
        import_json(&db, json).unwrap();
        let exported = export_json(&db).unwrap();
        assert!(exported.contains("\"shellProfiles\": []"));
    }

    #[test]
    fn imports_exported_close_behavior() {
        let db = seeded_db();
        let json = r#"{"version":4,"directories":[],"shellProfiles":[],"closeBehavior":"quit"}"#;
        import_json(&db, json).unwrap();
        assert_eq!(
            app_setting_repo::get_close_behavior(&db).unwrap(),
            CloseBehavior::Quit
        );
    }

    #[test]
    fn import_rejects_relative_directory_identity() {
        let db = seeded_db();
        let json = r#"{"version":2,"directories":[{"name":"bad","path":"relative/path","pinned":false,"note":null,"toolArgs":[{"toolKey":"claude","args":"--model x"}]}],"tools":[],"shellProfiles":[]}"#;
        assert!(import_json(&db, json).is_err());
        assert!(directory_repo::list(&db).unwrap().is_empty());
    }

    #[test]
    fn legacy_parameter_fields_are_ignored_without_deleting_saved_values() {
        let db = seeded_db();
        let path = absolute_test_path("legacy");
        let directory = directory_repo::add(&db, "legacy", &path, None).unwrap();
        db.execute(
            "update tools set global_args = ?1 where key = 'codex'",
            ["--existing-global"],
        )
        .unwrap();
        db.execute(
            "insert into directory_tool_args (directory_id, tool_key, args) values (?1, 'claude', ?2)",
            rusqlite::params![directory.id, "--existing-project"],
        )
        .unwrap();

        let legacy = format!(
            r#"{{"version":3,"directories":[{{"name":"renamed","path":"{}","pinned":false,"note":null,"toolArgs":[{{"toolKey":"claude","args":"--ignored-project"}}]}}],"tools":[{{"key":"codex","globalArgs":"--ignored-global"}}],"shellProfiles":[]}}"#,
            path.replace('\\', "\\\\")
        );
        import_json(&db, &legacy).unwrap();

        let global_args: String = db
            .query_row(
                "select global_args from tools where key = 'codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let project_args: String = db
            .query_row(
                "select args from directory_tool_args where directory_id = ?1 and tool_key = 'claude'",
                [directory.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(global_args, "--existing-global");
        assert_eq!(project_args, "--existing-project");
        let exported = export_json(&db).unwrap();
        assert!(!exported.contains("--existing-global"));
        assert!(!exported.contains("--existing-project"));
    }
}
