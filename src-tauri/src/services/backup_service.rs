use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use rusqlite::{backup::Backup, Connection, DatabaseName, OpenFlags};

use crate::db::connection;
use crate::models::backup::{BackupManifest, BackupReason};

use super::storage_service::StoragePaths;

const MAX_AUTOMATIC_BACKUPS: usize = 10;
const MAX_MANUAL_BACKUPS: usize = 5;

pub fn list(paths: &StoragePaths) -> Result<Vec<BackupManifest>> {
    let mut manifests = Vec::new();
    for entry in fs::read_dir(&paths.backup_manifests_dir)? {
        let path = entry?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let json = fs::read_to_string(&path)?;
        if let Ok(manifest) = serde_json::from_str::<BackupManifest>(&json) {
            if !valid_manifest(&manifest) {
                log::warn!("invalid backup manifest ignored");
                continue;
            }
            if backup_path(paths, &manifest).is_file() {
                manifests.push(manifest);
            }
        }
    }
    manifests.sort_by_key(|manifest| std::cmp::Reverse(manifest.created_at_ms));
    Ok(manifests)
}

pub fn create(
    connection: &Connection,
    paths: &StoragePaths,
    reason: BackupReason,
) -> Result<BackupManifest> {
    create_protecting(connection, paths, reason, None)
}

fn create_protecting(
    connection: &Connection,
    paths: &StoragePaths,
    reason: BackupReason,
    protected_id: Option<&str>,
) -> Result<BackupManifest> {
    let (created_at_ms, unique_timestamp) = timestamps()?;
    let id = format!("{unique_timestamp}-{}", reason.as_str());
    let filename = format!("cli-launchpad-{id}.db");
    let database_path = paths.backup_database_dir.join(&filename);
    let temporary_path = database_path.with_extension("db.tmp");

    if temporary_path.exists() {
        fs::remove_file(&temporary_path)?;
    }
    connection
        .backup(DatabaseName::Main, &temporary_path, None)
        .context("无法生成数据库备份")?;
    validate_database(&temporary_path)?;
    sync_file(&temporary_path)?;
    fs::rename(&temporary_path, &database_path)?;

    let schema_version = connection::schema_version(connection)?;
    let manifest = BackupManifest {
        id,
        created_at_ms,
        reason,
        schema_version,
        database_filename: filename,
        size_bytes: fs::metadata(&database_path)?.len(),
    };
    write_manifest(paths, &manifest)?;
    prune(paths, protected_id)?;
    log::info!("database backup created reason={}", reason.as_str());
    Ok(manifest)
}

pub fn restore(
    destination: &mut Connection,
    paths: &StoragePaths,
    backup_id: &str,
) -> Result<BackupManifest> {
    let manifest = list(paths)?
        .into_iter()
        .find(|entry| entry.id == backup_id)
        .ok_or_else(|| anyhow!("未找到指定备份"))?;
    let database_path = backup_path(paths, &manifest);
    validate_database(&database_path)?;
    if manifest.schema_version > connection::latest_schema_version() {
        return Err(anyhow!("备份来自更新版本的应用，当前版本不能安全恢复"));
    }

    let guard = create_protecting(
        destination,
        paths,
        BackupReason::PreRestore,
        Some(&manifest.id),
    )?;
    if !database_path.is_file() {
        return Err(anyhow!("待恢复备份已不存在"));
    }
    let source = open_read_only(&database_path)?;
    connection::ensure_integrity(&source)?;
    let source_schema = connection::schema_version(&source)?;
    if source_schema > connection::latest_schema_version() {
        return Err(anyhow!(
            "备份数据库来自更新版本的应用，当前版本不能安全恢复"
        ));
    }
    let result = (|| -> Result<()> {
        copy_database(&source, destination)?;
        connection::apply_migrations(destination)?;
        connection::ensure_integrity(destination)?;
        Ok(())
    })();
    if let Err(error) = result {
        let guard_source = open_read_only(&backup_path(paths, &guard))?;
        copy_database(&guard_source, destination).context("恢复失败且无法还原保护备份")?;
        return Err(error.context("恢复数据未完成，已还原恢复前状态"));
    }
    log::info!("database backup restored backup_id={}", manifest.id);
    Ok(manifest)
}

fn validate_database(path: &Path) -> Result<()> {
    let connection = open_read_only(path)?;
    connection::ensure_integrity(&connection)
}

fn open_read_only(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}

fn copy_database(source: &Connection, destination: &mut Connection) -> Result<()> {
    let restore = Backup::new(source, destination)?;
    restore.run_to_completion(64, Duration::from_millis(10), None)?;
    drop(restore);
    Ok(())
}

fn backup_path(paths: &StoragePaths, manifest: &BackupManifest) -> PathBuf {
    paths.backup_database_dir.join(&manifest.database_filename)
}

fn valid_manifest(manifest: &BackupManifest) -> bool {
    let valid_id = !manifest.id.is_empty()
        && manifest
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    valid_id
        && manifest.database_filename == format!("cli-launchpad-{}.db", manifest.id)
        && Path::new(&manifest.database_filename)
            .file_name()
            .is_some_and(|name| name == manifest.database_filename.as_str())
}

fn write_manifest(paths: &StoragePaths, manifest: &BackupManifest) -> Result<()> {
    let path = paths
        .backup_manifests_dir
        .join(format!("{}.json", manifest.id));
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(manifest)?)?;
    sync_file(&temporary)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn sync_file(path: &Path) -> Result<()> {
    OpenOptions::new().write(true).open(path)?.sync_all()?;
    Ok(())
}

fn timestamps() -> Result<(i64, u128)> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
    Ok((i64::try_from(elapsed.as_millis())?, elapsed.as_nanos()))
}

fn prune(paths: &StoragePaths, protected_id: Option<&str>) -> Result<()> {
    let manifests = list(paths)?;
    let mut manual = 0;
    let mut automatic = 0;
    for manifest in manifests {
        if protected_id == Some(manifest.id.as_str()) {
            continue;
        }
        let should_delete = match manifest.reason {
            BackupReason::Manual => {
                manual += 1;
                manual > MAX_MANUAL_BACKUPS
            }
            _ => {
                automatic += 1;
                automatic > MAX_AUTOMATIC_BACKUPS
            }
        };
        if should_delete {
            let _ = fs::remove_file(backup_path(paths, &manifest));
            let _ = fs::remove_file(
                paths
                    .backup_manifests_dir
                    .join(format!("{}.json", manifest.id)),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connection, directory_repo};
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, StoragePaths, Connection) {
        let directory = tempdir().unwrap();
        let paths = StoragePaths::from_root(directory.path().join(".cli-launchpad"));
        paths.create_directories().unwrap();
        let connection = connection::init_database(&paths.database_path).unwrap();
        (directory, paths, connection)
    }

    #[test]
    fn backup_is_listed_and_contains_current_data() {
        let (_directory, paths, connection) = setup();
        directory_repo::add(&connection, "demo", "C:\\demo", None).unwrap();

        let created = create(&connection, &paths, BackupReason::Manual).unwrap();
        assert_eq!(list(&paths).unwrap().len(), 1);

        let copied = Connection::open(backup_path(&paths, &created)).unwrap();
        assert_eq!(directory_repo::list(&copied).unwrap().len(), 1);
    }

    #[test]
    fn backup_and_restore_preserve_current_and_named_workspace_layouts() {
        let (_directory, paths, mut connection) = setup();
        crate::db::session_alias_repo::save(
            &connection,
            crate::models::tool::ToolKey::Claude,
            "session-1",
            "My session",
        )
        .unwrap();
        crate::db::app_setting_repo::set_close_behavior(
            &connection,
            crate::models::app_setting::CloseBehavior::Quit,
        )
        .unwrap();
        connection
            .execute(
                "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, 1, 4, '{\"tree\":\"current\"}', 10)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values ('preset-1', 'Saved Layout', 1, '{\"tree\":\"named\"}', 10, 10)",
                [],
            )
            .unwrap();

        let backup = create(&connection, &paths, BackupReason::Manual).unwrap();
        connection
            .execute("delete from workspace_state", [])
            .unwrap();
        connection
            .execute("delete from workspace_layout_presets", [])
            .unwrap();
        crate::db::session_alias_repo::delete(
            &connection,
            crate::models::tool::ToolKey::Claude,
            "session-1",
        )
        .unwrap();
        crate::db::app_setting_repo::set_close_behavior(
            &connection,
            crate::models::app_setting::CloseBehavior::MinimizeToTray,
        )
        .unwrap();

        restore(&mut connection, &paths, &backup.id).unwrap();

        let current_payload: String = connection
            .query_row(
                "select payload_json from workspace_state where id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            crate::db::workspace_layout_repo::get_current(&connection)
                .unwrap()
                .unwrap()
                .revision,
            4
        );
        let (preset_name, preset_payload): (String, String) = connection
            .query_row(
                "select name, payload_json from workspace_layout_presets where id = 'preset-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(current_payload, r#"{"tree":"current"}"#);
        assert_eq!(preset_name, "Saved Layout");
        assert_eq!(preset_payload, r#"{"tree":"named"}"#);
        assert_eq!(
            crate::db::session_alias_repo::list_for_tool(
                &connection,
                crate::models::tool::ToolKey::Claude
            )
            .unwrap()
            .get("session-1")
            .map(String::as_str),
            Some("My session")
        );
        assert_eq!(
            crate::db::app_setting_repo::get_close_behavior(&connection).unwrap(),
            crate::models::app_setting::CloseBehavior::Quit
        );
    }

    #[test]
    fn restore_creates_guard_backup_and_replaces_data() {
        let (_directory, paths, mut connection) = setup();
        directory_repo::add(&connection, "before", "C:\\before", None).unwrap();
        let backup = create(&connection, &paths, BackupReason::Manual).unwrap();
        directory_repo::add(&connection, "after", "C:\\after", None).unwrap();

        restore(&mut connection, &paths, &backup.id).unwrap();

        assert_eq!(directory_repo::list(&connection).unwrap().len(), 1);
        assert!(list(&paths)
            .unwrap()
            .iter()
            .any(|item| matches!(item.reason, BackupReason::PreRestore)));
    }

    #[test]
    fn restoring_a_024_schema_eight_backup_migrates_and_preserves_legacy_data() {
        let (_directory, paths, mut connection) = setup();
        let id = "0-2-4-schema-8";
        let filename = format!("cli-launchpad-{id}.db");
        let backup_file = paths.backup_database_dir.join(&filename);
        let legacy = Connection::open(&backup_file).unwrap();
        legacy.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection::apply_migrations_through(&legacy, 8).unwrap();
        legacy
            .execute(
                "insert into directories (id, name, path, pinned, note) values (8, 'Legacy', 'C:\\legacy', 1, 'preserve')",
                [],
            )
            .unwrap();
        legacy
            .execute(
                "update tools set global_args = '--legacy-args' where key = 'claude'",
                [],
            )
            .unwrap();
        legacy
            .execute(
                "insert into directory_tool_args (directory_id, tool_key, args) values (8, 'claude', '--legacy-project-args')",
                [],
            )
            .unwrap();
        legacy
            .execute(
                "insert into session_aliases (tool_key, session_id, alias, updated_at_ms) values ('claude', 'old-session', 'Old alias', 10)",
                [],
            )
            .unwrap();
        legacy
            .execute(
                "update application_settings set value = 'quit' where key = 'close_behavior'",
                [],
            )
            .unwrap();
        legacy.close().unwrap();

        let manifest = BackupManifest {
            id: id.to_string(),
            created_at_ms: 10,
            reason: BackupReason::Manual,
            schema_version: 8,
            database_filename: filename,
            size_bytes: fs::metadata(&backup_file).unwrap().len(),
        };
        write_manifest(&paths, &manifest).unwrap();

        restore(&mut connection, &paths, id).unwrap();

        assert_eq!(connection::schema_version(&connection).unwrap(), 13);
        assert_eq!(directory_repo::list(&connection).unwrap()[0].name, "Legacy");
        assert_eq!(
            connection
                .query_row(
                    "select global_args from tools where key = 'claude'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "--legacy-args"
        );
        assert_eq!(
            connection
                .query_row(
                    "select args from directory_tool_args where directory_id = 8 and tool_key = 'claude'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "--legacy-project-args"
        );
        assert_eq!(
            crate::db::session_alias_repo::list_for_tool(
                &connection,
                crate::models::tool::ToolKey::Claude
            )
            .unwrap()
            .get("old-session")
            .map(String::as_str),
            Some("Old alias")
        );
        assert_eq!(
            crate::db::app_setting_repo::get_close_behavior(&connection).unwrap(),
            crate::models::app_setting::CloseBehavior::Quit
        );
        assert!(list(&paths)
            .unwrap()
            .iter()
            .any(|item| matches!(item.reason, BackupReason::PreRestore)));
    }

    #[test]
    fn failed_old_backup_migration_restores_the_pre_restore_database() {
        let (_directory, paths, mut connection) = setup();
        directory_repo::add(&connection, "Keep current", "C:\\current", None).unwrap();

        let id = "broken-schema-8";
        let filename = format!("cli-launchpad-{id}.db");
        let backup_file = paths.backup_database_dir.join(&filename);
        let legacy = Connection::open(&backup_file).unwrap();
        legacy.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection::apply_migrations_through(&legacy, 8).unwrap();
        legacy.execute("drop table tools", []).unwrap();
        legacy.close().unwrap();

        let manifest = BackupManifest {
            id: id.to_string(),
            created_at_ms: 10,
            reason: BackupReason::Manual,
            schema_version: 8,
            database_filename: filename,
            size_bytes: fs::metadata(&backup_file).unwrap().len(),
        };
        write_manifest(&paths, &manifest).unwrap();

        assert!(restore(&mut connection, &paths, id).is_err());

        assert_eq!(connection::schema_version(&connection).unwrap(), 13);
        assert_eq!(
            directory_repo::list(&connection).unwrap()[0].name,
            "Keep current"
        );
        assert!(list(&paths)
            .unwrap()
            .iter()
            .any(|item| matches!(item.reason, BackupReason::PreRestore)));
    }

    #[test]
    fn restore_rejects_backup_from_newer_schema() {
        let (_directory, paths, mut connection) = setup();
        let mut backup = create(&connection, &paths, BackupReason::Manual).unwrap();
        backup.schema_version = connection::latest_schema_version() + 1;
        write_manifest(&paths, &backup).unwrap();

        let error = restore(&mut connection, &paths, &backup.id).unwrap_err();
        assert!(error.to_string().contains("更新版本"));
    }

    #[test]
    fn restoring_oldest_automatic_backup_does_not_prune_selected_source() {
        let (_directory, paths, mut connection) = setup();
        directory_repo::add(&connection, "oldest", "C:\\oldest", None).unwrap();
        let selected = create(&connection, &paths, BackupReason::PreImport).unwrap();
        for index in 0..9 {
            directory_repo::add(
                &connection,
                &format!("extra-{index}"),
                &format!("C:\\{index}"),
                None,
            )
            .unwrap();
            create(&connection, &paths, BackupReason::PreImport).unwrap();
        }
        restore(&mut connection, &paths, &selected.id).unwrap();
        assert_eq!(directory_repo::list(&connection).unwrap().len(), 1);
    }

    #[test]
    fn invalid_manifest_path_is_not_listed_or_deleted() {
        let (_directory, paths, connection) = setup();
        let victim = paths.root.join("victim.db");
        fs::write(&victim, "keep").unwrap();
        let manifest = BackupManifest {
            id: "evil".to_string(),
            created_at_ms: 1,
            reason: BackupReason::PreImport,
            schema_version: connection::latest_schema_version(),
            database_filename: "..\\victim.db".to_string(),
            size_bytes: 4,
        };
        fs::write(
            paths.backup_manifests_dir.join("evil.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(list(&paths).unwrap().is_empty());
        create(&connection, &paths, BackupReason::Manual).unwrap();
        assert!(victim.exists());
    }
}
