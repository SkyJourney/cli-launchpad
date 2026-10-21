//! The single entry for everything that must happen after the application data was
//! replaced wholesale (backup restore, configuration import).
//!
//! `run_data_replacement` is the only place that takes the `DataReplace` permit and the only
//! caller of `after_data_replaced`. The replacement itself runs inside the database lock; every
//! step runs after that lock is released, while the permit is still held.

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};

use rusqlite::Connection;

use crate::db::execution_task_repo;
use crate::services::app_lifecycle::{AppLifecycle, DataReplaceKind, Operation, Phase};
use crate::services::content_window_grants::ContentWindowRevoker;
use crate::{AppError, CacheDb, Db};

/// Tells the main window that the database was replaced (it reloads the workspace).
pub trait RestoreNotifier {
    fn workspace_data_restored(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepName {
    RevokeGrants,
    InvalidateCaches,
    ReconcileExecutionTasks,
    NotifyMainWindow,
}

impl StepName {
    /// The fixed execution order. Grants go first (windows are gone before the main
    /// window reloads), then caches, then execution task rows, then the notification.
    pub const ORDER: [StepName; 4] = [
        StepName::RevokeGrants,
        StepName::InvalidateCaches,
        StepName::ReconcileExecutionTasks,
        StepName::NotifyMainWindow,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            StepName::RevokeGrants => "revoke_grants",
            StepName::InvalidateCaches => "invalidate_caches",
            StepName::ReconcileExecutionTasks => "reconcile_execution_tasks",
            StepName::NotifyMainWindow => "notify_main_window",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    Done,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepResult {
    pub step: StepName,
    /// `Err` carries the failure text (an error message, or `panicked: <message>`).
    pub outcome: Result<StepOutcome, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataReplacedReport {
    pub kind: DataReplaceKind,
    /// Set when the hook refused to run any step (wrong phase or wrong step list).
    pub rejected: Option<String>,
    pub results: Vec<StepResult>,
}

impl DataReplacedReport {
    #[cfg(test)]
    pub fn failed(&self) -> Vec<StepName> {
        self.results
            .iter()
            .filter(|result| result.outcome.is_err())
            .map(|result| result.step)
            .collect()
    }

    pub fn error_of(&self, step: StepName) -> Option<&str> {
        self.results
            .iter()
            .find(|result| result.step == step)
            .and_then(|result| result.outcome.as_ref().err().map(String::as_str))
    }
}

pub trait DataReplacedStep {
    fn name(&self) -> StepName;
    fn run(&self) -> Result<StepOutcome, AppError>;
}

/// Runs the steps after a data replacement. Never returns an error: a refused call is reported
/// in `rejected`, and a failing or panicking step is reported in its `StepResult`.
pub fn after_data_replaced(
    lifecycle: &AppLifecycle,
    kind: DataReplaceKind,
    steps: &[&dyn DataReplacedStep],
) -> DataReplacedReport {
    let expected_phase = match kind {
        DataReplaceKind::RestoreBackup => Phase::Restoring,
        DataReplaceKind::ImportConfig => Phase::Importing,
    };
    let phase = lifecycle.phase();
    if phase != expected_phase {
        let reason = format!(
            "after_data_replaced refused to run: kind={kind:?} requires phase {expected_phase:?} but the application is in {phase:?}"
        );
        log::error!("{reason}");
        return DataReplacedReport {
            kind,
            rejected: Some(reason),
            results: Vec::new(),
        };
    }
    let names: Vec<StepName> = steps.iter().map(|step| step.name()).collect();
    if names != StepName::ORDER {
        let reason = format!(
            "after_data_replaced refused to run: steps must be exactly {:?} in that order, got {names:?}",
            StepName::ORDER
        );
        log::error!("{reason}");
        return DataReplacedReport {
            kind,
            rejected: Some(reason),
            results: Vec::new(),
        };
    }

    let mut results = Vec::with_capacity(steps.len());
    for step in steps {
        let name = step.name();
        let outcome = match catch_unwind(AssertUnwindSafe(|| step.run())) {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(error)) => {
                let message = error.to_string();
                log::error!(
                    "after_data_replaced: step={} kind={kind:?} failed: {message}",
                    name.as_str()
                );
                Err(message)
            }
            Err(payload) => {
                let message = format!("panicked: {}", panic_message(payload.as_ref()));
                log::error!(
                    "after_data_replaced: step={} kind={kind:?} {message}",
                    name.as_str()
                );
                Err(message)
            }
        };
        results.push(StepResult {
            step: name,
            outcome,
        });
    }
    let summary: Vec<String> = results
        .iter()
        .map(|result| match &result.outcome {
            Ok(StepOutcome::Done) => format!("{}:done", result.step.as_str()),
            Ok(StepOutcome::Skipped) => format!("{}:skipped", result.step.as_str()),
            Err(_) => format!("{}:failed", result.step.as_str()),
        })
        .collect();
    log::info!("after_data_replaced: kind={kind:?} {}", summary.join(","));
    DataReplacedReport {
        kind,
        rejected: None,
        results,
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "unknown panic".to_string()
    }
}

pub enum ReplacementFlavour<'a> {
    RestoreBackup {
        cache: &'a CacheDb,
        notifier: &'a dyn RestoreNotifier,
    },
    ImportConfig,
}

impl ReplacementFlavour<'_> {
    pub fn kind(&self) -> DataReplaceKind {
        match self {
            ReplacementFlavour::RestoreBackup { .. } => DataReplaceKind::RestoreBackup,
            ReplacementFlavour::ImportConfig => DataReplaceKind::ImportConfig,
        }
    }
}

pub struct DataReplacementContext<'a> {
    pub flavour: ReplacementFlavour<'a>,
    pub lifecycle: &'a AppLifecycle,
    pub db: &'a Db,
    pub revoker: &'a ContentWindowRevoker<'a>,
}

pub struct DataReplacement<T> {
    pub value: T,
    pub report: DataReplacedReport,
}

/// The only replacement entry point. Admission comes first (before any database lock), the
/// replacement runs inside the database lock, and the steps run after that lock is released.
/// An error from `replace` means nothing was replaced, so no step runs.
pub fn run_data_replacement<T>(
    ctx: &DataReplacementContext<'_>,
    replace: impl FnOnce(&mut Connection) -> Result<T, AppError>,
) -> Result<DataReplacement<T>, AppError> {
    let kind = ctx.flavour.kind();
    // Admission first, before any database lock is taken.
    let _permit = ctx.lifecycle.admit(Operation::DataReplace(kind))?;
    let value = ctx.db.with_sync("app_data.replace", replace)?;
    // Every step runs outside the database lock; the permit is held until this function returns.
    let steps = standard_steps(ctx);
    let step_refs: Vec<&dyn DataReplacedStep> = steps.iter().map(|step| step.as_ref()).collect();
    let report = after_data_replaced(ctx.lifecycle, kind, &step_refs);
    Ok(DataReplacement { value, report })
}

struct RevokeAllGrantsStep<'a>(&'a ContentWindowRevoker<'a>);

impl DataReplacedStep for RevokeAllGrantsStep<'_> {
    fn name(&self) -> StepName {
        StepName::RevokeGrants
    }
    fn run(&self) -> Result<StepOutcome, AppError> {
        // Never fails: a window that cannot be destroyed is only logged by the revoker.
        let _report = self.0.revoke_all();
        Ok(StepOutcome::Done)
    }
}

struct RevokeStaleGrantsStep<'a> {
    revoker: &'a ContentWindowRevoker<'a>,
    db: &'a Db,
}

impl DataReplacedStep for RevokeStaleGrantsStep<'_> {
    fn name(&self) -> StepName {
        StepName::RevokeGrants
    }
    fn run(&self) -> Result<StepOutcome, AppError> {
        self.revoker.revoke_stale_for_database(self.db)?;
        Ok(StepOutcome::Done)
    }
}

struct InvalidateCachesStep<'a>(&'a CacheDb);

impl DataReplacedStep for InvalidateCachesStep<'_> {
    fn name(&self) -> StepName {
        StepName::InvalidateCaches
    }
    fn run(&self) -> Result<StepOutcome, AppError> {
        // Targeted cleanup first; the whole cache only when that fails. Only a failure of both
        // levels is an error (the same text the restore returned as `cache_warning`).
        let outcome = self.0.with_sync("app_data.invalidate_caches", |connection| {
            let targeted =
                crate::services::cache_service::invalidate_after_data_replaced(connection);
            if let Err(targeted_error) = targeted {
                log::warn!(
                    "backup restore: targeted cache cleanup failed, clearing the whole cache: {targeted_error}"
                );
                if let Err(clear_error) = crate::services::cache_service::clear(connection) {
                    return Ok(Some(format!("缓存清理失败：{clear_error}")));
                }
            }
            Ok(None)
        });
        match outcome {
            Ok(None) => Ok(StepOutcome::Done),
            Ok(Some(warning)) => Err(AppError::internal(warning)),
            Err(lock_error) => Err(AppError::internal(format!("缓存清理失败：{lock_error}"))),
        }
    }
}

struct ReconcileExecutionTasksStep<'a> {
    db: &'a Db,
    lifecycle: &'a AppLifecycle,
}

impl DataReplacedStep for ReconcileExecutionTasksStep<'_> {
    fn name(&self) -> StepName {
        StepName::ReconcileExecutionTasks
    }
    fn run(&self) -> Result<StepOutcome, AppError> {
        let active = self.lifecycle.activity().exec;
        if active != 0 {
            // A live task must never be marked interrupted; the permit normally guarantees 0.
            return Err(AppError::internal(format!(
                "活动执行任务数为 {active}，跳过执行任务状态核对"
            )));
        }
        let interrupted =
            self.db
                .with_sync("app_data.reconcile_execution_tasks", |connection| {
                    Ok(execution_task_repo::mark_unfinished_interrupted(
                        connection,
                        crate::util::time::now_ms(),
                    )?)
                })?;
        if interrupted != 0 {
            log::warn!(
                "data replaced: marked {interrupted} unfinished execution task(s) as interrupted"
            );
        }
        Ok(StepOutcome::Done)
    }
}

struct NotifyMainWindowStep<'a>(&'a dyn RestoreNotifier);

impl DataReplacedStep for NotifyMainWindowStep<'_> {
    fn name(&self) -> StepName {
        StepName::NotifyMainWindow
    }
    fn run(&self) -> Result<StepOutcome, AppError> {
        self.0
            .workspace_data_restored()
            .map_err(AppError::internal)?;
        Ok(StepOutcome::Done)
    }
}

struct SkippedStep(StepName);

impl DataReplacedStep for SkippedStep {
    fn name(&self) -> StepName {
        self.0
    }
    fn run(&self) -> Result<StepOutcome, AppError> {
        Ok(StepOutcome::Skipped)
    }
}

/// The two flows differ only in which steps they run; the order is always `StepName::ORDER`.
fn standard_steps<'a>(ctx: &DataReplacementContext<'a>) -> Vec<Box<dyn DataReplacedStep + 'a>> {
    match &ctx.flavour {
        ReplacementFlavour::RestoreBackup { cache, notifier } => vec![
            Box::new(RevokeAllGrantsStep(ctx.revoker)),
            Box::new(InvalidateCachesStep(cache)),
            Box::new(ReconcileExecutionTasksStep {
                db: ctx.db,
                lifecycle: ctx.lifecycle,
            }),
            Box::new(NotifyMainWindowStep(*notifier)),
        ],
        ReplacementFlavour::ImportConfig => vec![
            Box::new(RevokeStaleGrantsStep {
                revoker: ctx.revoker,
                db: ctx.db,
            }),
            Box::new(SkippedStep(StepName::InvalidateCaches)),
            Box::new(SkippedStep(StepName::ReconcileExecutionTasks)),
            Box::new(SkippedStep(StepName::NotifyMainWindow)),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};

    use crate::db::connection;
    use crate::models::execution::ExecutionStatus;
    use crate::services::content_window_grants::{
        test_support::RecordingReclaimer, ContentWindowFileGrant, ContentWindowGrantRegistry,
        ContentWindowRevoker, RevocationReason,
    };

    const LABEL_A: &str = "workspace-content-11111111-2222-4333-8444-555555555555";

    fn memory_db() -> Db {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection::apply_migrations(&connection).unwrap();
        Db::new(connection)
    }

    fn cache_db() -> CacheDb {
        CacheDb::new(crate::db::cache_connection::init_ephemeral_cache().unwrap())
    }

    /// Lifecycle whose activity probes read shared counters (m6-031).
    fn lifecycle(pty: usize, exec: usize) -> (AppLifecycle, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let pty = Arc::new(AtomicUsize::new(pty));
        let exec = Arc::new(AtomicUsize::new(exec));
        (
            AppLifecycle::with_counters(pty.clone(), exec.clone()),
            pty,
            exec,
        )
    }

    /// A step that records its name, optionally fails or panics.
    struct Probe {
        name: StepName,
        log: Arc<Mutex<Vec<&'static str>>>,
        behaviour: Behaviour,
    }

    #[derive(Clone, Copy)]
    enum Behaviour {
        Succeed,
        Fail,
        Panic,
    }

    impl DataReplacedStep for Probe {
        fn name(&self) -> StepName {
            self.name
        }
        fn run(&self) -> Result<StepOutcome, AppError> {
            self.log.lock().unwrap().push(self.name.as_str());
            match self.behaviour {
                Behaviour::Succeed => Ok(StepOutcome::Done),
                Behaviour::Fail => {
                    Err(AppError::internal(format!("{} failed", self.name.as_str())))
                }
                Behaviour::Panic => panic!("boom in {}", self.name.as_str()),
            }
        }
    }

    fn probes(log: &Arc<Mutex<Vec<&'static str>>>, behaviours: [Behaviour; 4]) -> Vec<Probe> {
        StepName::ORDER
            .into_iter()
            .zip(behaviours)
            .map(|(name, behaviour)| Probe {
                name,
                log: log.clone(),
                behaviour,
            })
            .collect()
    }

    fn as_refs(steps: &[Probe]) -> Vec<&dyn DataReplacedStep> {
        steps
            .iter()
            .map(|step| step as &dyn DataReplacedStep)
            .collect()
    }

    /// Counts calls; optionally fails.
    struct CountingNotifier {
        calls: AtomicUsize,
        fail: bool,
    }

    impl RestoreNotifier for CountingNotifier {
        fn workspace_data_restored(&self) -> Result<(), String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                Err("window gone".to_string())
            } else {
                Ok(())
            }
        }
    }

    /// Signals `entered`, then blocks until `release` yields (never sleeps).
    struct BlockingNotifier {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl RestoreNotifier for BlockingNotifier {
        fn workspace_data_restored(&self) -> Result<(), String> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(())
        }
    }

    fn grant_for(directory_id: i64, path: &str) -> ContentWindowFileGrant {
        ContentWindowFileGrant {
            directory_id,
            directory_path: path.to_string(),
            relative_path: "a.md".to_string(),
        }
    }

    #[test]
    fn steps_run_in_the_fixed_order_and_every_step_is_reported() {
        let (lifecycle, _, _) = lifecycle(0, 0);
        let _permit = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
            .unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let steps = probes(&log, [Behaviour::Succeed; 4]);

        let report =
            after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &as_refs(&steps));

        assert!(report.rejected.is_none());
        assert_eq!(
            *log.lock().unwrap(),
            vec![
                "revoke_grants",
                "invalidate_caches",
                "reconcile_execution_tasks",
                "notify_main_window"
            ]
        );
        assert_eq!(report.results.len(), 4);
        assert!(report
            .results
            .iter()
            .all(|result| result.outcome == Ok(StepOutcome::Done)));
        assert!(report.failed().is_empty());
        assert_eq!(report.kind, DataReplaceKind::RestoreBackup);
    }

    #[test]
    fn a_permuted_or_incomplete_step_list_runs_nothing() {
        let (lifecycle, _, _) = lifecycle(0, 0);
        let _permit = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
            .unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let all = probes(&log, [Behaviour::Succeed; 4]);
        let permuted = vec![
            Probe {
                name: StepName::NotifyMainWindow,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
            Probe {
                name: StepName::RevokeGrants,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
            Probe {
                name: StepName::InvalidateCaches,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
            Probe {
                name: StepName::ReconcileExecutionTasks,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
        ];
        let incomplete = &all[..3];
        let duplicated = vec![
            Probe {
                name: StepName::RevokeGrants,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
            Probe {
                name: StepName::RevokeGrants,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
            Probe {
                name: StepName::InvalidateCaches,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
            Probe {
                name: StepName::NotifyMainWindow,
                log: log.clone(),
                behaviour: Behaviour::Succeed,
            },
        ];

        for steps in [
            as_refs(&permuted),
            as_refs(incomplete),
            as_refs(&duplicated),
        ] {
            let report = after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &steps);
            let reason = report.rejected.expect("a wrong step list is refused");
            assert!(reason.contains("steps must be exactly"), "{reason}");
            assert!(report.results.is_empty());
        }
        assert!(log.lock().unwrap().is_empty(), "no step may run");

        // Reverse: the correct order runs.
        let report =
            after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &as_refs(&all));
        assert!(report.rejected.is_none());
        assert_eq!(log.lock().unwrap().len(), 4);
    }

    #[test]
    fn a_failing_step_does_not_stop_the_remaining_steps() {
        let (lifecycle, _, _) = lifecycle(0, 0);
        let _permit = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
            .unwrap();
        for index in 0..4 {
            let log = Arc::new(Mutex::new(Vec::new()));
            let behaviours: [Behaviour; 4] = std::array::from_fn(|position| {
                if position == index {
                    Behaviour::Fail
                } else {
                    Behaviour::Succeed
                }
            });
            let steps = probes(&log, behaviours);

            let report =
                after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &as_refs(&steps));

            let failing = StepName::ORDER[index];
            assert_eq!(report.failed(), vec![failing]);
            assert_eq!(
                *log.lock().unwrap(),
                vec![
                    "revoke_grants",
                    "invalidate_caches",
                    "reconcile_execution_tasks",
                    "notify_main_window"
                ]
            );
            assert_eq!(
                report.error_of(failing),
                Some(format!("{} failed", failing.as_str()).as_str())
            );
            assert!(report.rejected.is_none());
        }
    }

    #[test]
    fn a_panicking_step_is_isolated_and_reported() {
        let (lifecycle, _, _) = lifecycle(0, 0);
        let _permit = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
            .unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let steps = probes(
            &log,
            [
                Behaviour::Succeed,
                Behaviour::Panic,
                Behaviour::Succeed,
                Behaviour::Succeed,
            ],
        );

        let report =
            after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &as_refs(&steps));

        assert_eq!(report.failed(), vec![StepName::InvalidateCaches]);
        let text = report
            .error_of(StepName::InvalidateCaches)
            .expect("the panicking step is reported");
        assert!(
            text.contains("panicked") && text.contains("boom in invalidate_caches"),
            "{text}"
        );
        assert_eq!(
            *log.lock().unwrap(),
            vec![
                "revoke_grants",
                "invalidate_caches",
                "reconcile_execution_tasks",
                "notify_main_window"
            ]
        );
        assert!(report.error_of(StepName::NotifyMainWindow).is_none());
    }

    #[test]
    fn the_hook_refuses_to_run_outside_a_matching_data_replace_permit() {
        // Scenario 1: no permit at all (phase Running).
        {
            let (lifecycle, _, _) = lifecycle(0, 0);
            let log = Arc::new(Mutex::new(Vec::new()));
            let steps = probes(&log, [Behaviour::Succeed; 4]);
            let report =
                after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &as_refs(&steps));
            let reason = report.rejected.expect("refused without a permit");
            assert!(
                reason.contains("refused to run") && reason.contains("Running"),
                "{reason}"
            );
            assert!(report.results.is_empty());
            assert!(log.lock().unwrap().is_empty());
            assert_eq!(
                lifecycle.phase(),
                Phase::Running,
                "the hook does not change the phase"
            );
        }
        // Scenario 2: an ImportConfig permit does not satisfy RestoreBackup (phase Importing).
        {
            let (lifecycle, _, _) = lifecycle(0, 0);
            let _permit = lifecycle
                .admit(Operation::DataReplace(DataReplaceKind::ImportConfig))
                .unwrap();
            let log = Arc::new(Mutex::new(Vec::new()));
            let steps = probes(&log, [Behaviour::Succeed; 4]);
            let report =
                after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &as_refs(&steps));
            let reason = report.rejected.expect("refused under the import permit");
            assert!(
                reason.contains("refused to run") && reason.contains("Importing"),
                "{reason}"
            );
            assert!(report.results.is_empty());
            assert!(log.lock().unwrap().is_empty());
        }
        // Scenario 3: the matching permit runs everything.
        {
            let (lifecycle, _, _) = lifecycle(0, 0);
            let _permit = lifecycle
                .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
                .unwrap();
            let log = Arc::new(Mutex::new(Vec::new()));
            let steps = probes(&log, [Behaviour::Succeed; 4]);
            let report =
                after_data_replaced(&lifecycle, DataReplaceKind::RestoreBackup, &as_refs(&steps));
            assert!(report.rejected.is_none());
            assert_eq!(log.lock().unwrap().len(), 4);
        }
    }

    /// Creates an execution task row with the given status (copied from the repository tests).
    fn insert_task(connection: &Connection, id: &str, status: ExecutionStatus) {
        let plan = crate::models::install::InstallPlan {
            tool_key: crate::models::tool::ToolKey::Codex,
            kind: crate::models::install::InstallKind::Update,
            program: "C:\\codex.exe".to_string(),
            args: vec!["update".to_string()],
            fingerprint: "test-fingerprint".to_string(),
            source: "test".to_string(),
            preview: "C:\\codex.exe update".to_string(),
        };
        execution_task_repo::insert(connection, id, &plan, 1).unwrap();
        if status != ExecutionStatus::Preparing {
            execution_task_repo::update_status(connection, id, status, None, None, None).unwrap();
        }
    }

    fn task_status(connection: &Connection, id: &str) -> String {
        execution_task_repo::get(connection, id)
            .unwrap()
            .unwrap()
            .status
            .as_str()
            .to_string()
    }

    /// Writes one session-search document for `directory_id` (copied from cache_service tests).
    fn index_one_document(connection: &Connection, directory_id: i64) {
        crate::db::session_search_repo::refresh(
            connection,
            directory_id,
            &[crate::models::session::SessionSearchIndexSource {
                tool_key: crate::models::tool::ToolKey::Claude,
                documents: Some(vec![crate::models::session::SessionSearchIndexDocument {
                    tool_key: crate::models::tool::ToolKey::Claude,
                    session_id: "s1".to_string(),
                    title: "query title".to_string(),
                    last_active_ms: Some(1),
                    fields: vec!["query title".to_string()],
                }]),
                incomplete: false,
            }],
        )
        .unwrap();
    }

    fn search_count(connection: &Connection, directory_id: i64) -> usize {
        crate::db::session_search_repo::search(
            connection,
            directory_id,
            "query",
            &std::collections::HashMap::new(),
        )
        .unwrap()
        .items
        .len()
    }

    /// Fills the cache with one live key and one search document per directory 1 and 2.
    fn seed_cache(cache: &CacheDb) {
        let conn = cache.lock_for_test();
        crate::services::cache_service::put(
            &crate::runtime::CacheConn::for_test(&conn),
            &crate::models::cache::CacheKey::CliStatusAll,
            &"live-all",
        )
        .unwrap();
        index_one_document(&conn, 1);
        index_one_document(&conn, 2);
    }

    #[test]
    fn import_runs_only_the_grant_step_and_restore_runs_all_four() {
        // Restore: every step runs and the report carries the real effects.
        {
            let db = memory_db();
            let cache = cache_db();
            seed_cache(&cache);
            {
                let conn = db.lock_for_test();
                insert_task(&conn, "t-run", ExecutionStatus::Running);
            }
            let registry = ContentWindowGrantRegistry::default();
            registry.grant(LABEL_A, grant_for(9999, "C:/gone")).unwrap();
            let reclaimer = RecordingReclaimer::default();
            let revoker =
                ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::RestoreBackup);
            let notifier = CountingNotifier {
                calls: AtomicUsize::new(0),
                fail: false,
            };
            let (lifecycle, _, _) = lifecycle(0, 0);
            let ctx = DataReplacementContext {
                flavour: ReplacementFlavour::RestoreBackup {
                    cache: &cache,
                    notifier: &notifier,
                },
                lifecycle: &lifecycle,
                db: &db,
                revoker: &revoker,
            };

            let replaced = run_data_replacement(&ctx, |_conn| Ok(())).unwrap();

            assert_eq!(
                replaced.report.results,
                vec![
                    StepResult {
                        step: StepName::RevokeGrants,
                        outcome: Ok(StepOutcome::Done)
                    },
                    StepResult {
                        step: StepName::InvalidateCaches,
                        outcome: Ok(StepOutcome::Done)
                    },
                    StepResult {
                        step: StepName::ReconcileExecutionTasks,
                        outcome: Ok(StepOutcome::Done)
                    },
                    StepResult {
                        step: StepName::NotifyMainWindow,
                        outcome: Ok(StepOutcome::Done)
                    },
                ]
            );
            assert!(registry.get(LABEL_A).is_err());
            assert_eq!(reclaimer.reclaimed(), vec![LABEL_A.to_string()]);
            {
                let conn = cache.lock_for_test();
                assert_eq!(search_count(&conn, 1), 0);
                assert_eq!(search_count(&conn, 2), 0);
                assert!(crate::services::cache_service::get_any::<String>(
                    &crate::runtime::CacheConn::for_test(&conn),
                    &crate::models::cache::CacheKey::CliStatusAll,
                )
                .unwrap()
                .is_some());
            }
            assert_eq!(task_status(&db.lock_for_test(), "t-run"), "interrupted");
            assert_eq!(notifier.calls.load(Ordering::SeqCst), 1);
        }
        // Import: only the grant step runs; caches, tasks and the window are untouched.
        {
            let db = memory_db();
            let cache = cache_db();
            seed_cache(&cache);
            {
                let conn = db.lock_for_test();
                insert_task(&conn, "t-run", ExecutionStatus::Running);
            }
            let registry = ContentWindowGrantRegistry::default();
            registry.grant(LABEL_A, grant_for(9999, "C:/gone")).unwrap();
            let reclaimer = RecordingReclaimer::default();
            let revoker =
                ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::ImportConfig);
            let notifier = CountingNotifier {
                calls: AtomicUsize::new(0),
                fail: false,
            };
            let (lifecycle, _, _) = lifecycle(0, 0);
            let ctx = DataReplacementContext {
                flavour: ReplacementFlavour::ImportConfig,
                lifecycle: &lifecycle,
                db: &db,
                revoker: &revoker,
            };

            let replaced = run_data_replacement(&ctx, |_conn| Ok(())).unwrap();

            let outcomes: Vec<_> = replaced
                .report
                .results
                .iter()
                .map(|result| result.outcome.clone())
                .collect();
            assert_eq!(
                outcomes,
                vec![
                    Ok(StepOutcome::Done),
                    Ok(StepOutcome::Skipped),
                    Ok(StepOutcome::Skipped),
                    Ok(StepOutcome::Skipped),
                ]
            );
            assert!(registry.get(LABEL_A).is_err());
            // Reverse: the import clears nothing, reconciles nothing and notifies nobody.
            {
                let conn = cache.lock_for_test();
                assert_eq!(search_count(&conn, 1), 1);
                assert_eq!(search_count(&conn, 2), 1);
            }
            assert_eq!(task_status(&db.lock_for_test(), "t-run"), "running");
            assert_eq!(notifier.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn the_cache_step_degrades_to_a_full_clear_and_only_errors_when_both_levels_fail() {
        // Healthy cache: the targeted cleanup succeeds; the live key stays.
        {
            let cache = cache_db();
            seed_cache(&cache);
            let step = InvalidateCachesStep(&cache);
            assert_eq!(step.run().unwrap(), StepOutcome::Done);
            let conn = cache.lock_for_test();
            assert_eq!(search_count(&conn, 1), 0);
            assert_eq!(search_count(&conn, 2), 0);
            assert!(crate::services::cache_service::get_any::<String>(
                &crate::runtime::CacheConn::for_test(&conn),
                &crate::models::cache::CacheKey::CliStatusAll,
            )
            .unwrap()
            .is_some());
        }
        // Broken search table: both levels fail, so the step reports it.
        {
            let cache = cache_db();
            seed_cache(&cache);
            cache
                .with_sync("test.drop_search", |conn| {
                    conn.execute("drop table session_search_documents", [])
                        .unwrap();
                    Ok(())
                })
                .unwrap();
            let error = InvalidateCachesStep(&cache).run().unwrap_err();
            assert!(error.to_string().contains("缓存清理失败"), "{error}");
        }
    }

    #[test]
    fn execution_reconcile_interrupts_only_unfinished_rows_and_never_with_live_tasks() {
        let db = memory_db();
        {
            let conn = db.lock_for_test();
            insert_task(&conn, "t-prep", ExecutionStatus::Preparing);
            insert_task(&conn, "t-run", ExecutionStatus::Running);
            insert_task(&conn, "t-cancel", ExecutionStatus::Cancelling);
            insert_task(&conn, "t-done", ExecutionStatus::Succeeded);
            execution_task_repo::update_status(
                &conn,
                "t-done",
                ExecutionStatus::Succeeded,
                Some(50),
                Some(0),
                None,
            )
            .unwrap();
        }
        let (lifecycle, _, exec) = lifecycle(0, 0);
        let step = ReconcileExecutionTasksStep {
            db: &db,
            lifecycle: &lifecycle,
        };

        // 1. No live task: the three unfinished rows become interrupted, the finished row stays.
        assert_eq!(step.run().unwrap(), StepOutcome::Done);
        {
            let conn = db.lock_for_test();
            for id in ["t-prep", "t-run", "t-cancel"] {
                let row = execution_task_repo::get(&conn, id).unwrap().unwrap();
                assert_eq!(row.status.as_str(), "interrupted", "{id}");
                assert!(row.finished_at_ms.is_some(), "{id}");
                assert_eq!(
                    row.error_message.as_deref(),
                    Some("应用退出时任务尚未结束"),
                    "{id}"
                );
            }
            let done = execution_task_repo::get(&conn, "t-done").unwrap().unwrap();
            assert_eq!(done.status.as_str(), "succeeded");
            assert_eq!(done.finished_at_ms, Some(50));
        }

        // 2. A live task: nothing is changed and the step fails.
        {
            let conn = db.lock_for_test();
            insert_task(&conn, "t-run2", ExecutionStatus::Running);
        }
        exec.store(1, Ordering::SeqCst);
        let error = step.run().unwrap_err();
        assert!(error.to_string().contains("活动执行任务数为 1"), "{error}");
        assert_eq!(task_status(&db.lock_for_test(), "t-run2"), "running");

        // 3. The live task ends: the next run interrupts it.
        exec.store(0, Ordering::SeqCst);
        assert_eq!(step.run().unwrap(), StepOutcome::Done);
        assert_eq!(task_status(&db.lock_for_test(), "t-run2"), "interrupted");
    }

    #[test]
    fn the_data_replace_permit_covers_the_whole_hook() {
        let db = memory_db();
        let cache = cache_db();
        let (lifecycle, _, _) = lifecycle(0, 0);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            // Owned by this closure: a panic here drops it, which unblocks the worker and ends the test.
            let release_tx = release_tx;
            // The notifier, revoker and context are built on the worker thread: they hold
            // trait objects that are not Send, and only the channels cross the thread boundary.
            let worker = scope.spawn(|| {
                let registry = ContentWindowGrantRegistry::default();
                let reclaimer = RecordingReclaimer::default();
                let revoker = ContentWindowRevoker::new(
                    &registry,
                    &reclaimer,
                    RevocationReason::RestoreBackup,
                );
                let notifier = BlockingNotifier {
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                };
                let ctx = DataReplacementContext {
                    flavour: ReplacementFlavour::RestoreBackup {
                        cache: &cache,
                        notifier: &notifier,
                    },
                    lifecycle: &lifecycle,
                    db: &db,
                    revoker: &revoker,
                };
                run_data_replacement(&ctx, |_conn| Ok(())).unwrap()
            });
            // The hook has reached the last step and the notifier is blocked.
            entered_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .expect("the hook never started");

            assert_eq!(lifecycle.phase(), Phase::Restoring);
            let pty = lifecycle.admit(Operation::PtyStart).unwrap_err();
            assert_eq!(pty.code(), "backup.restore_in_progress");
            let exec = lifecycle.admit(Operation::ExecStart).unwrap_err();
            assert_eq!(exec.code(), "backup.restore_in_progress");
            let replace = lifecycle
                .admit(Operation::DataReplace(DataReplaceKind::ImportConfig))
                .unwrap_err();
            assert_eq!(replace.code(), "app.data_replace_in_progress");
            let exit = lifecycle.admit(Operation::Exit).unwrap_err();
            assert_eq!(exit.code(), "app.exit_deferred");

            release_tx.send(()).unwrap();
            let replaced = worker.join().unwrap();
            assert!(replaced.report.failed().is_empty());
        });
        assert_eq!(lifecycle.phase(), Phase::Running);
    }

    #[test]
    fn a_second_replacement_is_rejected_while_the_hook_runs_and_never_reruns_it() {
        let db = memory_db();
        let cache = cache_db();
        let (lifecycle, _, _) = lifecycle(0, 0);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let second_replace_calls = AtomicUsize::new(0);

        std::thread::scope(|scope| {
            // Owned by this closure: a panic here drops it, which unblocks the worker and ends the test.
            let release_tx = release_tx;
            let worker = scope.spawn(|| {
                let registry = ContentWindowGrantRegistry::default();
                let reclaimer = RecordingReclaimer::default();
                let revoker = ContentWindowRevoker::new(
                    &registry,
                    &reclaimer,
                    RevocationReason::RestoreBackup,
                );
                let notifier = BlockingNotifier {
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                };
                let ctx = DataReplacementContext {
                    flavour: ReplacementFlavour::RestoreBackup {
                        cache: &cache,
                        notifier: &notifier,
                    },
                    lifecycle: &lifecycle,
                    db: &db,
                    revoker: &revoker,
                };
                run_data_replacement(&ctx, |_conn| Ok(())).unwrap()
            });
            entered_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .expect("the hook never started");

            // The second replacement is refused before its closure can run.
            let registry = ContentWindowGrantRegistry::default();
            let reclaimer = RecordingReclaimer::default();
            let revoker =
                ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::ImportConfig);
            let second_ctx = DataReplacementContext {
                flavour: ReplacementFlavour::ImportConfig,
                lifecycle: &lifecycle,
                db: &db,
                revoker: &revoker,
            };
            let rejected = run_data_replacement(&second_ctx, |_conn| {
                second_replace_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
            assert_eq!(
                rejected.err().unwrap().code(),
                "app.data_replace_in_progress"
            );
            assert_eq!(second_replace_calls.load(Ordering::SeqCst), 0);

            release_tx.send(()).unwrap();
            let replaced = worker.join().unwrap();
            assert!(replaced.report.failed().is_empty());
            assert_eq!(replaced.report.results.len(), 4);
        });

        // Reverse: once the first replacement has finished the permit is free again.
        let registry = ContentWindowGrantRegistry::default();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::ImportConfig);
        let second_ctx = DataReplacementContext {
            flavour: ReplacementFlavour::ImportConfig,
            lifecycle: &lifecycle,
            db: &db,
            revoker: &revoker,
        };
        let again = run_data_replacement(&second_ctx, |_conn| {
            second_replace_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        assert!(again.report.rejected.is_none());
        assert_eq!(second_replace_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_replacement_does_not_run_the_hook_and_releases_the_permit() {
        let db = memory_db();
        let cache = cache_db();
        seed_cache(&cache);
        {
            let conn = db.lock_for_test();
            insert_task(&conn, "t-run", ExecutionStatus::Running);
        }
        let registry = ContentWindowGrantRegistry::default();
        registry.grant(LABEL_A, grant_for(1, "C:/a")).unwrap();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::RestoreBackup);
        let notifier = CountingNotifier {
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let (lifecycle, _, _) = lifecycle(0, 0);
        let ctx = DataReplacementContext {
            flavour: ReplacementFlavour::RestoreBackup {
                cache: &cache,
                notifier: &notifier,
            },
            lifecycle: &lifecycle,
            db: &db,
            revoker: &revoker,
        };

        let error = run_data_replacement(&ctx, |_conn| {
            Err::<(), _>(AppError::internal("replace failed"))
        })
        .err()
        .expect("a failed replacement is an error");
        assert!(error.to_string().contains("replace failed"), "{error}");
        assert_eq!(notifier.calls.load(Ordering::SeqCst), 0);
        assert!(registry.get(LABEL_A).is_ok(), "no grant is revoked");
        assert!(reclaimer.reclaimed().is_empty());
        {
            let conn = cache.lock_for_test();
            assert_eq!(search_count(&conn, 1), 1);
            assert_eq!(search_count(&conn, 2), 1);
        }
        assert_eq!(task_status(&db.lock_for_test(), "t-run"), "running");
        assert_eq!(lifecycle.phase(), Phase::Running);
        assert!(
            lifecycle.admit(Operation::PtyStart).is_ok(),
            "the permit was released"
        );

        // Reverse: a successful replacement afterwards runs all four steps.
        let replaced = run_data_replacement(&ctx, |_conn| Ok(())).unwrap();
        assert!(replaced
            .report
            .results
            .iter()
            .all(|result| result.outcome == Ok(StepOutcome::Done)));
        assert_eq!(notifier.calls.load(Ordering::SeqCst), 1);
    }

    /// Records the lock state of both databases at the moment it is called.
    type LockLog = Arc<Mutex<Vec<(&'static str, bool, bool)>>>;

    struct LockProbeReclaimer {
        db: Arc<Mutex<Connection>>,
        cache: Arc<Mutex<Connection>>,
        log: LockLog,
    }

    impl crate::services::content_window_grants::ContentWindowReclaimer for LockProbeReclaimer {
        fn reclaim(&self, _label: &str) -> Result<(), String> {
            let db_free = self.db.try_lock().is_ok();
            let cache_free = self.cache.try_lock().is_ok();
            self.log
                .lock()
                .unwrap()
                .push(("reclaim", db_free, cache_free));
            Ok(())
        }
    }

    struct LockProbeNotifier {
        db: Arc<Mutex<Connection>>,
        cache: Arc<Mutex<Connection>>,
        log: LockLog,
    }

    impl RestoreNotifier for LockProbeNotifier {
        fn workspace_data_restored(&self) -> Result<(), String> {
            let db_free = self.db.try_lock().is_ok();
            let cache_free = self.cache.try_lock().is_ok();
            self.log
                .lock()
                .unwrap()
                .push(("notify", db_free, cache_free));
            Ok(())
        }
    }

    #[test]
    fn no_database_or_cache_lock_is_held_while_grants_are_revoked_or_the_main_window_is_notified() {
        let db = memory_db();
        let cache = cache_db();
        let shared_db = db.shared_for_test();
        let shared_cache = cache.shared_for_test();
        let registry = ContentWindowGrantRegistry::default();
        registry.grant(LABEL_A, grant_for(1, "C:/a")).unwrap();
        let log: LockLog = Arc::new(Mutex::new(Vec::new()));
        let reclaimer = LockProbeReclaimer {
            db: shared_db.clone(),
            cache: shared_cache.clone(),
            log: log.clone(),
        };
        let notifier = LockProbeNotifier {
            db: shared_db.clone(),
            cache: shared_cache.clone(),
            log: log.clone(),
        };
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::RestoreBackup);
        let (lifecycle, _, _) = lifecycle(0, 0);
        let ctx = DataReplacementContext {
            flavour: ReplacementFlavour::RestoreBackup {
                cache: &cache,
                notifier: &notifier,
            },
            lifecycle: &lifecycle,
            db: &db,
            revoker: &revoker,
        };

        run_data_replacement(&ctx, |_conn| Ok(())).unwrap();

        assert_eq!(
            *log.lock().unwrap(),
            vec![("reclaim", true, true), ("notify", true, true)]
        );
    }

    #[test]
    fn step_failures_never_change_the_return_value() {
        let db = memory_db();
        let cache = cache_db();
        seed_cache(&cache);
        cache
            .with_sync("test.drop_search", |conn| {
                conn.execute("drop table session_search_documents", [])
                    .unwrap();
                Ok(())
            })
            .unwrap();
        let registry = ContentWindowGrantRegistry::default();
        let reclaimer = RecordingReclaimer::default();
        let revoker =
            ContentWindowRevoker::new(&registry, &reclaimer, RevocationReason::RestoreBackup);
        let notifier = CountingNotifier {
            calls: AtomicUsize::new(0),
            fail: true,
        };
        let (lifecycle, _, _) = lifecycle(0, 0);
        let ctx = DataReplacementContext {
            flavour: ReplacementFlavour::RestoreBackup {
                cache: &cache,
                notifier: &notifier,
            },
            lifecycle: &lifecycle,
            db: &db,
            revoker: &revoker,
        };

        let replacement =
            run_data_replacement(&ctx, |_conn| Ok(("manifest".to_string(), 7))).unwrap();

        assert_eq!(replacement.value, ("manifest".to_string(), 7));
        assert_eq!(
            replacement.report.failed(),
            vec![StepName::InvalidateCaches, StepName::NotifyMainWindow]
        );
        assert!(replacement
            .report
            .error_of(StepName::InvalidateCaches)
            .unwrap()
            .contains("缓存清理失败"));
        assert!(replacement
            .report
            .error_of(StepName::NotifyMainWindow)
            .unwrap()
            .contains("window gone"));
        assert_eq!(notifier.calls.load(Ordering::SeqCst), 1);
        assert_eq!(replacement.report.results[0].outcome, Ok(StepOutcome::Done));
        assert_eq!(replacement.report.results[2].outcome, Ok(StepOutcome::Done));
        assert!(lifecycle.admit(Operation::PtyStart).is_ok());
    }
}
