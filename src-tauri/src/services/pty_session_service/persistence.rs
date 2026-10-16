//! Durable-enough persistence of PTY session rows (m6-056).
//!
//! The in-memory session table is the authority for "is this session running"; the
//! `pty_sessions` row is only the persistent record. A failed `finish` write used to be logged
//! and forgotten, leaving the row on `running` forever. `RetryingStore` keeps such writes in a
//! bounded queue and retries them passively: before the next `insert_running`, after the next
//! successful `finish`, or through an explicit `flush_pending`.
//!
//! The queue lock is a leaf lock: it is never held while the inner store (the database) or the
//! observer is called.
use std::{collections::VecDeque, sync::Arc, sync::Mutex};

use super::{ports::PtySessionStore, registry::SessionRegistry, session::ManagedSession};
use crate::{models::tool::ToolKey, AppError};

pub(super) const MAX_PENDING_FINISHES: usize = 64;
pub(super) const MAX_FINISH_ATTEMPTS: u32 = 5;

/// Told about persistence failures. The default implementation only logs; no window event is
/// emitted (whether the user must be told is an open product question).
pub(crate) trait PersistenceObserver: Send + Sync {
    fn finish_failed(&self, session_id: &str, state: &str, attempts: u32, error: &AppError);
    fn finish_gave_up(&self, session_id: &str, state: &str, attempts: u32);
}

pub(crate) struct LogObserver;

impl PersistenceObserver for LogObserver {
    fn finish_failed(&self, session_id: &str, state: &str, attempts: u32, error: &AppError) {
        log::error!(
            "PTY session finish persistence failed session_id={session_id} state={state} attempts={attempts} error={error}"
        );
    }

    fn finish_gave_up(&self, session_id: &str, state: &str, attempts: u32) {
        log::error!(
            "PTY session finish persistence abandoned session_id={session_id} state={state} attempts={attempts}"
        );
    }
}

struct PendingFinish {
    session_id: String,
    state: String,
    ended_at_ms: i64,
    exit_code: Option<i64>,
    attempts: u32,
}

/// Bounded queue of `finish` writes that failed. Shared by every store the manager hands out.
pub(crate) struct PendingFinishQueue {
    entries: Mutex<VecDeque<PendingFinish>>,
}

impl PendingFinishQueue {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(VecDeque::new()),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }

    /// Appends an entry; when the queue is full the oldest entry is evicted and returned.
    fn push(&self, entry: PendingFinish) -> Option<PendingFinish> {
        let mut entries = self.entries.lock().ok()?;
        let evicted = if entries.len() >= MAX_PENDING_FINISHES {
            entries.pop_front()
        } else {
            None
        };
        entries.push_back(entry);
        evicted
    }

    /// Takes every entry; the lock is released before the caller touches the store.
    fn drain(&self) -> Vec<PendingFinish> {
        match self.entries.lock() {
            Ok(mut entries) => entries.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }
}

pub struct FlushReport {
    pub retried: usize,
    pub succeeded: usize,
    /// Entries given up on: the attempt limit was reached, or a requeued entry pushed an older
    /// one out of a full queue.
    pub dropped: usize,
}

pub(crate) struct RetryingStore {
    inner: Arc<dyn PtySessionStore>,
    queue: Arc<PendingFinishQueue>,
    observer: Arc<dyn PersistenceObserver>,
}

impl RetryingStore {
    pub(crate) fn new(
        inner: Arc<dyn PtySessionStore>,
        queue: Arc<PendingFinishQueue>,
        observer: Arc<dyn PersistenceObserver>,
    ) -> Self {
        Self {
            inner,
            queue,
            observer,
        }
    }

    /// Retries every queued `finish`. A write that fails again is requeued until it reaches
    /// `MAX_FINISH_ATTEMPTS`, then it is abandoned and reported.
    pub(crate) fn flush_pending(&self) -> FlushReport {
        let batch = self.queue.drain();
        let mut report = FlushReport {
            retried: batch.len(),
            succeeded: 0,
            dropped: 0,
        };
        for mut entry in batch {
            match self.inner.finish(
                &entry.session_id,
                &entry.state,
                entry.ended_at_ms,
                entry.exit_code,
            ) {
                Ok(()) => report.succeeded += 1,
                Err(error) => {
                    entry.attempts += 1;
                    if entry.attempts >= MAX_FINISH_ATTEMPTS {
                        self.observer.finish_gave_up(
                            &entry.session_id,
                            &entry.state,
                            entry.attempts,
                        );
                        report.dropped += 1;
                    } else {
                        self.observer.finish_failed(
                            &entry.session_id,
                            &entry.state,
                            entry.attempts,
                            &error,
                        );
                        if let Some(evicted) = self.queue.push(entry) {
                            self.observer.finish_gave_up(
                                &evicted.session_id,
                                &evicted.state,
                                evicted.attempts,
                            );
                            report.dropped += 1;
                        }
                    }
                }
            }
        }
        if report.retried > 0 {
            log::debug!(
                "PTY finish persistence retried={} succeeded={} dropped={}",
                report.retried,
                report.succeeded,
                report.dropped
            );
        }
        report
    }

    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.queue.len()
    }
}

impl PtySessionStore for RetryingStore {
    fn insert_running(
        &self,
        session_id: &str,
        directory_id: i64,
        tool_key: ToolKey,
        working_directory: &str,
        started_at_ms: i64,
    ) -> Result<(), AppError> {
        // Earlier finishes land before the next row is written.
        self.flush_pending();
        self.inner.insert_running(
            session_id,
            directory_id,
            tool_key,
            working_directory,
            started_at_ms,
        )
    }

    fn finish(
        &self,
        session_id: &str,
        state: &str,
        ended_at_ms: i64,
        exit_code: Option<i64>,
    ) -> Result<(), AppError> {
        match self.inner.finish(session_id, state, ended_at_ms, exit_code) {
            Ok(()) => {
                self.flush_pending();
                Ok(())
            }
            Err(error) => {
                self.observer.finish_failed(session_id, state, 1, &error);
                let entry = PendingFinish {
                    session_id: session_id.to_string(),
                    state: state.to_string(),
                    ended_at_ms,
                    exit_code,
                    attempts: 1,
                };
                if let Some(evicted) = self.queue.push(entry) {
                    self.observer.finish_gave_up(
                        &evicted.session_id,
                        &evicted.state,
                        evicted.attempts,
                    );
                }
                Err(error)
            }
        }
    }
}

/// Registers the session in memory first and writes the row second; a failed write unregisters.
/// With this order "the row says running but memory does not know the session" can only be the
/// result of a later failed `finish`, never of a start race.
pub(super) fn register_then_persist(
    registry: &SessionRegistry,
    store: &dyn PtySessionStore,
    session: &Arc<ManagedSession>,
) -> Result<(), AppError> {
    registry.insert(Arc::clone(session))?;
    if let Err(error) = store.insert_running(
        &session.session_id,
        session.directory_id,
        session.tool_key,
        &session.working_directory,
        session.started_at_ms,
    ) {
        registry.remove(&session.session_id);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
impl super::PtySessionManager {
    /// Test seam for command-level wiring tests: puts one failed `finish` write into the
    /// manager's own retry queue, as a store that could not reach the database would.
    pub(crate) fn queue_failed_finish_for_test(
        &self,
        session_id: &str,
        state: &str,
        ended_at_ms: i64,
        exit_code: Option<i64>,
    ) {
        self.persist_queue.push(PendingFinish {
            session_id: session_id.to_string(),
            state: state.to_string(),
            ended_at_ms,
            exit_code,
            attempts: 1,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::services::pty_session_service::{
        test_support::{run_with_timeout, FakeStore, RecordingObserver},
        PtySessionManager,
    };

    fn retrying(
        store: &Arc<FakeStore>,
    ) -> (
        Arc<RetryingStore>,
        Arc<PendingFinishQueue>,
        Arc<RecordingObserver>,
    ) {
        let inner: Arc<dyn PtySessionStore> = store.clone();
        let queue = Arc::new(PendingFinishQueue::new());
        let observer = Arc::new(RecordingObserver::default());
        let rs = Arc::new(RetryingStore::new(
            inner,
            Arc::clone(&queue),
            observer.clone(),
        ));
        (rs, queue, observer)
    }

    #[test]
    fn finish_failure_is_queued_and_the_error_is_returned() {
        let (store, _rx) = FakeStore::new();
        store.fail_next_finishes(1);
        let (rs, _queue, observer) = retrying(&store);

        let result = rs.finish("s1", "exited", 10, Some(0));

        assert!(result.is_err());
        assert_eq!(rs.pending_len(), 1);
        assert_eq!(
            observer.events(),
            vec![("finish_failed".to_string(), "s1".to_string(), 1)]
        );
        assert_eq!(store.calls(), vec!["finish:s1:exited".to_string()]);

        // Reverse: a failed row insert is returned and never queued.
        let (store, _rx) = FakeStore::new();
        store.fail_next_inserts(1);
        let (rs, _queue, _observer) = retrying(&store);
        let result = rs.insert_running("s2", 1, ToolKey::Claude, "C:/p", 20);
        assert!(result.is_err());
        assert_eq!(rs.pending_len(), 0);
    }

    #[test]
    fn queued_finishes_are_retried_before_the_next_insert_or_finish() {
        let (store, _rx) = FakeStore::new();
        store.fail_next_finishes(1);
        let (rs, _queue, _observer) = retrying(&store);
        assert!(rs.finish("s1", "exited", 10, Some(0)).is_err());

        rs.insert_running("s2", 1, ToolKey::Claude, "C:/p", 20)
            .unwrap();

        assert_eq!(
            store.calls(),
            vec![
                "finish:s1:exited".to_string(),
                "finish:s1:exited".to_string(),
                "insert:s2".to_string(),
            ]
        );
        assert_eq!(rs.pending_len(), 0);

        // A successful finish retries what is queued behind it.
        store.fail_next_finishes(1);
        assert!(rs.finish("s3", "exited", 30, Some(0)).is_err());
        rs.finish("s4", "exited", 40, Some(0)).unwrap();
        let calls = store.calls();
        assert_eq!(
            calls[calls.len() - 3..],
            [
                "finish:s3:exited".to_string(),
                "finish:s4:exited".to_string(),
                "finish:s3:exited".to_string(),
            ]
        );
        assert_eq!(rs.pending_len(), 0);
    }

    #[test]
    fn a_finish_that_keeps_failing_is_dropped_after_the_attempt_limit_and_reported() {
        assert_eq!(MAX_FINISH_ATTEMPTS, 5);
        let (store, _rx) = FakeStore::new();
        store.fail_next_finishes(100);
        let (rs, _queue, observer) = retrying(&store);
        assert!(rs.finish("s1", "exited", 10, Some(0)).is_err());

        for expected_pending in [1, 1, 1] {
            let report = rs.flush_pending();
            assert_eq!(report.retried, 1);
            assert_eq!(report.dropped, 0);
            assert_eq!(rs.pending_len(), expected_pending);
        }
        let report = rs.flush_pending();
        assert_eq!(report.dropped, 1);
        assert_eq!(rs.pending_len(), 0);
        assert_eq!(
            observer.events(),
            vec![
                ("finish_failed".to_string(), "s1".to_string(), 1),
                ("finish_failed".to_string(), "s1".to_string(), 2),
                ("finish_failed".to_string(), "s1".to_string(), 3),
                ("finish_failed".to_string(), "s1".to_string(), 4),
                ("finish_gave_up".to_string(), "s1".to_string(), 5),
            ]
        );

        let calls_before = store.calls().len();
        let report = rs.flush_pending();
        assert_eq!(report.retried, 0);
        assert_eq!(store.calls().len(), calls_before);
    }

    #[test]
    fn the_queue_is_bounded_and_drops_the_oldest_entry() {
        assert_eq!(MAX_PENDING_FINISHES, 64);
        let (store, _rx) = FakeStore::new();
        store.fail_next_finishes(1000);
        let (rs, _queue, observer) = retrying(&store);

        for index in 0..65 {
            let id = format!("s{index}");
            assert!(rs.finish(&id, "exited", 10, Some(0)).is_err());
        }

        assert_eq!(rs.pending_len(), 64);
        let gave_up: Vec<_> = observer
            .events()
            .into_iter()
            .filter(|(kind, _, _)| kind == "finish_gave_up")
            .collect();
        assert_eq!(
            gave_up,
            vec![("finish_gave_up".to_string(), "s0".to_string(), 1)]
        );

        store.fail_next_finishes(0);
        let calls_before = store.calls().len();
        let report = rs.flush_pending();
        assert_eq!(report.retried, 64);
        assert_eq!(report.succeeded, 64);
        let retried: Vec<String> = store.calls()[calls_before..].to_vec();
        assert_eq!(retried.len(), 64);
        assert!(!retried.contains(&"finish:s0:exited".to_string()));
    }

    #[test]
    fn flush_does_not_hold_the_queue_lock_while_calling_the_store() {
        let (store, _rx) = FakeStore::new();
        store.fail_next_finishes(1);
        let (rs, _queue, _observer) = retrying(&store);
        assert!(rs.finish("s1", "exited", 10, Some(0)).is_err());
        let observed: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let weak = Arc::downgrade(&rs);
            let observed = Arc::clone(&observed);
            store.set_on_finish(move || {
                if let Some(rs) = weak.upgrade() {
                    // Needs the queue lock: it must be free while the store is called.
                    observed.lock().unwrap().push(rs.pending_len());
                }
            });
        }

        let report = {
            let rs = Arc::clone(&rs);
            run_with_timeout(5, move || rs.flush_pending())
        };

        let report = report.expect("flush_pending must not deadlock on the queue lock");
        assert_eq!(report.retried, 1);
        let observed = observed.lock().unwrap().clone();
        assert!(!observed.is_empty(), "the store callback must have run");
        assert!(observed.iter().all(|len| *len <= 1));
    }

    #[test]
    fn the_manager_owns_one_queue_shared_by_every_store_it_hands_out() {
        let observer = Arc::new(RecordingObserver::default());
        let manager = PtySessionManager::with_observer(observer.clone());
        let (store, _rx) = FakeStore::new();
        store.fail_next_finishes(1);
        let inner: Arc<dyn PtySessionStore> = store.clone();
        let first = RetryingStore::new(
            Arc::clone(&inner),
            Arc::clone(&manager.persist_queue),
            observer.clone(),
        );
        let second = RetryingStore::new(inner, Arc::clone(&manager.persist_queue), observer);

        assert!(first.finish("s1", "exited", 10, Some(0)).is_err());

        assert_eq!(second.pending_len(), 1);
        assert_eq!(manager.persist_queue.len(), 1);
        store.fail_next_finishes(0);
        second.flush_pending();
        assert_eq!(first.pending_len(), 0);
    }

    #[test]
    fn the_manager_flushes_queued_finishes_into_the_database() {
        use crate::db::{connection, directory_repo, pty_session_repo};
        use crate::models::tool::ToolKey;

        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        let directory =
            directory_repo::add(&connection, "work", "C:\\Projects\\work", None).unwrap();
        pty_session_repo::insert_running(
            &connection,
            "s1",
            directory.id,
            ToolKey::Claude,
            &directory.path,
            1,
        )
        .unwrap();
        let db = crate::Db::new(connection);
        let manager = PtySessionManager::default();
        // A finish that failed earlier sits in the manager's own queue.
        assert!(manager
            .persist_queue
            .push(PendingFinish {
                session_id: "s1".to_string(),
                state: "exited".to_string(),
                ended_at_ms: 10,
                exit_code: Some(0),
                attempts: 1,
            })
            .is_none());

        let report = manager.flush_pending_persistence(&db);

        assert_eq!(report.retried, 1);
        assert_eq!(report.succeeded, 1);
        assert_eq!(report.dropped, 0);
        assert_eq!(manager.persist_queue.len(), 0);
        let row = db
            .with_sync("test.pty_session.read", |connection| {
                Ok(pty_session_repo::get_by_id(connection, "s1")?)
            })
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "exited");
        assert_eq!(row.ended_at_ms, Some(10));
        assert_eq!(row.exit_code, Some(0));
    }
}
