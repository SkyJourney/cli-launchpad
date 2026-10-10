use std::sync::atomic::{AtomicBool, Ordering};

use crate::models::app_setting::CloseBehavior;
use crate::models::window_kind::{window_kind_of, WindowKind};

/// One-shot authorization for the application's final exit request.
#[derive(Default)]
pub struct AppExitGate {
    authorized: AtomicBool,
}

impl AppExitGate {
    pub fn authorize(&self) {
        self.authorized.store(true, Ordering::Release);
    }

    pub fn consume_authorization(&self) -> bool {
        self.authorized.swap(false, Ordering::AcqRel)
    }
}

/// 一次应用退出请求的处理结论；调用方根据它执行阻止、显示主窗与通知前端等副作用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitRequestDecision {
    /// 放行：已有一次性授权，或没有任何需要询问的损失。
    AllowExit,
    /// 有主窗：阻止退出，显示主窗并把活动数量带给前端。
    PreventAndAskMain {
        pty_count: usize,
        execution_task_count: usize,
    },
    /// 没有主窗但仍有运行中的 PTY：只阻止，无处可问。
    PreventWithoutMain,
}

/// 纯决策：只消费一次性授权，不产生任何副作用。
/// 主窗缺失时不检查文件窗的脏状态，也不检查执行任务（现行行为，N5）。
pub fn decide_exit_request(
    gate: &AppExitGate,
    active_pty_count: usize,
    execution_task_count: usize,
    main_window_present: bool,
) -> ExitRequestDecision {
    if gate.consume_authorization() {
        return ExitRequestDecision::AllowExit;
    }
    if main_window_present {
        return ExitRequestDecision::PreventAndAskMain {
            pty_count: active_pty_count,
            execution_task_count,
        };
    }
    if active_pty_count > 0 {
        ExitRequestDecision::PreventWithoutMain
    } else {
        ExitRequestDecision::AllowExit
    }
}

/// 窗口收到关闭请求时的处理结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainCloseDecision {
    /// 不是主窗：不处理。
    NotMainWindow,
    /// 主窗：阻止关闭并隐藏到托盘。
    HideToTray,
    /// 主窗：阻止关闭并发起应用退出请求，仍经过退出确认。
    RequestAppExit,
}

/// 纯决策：窗口类别通过注册表判断，不比较字符串字面量。
pub fn decide_close_request(
    window_label: &str,
    stored: CloseBehavior,
    tray: &TrayAvailability,
) -> MainCloseDecision {
    if window_kind_of(window_label) != Some(WindowKind::Main) {
        return MainCloseDecision::NotMainWindow;
    }
    match effective_close_behavior(stored, tray) {
        CloseBehavior::MinimizeToTray => MainCloseDecision::HideToTray,
        CloseBehavior::Quit => MainCloseDecision::RequestAppExit,
    }
}

/// Whether the system tray could be created. Held as managed state only
/// (never persisted): a later launch re-detects it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayAvailability {
    Available,
    Unavailable { reason: String },
}

/// 创建托盘；失败只记一次 warn 并降级，绝不让应用启动失败，也不重试。
/// 返回值不是 Result，调用方没有 ? 可用。
pub fn setup_tray_or_degrade(create: impl FnOnce() -> tauri::Result<()>) -> TrayAvailability {
    match create() {
        Ok(()) => TrayAvailability::Available,
        Err(error) => {
            let reason = error.to_string();
            log::warn!("system tray unavailable; closing the main window will quit: {reason}");
            TrayAvailability::Unavailable { reason }
        }
    }
}

/// 有效关闭行为：托盘不可用时恒为“退出”（隐藏到托盘后窗口再也找不回来），
/// 可用时原样返回已保存的值。纯函数，不读写数据库，也不改写已保存的设置。
pub fn effective_close_behavior(stored: CloseBehavior, tray: &TrayAvailability) -> CloseBehavior {
    match tray {
        TrayAvailability::Available => stored,
        TrayAvailability::Unavailable { .. } => CloseBehavior::Quit,
    }
}

use crate::AppError;

// m6-033 moves these into the error code registry. The three legacy codes
// keep their current strings (PD-15 keeps them as aliases for one version).
const CODE_RESTORE_IN_PROGRESS: &str = "backup_restore_in_progress";
const CODE_SESSION_STARTING: &str = "pty_session_starting";
const CODE_SESSIONS_ACTIVE: &str = "pty_sessions_active";
const CODE_IMPORT_IN_PROGRESS: &str = "config.import_in_progress";
const CODE_DATA_REPLACE_BLOCKED: &str = "app.data_replace_blocked";
const CODE_DATA_REPLACE_IN_PROGRESS: &str = "app.data_replace_in_progress";
const CODE_EXIT_DEFERRED: &str = "app.exit_deferred";
const CODE_EXITING: &str = "app.exiting";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Running,
    Restoring,
    Importing,
    Exiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataReplaceKind {
    RestoreBackup,
    ImportConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    PtyStart,
    ExecStart,
    DataReplace(DataReplaceKind),
    Exit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityCounts {
    pub pty: usize,
    pub exec: usize,
}

type Probe = Box<dyn Fn() -> usize + Send + Sync>;

struct LifecycleState {
    phase: Phase,
    inflight_starts: usize,
}

struct LifecycleInner {
    state: std::sync::Mutex<LifecycleState>,
    pty_active: Probe,
    exec_active: Probe,
}

/// Single owner of the application phase and the admission rules for PTY
/// starts, execution starts, data replacement and exit. Lock order:
/// `state` first, then the session table / execution task table (the probes
/// read their counts while `state` is held). Never call `admit` while holding
/// the session table, the execution task table or a database connection lock.
#[derive(Clone)]
pub struct AppLifecycle {
    inner: std::sync::Arc<LifecycleInner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermitKind {
    Start,
    DataReplace,
    ExitPending,
    ExitKept,
    ExitRepeated,
}

/// RAII admission. Dropping it releases whatever the admission reserved.
#[must_use = "dropping the permit releases the admission immediately"]
pub struct Permit {
    inner: std::sync::Arc<LifecycleInner>,
    kind: PermitKind,
}

impl std::fmt::Debug for Permit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Permit").field("kind", &self.kind).finish()
    }
}

impl Permit {
    /// For an exit permit: keep the application in `Exiting` after the permit is dropped.
    pub fn keep_exiting(mut self) {
        if self.kind == PermitKind::ExitPending {
            self.kind = PermitKind::ExitKept;
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        match self.inner.state.lock() {
            Ok(mut state) => match self.kind {
                PermitKind::Start => {
                    state.inflight_starts = state.inflight_starts.saturating_sub(1);
                }
                PermitKind::DataReplace | PermitKind::ExitPending => {
                    state.phase = Phase::Running;
                }
                PermitKind::ExitKept | PermitKind::ExitRepeated => {}
            },
            Err(_) => log::error!("application lifecycle lock poisoned while releasing a permit"),
        }
    }
}

impl AppLifecycle {
    pub fn new(
        pty_active: impl Fn() -> usize + Send + Sync + 'static,
        exec_active: impl Fn() -> usize + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: std::sync::Arc::new(LifecycleInner {
                state: std::sync::Mutex::new(LifecycleState {
                    phase: Phase::Running,
                    inflight_starts: 0,
                }),
                pty_active: Box::new(pty_active),
                exec_active: Box::new(exec_active),
            }),
        }
    }

    /// Test constructor whose activity probes read shared counters.
    #[cfg(test)]
    pub(crate) fn with_counters(
        pty: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        exec: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        Self::new(
            move || pty.load(std::sync::atomic::Ordering::SeqCst),
            move || exec.load(std::sync::atomic::Ordering::SeqCst),
        )
    }

    #[cfg(test)]
    pub(crate) fn inflight_starts(&self) -> usize {
        self.inner.state.lock().unwrap().inflight_starts
    }

    #[cfg(test)]
    pub fn phase(&self) -> Phase {
        self.inner
            .state
            .lock()
            .map(|state| state.phase)
            .unwrap_or(Phase::Running)
    }

    pub fn activity(&self) -> ActivityCounts {
        ActivityCounts {
            pty: (self.inner.pty_active)(),
            exec: (self.inner.exec_active)(),
        }
    }

    fn permit(&self, kind: PermitKind) -> Permit {
        Permit {
            inner: std::sync::Arc::clone(&self.inner),
            kind,
        }
    }

    pub fn admit(&self, op: Operation) -> Result<Permit, AppError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| AppError::msg("应用生命周期锁中毒"))?;
        match (state.phase, op) {
            (Phase::Running, Operation::PtyStart | Operation::ExecStart) => {
                state.inflight_starts = state.inflight_starts.saturating_add(1);
                Ok(self.permit(PermitKind::Start))
            }
            (Phase::Running, Operation::DataReplace(kind)) => {
                self.ensure_data_replace_allowed(&state, kind)?;
                state.phase = match kind {
                    DataReplaceKind::RestoreBackup => Phase::Restoring,
                    DataReplaceKind::ImportConfig => Phase::Importing,
                };
                Ok(self.permit(PermitKind::DataReplace))
            }
            (Phase::Running, Operation::Exit) => {
                state.phase = Phase::Exiting;
                Ok(self.permit(PermitKind::ExitPending))
            }
            (Phase::Restoring, Operation::PtyStart) => Err(AppError::coded(
                CODE_RESTORE_IN_PROGRESS,
                "备份恢复正在进行，暂时不能启动终端会话",
            )),
            (Phase::Restoring, Operation::ExecStart) => Err(AppError::coded(
                CODE_RESTORE_IN_PROGRESS,
                "备份恢复正在进行，暂时不能启动安装或更新任务",
            )),
            (Phase::Importing, Operation::PtyStart | Operation::ExecStart) => Err(AppError::coded(
                CODE_IMPORT_IN_PROGRESS,
                "配置导入正在进行，暂时不能启动终端会话或任务",
            )),
            (Phase::Restoring | Phase::Importing, Operation::DataReplace(_)) => Err(
                AppError::coded(CODE_DATA_REPLACE_IN_PROGRESS, "另一个数据替换操作正在进行"),
            ),
            (Phase::Restoring | Phase::Importing, Operation::Exit) => Err(AppError::coded(
                CODE_EXIT_DEFERRED,
                "数据替换正在进行，暂缓退出",
            )),
            (
                Phase::Exiting,
                Operation::PtyStart | Operation::ExecStart | Operation::DataReplace(_),
            ) => Err(AppError::coded(CODE_EXITING, "应用正在退出")),
            (Phase::Exiting, Operation::Exit) => Ok(self.permit(PermitKind::ExitRepeated)),
        }
    }

    fn ensure_data_replace_allowed(
        &self,
        state: &LifecycleState,
        kind: DataReplaceKind,
    ) -> Result<(), AppError> {
        let activity = self.activity();
        let inflight = state.inflight_starts;
        let action = match kind {
            DataReplaceKind::RestoreBackup => "恢复备份",
            DataReplaceKind::ImportConfig => "导入配置",
        };
        let params = |count: usize| {
            serde_json::json!({
                "count": count,
                "ptyCount": activity.pty,
                "execCount": activity.exec,
                "inflightStarts": inflight,
            })
        };
        if inflight > 0 {
            return Err(AppError::coded_with_params(
                CODE_SESSION_STARTING,
                format!("有 {inflight} 个终端会话正在启动，请稍后重试{action}"),
                params(inflight),
            ));
        }
        if activity.pty > 0 {
            return Err(AppError::coded_with_params(
                CODE_SESSIONS_ACTIVE,
                format!(
                    "请先关闭所有运行中的终端会话（当前 {} 个）再{action}",
                    activity.pty
                ),
                params(activity.pty),
            ));
        }
        if activity.exec > 0 {
            return Err(AppError::coded_with_params(
                CODE_DATA_REPLACE_BLOCKED,
                format!(
                    "有 {} 个安装或更新任务正在执行，请等待其结束后再{action}",
                    activity.exec
                ),
                params(activity.exec),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::AppExitGate;
    use super::{
        decide_close_request, decide_exit_request, effective_close_behavior, setup_tray_or_degrade,
        ExitRequestDecision, MainCloseDecision, TrayAvailability,
    };
    use crate::models::app_setting::CloseBehavior;

    const FILE_L1: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    const TERM_T1: &str = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    const SOURCE: &str = include_str!("app_lifecycle.rs");
    const LIB_RS: &str = include_str!("../lib.rs");

    #[test]
    fn exit_request_decision_matrix() {
        use ExitRequestDecision::{AllowExit, PreventAndAskMain, PreventWithoutMain};
        // (已授权, PTY 数, 执行任务数, 主窗存在, 期望)
        let rows = [
            (true, 3, 0, true, AllowExit),
            (
                false,
                0,
                0,
                true,
                PreventAndAskMain {
                    pty_count: 0,
                    execution_task_count: 0,
                },
            ),
            (
                false,
                3,
                0,
                true,
                PreventAndAskMain {
                    pty_count: 3,
                    execution_task_count: 0,
                },
            ),
            (false, 2, 0, false, PreventWithoutMain),
            // 主窗缺失时不检查文件窗脏状态（N5）。
            (false, 0, 0, false, AllowExit),
            // 只有执行任务也必须询问（PD-01）。
            (
                false,
                0,
                2,
                true,
                PreventAndAskMain {
                    pty_count: 0,
                    execution_task_count: 2,
                },
            ),
            (
                false,
                1,
                2,
                true,
                PreventAndAskMain {
                    pty_count: 1,
                    execution_task_count: 2,
                },
            ),
            // 授权后不再询问。
            (true, 0, 2, true, AllowExit),
            // 执行任务不阻止无主窗退出，终止由目标 041 兜底。
            (false, 0, 2, false, AllowExit),
        ];
        for (index, (authorized, pty, tasks, main_present, expected)) in
            rows.into_iter().enumerate()
        {
            let gate = AppExitGate::default();
            if authorized {
                gate.authorize();
            }
            assert_eq!(
                decide_exit_request(&gate, pty, tasks, main_present),
                expected,
                "row {}",
                index + 1
            );
        }

        // 一次性：授权只放行一次。
        let gate = AppExitGate::default();
        gate.authorize();
        assert_eq!(decide_exit_request(&gate, 3, 0, true), AllowExit);
        assert_eq!(
            decide_exit_request(&gate, 3, 0, true),
            PreventAndAskMain {
                pty_count: 3,
                execution_task_count: 0
            }
        );
        // 反向断言：未授权的 gate 经过任何决策之后仍然没有授权。
        let gate = AppExitGate::default();
        let _ = decide_exit_request(&gate, 0, 0, true);
        let _ = decide_exit_request(&gate, 2, 1, false);
        assert!(!gate.consume_authorization());
    }

    #[test]
    fn exit_decision_function_does_not_terminate_anything() {
        let start = SOURCE.find("pub fn decide_exit_request").unwrap();
        let rest = &SOURCE[start..];
        let end = rest.find("pub fn decide_close_request").unwrap();
        let body = &rest[..end];
        for forbidden in ["terminate", "cancel", "emit", "exit("] {
            assert!(
                !body.contains(forbidden),
                "decide_exit_request must stay pure: found {forbidden}"
            );
        }
        assert!(body.contains("consume_authorization"));

        // 反向断言：关闭决策同样是纯函数。
        let close_start = SOURCE.find("pub fn decide_close_request").unwrap();
        let close_rest = &SOURCE[close_start..];
        let close_end = close_rest.find("pub enum TrayAvailability").unwrap();
        let close_body = &close_rest[..close_end];
        for forbidden in ["terminate", "cancel", "emit", "exit("] {
            assert!(
                !close_body.contains(forbidden),
                "decide_close_request must stay pure: found {forbidden}"
            );
        }
    }

    #[test]
    fn main_close_request_decisions() {
        assert_eq!(
            decide_close_request(
                "main",
                CloseBehavior::MinimizeToTray,
                &TrayAvailability::Available
            ),
            MainCloseDecision::HideToTray
        );
        assert_eq!(
            decide_close_request("main", CloseBehavior::Quit, &TrayAvailability::Available),
            MainCloseDecision::RequestAppExit
        );
        assert_eq!(
            decide_close_request(TERM_T1, CloseBehavior::Quit, &TrayAvailability::Available),
            MainCloseDecision::NotMainWindow
        );
        assert_eq!(
            decide_close_request(
                FILE_L1,
                CloseBehavior::MinimizeToTray,
                &TrayAvailability::Available
            ),
            MainCloseDecision::NotMainWindow
        );
        // 大小写与空白敏感。
        assert_eq!(
            decide_close_request("MAIN", CloseBehavior::Quit, &TrayAvailability::Available),
            MainCloseDecision::NotMainWindow
        );
        assert_eq!(
            decide_close_request("", CloseBehavior::Quit, &TrayAvailability::Available),
            MainCloseDecision::NotMainWindow
        );
        assert_eq!(
            decide_close_request("main ", CloseBehavior::Quit, &TrayAvailability::Available),
            MainCloseDecision::NotMainWindow
        );
    }

    #[test]
    fn lib_rs_delegates_exit_and_window_events_to_decision_functions() {
        let start = LIB_RS.find("fn handle_run_event").unwrap();
        let end = LIB_RS.find("fn show_main_window").unwrap();
        let run_event = &LIB_RS[start..end];
        assert!(run_event.contains("decide_exit_request("));
        assert!(!run_event.contains("consume_authorization"));
        assert!(run_event.contains("executionTaskCount"));
        assert!(LIB_RS.contains("on_window_destroyed("));
        assert!(LIB_RS.contains("decide_close_request("));
        // 反向断言：旧的内联逻辑不能回来。
        assert!(!LIB_RS.contains(".reclaim_window("));
        assert!(!LIB_RS.contains("grants.revoke("));
        assert!(!LIB_RS.contains("window.label() != \"main\""));
    }

    fn unavailable() -> TrayAvailability {
        TrayAvailability::Unavailable {
            reason: "no tray host".to_string(),
        }
    }

    #[test]
    fn close_decision_matrix_with_tray_availability() {
        use MainCloseDecision::{HideToTray, NotMainWindow, RequestAppExit};
        let rows = [
            ("main", CloseBehavior::MinimizeToTray, true, HideToTray),
            ("main", CloseBehavior::MinimizeToTray, false, RequestAppExit),
            ("main", CloseBehavior::Quit, true, RequestAppExit),
            ("main", CloseBehavior::Quit, false, RequestAppExit),
            (TERM_T1, CloseBehavior::MinimizeToTray, false, NotMainWindow),
            (FILE_L1, CloseBehavior::Quit, false, NotMainWindow),
            ("MAIN", CloseBehavior::Quit, false, NotMainWindow),
        ];
        for (index, (label, stored, available, expected)) in rows.into_iter().enumerate() {
            let tray = if available {
                TrayAvailability::Available
            } else {
                unavailable()
            };
            assert_eq!(
                decide_close_request(label, stored, &tray),
                expected,
                "row {}",
                index + 1
            );
        }
        // 反向断言：降级后主窗关闭不会被隐藏到托盘（隐藏后窗口再也找不回来）。
        assert_ne!(
            decide_close_request("main", CloseBehavior::MinimizeToTray, &unavailable()),
            HideToTray
        );
        // 非主窗口不受托盘状态影响。
        for (label, stored) in [
            (TERM_T1, CloseBehavior::MinimizeToTray),
            (FILE_L1, CloseBehavior::Quit),
            ("MAIN", CloseBehavior::Quit),
        ] {
            assert_eq!(
                decide_close_request(label, stored, &TrayAvailability::Available),
                decide_close_request(label, stored, &unavailable()),
                "{label}"
            );
        }
    }

    #[test]
    fn degradation_never_rewrites_the_saved_close_behavior() {
        use crate::db::{app_setting_repo, connection};

        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection::apply_migrations(&db).unwrap();
        app_setting_repo::set_close_behavior(&db, CloseBehavior::MinimizeToTray).unwrap();
        let tray = unavailable();

        assert_eq!(
            effective_close_behavior(app_setting_repo::get_close_behavior(&db).unwrap(), &tray),
            CloseBehavior::Quit
        );
        // 已保存的设置没有被改写。
        assert_eq!(
            app_setting_repo::get_close_behavior(&db).unwrap(),
            CloseBehavior::MinimizeToTray
        );
        // 托盘恢复可用后回到已保存的值。
        assert_eq!(
            effective_close_behavior(CloseBehavior::MinimizeToTray, &TrayAvailability::Available),
            CloseBehavior::MinimizeToTray
        );
        assert_eq!(
            effective_close_behavior(CloseBehavior::Quit, &tray),
            CloseBehavior::Quit
        );
        // 反向断言：不可用原因的文本不影响结果。
        let other_reason = TrayAvailability::Unavailable {
            reason: "another reason".to_string(),
        };
        assert_eq!(
            effective_close_behavior(CloseBehavior::MinimizeToTray, &other_reason),
            CloseBehavior::Quit
        );
    }

    #[test]
    fn tray_creation_failure_is_logged_and_does_not_abort_startup() {
        let created = std::cell::Cell::new(0);

        // 显式类型：函数必须直接返回 TrayAvailability 而不是 Result，调用方没有 ? 可用，
        // setup 的后续步骤因此一定会继续执行（改成 Result 会编译失败）。
        let tray: TrayAvailability = setup_tray_or_degrade(|| {
            created.set(created.get() + 1);
            Err(tauri::Error::Anyhow(anyhow::anyhow!("no tray host")))
        });

        assert_eq!(created.get(), 1);
        match &tray {
            TrayAvailability::Unavailable { reason } => {
                assert!(reason.contains("no tray host"));
            }
            other => panic!("expected the tray to degrade, got {other:?}"),
        }
        assert_eq!(
            setup_tray_or_degrade(|| Ok(())),
            TrayAvailability::Available
        );
        // 反向断言：失败后闭包仍只被调用过一次，不重试。
        assert_eq!(created.get(), 1);

        assert!(!LIB_RS.contains("setup_tray(app.handle())?"));
        assert!(LIB_RS.contains("setup_tray_or_degrade("));
    }

    #[test]
    fn exit_request_still_goes_through_the_exit_gate_when_tray_is_unavailable() {
        let gate = AppExitGate::default();
        let tray = unavailable();

        assert_eq!(
            decide_close_request("main", CloseBehavior::MinimizeToTray, &tray),
            MainCloseDecision::RequestAppExit
        );
        assert_eq!(
            decide_exit_request(&gate, 1, 0, true),
            ExitRequestDecision::PreventAndAskMain {
                pty_count: 1,
                execution_task_count: 0
            }
        );
        assert_eq!(
            decide_exit_request(&gate, 0, 2, true),
            ExitRequestDecision::PreventAndAskMain {
                pty_count: 0,
                execution_task_count: 2
            }
        );
        // 反向断言：关闭决策没有授权退出。
        assert!(!gate.consume_authorization());
    }

    #[test]
    fn exit_authorization_is_consumed_exactly_once() {
        let gate = AppExitGate::default();

        assert!(!gate.consume_authorization());
        gate.authorize();
        assert!(gate.consume_authorization());
        assert!(!gate.consume_authorization());
    }

    use super::{AppLifecycle, DataReplaceKind, Operation, Permit, Phase};
    use crate::AppError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn counters() -> (Arc<AtomicUsize>, Arc<AtomicUsize>, AppLifecycle) {
        let pty = Arc::new(AtomicUsize::new(0));
        let exec = Arc::new(AtomicUsize::new(0));
        let lifecycle = AppLifecycle::with_counters(pty.clone(), exec.clone());
        (pty, exec, lifecycle)
    }

    fn code_of(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// Puts a fresh lifecycle into `phase` and returns the permit that keeps it there.
    fn enter(lifecycle: &AppLifecycle, phase: Phase) -> Option<Permit> {
        match phase {
            Phase::Running => None,
            Phase::Restoring => Some(
                lifecycle
                    .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
                    .unwrap(),
            ),
            Phase::Importing => Some(
                lifecycle
                    .admit(Operation::DataReplace(DataReplaceKind::ImportConfig))
                    .unwrap(),
            ),
            Phase::Exiting => {
                lifecycle.admit(Operation::Exit).unwrap().keep_exiting();
                None
            }
        }
    }

    #[test]
    fn admission_matrix_matches_the_design_table() {
        use DataReplaceKind::{ImportConfig, RestoreBackup};
        use Operation::{DataReplace, ExecStart, Exit, PtyStart};
        // (phase entered, operation, expected error code or None when admitted, phase afterwards)
        let rows: Vec<(Phase, Operation, Option<&str>, Phase)> = vec![
            (Phase::Running, PtyStart, None, Phase::Running),
            (Phase::Running, ExecStart, None, Phase::Running),
            (
                Phase::Running,
                DataReplace(RestoreBackup),
                None,
                Phase::Restoring,
            ),
            (
                Phase::Running,
                DataReplace(ImportConfig),
                None,
                Phase::Importing,
            ),
            (Phase::Running, Exit, None, Phase::Exiting),
            (
                Phase::Restoring,
                PtyStart,
                Some("backup_restore_in_progress"),
                Phase::Restoring,
            ),
            (
                Phase::Restoring,
                ExecStart,
                Some("backup_restore_in_progress"),
                Phase::Restoring,
            ),
            (
                Phase::Restoring,
                DataReplace(RestoreBackup),
                Some("app.data_replace_in_progress"),
                Phase::Restoring,
            ),
            (
                Phase::Restoring,
                DataReplace(ImportConfig),
                Some("app.data_replace_in_progress"),
                Phase::Restoring,
            ),
            (
                Phase::Restoring,
                Exit,
                Some("app.exit_deferred"),
                Phase::Restoring,
            ),
            (
                Phase::Importing,
                PtyStart,
                Some("config.import_in_progress"),
                Phase::Importing,
            ),
            (
                Phase::Importing,
                ExecStart,
                Some("config.import_in_progress"),
                Phase::Importing,
            ),
            (
                Phase::Importing,
                DataReplace(RestoreBackup),
                Some("app.data_replace_in_progress"),
                Phase::Importing,
            ),
            (
                Phase::Importing,
                DataReplace(ImportConfig),
                Some("app.data_replace_in_progress"),
                Phase::Importing,
            ),
            (
                Phase::Importing,
                Exit,
                Some("app.exit_deferred"),
                Phase::Importing,
            ),
            (
                Phase::Exiting,
                PtyStart,
                Some("app.exiting"),
                Phase::Exiting,
            ),
            (
                Phase::Exiting,
                ExecStart,
                Some("app.exiting"),
                Phase::Exiting,
            ),
            (
                Phase::Exiting,
                DataReplace(RestoreBackup),
                Some("app.exiting"),
                Phase::Exiting,
            ),
            (
                Phase::Exiting,
                DataReplace(ImportConfig),
                Some("app.exiting"),
                Phase::Exiting,
            ),
            (Phase::Exiting, Exit, None, Phase::Exiting),
        ];
        assert_eq!(rows.len(), 20);
        for (phase, operation, expected_code, phase_after) in rows {
            let (_pty, _exec, lifecycle) = counters();
            let held = enter(&lifecycle, phase);
            assert_eq!(lifecycle.phase(), phase, "setup for {phase:?}");
            let result = lifecycle.admit(operation);
            match (&result, expected_code) {
                (Ok(_), None) => {}
                (Err(error), Some(code)) => {
                    assert_eq!(code_of(error), code, "{phase:?} + {operation:?}");
                }
                (Ok(_), Some(code)) => {
                    panic!("{phase:?} + {operation:?} must be rejected with {code}")
                }
                (Err(error), None) => panic!(
                    "{phase:?} + {operation:?} must be admitted but was rejected with {}",
                    code_of(error)
                ),
            }
            assert_eq!(lifecycle.phase(), phase_after, "{phase:?} + {operation:?}");
            drop(result);
            drop(held);
        }
    }

    #[test]
    fn data_replace_is_blocked_with_the_documented_reason_and_params() {
        let replace = Operation::DataReplace(DataReplaceKind::RestoreBackup);

        // 1. an in-flight start wins over everything else
        let (pty, exec, lifecycle) = counters();
        pty.store(2, Ordering::SeqCst);
        exec.store(3, Ordering::SeqCst);
        let starting = lifecycle.admit(Operation::PtyStart).unwrap();
        let error = lifecycle.admit(replace).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "pty_session_starting");
        assert_eq!(value["params"]["count"], 1);
        assert_eq!(value["params"]["inflightStarts"], 1);
        assert_eq!(value["params"]["ptyCount"], 2);
        assert_eq!(value["params"]["execCount"], 3);
        assert_eq!(lifecycle.phase(), Phase::Running);
        drop(starting);

        // 2. then active PTY sessions
        let error = lifecycle.admit(replace).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "pty_sessions_active");
        assert_eq!(value["params"]["count"], 2);
        assert!(error.to_string().contains("2 个"));
        assert_eq!(lifecycle.phase(), Phase::Running);

        // 3. then active execution tasks
        pty.store(0, Ordering::SeqCst);
        let error = lifecycle.admit(replace).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "app.data_replace_blocked");
        assert_eq!(value["params"]["count"], 3);
        assert_eq!(value["params"]["ptyCount"], 0);
        assert_eq!(value["params"]["execCount"], 3);
        assert_eq!(lifecycle.phase(), Phase::Running);

        // reverse: nothing active, nothing starting -> admitted
        exec.store(0, Ordering::SeqCst);
        assert!(lifecycle.admit(replace).is_ok());
    }

    #[test]
    fn permits_release_their_effect_when_dropped() {
        let (_pty, _exec, lifecycle) = counters();

        let start = lifecycle.admit(Operation::PtyStart).unwrap();
        assert_eq!(lifecycle.inflight_starts(), 1);
        let second = lifecycle.admit(Operation::ExecStart).unwrap();
        assert_eq!(lifecycle.inflight_starts(), 2);
        drop(start);
        assert_eq!(lifecycle.inflight_starts(), 1);
        drop(second);
        assert_eq!(lifecycle.inflight_starts(), 0);

        let replace = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::ImportConfig))
            .unwrap();
        assert_eq!(lifecycle.phase(), Phase::Importing);
        drop(replace);
        assert_eq!(lifecycle.phase(), Phase::Running);

        let exit = lifecycle.admit(Operation::Exit).unwrap();
        assert_eq!(lifecycle.phase(), Phase::Exiting);
        drop(exit);
        assert_eq!(
            lifecycle.phase(),
            Phase::Running,
            "an exit that was not kept must roll back when its permit is dropped"
        );
    }

    #[test]
    fn a_kept_exit_permit_leaves_the_app_in_exiting() {
        let (_pty, _exec, lifecycle) = counters();
        lifecycle.admit(Operation::Exit).unwrap().keep_exiting();
        assert_eq!(lifecycle.phase(), Phase::Exiting);
        assert_eq!(
            code_of(&lifecycle.admit(Operation::PtyStart).unwrap_err()),
            "app.exiting"
        );
        assert_eq!(
            code_of(
                &lifecycle
                    .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
                    .unwrap_err()
            ),
            "app.exiting"
        );
    }

    #[test]
    fn exit_during_restore_or_import_is_deferred_until_the_permit_is_released() {
        for kind in [
            DataReplaceKind::RestoreBackup,
            DataReplaceKind::ImportConfig,
        ] {
            let (_pty, _exec, lifecycle) = counters();
            let replace = lifecycle.admit(Operation::DataReplace(kind)).unwrap();
            let error = lifecycle.admit(Operation::Exit).unwrap_err();
            assert_eq!(code_of(&error), "app.exit_deferred");
            assert_ne!(lifecycle.phase(), Phase::Exiting, "{kind:?}");
            drop(replace);
            assert!(lifecycle.admit(Operation::Exit).is_ok(), "{kind:?}");
        }
    }

    #[test]
    fn a_second_exit_request_is_idempotent() {
        let (_pty, _exec, lifecycle) = counters();
        lifecycle.admit(Operation::Exit).unwrap().keep_exiting();
        let repeated = lifecycle.admit(Operation::Exit).unwrap();
        assert_eq!(lifecycle.phase(), Phase::Exiting);
        drop(repeated);
        assert_eq!(
            lifecycle.phase(),
            Phase::Exiting,
            "dropping the idempotent permit must not leave Exiting"
        );
    }

    #[test]
    fn start_permits_are_counted_exactly_under_concurrency() {
        let (_pty, _exec, lifecycle) = counters();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let lifecycle = lifecycle.clone();
                scope.spawn(move || {
                    for _ in 0..500 {
                        let permit = lifecycle.admit(Operation::PtyStart).unwrap();
                        drop(permit);
                    }
                });
            }
        });
        assert_eq!(lifecycle.inflight_starts(), 0);
        assert_eq!(lifecycle.phase(), Phase::Running);
    }

    #[test]
    fn backup_restore_is_blocked_while_pty_sessions_are_registered() {
        let (pty, _exec, lifecycle) = counters();
        assert!(lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
            .is_ok());
        pty.store(1, Ordering::SeqCst);
        let error = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
            .unwrap_err();
        assert_eq!(code_of(&error), "pty_sessions_active");
        assert!(error.to_string().contains("1 个"));
    }

    #[test]
    fn backup_restore_serializes_against_session_startup() {
        let (_pty, _exec, lifecycle) = counters();
        let restore = Operation::DataReplace(DataReplaceKind::RestoreBackup);
        let starting = lifecycle.admit(Operation::PtyStart).unwrap();
        let starting_error = match lifecycle.admit(restore) {
            Ok(_) => panic!("restore must wait for a session startup"),
            Err(error) => error,
        };
        assert_eq!(code_of(&starting_error), "pty_session_starting");

        drop(starting);
        let restoring = lifecycle.admit(restore).unwrap();
        let start_error = match lifecycle.admit(Operation::PtyStart) {
            Ok(_) => panic!("session startup must be blocked during restore"),
            Err(error) => error,
        };
        assert_eq!(code_of(&start_error), "backup_restore_in_progress");

        drop(restoring);
        assert!(lifecycle.admit(Operation::PtyStart).is_ok());
    }

    #[test]
    fn backup_restore_guard_rejects_registered_session() {
        use crate::services::pty_session_service::PtySessionManager;

        let manager = PtySessionManager::default();
        let probe = manager.clone();
        let lifecycle = AppLifecycle::new(move || probe.active_count(), || 0);
        let restore = Operation::DataReplace(DataReplaceKind::RestoreBackup);

        let session = manager.insert_test_session("main", None);
        let error = lifecycle.admit(restore).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "pty_sessions_active");
        assert_eq!(value["params"]["count"], 1);

        manager.remove_test_session(&session.session_id);
        let restoring = lifecycle.admit(restore).unwrap();
        assert_eq!(
            code_of(&lifecycle.admit(Operation::PtyStart).unwrap_err()),
            "backup_restore_in_progress"
        );
        drop(restoring);
        assert!(lifecycle.admit(Operation::PtyStart).is_ok());
    }
}
