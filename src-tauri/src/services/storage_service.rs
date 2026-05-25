use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

const LEGACY_IDENTIFIER: &str = "dev.local.cli-launchpad";
const DB_FILENAME: &str = "cli-launchpad.db";
const WINDOW_STATE_FILENAME: &str = ".window-state.json";

#[derive(Debug, Clone)]
pub struct StoragePaths {
    pub root: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub backup_database_dir: PathBuf,
    pub backup_manifests_dir: PathBuf,
    pub database_path: PathBuf,
}

impl StoragePaths {
    fn new(home_dir: &Path) -> Self {
        let root = home_dir.join(".cli-launchpad");
        let data_dir = root.join("data");
        let cache_dir = root.join("cache");
        let logs_dir = root.join("logs");
        let backup_database_dir = root.join("backups").join("database");
        let backup_manifests_dir = root.join("backups").join("manifests");
        let database_path = data_dir.join(DB_FILENAME);

        Self {
            root,
            data_dir,
            cache_dir,
            logs_dir,
            backup_database_dir,
            backup_manifests_dir,
            database_path,
        }
    }

    fn create_directories(&self) -> Result<()> {
        for directory in [
            &self.root,
            &self.data_dir,
            &self.cache_dir,
            &self.logs_dir,
            &self.backup_database_dir,
            &self.backup_manifests_dir,
        ] {
            fs::create_dir_all(directory)
                .with_context(|| format!("无法创建应用目录 {}", directory.display()))?;
        }
        Ok(())
    }
}

pub fn prepare(app: &AppHandle) -> Result<StoragePaths> {
    let paths = StoragePaths::new(&app.path().home_dir()?);
    paths.create_directories()?;

    let legacy_data_dir = app.path().data_dir()?.join(LEGACY_IDENTIFIER);
    migrate_if_missing(
        &legacy_data_dir.join(DB_FILENAME),
        &paths.database_path,
        "旧数据库",
    )?;

    // Window-state is owned by the Tauri plugin and remains under app_config_dir.
    // Copy it before registering the plugin so the first run under the stable
    // identifier preserves the user's existing window placement.
    let legacy_config_dir = app.path().config_dir()?.join(LEGACY_IDENTIFIER);
    let current_config_dir = app.path().app_config_dir()?;
    fs::create_dir_all(&current_config_dir)?;
    migrate_if_missing(
        &legacy_config_dir.join(WINDOW_STATE_FILENAME),
        &current_config_dir.join(WINDOW_STATE_FILENAME),
        "旧窗口状态",
    )?;

    Ok(paths)
}

fn migrate_if_missing(source: &Path, target: &Path, label: &str) -> Result<bool> {
    if target.exists() || !source.is_file() {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = target.with_extension("migrating");
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    fs::copy(source, &temporary).with_context(|| {
        format!(
            "无法迁移{label}：{} -> {}",
            source.display(),
            target.display()
        )
    })?;
    OpenOptions::new()
        .write(true)
        .open(&temporary)?
        .sync_all()?;
    fs::rename(&temporary, target)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn storage_paths_create_required_layout() {
        let home = tempdir().unwrap();
        let paths = StoragePaths::new(home.path());
        paths.create_directories().unwrap();

        assert!(paths.data_dir.is_dir());
        assert!(paths.cache_dir.is_dir());
        assert!(paths.logs_dir.is_dir());
        assert!(paths.backup_database_dir.is_dir());
        assert!(paths.backup_manifests_dir.is_dir());
    }

    #[test]
    fn migration_never_overwrites_existing_target() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.db");
        let target = dir.path().join("target.db");
        fs::write(&source, b"legacy").unwrap();
        fs::write(&target, b"current").unwrap();

        assert!(!migrate_if_missing(&source, &target, "test").unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"current");
    }

    #[test]
    fn migration_copies_missing_target_and_keeps_source() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.db");
        let target = dir.path().join("nested").join("target.db");
        fs::write(&source, b"legacy").unwrap();

        assert!(migrate_if_missing(&source, &target, "test").unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"legacy");
        assert_eq!(fs::read(&source).unwrap(), b"legacy");
    }
}
