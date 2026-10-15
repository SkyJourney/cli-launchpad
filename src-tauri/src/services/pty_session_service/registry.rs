use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use super::session::ManagedSession;
use crate::AppError;

/// Owner of the session table. Lookups clone the `Arc` out and release the
/// table lock immediately; nothing inspects a session while holding it.
pub(super) struct SessionRegistry {
    inner: Mutex<HashMap<String, Arc<ManagedSession>>>,
}

impl SessionRegistry {
    pub(super) fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn insert(&self, session: Arc<ManagedSession>) -> Result<(), AppError> {
        self.inner
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .insert(session.session_id.clone(), session);
        Ok(())
    }

    pub(super) fn get(&self, session_id: &str) -> Result<Arc<ManagedSession>, AppError> {
        self.inner
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::msg("PTY 会话不存在或已结束"))
    }

    pub(super) fn find(&self, session_id: &str) -> Result<Option<Arc<ManagedSession>>, AppError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .get(session_id)
            .cloned())
    }

    pub(super) fn remove(&self, session_id: &str) -> bool {
        match self.inner.lock() {
            Ok(mut sessions) => sessions.remove(session_id).is_some(),
            Err(_) => {
                log::error!("PTY session table lock poisoned while removing session");
                false
            }
        }
    }

    pub(super) fn snapshot(&self) -> Result<Vec<Arc<ManagedSession>>, AppError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .values()
            .cloned()
            .collect())
    }

    pub(super) fn len(&self) -> usize {
        self.inner
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    /// Test seam: true when nobody holds the table lock right now.
    #[cfg(test)]
    pub(super) fn is_unlocked(&self) -> bool {
        self.inner.try_lock().is_ok()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::services::pty_session_service::PtySessionManager;

    #[test]
    fn registry_get_returns_the_session_or_the_documented_error() {
        let manager = PtySessionManager::default();
        let inserted = manager.insert_test_session("main", None);
        let registry = manager.registry_handle();

        let found = registry
            .get(&inserted.session_id)
            .expect("a registered session is found");
        assert_eq!(found.session_id, inserted.session_id);

        let error = registry
            .get("missing")
            .err()
            .expect("an unknown session is an error");
        assert!(error.to_string().contains("PTY 会话不存在或已结束"));
        // `find` is for callers where a missing session is not an error.
        assert!(registry
            .find("missing")
            .expect("find must not fail for an unknown id")
            .is_none());
        assert!(registry
            .find(&inserted.session_id)
            .expect("find must not fail for a known id")
            .is_some());
    }

    #[test]
    fn registry_remove_is_idempotent_and_len_tracks_membership() {
        let manager = PtySessionManager::default();
        let first = manager.insert_test_session("main", None);
        let second = manager.insert_test_session("main", None);
        let registry = manager.registry_handle();

        assert_eq!(registry.len(), 2);
        assert!(registry.remove(&first.session_id));
        assert_eq!(registry.len(), 1);
        assert!(!registry.remove(&first.session_id));
        assert_eq!(registry.len(), 1);
        assert!(registry.remove(&second.session_id));
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn registry_snapshot_returns_every_session_without_holding_the_lock() {
        let manager = PtySessionManager::default();
        let ids: HashSet<String> = (0..3)
            .map(|_| manager.insert_test_session("main", None).session_id)
            .collect();
        let registry = manager.registry_handle();

        let snapshot = registry.snapshot().expect("snapshot");
        assert_eq!(snapshot.len(), 3);
        let snapshot_ids: HashSet<String> = snapshot
            .iter()
            .map(|session| session.session_id.clone())
            .collect();
        assert_eq!(snapshot_ids, ids);
        // The same thread can take the table lock again: the snapshot released it.
        assert_eq!(registry.len(), 3);

        let removed = snapshot[0].session_id.clone();
        assert!(registry.remove(&removed));
        assert_eq!(registry.len(), 2);
        assert_eq!(snapshot[0].session_id, removed);
    }
}
