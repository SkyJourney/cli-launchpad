use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{bail, Result};

use crate::db::directory_repo;
use crate::models::directory::Directory;
use crate::models::window_kind::{window_kind_of, WindowKind, WindowLabel};
use crate::platform::path_identity;
use crate::services::project_directory::ProjectDirectory;
use crate::services::window_lifecycle::{AppEvent, WindowScopedResource};
use crate::{AppError, Db};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentWindowFileGrant {
    pub directory_id: i64,
    pub directory_path: String,
    pub relative_path: String,
}

#[derive(Default)]
pub struct ContentWindowGrantRegistry {
    grants: Mutex<HashMap<String, ContentWindowFileGrant>>,
}

impl ContentWindowGrantRegistry {
    pub fn grant(&self, label: &str, grant: ContentWindowFileGrant) -> Result<()> {
        if !window_kind_of(label).is_some_and(WindowKind::has_file_grant) {
            bail!("文件授权目标不是已登记的内容窗口");
        }
        ProjectDirectory::validate_relative_path(&grant.relative_path)?;
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?;
        match grants.entry(label.to_string()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(grant);
                Ok(())
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                bail!("内容窗口已有文件授权")
            }
        }
    }

    pub fn get(&self, label: &str) -> Result<ContentWindowFileGrant> {
        if !window_kind_of(label).is_some_and(WindowKind::has_file_grant) {
            bail!("调用窗口不是已登记的内容窗口");
        }
        self.grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?
            .get(label)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("文件窗口没有文件授权"))
    }

    pub fn revoke(&self, label: &str) -> Result<bool> {
        Ok(self
            .grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?
            .remove(label)
            .is_some())
    }
}

impl WindowScopedResource for ContentWindowGrantRegistry {
    fn release_window(&self, window: &WindowLabel) -> Vec<AppEvent> {
        if !window.kind().has_file_grant() {
            return Vec::new();
        }
        if let Err(error) = self.revoke(window.as_str()) {
            log::warn!("unable to revoke file grant for destroyed window label={window}: {error}");
        }
        vec![AppEvent::WorkspaceContentWindowLost {
            window_label: window.as_str().to_string(),
        }]
    }
}

/// Closes a content window whose grant was revoked. Implementations perform
/// IPC; callers must not hold any lock while calling it.
pub trait ContentWindowReclaimer {
    fn reclaim(&self, label: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevocationReason {
    RestoreBackup,
    ImportConfig,
    RemoveDirectory,
}

impl RevocationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RevocationReason::RestoreBackup => "restore_backup",
            RevocationReason::ImportConfig => "import_config",
            RevocationReason::RemoveDirectory => "remove_directory",
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RevocationReport {
    /// Labels whose grant was removed, sorted ascending.
    pub revoked: Vec<String>,
    /// Subset of `revoked` whose window could not be reclaimed.
    pub reclaim_failed: Vec<String>,
}

impl ContentWindowGrantRegistry {
    /// All grants sorted by label.
    pub fn snapshot(&self) -> Result<Vec<(String, ContentWindowFileGrant)>> {
        let grants = self
            .grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?;
        let mut entries: Vec<(String, ContentWindowFileGrant)> = grants
            .iter()
            .map(|(label, grant)| (label.clone(), grant.clone()))
            .collect();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(entries)
    }

    /// Removes every grant for which `predicate` is true. The predicate runs
    /// under the registry lock and must not perform IO.
    pub fn revoke_matching(
        &self,
        predicate: impl Fn(&ContentWindowFileGrant) -> bool,
    ) -> Result<Vec<String>> {
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?;
        let mut labels: Vec<String> = grants
            .iter()
            .filter(|(_, grant)| predicate(grant))
            .map(|(label, _)| label.clone())
            .collect();
        labels.sort();
        for label in &labels {
            grants.remove(label);
        }
        Ok(labels)
    }

    /// Removes the grant of `label` only when it still equals `expected`.
    pub fn revoke_exact(&self, label: &str, expected: &ContentWindowFileGrant) -> Result<bool> {
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?;
        if grants.get(label) == Some(expected) {
            grants.remove(label);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

pub struct ContentWindowRevoker<'a> {
    registry: &'a ContentWindowGrantRegistry,
    reclaimer: &'a dyn ContentWindowReclaimer,
    reason: RevocationReason,
}

impl<'a> ContentWindowRevoker<'a> {
    pub fn new(
        registry: &'a ContentWindowGrantRegistry,
        reclaimer: &'a dyn ContentWindowReclaimer,
        reason: RevocationReason,
    ) -> Self {
        Self {
            registry,
            reclaimer,
            reason,
        }
    }

    pub fn revoke_all(&self) -> RevocationReport {
        self.finish(self.registry.revoke_matching(|_| true))
    }

    pub fn revoke_for_directory(&self, directory_id: i64) -> RevocationReport {
        self.finish(
            self.registry
                .revoke_matching(|grant| grant.directory_id == directory_id),
        )
    }

    /// Revokes the grants whose project no longer exists or whose path snapshot no
    /// longer equals the project's current path (the same two conditions
    /// `ProjectDirectory::open_for` enforces on every read and write).
    pub fn revoke_stale(&self, directories: &[Directory]) -> RevocationReport {
        let snapshot = match self.registry.snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => return self.finish(Err(error)),
        };
        let mut revoked = Vec::new();
        for (label, grant) in snapshot {
            // `paths_equal` touches the file system: it runs outside the registry lock.
            let still_valid = directories.iter().any(|directory| {
                directory.id == grant.directory_id
                    && path_identity::paths_equal(&grant.directory_path, &directory.path)
            });
            if still_valid {
                continue;
            }
            match self.registry.revoke_exact(&label, &grant) {
                Ok(true) => revoked.push(label),
                Ok(false) => {}
                Err(error) => return self.finish(Err(error)),
            }
        }
        self.finish(Ok(revoked))
    }

    pub fn revoke_stale_for_database(&self, db: &Db) -> Result<RevocationReport, AppError> {
        // The database lock is held only until `list` returns.
        let directories = db.with_sync("content_window.revoke_stale", |connection| {
            Ok(directory_repo::list(connection)?)
        })?;
        Ok(self.revoke_stale(&directories))
    }

    fn finish(&self, revoked: Result<Vec<String>>) -> RevocationReport {
        let revoked = match revoked {
            Ok(labels) => labels,
            Err(error) => {
                log::error!(
                    "unable to revoke content window grants reason={}: {error}",
                    self.reason.as_str()
                );
                return RevocationReport::default();
            }
        };
        let mut reclaim_failed = Vec::new();
        for label in &revoked {
            if let Err(error) = self.reclaimer.reclaim(label) {
                log::warn!("unable to reclaim content window label={label}: {error}");
                reclaim_failed.push(label.clone());
            }
        }
        log::info!(
            "content window grants revoked: reason={} revoked={} reclaim_failed={}",
            self.reason.as_str(),
            revoked.len(),
            reclaim_failed.len()
        );
        RevocationReport {
            revoked,
            reclaim_failed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::RecordingReclaimer;
    use super::*;
    use crate::db::{connection, directory_repo};

    const FIRST_LABEL: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    const SECOND_LABEL: &str = "workspace-content-11111111-2222-4333-8444-555555555555";

    fn grant(relative_path: &str) -> ContentWindowFileGrant {
        ContentWindowFileGrant {
            directory_id: 7,
            directory_path: "C:/workspace".to_string(),
            relative_path: relative_path.to_string(),
        }
    }

    #[test]
    fn grants_only_registered_content_windows_and_one_relative_file() {
        let registry = ContentWindowGrantRegistry::default();

        assert!(registry.grant("main", grant("notes.md")).is_err());
        assert!(registry
            .grant("workspace-content-invalid", grant("notes.md"))
            .is_err());
        assert!(registry.grant(FIRST_LABEL, grant("../outside.md")).is_err());

        registry.grant(FIRST_LABEL, grant("notes.md")).unwrap();
        assert_eq!(registry.get(FIRST_LABEL).unwrap(), grant("notes.md"));
        assert!(registry.get(SECOND_LABEL).is_err());
    }

    #[test]
    fn revocation_is_scoped_to_the_exact_window_label() {
        let registry = ContentWindowGrantRegistry::default();
        registry.grant(FIRST_LABEL, grant("one.md")).unwrap();
        registry.grant(SECOND_LABEL, grant("two.md")).unwrap();

        assert!(registry.revoke(FIRST_LABEL).unwrap());
        assert!(registry.get(FIRST_LABEL).is_err());
        assert_eq!(registry.get(SECOND_LABEL).unwrap(), grant("two.md"));
        assert!(!registry.revoke(FIRST_LABEL).unwrap());
    }

    #[test]
    fn release_window_still_reports_the_lost_window_when_the_grant_table_is_poisoned() {
        let registry = ContentWindowGrantRegistry::default();
        registry.grant(FIRST_LABEL, grant("a.txt")).unwrap();
        // A panic while the table lock is held poisons it, so the revocation fails.
        let poisoning = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = registry.grants.lock().unwrap();
            panic!("poison the grant table on purpose");
        }));
        assert!(poisoning.is_err());
        assert!(
            registry.revoke(FIRST_LABEL).is_err(),
            "the revocation must really fail for this test to mean anything"
        );

        let window = WindowLabel::parse(FIRST_LABEL).unwrap();
        let events = registry.release_window(&window);
        assert_eq!(
            events,
            vec![AppEvent::WorkspaceContentWindowLost {
                window_label: FIRST_LABEL.to_string(),
            }],
            "the main window must still learn that the content window is gone"
        );
    }

    const THIRD_LABEL: &str = "workspace-content-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    fn grant_in(directory_id: i64, path: &str, relative_path: &str) -> ContentWindowFileGrant {
        ContentWindowFileGrant {
            directory_id,
            directory_path: path.to_string(),
            relative_path: relative_path.to_string(),
        }
    }

    fn directory(id: i64, path: &str) -> Directory {
        Directory {
            id,
            name: format!("p{id}"),
            path: path.to_string(),
            sort_order: id,
            pinned: false,
            note: None,
        }
    }

    #[test]
    fn revoke_all_removes_every_grant_and_reclaims_each_window_once() {
        let registry = ContentWindowGrantRegistry::default();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::RestoreBackup);

        // 反向：空注册表上撤销什么也不回收。
        assert_eq!(revoker.revoke_all(), RevocationReport::default());
        assert!(reclaimer.reclaimed().is_empty());

        registry
            .grant(FIRST_LABEL, grant_in(7, "C:/workspace", "one.md"))
            .unwrap();
        registry
            .grant(SECOND_LABEL, grant_in(8, "C:/other", "two.md"))
            .unwrap();

        let report = revoker.revoke_all();
        assert_eq!(
            report.revoked,
            vec![SECOND_LABEL.to_string(), FIRST_LABEL.to_string()]
        );
        assert!(report.reclaim_failed.is_empty());
        assert_eq!(
            reclaimer.reclaimed(),
            vec![SECOND_LABEL.to_string(), FIRST_LABEL.to_string()]
        );
        assert!(registry.get(FIRST_LABEL).is_err());
        assert!(registry.get(SECOND_LABEL).is_err());
        assert!(registry.snapshot().unwrap().is_empty());

        // 再撤销一次：没有授权可撤，每个窗口只回收一次。
        assert!(revoker.revoke_all().revoked.is_empty());
        assert_eq!(reclaimer.reclaimed().len(), 2);
    }

    #[test]
    fn revoke_for_directory_only_touches_grants_of_that_directory() {
        let registry = ContentWindowGrantRegistry::default();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::RemoveDirectory);
        registry
            .grant(FIRST_LABEL, grant_in(7, "C:/workspace", "one.md"))
            .unwrap();
        registry
            .grant(SECOND_LABEL, grant_in(8, "C:/other", "two.md"))
            .unwrap();
        registry
            .grant(THIRD_LABEL, grant_in(7, "C:/workspace", "three.md"))
            .unwrap();

        let report = revoker.revoke_for_directory(7);
        assert_eq!(
            report.revoked,
            vec![FIRST_LABEL.to_string(), THIRD_LABEL.to_string()]
        );
        assert_eq!(
            reclaimer.reclaimed(),
            vec![FIRST_LABEL.to_string(), THIRD_LABEL.to_string()]
        );
        // 反向：其他项目的授权完好。
        assert_eq!(
            registry.get(SECOND_LABEL).unwrap(),
            grant_in(8, "C:/other", "two.md")
        );

        assert!(revoker.revoke_for_directory(99).revoked.is_empty());
        assert!(registry.get(SECOND_LABEL).is_ok());
        assert_eq!(reclaimer.reclaimed().len(), 2);
    }

    #[test]
    fn revoke_stale_keeps_grants_of_unchanged_projects_and_revokes_the_rest() {
        let registry = ContentWindowGrantRegistry::default();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::ImportConfig);
        registry
            .grant(FIRST_LABEL, grant_in(7, "C:/workspace", "one.md"))
            .unwrap();
        // 项目 8 已不存在。
        registry
            .grant(SECOND_LABEL, grant_in(8, "C:/gone", "two.md"))
            .unwrap();
        // 项目 9 的路径已变。
        registry
            .grant(THIRD_LABEL, grant_in(9, "C:/old-path", "three.md"))
            .unwrap();
        let directories = vec![directory(7, "C:/workspace"), directory(9, "C:/new-path")];

        let report = revoker.revoke_stale(&directories);
        assert_eq!(
            report.revoked,
            vec![SECOND_LABEL.to_string(), THIRD_LABEL.to_string()]
        );
        assert_eq!(
            reclaimer.reclaimed(),
            vec![SECOND_LABEL.to_string(), THIRD_LABEL.to_string()]
        );
        assert_eq!(
            registry.get(FIRST_LABEL).unwrap(),
            grant_in(7, "C:/workspace", "one.md")
        );
        assert!(!reclaimer.reclaimed().contains(&FIRST_LABEL.to_string()));

        // 幂等：再次撤销没有新的失效授权。
        assert!(revoker.revoke_stale(&directories).revoked.is_empty());
    }

    #[test]
    fn a_failed_reclaim_is_reported_and_does_not_stop_the_remaining_windows() {
        let registry = ContentWindowGrantRegistry::default();
        let reclaimer = RecordingReclaimer::failing_for(&[SECOND_LABEL]);
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::RestoreBackup);
        registry
            .grant(FIRST_LABEL, grant_in(7, "C:/workspace", "a.md"))
            .unwrap();
        registry
            .grant(SECOND_LABEL, grant_in(8, "C:/other", "b.md"))
            .unwrap();
        registry
            .grant(THIRD_LABEL, grant_in(9, "C:/third", "c.md"))
            .unwrap();

        let report = revoker.revoke_all();
        assert_eq!(
            report.revoked,
            vec![
                SECOND_LABEL.to_string(),
                FIRST_LABEL.to_string(),
                THIRD_LABEL.to_string()
            ]
        );
        assert_eq!(report.reclaim_failed, vec![SECOND_LABEL.to_string()]);
        assert_eq!(
            reclaimer.reclaimed(),
            vec![
                SECOND_LABEL.to_string(),
                FIRST_LABEL.to_string(),
                THIRD_LABEL.to_string()
            ]
        );
        // 反向：回收失败不让授权残留。
        assert!(registry.snapshot().unwrap().is_empty());
    }

    #[test]
    fn revoke_exact_does_not_remove_a_newer_grant_for_the_same_window() {
        let registry = ContentWindowGrantRegistry::default();
        let old = grant_in(7, "C:/workspace", "old.md");
        let newer = grant_in(7, "C:/workspace", "new.md");
        registry.grant(FIRST_LABEL, old.clone()).unwrap();
        registry.revoke(FIRST_LABEL).unwrap();
        registry.grant(FIRST_LABEL, newer.clone()).unwrap();

        assert!(!registry.revoke_exact(FIRST_LABEL, &old).unwrap());
        assert_eq!(registry.get(FIRST_LABEL).unwrap(), newer);
        assert!(registry.revoke_exact(FIRST_LABEL, &newer).unwrap());
        assert!(registry.get(FIRST_LABEL).is_err());
    }

    #[test]
    fn revoke_stale_for_database_reads_the_current_directory_table() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        let a = directory_repo::add(&connection, "A", "C:/workspace", None).unwrap();
        let b = directory_repo::add(&connection, "B", "C:/other", None).unwrap();
        let db = Db::new(connection);
        let registry = ContentWindowGrantRegistry::default();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::ImportConfig);
        registry
            .grant(FIRST_LABEL, grant_in(a.id, "C:/workspace", "one.md"))
            .unwrap();
        registry
            .grant(SECOND_LABEL, grant_in(b.id, "C:/other", "two.md"))
            .unwrap();

        // 两个项目都有效时不撤销。
        assert!(revoker
            .revoke_stale_for_database(&db)
            .unwrap()
            .revoked
            .is_empty());
        assert!(reclaimer.reclaimed().is_empty());

        directory_repo::remove(&db.lock_for_test(), b.id).unwrap();
        let report = revoker.revoke_stale_for_database(&db).unwrap();
        assert_eq!(report.revoked, vec![SECOND_LABEL.to_string()]);
        assert_eq!(reclaimer.reclaimed(), vec![SECOND_LABEL.to_string()]);
        assert!(registry.get(FIRST_LABEL).is_ok());
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    use super::ContentWindowReclaimer;

    /// Records every reclaim attempt in call order; labels in `fail` return an error.
    #[derive(Default)]
    pub(crate) struct RecordingReclaimer {
        log: Arc<Mutex<Vec<String>>>,
        fail: HashSet<String>,
    }

    impl RecordingReclaimer {
        pub(crate) fn with_log(log: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                log,
                fail: HashSet::new(),
            }
        }

        pub(crate) fn failing_for(labels: &[&str]) -> Self {
            Self {
                log: Arc::default(),
                fail: labels.iter().map(|label| label.to_string()).collect(),
            }
        }

        pub(crate) fn reclaimed(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    impl ContentWindowReclaimer for RecordingReclaimer {
        fn reclaim(&self, label: &str) -> Result<(), String> {
            self.log.lock().unwrap().push(label.to_string());
            if self.fail.contains(label) {
                Err("window busy".to_string())
            } else {
                Ok(())
            }
        }
    }
}
