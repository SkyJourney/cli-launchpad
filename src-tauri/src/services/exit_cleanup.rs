//! Best-effort cleanup on `RunEvent::Exit` (PD-12②).
//!
//! Each target runs on its own thread so one blocked or panicking target cannot stop the others,
//! and the whole cleanup returns within a total budget even if some target never finishes.
//! The clean-exit marker is cleared afterwards in every case, including timeout and panic,
//! because a graceful exit has already been reached at this point.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::services::clean_exit_marker::end_session_cleanly;
use crate::services::storage_service::StoragePaths;
use crate::AppError;

/// Total time budget for the whole exit cleanup. It must exceed the roughly
/// three seconds `PtySessionManager::terminate_all` allows itself internally.
pub const EXIT_CLEANUP_BUDGET: Duration = Duration::from_secs(4);

pub trait ExitCleanupTarget: Send + Sync {
    fn name(&self) -> &'static str;
    fn terminate_all(&self, budget: Duration) -> Result<usize, AppError>;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ExitCleanupReport {
    pub terminated: Vec<(&'static str, usize)>,
    pub failed: Vec<(&'static str, String)>,
    pub timed_out: bool,
}

/// Starts every target on its own thread and collects their results until the total budget ends.
/// A target still running at the deadline is left alone: it is neither terminated nor failed.
pub fn run_exit_cleanup(
    targets: &[Arc<dyn ExitCleanupTarget>],
    total_budget: Duration,
) -> ExitCleanupReport {
    let deadline = Instant::now() + total_budget;
    let (sender, receiver) = mpsc::channel::<(usize, Result<usize, String>)>();
    let mut outcomes: Vec<Option<Result<usize, String>>> =
        (0..targets.len()).map(|_| None).collect();
    let mut pending = 0usize;

    for (index, target) in targets.iter().enumerate() {
        let target = Arc::clone(target);
        let sender = sender.clone();
        let spawned = thread::Builder::new()
            .name(format!("exit-cleanup-{}", target.name()))
            .spawn(move || {
                let outcome =
                    match catch_unwind(AssertUnwindSafe(|| target.terminate_all(total_budget))) {
                        Ok(Ok(count)) => Ok(count),
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(_) => Err("panicked".to_string()),
                    };
                let _ = sender.send((index, outcome));
            });
        match spawned {
            Ok(_) => pending += 1,
            Err(error) => outcomes[index] = Some(Err(format!("spawn failed: {error}"))),
        }
    }
    drop(sender);

    let mut timed_out = false;
    while pending > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok((index, outcome)) => {
                outcomes[index] = Some(outcome);
                pending -= 1;
            }
            Err(RecvTimeoutError::Timeout) => {
                timed_out = true;
                break;
            }
            // Every spawned thread sends its result before it exits, so all senders are only
            // dropped after `pending` reaches zero; this arm is a defensive exit.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let mut report = ExitCleanupReport {
        timed_out,
        ..ExitCleanupReport::default()
    };
    for (index, target) in targets.iter().enumerate() {
        match outcomes[index].take() {
            Some(Ok(count)) => report.terminated.push((target.name(), count)),
            Some(Err(message)) => report.failed.push((target.name(), message)),
            None => {}
        }
    }
    report
}

/// Runs on `RunEvent::Exit`: cleanup first, then clear the clean-exit marker. A timed-out or
/// panicking cleanup still clears the marker, because the app is leaving gracefully either way.
pub fn on_run_event_exit(
    paths: &StoragePaths,
    targets: &[Arc<dyn ExitCleanupTarget>],
    budget: Duration,
) {
    match catch_unwind(AssertUnwindSafe(|| run_exit_cleanup(targets, budget))) {
        Ok(report) => log::info!(
            "exit cleanup finished terminated={:?} failed={:?} timed_out={}",
            report.terminated,
            report.failed,
            report.timed_out
        ),
        Err(_) => log::error!("exit cleanup panicked; clearing the clean-exit marker anyway"),
    }
    end_session_cleanly(paths);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::services::clean_exit_marker::{begin_session, PreviousExit, MARKER_FILE_NAME};
    use crate::services::storage_service::StoragePaths;

    struct FakeTarget {
        name: &'static str,
        remaining: AtomicUsize,
        calls: AtomicUsize,
        fail: bool,
    }

    impl FakeTarget {
        fn new(name: &'static str, remaining: usize) -> Arc<Self> {
            Arc::new(Self {
                name,
                remaining: AtomicUsize::new(remaining),
                calls: AtomicUsize::new(0),
                fail: false,
            })
        }

        fn failing(name: &'static str) -> Arc<Self> {
            Arc::new(Self {
                name,
                remaining: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
                fail: true,
            })
        }
    }

    impl ExitCleanupTarget for FakeTarget {
        fn name(&self) -> &'static str {
            self.name
        }

        fn terminate_all(&self, _budget: Duration) -> Result<usize, AppError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(AppError::msg("boom"));
            }
            Ok(self.remaining.swap(0, Ordering::SeqCst))
        }
    }

    struct BlockingTarget {
        release: Mutex<mpsc::Receiver<()>>,
        started: mpsc::Sender<()>,
        calls: AtomicUsize,
    }

    impl ExitCleanupTarget for BlockingTarget {
        fn name(&self) -> &'static str {
            "blocking"
        }

        fn terminate_all(&self, _budget: Duration) -> Result<usize, AppError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let _ = self.started.send(());
            let _ = self
                .release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5));
            Ok(0)
        }
    }

    /// Returns the target, a sender that releases it, and a receiver that reports it has started.
    fn blocking_target() -> (Arc<BlockingTarget>, mpsc::Sender<()>, mpsc::Receiver<()>) {
        let (release, receiver) = mpsc::channel();
        let (started, started_rx) = mpsc::channel();
        (
            Arc::new(BlockingTarget {
                release: Mutex::new(receiver),
                started,
                calls: AtomicUsize::new(0),
            }),
            release,
            started_rx,
        )
    }

    struct PanickingTarget;

    impl ExitCleanupTarget for PanickingTarget {
        fn name(&self) -> &'static str {
            "panicking"
        }

        fn terminate_all(&self, _budget: Duration) -> Result<usize, AppError> {
            panic!("cleanup exploded")
        }
    }

    /// Records whether the running marker still existed when cleanup reached it.
    struct OrderProbe {
        marker: std::path::PathBuf,
        saw_marker: AtomicBool,
    }

    impl ExitCleanupTarget for OrderProbe {
        fn name(&self) -> &'static str {
            "order_probe"
        }

        fn terminate_all(&self, _budget: Duration) -> Result<usize, AppError> {
            self.saw_marker
                .store(self.marker.exists(), Ordering::SeqCst);
            Ok(1)
        }
    }

    fn as_dyn<T: ExitCleanupTarget + 'static>(target: &Arc<T>) -> Arc<dyn ExitCleanupTarget> {
        Arc::clone(target) as Arc<dyn ExitCleanupTarget>
    }

    fn scenario() -> (tempfile::TempDir, StoragePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = StoragePaths::from_root(dir.path().to_path_buf());
        (dir, paths)
    }

    #[test]
    fn cleanup_terminates_every_target_in_order() {
        let pty = FakeTarget::new("pty", 2);
        let tasks = FakeTarget::new("tasks", 3);
        let targets = [as_dyn(&pty), as_dyn(&tasks)];

        let report = run_exit_cleanup(&targets, Duration::from_secs(3));

        assert_eq!(report.terminated, vec![("pty", 2), ("tasks", 3)]);
        assert!(report.failed.is_empty());
        assert!(!report.timed_out);
        assert_eq!(pty.calls.load(Ordering::SeqCst), 1);
        assert_eq!(tasks.calls.load(Ordering::SeqCst), 1);
        assert_eq!(report.terminated.len(), 2);
    }

    #[test]
    fn cleanup_is_idempotent() {
        let pty = FakeTarget::new("pty", 2);
        let tasks = FakeTarget::new("tasks", 3);
        let targets = [as_dyn(&pty), as_dyn(&tasks)];

        let first = run_exit_cleanup(&targets, Duration::from_secs(3));
        assert_eq!(first.terminated, vec![("pty", 2), ("tasks", 3)]);

        let second = run_exit_cleanup(&targets, Duration::from_secs(3));
        assert_eq!(second.terminated, vec![("pty", 0), ("tasks", 0)]);
        assert!(second.failed.is_empty());
        assert!(!second.timed_out);
        assert_eq!(pty.calls.load(Ordering::SeqCst), 2);
        assert_eq!(tasks.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn cleanup_respects_the_total_budget() {
        let (blocker, release, started) = blocking_target();
        let fast = FakeTarget::new("fast", 1);
        let targets = [as_dyn(&blocker), as_dyn(&fast)];

        let start = Instant::now();
        let report = run_exit_cleanup(&targets, Duration::from_millis(300));
        let elapsed = start.elapsed();
        started
            .recv_timeout(Duration::from_secs(2))
            .expect("the blocking target must have started");
        let _ = release.send(());

        assert!(elapsed < Duration::from_secs(2));
        assert!(report.timed_out);
        assert_eq!(fast.calls.load(Ordering::SeqCst), 1);
        assert!(report.terminated.contains(&("fast", 1)));
        assert_eq!(blocker.calls.load(Ordering::SeqCst), 1);
        assert!(!report
            .terminated
            .iter()
            .any(|(name, _)| *name == "blocking"));
        assert!(!report.failed.iter().any(|(name, _)| *name == "blocking"));
        assert!(report.failed.is_empty());
    }

    #[test]
    fn a_failed_target_does_not_skip_the_others() {
        let first = FakeTarget::failing("first");
        let second = FakeTarget::new("second", 4);
        let targets = [as_dyn(&first), as_dyn(&second)];

        let report = run_exit_cleanup(&targets, Duration::from_secs(3));

        assert_eq!(report.failed, vec![("first", "boom".to_string())]);
        assert_eq!(report.terminated, vec![("second", 4)]);
        assert_eq!(first.calls.load(Ordering::SeqCst), 1);
        assert_eq!(second.calls.load(Ordering::SeqCst), 1);
        assert!(!report.timed_out);
        assert!(!report.terminated.iter().any(|(name, _)| *name == "first"));
    }

    #[test]
    fn exit_event_runs_cleanup_then_clears_the_marker_even_if_cleanup_times_out() {
        // Scenario A: the cleanup order must be "terminate first, clear the marker after".
        {
            let (dir, paths) = scenario();
            assert_eq!(begin_session(&paths, 1), PreviousExit::FirstRun);
            std::fs::write(dir.path().join("project.txt"), "keep").unwrap();
            let probe = Arc::new(OrderProbe {
                marker: paths.data_dir.join(MARKER_FILE_NAME),
                saw_marker: AtomicBool::new(false),
            });
            let targets = [as_dyn(&probe)];

            on_run_event_exit(&paths, &targets, Duration::from_secs(3));

            assert!(probe.saw_marker.load(Ordering::SeqCst));
            assert!(!paths.data_dir.join(MARKER_FILE_NAME).exists());
            assert_eq!(begin_session(&paths, 2), PreviousExit::Clean);
            assert_eq!(
                std::fs::read_to_string(dir.path().join("project.txt")).unwrap(),
                "keep"
            );
        }

        // Scenario B: a blocked target must not prevent the marker from being cleared.
        {
            let (dir, paths) = scenario();
            assert_eq!(begin_session(&paths, 1), PreviousExit::FirstRun);
            std::fs::write(dir.path().join("project.txt"), "keep").unwrap();
            let (blocker, release, _started) = blocking_target();
            let targets = [as_dyn(&blocker)];

            let start = Instant::now();
            on_run_event_exit(&paths, &targets, Duration::from_millis(300));
            let elapsed = start.elapsed();

            assert!(elapsed < Duration::from_secs(2));
            assert!(!paths.data_dir.join(MARKER_FILE_NAME).exists());
            assert_eq!(begin_session(&paths, 2), PreviousExit::Clean);
            let _ = release.send(());
            assert_eq!(
                std::fs::read_to_string(dir.path().join("project.txt")).unwrap(),
                "keep"
            );
        }

        // Scenario C: a panicking target must not prevent the marker from being cleared.
        {
            let (dir, paths) = scenario();
            assert_eq!(begin_session(&paths, 1), PreviousExit::FirstRun);
            std::fs::write(dir.path().join("project.txt"), "keep").unwrap();
            let panicking = Arc::new(PanickingTarget);
            let targets = [as_dyn(&panicking)];

            on_run_event_exit(&paths, &targets, Duration::from_secs(3));

            assert!(!paths.data_dir.join(MARKER_FILE_NAME).exists());
            assert_eq!(begin_session(&paths, 2), PreviousExit::Clean);
            assert_eq!(
                std::fs::read_to_string(dir.path().join("project.txt")).unwrap(),
                "keep"
            );
        }
    }

    #[test]
    fn exit_requested_does_not_run_cleanup_or_clear_the_marker() {
        use crate::services::app_lifecycle::{
            decide_exit_request, AppExitGate, ExitRequestDecision,
        };

        let gate = AppExitGate::default();
        assert_eq!(
            decide_exit_request(&gate, 1, 0, true),
            ExitRequestDecision::PreventAndAskMain {
                pty_count: 1,
                execution_task_count: 0,
            }
        );

        const LIB_RS: &str = include_str!("../lib.rs");
        let run_event = &LIB_RS[LIB_RS.find("fn handle_run_event").unwrap()
            ..LIB_RS.find("fn show_main_window").unwrap()];
        let exit_index = run_event.find("tauri::RunEvent::Exit =>").unwrap();
        let before_exit = &run_event[..exit_index];
        assert!(!before_exit.contains("on_run_event_exit("));
        assert!(!before_exit.contains("run_exit_cleanup("));
        assert!(!before_exit.contains(concat!("end_session_cleanly", "(")));
        assert!(run_event[exit_index..].contains("on_run_event_exit("));
        assert_eq!(LIB_RS.matches("on_run_event_exit(").count(), 1);
    }

    #[test]
    fn real_pty_sessions_are_gone_after_cleanup() {
        use crate::services::pty_session_service::PtySessionManager;
        let manager = PtySessionManager::default();
        let real = manager.insert_test_session_with_child("main", None);
        let targets: Vec<Arc<dyn ExitCleanupTarget>> = vec![Arc::new(manager.clone())];

        let report = run_exit_cleanup(&targets, Duration::from_secs(5));

        assert!(
            report.failed.is_empty(),
            "failed targets: {:?}",
            report.failed
        );
        assert!(!report.timed_out);
        assert!(report
            .terminated
            .iter()
            .any(|(name, count)| *name == "pty_sessions" && *count == 1));
        assert_eq!(manager.active_count(), 0);
        let deadline = Instant::now() + Duration::from_secs(1);
        while !real.exited.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "child process must have exited");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
