use crate::db::tx::with_tx;
use anyhow::Result;
use rusqlite::Connection;
use rusqlite::TransactionBehavior;

use crate::db::{app_setting_repo, directory_repo};
use crate::models::app_setting::CloseBehavior;
use crate::models::backup::BackupReason;
use crate::models::config_bundle::{ConfigBundle, ExportedDirectory, CONFIG_BUNDLE_VERSION};
use crate::services::app_lifecycle::{AppLifecycle, DataReplaceKind, Operation};
use crate::services::backup_service;
use crate::services::session_service::RestoreGeneration;
use crate::services::storage_service::StoragePaths;
use crate::{AppError, Db};

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

/// Exports the configuration through the business connection. Runs on a blocking thread
/// (the command wraps it in `blocking_unbounded`).
pub fn export_with(db: &Db, path: &str) -> Result<(), AppError> {
    // The bundle is built under the connection lock; the file is written after it is released.
    let json = db.with_sync("config.export", |conn| {
        export_json(conn).map_err(|error| {
            log::error!("configuration export failed");
            AppError::from(error)
        })
    })?;
    match super::file_service::replace_file(std::path::Path::new(path), json.as_bytes()) {
        Ok(()) => {
            log::info!("configuration export completed");
            Ok(())
        }
        Err(error) => {
            log::error!("configuration export failed");
            Err(error.into())
        }
    }
}

/// Imports a configuration file: a pre-import backup and the import, under a data-replace permit.
/// Returns the imported close behavior. Runs on a blocking thread (the command wraps it in `blocking_unbounded`).
pub fn import_with(
    db: &Db,
    storage: &StoragePaths,
    lifecycle: &AppLifecycle,
    generation: &RestoreGeneration,
    path: &str,
) -> Result<CloseBehavior, AppError> {
    let bundle = read_bundle_from_path(path)?;
    // Held until the import finishes.
    let _data_replace_permit =
        lifecycle.admit(Operation::DataReplace(DataReplaceKind::ImportConfig))?;
    let close_behavior = db.with_sync("config.import", |conn| {
        backup_service::create(conn, storage, BackupReason::PreImport)?;
        match import(conn, &bundle) {
            Ok(()) => {
                log::info!("configuration import completed");
                // The directory set changed: an index refresh that captured the previous
                // generation must not write to the cache any more (m6-b1920 D2).
                generation.advance();
                Ok(app_setting_repo::get_close_behavior(conn)?)
            }
            Err(error) => {
                log::error!("configuration import failed");
                Err(error.into())
            }
        }
    })?;
    Ok(close_behavior)
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
    with_tx(conn, TransactionBehavior::Deferred, |transaction| {
        import_inner(transaction, bundle)
    })
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

    #[test]
    fn import_that_only_adds_projects_keeps_every_content_window_grant() {
        use crate::services::content_window_grants::{
            test_support::RecordingReclaimer, ContentWindowFileGrant, ContentWindowGrantRegistry,
            ContentWindowRevoker, RevocationReason,
        };
        let conn = seeded_db();
        let path = absolute_test_path("demo");
        let demo = directory_repo::add(&conn, "demo", &path, None).unwrap();
        let mut bundle = export(&conn).unwrap();
        bundle.directories[0].note = Some("changed".to_string());
        bundle.directories.push(ExportedDirectory {
            name: "extra".to_string(),
            path: absolute_test_path("extra"),
            pinned: false,
            note: None,
        });
        import(&conn, &bundle).unwrap();
        let db = Db::new(conn);
        let grants = ContentWindowGrantRegistry::default();
        grants
            .grant(
                "workspace-content-8e783338-f464-4b10-b15e-b534748c6241",
                ContentWindowFileGrant {
                    directory_id: demo.id,
                    directory_path: path.clone(),
                    relative_path: "a.txt".to_string(),
                },
            )
            .unwrap();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&grants, &reclaimer, RevocationReason::ImportConfig);

        let report = revoker.revoke_stale_for_database(&db).unwrap();

        assert!(report.revoked.is_empty());
        assert!(reclaimer.reclaimed().is_empty());
        assert_eq!(grants.snapshot().unwrap().len(), 1);
        // 反向基线：导入确实生效，测试不是空转。
        let conn = db.lock_for_test();
        assert_eq!(directory_repo::list(&conn).unwrap().len(), 2);
        assert_eq!(
            directory_repo::get(&conn, demo.id)
                .unwrap()
                .unwrap()
                .note
                .as_deref(),
            Some("changed")
        );
    }

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

    /// A storage root and a business database holding one directory.
    fn import_scenario() -> (tempfile::TempDir, StoragePaths, Db, AppLifecycle) {
        let root = tempfile::tempdir().unwrap();
        let storage = StoragePaths::from_root(root.path().join(".cli-launchpad"));
        storage.create_directories().unwrap();
        let connection = connection::init_database(&storage.database_path).unwrap();
        directory_repo::add(
            &connection,
            "existing",
            &absolute_test_path("existing"),
            None,
        )
        .unwrap();
        let lifecycle = AppLifecycle::with_counters(
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        );
        (root, storage, Db::new(connection), lifecycle)
    }

    fn write_bundle(root: &tempfile::TempDir, directory_path: &str) -> String {
        let source = seeded_db();
        directory_repo::add(&source, "imported", directory_path, None).unwrap();
        let path = root.path().join("bundle.json");
        std::fs::write(&path, export_json(&source).unwrap()).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn import_advances_the_generation_and_discards_an_in_flight_index_refresh() {
        use crate::services::session_service::{write_search_index_if_current, IndexWriteOutcome};

        let (root, storage, db, lifecycle) = import_scenario();
        let generation = RestoreGeneration::default();
        let g0 = generation.current();
        let bundle = write_bundle(&root, &absolute_test_path("imported"));

        import_with(&db, &storage, &lifecycle, &generation, &bundle).unwrap();

        assert_eq!(generation.current(), g0 + 1);
        let cache = crate::CacheDb::new(
            crate::db::cache_connection::init_cache(&root.path().join("cache.db")).unwrap(),
        );
        let connection = cache.lock_for_test();
        let stale = write_search_index_if_current(&connection, &generation, g0, 1, &[]).unwrap();
        assert!(matches!(stale, IndexWriteOutcome::Discarded));
        // Reverse: a refresh that starts after the import carries the new generation.
        let fresh =
            write_search_index_if_current(&connection, &generation, generation.current(), 1, &[])
                .unwrap();
        assert!(matches!(fresh, IndexWriteOutcome::Written(_)));
    }

    #[test]
    fn a_failed_import_keeps_the_generation_and_an_in_flight_refresh_valid() {
        use crate::services::session_service::{write_search_index_if_current, IndexWriteOutcome};

        let (root, storage, db, lifecycle) = import_scenario();
        let generation = RestoreGeneration::default();
        let g0 = generation.current();
        // A relative directory identity makes the import fail and roll back.
        let bundle = write_bundle(&root, "relative/path");

        let error = import_with(&db, &storage, &lifecycle, &generation, &bundle)
            .expect_err("a relative directory identity must be rejected");

        // The pre-import backup was taken, so the failure came from the import itself.
        assert_eq!(backup_service::list(&storage).unwrap().len(), 1, "{error}");
        // Rolled back: the database still holds only the directory it started with.
        let names: Vec<String> = directory_repo::list(&db.lock_for_test())
            .unwrap()
            .into_iter()
            .map(|directory| directory.name)
            .collect();
        assert_eq!(names, vec!["existing".to_string()]);
        assert_eq!(generation.current(), g0);
        let cache = crate::CacheDb::new(
            crate::db::cache_connection::init_cache(&root.path().join("cache.db")).unwrap(),
        );
        let connection = cache.lock_for_test();
        let outcome = write_search_index_if_current(&connection, &generation, g0, 1, &[]).unwrap();
        assert!(matches!(outcome, IndexWriteOutcome::Written(_)));
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
        assert!(!exported.contains("shellProfiles"));
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
    fn legacy_parameter_fields_in_old_bundles_are_ignored() {
        let db = seeded_db();
        let path = absolute_test_path("legacy");
        directory_repo::add(&db, "legacy", &path, None).unwrap();

        let legacy = format!(
            r#"{{"version":3,"directories":[{{"name":"renamed","path":"{}","pinned":false,"note":null,"toolArgs":[{{"toolKey":"claude","args":"--ignored-project"}}]}}],"tools":[{{"key":"codex","globalArgs":"--ignored-global"}}],"shellProfiles":[]}}"#,
            path.replace('\\', "\\\\")
        );
        import_json(&db, &legacy).unwrap();

        // The import matches the existing project by path and does not add a second one.
        let projects: i64 = db
            .query_row(
                "select count(*) from directories where path = ?1",
                [&path],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(projects, 1);
        let exported = export_json(&db).unwrap();
        assert!(!exported.contains("--ignored-global"));
        assert!(!exported.contains("--ignored-project"));
        // Reverse: the legacy table is not recreated by the import.
        let legacy_tables: i64 = db
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name = 'directory_tool_args'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_tables, 0);
    }

    #[test]
    fn version_one_to_three_bundles_with_legacy_fields_remain_importable() {
        let db = seeded_db();
        let v1 = serde_json::json!({ "version": 1, "directories": [], "tools": [] }).to_string();
        let v2 = serde_json::json!({
            "version": 2,
            "directories": [],
            "tools": [],
            "shellProfiles": [{
                "name": "old",
                "terminalExe": "wt.exe",
                "shellExe": "pwsh.exe",
                "shellArgs": "-NoLogo",
                "initScript": "",
                "isDefault": true,
                "kind": "wt-pwsh"
            }]
        })
        .to_string();
        let v3 = serde_json::json!({
            "version": 3,
            "directories": [{
                "name": "d",
                "path": absolute_test_path("legacy-v3"),
                "pinned": false,
                "note": null,
                "toolArgs": [{ "toolKey": "claude", "args": "--ignored" }]
            }],
            "tools": [{ "key": "codex", "globalArgs": "--ignored-global" }],
            "shellProfiles": []
        })
        .to_string();
        for json in [&v1, &v2, &v3] {
            import_json(&db, json).unwrap();
        }
        assert!(crate::db::directory_repo::list(&db)
            .unwrap()
            .iter()
            .any(|directory| directory.name == "d"));
        let exported = export_json(&db).unwrap();
        assert!(!exported.contains("--ignored"));
        assert!(!exported.contains("--ignored-global"));
        // Reverse: the import neither recreates nor writes the legacy table.
        let legacy_tables: i64 = db
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name = 'directory_tool_args'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_tables, 0);
    }

    #[test]
    fn exported_bundles_do_not_contain_shell_profiles() {
        let db = seeded_db();
        db.execute(
            "insert into directories (id, name, path) values (50, 'Exported', ?1)",
            [absolute_test_path("exported")],
        )
        .unwrap();
        let exported = export_json(&db).unwrap();
        assert!(!exported.contains("shellProfiles"));
        let value: serde_json::Value = serde_json::from_str(&exported).unwrap();
        let object = value.as_object().expect("bundle is an object");
        for key in object.keys() {
            assert!(
                ["closeBehavior", "directories", "version"].contains(&key.as_str()),
                "unexpected key {key}"
            );
        }
        assert_eq!(value["version"], 4);
        // Reverse: the exported bundle imports back.
        import_json(&db, &exported).unwrap();
    }
}
