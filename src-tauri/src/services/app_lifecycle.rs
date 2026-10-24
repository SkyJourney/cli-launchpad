use crate::domain_errors::{ActivityBreakdown, LifecycleError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::models::app_setting::CloseBehavior;
use crate::models::window_kind::{WindowKind, WindowLabel};

/// Authorization for the application's final exit request, and the pending request it answers.
/// A confirmation is honoured only for the newest request and only within `AUTHORIZATION_TTL`.
#[derive(Default)]
pub struct AppExitGate {
    authorized_at: Mutex<Option<Instant>>,
    pending_request: Mutex<PendingRequest>,
    /// The impacts Rust reported for the pending request (m6-101). Lock order: `pending_request`
    /// first, then `reported`.
    reported: Mutex<Option<(String, ReportedImpacts)>>,
}

/// The newest exit request and whether its confirmation is currently terminating PTY sessions.
/// While it terminates, a newer request must not supersede it: the sessions that were already
/// ended could otherwise never be matched with an authorized exit.
#[derive(Default)]
struct PendingRequest {
    id: Option<String>,
    /// Confirmations currently terminating sessions for `id` (a count, not a flag, so one
    /// finishing confirmation cannot unlock another that is still terminating).
    terminating: usize,
}

/// Held while a confirmed exit terminates sessions; releases the lock on every path.
struct TerminationLock<'a> {
    gate: &'a AppExitGate,
}

impl Drop for TerminationLock<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.gate.pending_request.lock() {
            pending.terminating = pending.terminating.saturating_sub(1);
        }
    }
}

/// An authorization older than this is ignored, so a stale confirmation can never let a later,
/// unrelated exit through.
const AUTHORIZATION_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitRequest {
    pub id: String,
}

/// Live counts that the exit confirmation covers (m6-101).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitActivity {
    pub pty_count: usize,
    pub execution_task_count: usize,
}

/// What Rust reported for a pending request: the counts it recomputed and the dirty file count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportedImpacts {
    pub activity: ExitActivity,
    pub dirty_file_count: usize,
    pub requires_prompt: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitConfirmError {
    NoPendingRequest,
    RequestMismatch,
}

impl AppExitGate {
    pub fn authorize(&self) {
        self.authorize_at(Instant::now());
    }

    pub fn authorize_at(&self, now: Instant) {
        if let Ok(mut authorized_at) = self.authorized_at.lock() {
            *authorized_at = Some(now);
        }
    }

    pub fn consume_authorization(&self) -> bool {
        self.consume_authorization_at(Instant::now())
    }

    pub fn consume_authorization_at(&self, now: Instant) -> bool {
        let issued = match self.authorized_at.lock() {
            Ok(mut authorized_at) => authorized_at.take(),
            Err(_) => None,
        };
        matches!(issued, Some(at) if now.saturating_duration_since(at) < AUTHORIZATION_TTL)
    }

    /// A new request supersedes any older pending one (the newest wins), except while the
    /// pending request's confirmation is terminating sessions: then the in-flight request is
    /// returned unchanged, so the confirmation that already started can still complete.
    pub fn begin_request(&self) -> ExitRequest {
        if let Ok(mut pending) = self.pending_request.lock() {
            if pending.terminating > 0 {
                if let Some(id) = pending.id.clone() {
                    return ExitRequest { id };
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            pending.id = Some(id.clone());
            if let Ok(mut reported) = self.reported.lock() {
                *reported = None;
            }
            return ExitRequest { id };
        }
        ExitRequest {
            id: uuid::Uuid::new_v4().to_string(),
        }
    }

    #[cfg(test)]
    pub fn pending_request_id(&self) -> Option<String> {
        self.pending_request
            .lock()
            .ok()
            .and_then(|pending| pending.id.clone())
    }

    /// Verifies `request_id` is the pending request and keeps it pending (and unsuperseded)
    /// until the returned lock is dropped.
    fn lock_for_termination(
        &self,
        request_id: &str,
    ) -> Result<TerminationLock<'_>, ExitConfirmError> {
        let mut pending = self
            .pending_request
            .lock()
            .map_err(|_| ExitConfirmError::NoPendingRequest)?;
        match pending.id.as_deref() {
            None => return Err(ExitConfirmError::NoPendingRequest),
            Some(current) if current != request_id => {
                return Err(ExitConfirmError::RequestMismatch)
            }
            Some(_) => {}
        }
        pending.terminating += 1;
        Ok(TerminationLock { gate: self })
    }

    /// Authorizes the exit only when `request_id` equals the pending request, and consumes it.
    pub fn confirm(&self, request_id: &str) -> Result<(), ExitConfirmError> {
        {
            let mut pending = self
                .pending_request
                .lock()
                .map_err(|_| ExitConfirmError::NoPendingRequest)?;
            let matched = match pending.id.as_deref() {
                None => return Err(ExitConfirmError::NoPendingRequest),
                Some(current) => current == request_id,
            };
            if !matched {
                return Err(ExitConfirmError::RequestMismatch);
            }
            pending.id = None;
        }
        if let Ok(mut reported) = self.reported.lock() {
            *reported = None;
        }
        self.authorize();
        Ok(())
    }

    /// `Ok` only when `request_id` is the pending request (m6-101: checked before the payload).
    pub(crate) fn check_pending(&self, request_id: &str) -> Result<(), ExitConfirmError> {
        let pending = self
            .pending_request
            .lock()
            .map_err(|_| ExitConfirmError::NoPendingRequest)?;
        match pending.id.as_deref() {
            None => Err(ExitConfirmError::NoPendingRequest),
            Some(current) if current != request_id => Err(ExitConfirmError::RequestMismatch),
            Some(_) => Ok(()),
        }
    }

    /// Records the impacts for the pending request; a later report replaces the earlier one.
    pub(crate) fn record_report(
        &self,
        request_id: &str,
        reported: ReportedImpacts,
    ) -> Result<(), ExitConfirmError> {
        let pending = self
            .pending_request
            .lock()
            .map_err(|_| ExitConfirmError::NoPendingRequest)?;
        match pending.id.as_deref() {
            None => return Err(ExitConfirmError::NoPendingRequest),
            Some(current) if current != request_id => {
                return Err(ExitConfirmError::RequestMismatch)
            }
            Some(_) => {}
        }
        if let Ok(mut slot) = self.reported.lock() {
            *slot = Some((request_id.to_string(), reported));
        }
        Ok(())
    }

    /// The impacts reported for `request_id`, if that request is the one reported on.
    pub(crate) fn reported_for(&self, request_id: &str) -> Option<ReportedImpacts> {
        let slot = self.reported.lock().ok()?;
        slot.as_ref()
            .filter(|(id, _)| id == request_id)
            .map(|(_, reported)| reported.clone())
    }
}

pub(crate) fn exit_confirm_error(error: ExitConfirmError) -> AppError {
    match error {
        ExitConfirmError::NoPendingRequest => {
            AppError::coded(ErrorCode::ExitNoPendingRequest, "没有待决的退出请求")
        }
        ExitConfirmError::RequestMismatch => AppError::coded(
            ErrorCode::ExitRequestMismatch,
            "退出请求与当前待决请求不一致",
        ),
    }
}

/// Checks the request id first, terminates only for the pending request, then confirms it. A
/// rejected id never reaches `terminate`; a failed `terminate` leaves the request pending.
pub(crate) fn confirm_exit_with<T>(
    gate: &AppExitGate,
    request_id: &str,
    terminate: impl FnOnce() -> Result<T, AppError>,
) -> Result<(), AppError> {
    // The request stays pending and cannot be superseded while sessions are terminated.
    let _termination = gate
        .lock_for_termination(request_id)
        .map_err(exit_confirm_error)?;
    terminate()?;
    gate.confirm(request_id).map_err(exit_confirm_error)
}

pub(crate) fn exit_requested_payload(
    request: &ExitRequest,
    pty_count: usize,
    execution_task_count: usize,
) -> serde_json::Value {
    serde_json::json!({
        "requestId": request.id,
        "ptyCount": pty_count,
        "executionTaskCount": execution_task_count,
    })
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
    /// 没有主窗但仍有运行中的 PTY：阻止退出，先恢复主窗再询问（109 与 114 合并的方案，
    /// 2026-10-21 用户裁定）。恢复失败时调用方放行，退出清理终止全部会话。
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
    window: &WindowLabel,
    stored: CloseBehavior,
    tray: &TrayAvailability,
) -> MainCloseDecision {
    if window.kind() != WindowKind::main() {
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

use crate::error_codes::ErrorCode;
use crate::AppError;

// m6-033 moves these into the error code registry. The three legacy codes
// keep their current strings (PD-15 keeps them as aliases for one version).

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
    /// Signalled when a start permit drops (see `wait_for_starts`).
    starts_drained: std::sync::Condvar,
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
                    // Notified while `state` is still held, so a waiter cannot miss it.
                    self.inner.starts_drained.notify_all();
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
                starts_drained: std::sync::Condvar::new(),
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

    /// Blocks for at most `budget` until no start permit is outstanding. Returns true when none
    /// is left (a poisoned lock counts as drained). Callers must not hold the session table, the
    /// execution task table or a database connection lock (same rule as `admit`).
    pub fn wait_for_starts(&self, budget: Duration) -> bool {
        let Ok(state) = self.inner.state.lock() else {
            return true;
        };
        match self
            .inner
            .starts_drained
            .wait_timeout_while(state, budget, |state| state.inflight_starts > 0)
        {
            Ok((state, _)) => state.inflight_starts == 0,
            Err(_) => true,
        }
    }

    /// The current phase; the data replacement hook checks it before running (m6-099).
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
        let mut state =
            self.inner.state.lock().map_err(|_| {
                AppError::coded(ErrorCode::InternalLockPoisoned, "应用生命周期锁中毒")
            })?;
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
            (Phase::Restoring, Operation::PtyStart | Operation::ExecStart) => {
                Err(LifecycleError::RestoreInProgress.into())
            }
            (Phase::Importing, Operation::PtyStart | Operation::ExecStart) => {
                Err(LifecycleError::ConfigImportInProgress.into())
            }
            (Phase::Restoring | Phase::Importing, Operation::DataReplace(_)) => {
                Err(LifecycleError::DataReplaceInProgress.into())
            }
            (Phase::Restoring | Phase::Importing, Operation::Exit) => {
                Err(LifecycleError::ExitDeferred.into())
            }
            (
                Phase::Exiting,
                Operation::PtyStart | Operation::ExecStart | Operation::DataReplace(_),
            ) => Err(LifecycleError::Exiting.into()),
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
        let breakdown = ActivityBreakdown {
            pty_count: activity.pty,
            exec_count: activity.exec,
            inflight_starts: inflight,
        };
        // The messages name the refused action; the code and parameters come from the domain error.
        if inflight > 0 {
            return Err(LifecycleError::PtySessionStarting {
                count: inflight,
                activity: breakdown,
            }
            .with_message(format!(
                "有 {inflight} 个终端会话或执行任务正在启动，请稍后重试{action}"
            )));
        }
        if activity.pty > 0 {
            return Err(LifecycleError::PtySessionsActive {
                count: activity.pty,
                activity: breakdown,
            }
            .with_message(format!(
                "请先关闭所有运行中的终端会话（当前 {} 个）再{action}",
                activity.pty
            )));
        }
        if activity.exec > 0 {
            return Err(LifecycleError::DataReplaceBlocked {
                count: activity.exec,
                activity: breakdown,
            }
            .with_message(format!(
                "有 {} 个安装或更新任务正在执行，请等待其结束后再{action}",
                activity.exec
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::AppExitGate;
    use super::{confirm_exit_with, exit_requested_payload, ExitRequest};
    use super::{
        decide_close_request, decide_exit_request, effective_close_behavior, setup_tray_or_degrade,
        ExitRequestDecision, MainCloseDecision, TrayAvailability,
    };
    use crate::models::window_kind::test_label;
    use std::cell::Cell;
    use std::time::{Duration, Instant};

    fn error_code(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }
    use crate::models::app_setting::CloseBehavior;

    const FILE_L1: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    const TERM_T1: &str = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    const SOURCE: &str = include_str!("app_lifecycle.rs");
    const LIB_RS: &str = include_str!("../lib.rs");

    #[test]
    fn a_missing_main_window_with_sessions_restores_the_window_instead_of_authorizing_the_exit() {
        // 109 与 114 合并（2026-10-21 裁定）：显式退出不再预先授权。主窗缺失且有 PTY 时决策为
        // PreventWithoutMain，由调用方先恢复主窗再询问；决策本身不消费也不产生授权。
        let gate = AppExitGate::default();
        assert_eq!(
            decide_exit_request(&gate, 2, 0, false),
            ExitRequestDecision::PreventWithoutMain
        );
        assert_eq!(
            decide_exit_request(&gate, 2, 0, false),
            ExitRequestDecision::PreventWithoutMain,
            "the decision must not authorize on its own"
        );
        // 没有会话或主窗存在时，决策不变：放行或询问主窗。
        assert_eq!(
            decide_exit_request(&AppExitGate::default(), 0, 0, false),
            ExitRequestDecision::AllowExit
        );
        assert!(matches!(
            decide_exit_request(&AppExitGate::default(), 3, 0, true),
            ExitRequestDecision::PreventAndAskMain { .. }
        ));
    }

    use super::{ExitActivity, ExitConfirmError, ReportedImpacts};

    fn reported_counts(pty: usize, exec: usize) -> ReportedImpacts {
        ReportedImpacts {
            activity: ExitActivity {
                pty_count: pty,
                execution_task_count: exec,
            },
            dirty_file_count: 0,
            requires_prompt: true,
        }
    }

    #[test]
    fn a_new_request_discards_the_previous_report() {
        let gate = AppExitGate::default();
        let a = gate.begin_request().id;
        let reported = reported_counts(1, 0);
        assert!(gate.record_report(&a, reported.clone()).is_ok());
        assert_eq!(gate.reported_for(&a), Some(reported.clone()));
        gate.authorize();
        let b = gate.begin_request().id;
        assert!(gate.reported_for(&a).is_none());
        assert!(gate.reported_for(&b).is_none());
        assert_eq!(
            gate.record_report(&a, reported),
            Err(ExitConfirmError::RequestMismatch)
        );
        // Beginning a request does not clear an authorization already granted.
        assert!(gate.consume_authorization());
    }

    #[test]
    fn a_report_needs_the_pending_request_and_a_later_report_replaces_it() {
        let gate = AppExitGate::default();
        let reported = reported_counts(1, 0);
        let later = reported_counts(0, 2);
        assert_eq!(
            gate.record_report("x", reported.clone()),
            Err(ExitConfirmError::NoPendingRequest)
        );
        let id = gate.begin_request().id;
        assert_eq!(
            gate.record_report("other", reported.clone()),
            Err(ExitConfirmError::RequestMismatch)
        );
        assert!(gate.reported_for(&id).is_none());
        assert!(gate.record_report(&id, reported).is_ok());
        assert!(gate.record_report(&id, later.clone()).is_ok());
        assert_eq!(gate.reported_for(&id), Some(later));
        assert!(gate.reported_for("other").is_none());
    }

    #[test]
    fn a_confirmed_request_clears_its_report() {
        let gate = AppExitGate::default();
        let id = gate.begin_request().id;
        gate.record_report(&id, reported_counts(1, 0)).unwrap();
        assert!(gate.confirm("wrong").is_err());
        assert!(gate.reported_for(&id).is_some());
        assert!(gate.confirm(&id).is_ok());
        assert!(gate.reported_for(&id).is_none());
        assert!(gate.pending_request_id().is_none());
        assert!(gate.consume_authorization());
    }

    #[test]
    fn the_no_main_exit_restores_the_main_window_before_asking() {
        // 接线守护：PreventWithoutMain 分支必须先恢复主窗，恢复失败时不阻止退出（不会让应用永远无法退出）。
        let start = LIB_RS
            .find("services::app_lifecycle::ExitRequestDecision::PreventWithoutMain => {")
            .expect("the no-main branch is handled");
        let branch = &LIB_RS[start..];
        let restore = branch
            .find("restore_main_window(app)")
            .expect("restore first");
        let ask = branch.find("ask_main_to_confirm_exit(").expect("then ask");
        let prevent = branch
            .find("api.prevent_exit()")
            .expect("prevent once restored");
        assert!(
            restore < prevent && prevent < ask,
            "restore, then prevent, then ask"
        );
        let fallback = branch
            .find("Err(error) =>")
            .expect("a failed restore is handled");
        assert!(
            ask < fallback,
            "the failure arm follows the success arm, which carries the prevent and the ask"
        );
    }

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
                &test_label("main"),
                CloseBehavior::MinimizeToTray,
                &TrayAvailability::Available
            ),
            MainCloseDecision::HideToTray
        );
        assert_eq!(
            decide_close_request(
                &test_label("main"),
                CloseBehavior::Quit,
                &TrayAvailability::Available
            ),
            MainCloseDecision::RequestAppExit
        );
        assert_eq!(
            decide_close_request(
                &test_label(TERM_T1),
                CloseBehavior::Quit,
                &TrayAvailability::Available
            ),
            MainCloseDecision::NotMainWindow
        );
        assert_eq!(
            decide_close_request(
                &test_label(FILE_L1),
                CloseBehavior::MinimizeToTray,
                &TrayAvailability::Available
            ),
            MainCloseDecision::NotMainWindow
        );
        // 大小写与空白敏感：这些标签不是规范窗口标签，在边界处即被拒绝（lib.rs 视为非主窗口）。
        for raw in ["MAIN", "", "main "] {
            assert!(
                crate::models::window_kind::WindowLabel::parse(raw).is_err(),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn lib_rs_delegates_exit_and_window_events_to_decision_functions() {
        let start = LIB_RS.find("fn handle_run_event").unwrap();
        // 退出确认的发送在 handle_run_event 之后的 ask_main_to_confirm_exit 中，区间延伸到其后的函数。
        let end = LIB_RS.find("fn exit_cleanup_targets").unwrap();
        let run_event = &LIB_RS[start..end];
        assert!(run_event.contains("decide_exit_request("));
        assert!(!run_event.contains("consume_authorization"));
        assert!(run_event.contains("exit_requested_payload("));
        assert!(run_event.contains("begin_request()"));
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
        ];
        for (index, (label, stored, available, expected)) in rows.into_iter().enumerate() {
            let tray = if available {
                TrayAvailability::Available
            } else {
                unavailable()
            };
            assert_eq!(
                decide_close_request(&test_label(label), stored, &tray),
                expected,
                "row {}",
                index + 1
            );
        }
        // 反向断言：降级后主窗关闭不会被隐藏到托盘（隐藏后窗口再也找不回来）。
        assert_ne!(
            decide_close_request(
                &test_label("main"),
                CloseBehavior::MinimizeToTray,
                &unavailable()
            ),
            HideToTray
        );
        // 非主窗口不受托盘状态影响。
        for (label, stored) in [
            (TERM_T1, CloseBehavior::MinimizeToTray),
            (FILE_L1, CloseBehavior::Quit),
        ] {
            assert_eq!(
                decide_close_request(&test_label(label), stored, &TrayAvailability::Available),
                decide_close_request(&test_label(label), stored, &unavailable()),
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
            decide_close_request(&test_label("main"), CloseBehavior::MinimizeToTray, &tray),
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
                Some("backup.restore_in_progress"),
                Phase::Restoring,
            ),
            (
                Phase::Restoring,
                ExecStart,
                Some("backup.restore_in_progress"),
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
        assert_eq!(value["code"], "pty.session_starting");
        assert_eq!(value["params"]["count"], 1);
        assert_eq!(value["params"]["inflightStarts"], 1);
        assert_eq!(value["params"]["ptyCount"], 2);
        assert_eq!(value["params"]["execCount"], 3);
        assert_eq!(lifecycle.phase(), Phase::Running);
        drop(starting);

        // 2. then active PTY sessions
        let error = lifecycle.admit(replace).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "pty.sessions_active");
        assert_eq!(value["params"]["count"], 2);
        assert_eq!(value["params"]["ptyCount"], 2);
        assert_eq!(value["params"]["inflightStarts"], 0);
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
        assert_eq!(value["params"]["inflightStarts"], 0);
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
        assert_eq!(code_of(&error), "pty.sessions_active");
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
        assert_eq!(code_of(&starting_error), "pty.session_starting");

        drop(starting);
        let restoring = lifecycle.admit(restore).unwrap();
        let start_error = match lifecycle.admit(Operation::PtyStart) {
            Ok(_) => panic!("session startup must be blocked during restore"),
            Err(error) => error,
        };
        assert_eq!(code_of(&start_error), "backup.restore_in_progress");

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
        assert_eq!(value["code"], "pty.sessions_active");
        assert_eq!(value["params"]["count"], 1);
        assert_eq!(value["params"]["ptyCount"], 1);
        assert_eq!(value["params"]["inflightStarts"], 0);

        manager.remove_test_session(&session.session_id);
        let restoring = lifecycle.admit(restore).unwrap();
        assert_eq!(
            code_of(&lifecycle.admit(Operation::PtyStart).unwrap_err()),
            "backup.restore_in_progress"
        );
        drop(restoring);
        assert!(lifecycle.admit(Operation::PtyStart).is_ok());
    }

    #[test]
    fn confirm_exit_without_a_pending_request_is_rejected_and_terminates_nothing() {
        let gate = AppExitGate::default();
        let terminated = Cell::new(0usize);

        let result = confirm_exit_with(&gate, "any-id", || {
            terminated.set(terminated.get() + 1);
            Ok::<(), AppError>(())
        });

        let error = result.unwrap_err();
        assert_eq!(error_code(&error), "exit.no_pending_request");
        assert_eq!(terminated.get(), 0);
        assert!(!gate.consume_authorization());
    }

    #[test]
    fn confirm_exit_with_a_mismatched_id_is_rejected_and_keeps_the_pending_request() {
        let gate = AppExitGate::default();
        let request = gate.begin_request();
        let terminated = Cell::new(0usize);
        let forged = [
            "forged-id".to_string(),
            String::new(),
            request.id.to_uppercase(),
            format!("{} ", request.id),
        ];
        assert_ne!(request.id.to_uppercase(), request.id);

        for candidate in &forged {
            let result = confirm_exit_with(&gate, candidate, || {
                terminated.set(terminated.get() + 1);
                Ok::<(), AppError>(())
            });
            let error = result.unwrap_err();
            assert_eq!(
                error_code(&error),
                "exit.request_mismatch",
                "candidate {candidate:?}"
            );
        }
        assert_eq!(terminated.get(), 0);
        assert!(!gate.consume_authorization());
        assert_eq!(gate.pending_request_id(), Some(request.id.clone()));

        let result = confirm_exit_with(&gate, &request.id, || {
            terminated.set(terminated.get() + 1);
            Ok::<(), AppError>(())
        });
        assert!(result.is_ok());
        assert_eq!(terminated.get(), 1);
        assert!(gate.consume_authorization());
        assert!(!gate.consume_authorization());
    }

    #[test]
    fn exit_request_ids_are_single_use_unique_and_superseded_by_newer_requests() {
        let gate = AppExitGate::default();
        let ids: std::collections::HashSet<String> =
            (0..100).map(|_| gate.begin_request().id).collect();
        assert_eq!(ids.len(), 100);
        for id in &ids {
            let parsed = uuid::Uuid::parse_str(id).unwrap();
            assert_eq!(parsed.get_version_num(), 4);
        }

        let gate = AppExitGate::default();
        let terminated = Cell::new(0usize);
        let first = gate.begin_request();
        let second = gate.begin_request();
        // 被取代的旧请求不得终止任何 PTY（校验先于终止）。
        let stale = confirm_exit_with(&gate, &first.id, || {
            terminated.set(terminated.get() + 1);
            Ok::<(), AppError>(())
        });
        assert_eq!(error_code(&stale.unwrap_err()), "exit.request_mismatch");
        assert_eq!(terminated.get(), 0);
        assert!(!gate.consume_authorization());

        assert!(confirm_exit_with(&gate, &second.id, || {
            terminated.set(terminated.get() + 1);
            Ok::<(), AppError>(())
        })
        .is_ok());
        assert_eq!(terminated.get(), 1);
        let replay = confirm_exit_with(&gate, &second.id, || {
            terminated.set(terminated.get() + 1);
            Ok::<(), AppError>(())
        });
        assert_eq!(error_code(&replay.unwrap_err()), "exit.no_pending_request");
        assert_eq!(terminated.get(), 1);
    }

    #[test]
    fn failed_termination_keeps_the_request_pending_and_does_not_authorize_exit() {
        let gate = AppExitGate::default();
        let request = gate.begin_request();

        let failed = confirm_exit_with(&gate, &request.id, || {
            Err::<(), AppError>(AppError::internal("pty busy"))
        });
        assert_eq!(failed.unwrap_err().to_string(), "pty busy");
        assert!(!gate.consume_authorization());
        assert_eq!(gate.pending_request_id(), Some(request.id.clone()));

        let retried = confirm_exit_with(&gate, &request.id, || Ok::<(), AppError>(()));
        assert!(retried.is_ok());
        assert!(gate.consume_authorization());
    }

    #[test]
    fn exit_requested_payload_reports_pty_and_execution_task_counts() {
        let request = ExitRequest {
            id: "r1".to_string(),
        };
        let payload = exit_requested_payload(&request, 2, 3);
        assert_eq!(
            payload,
            serde_json::json!({"requestId": "r1", "ptyCount": 2, "executionTaskCount": 3})
        );
        let object = payload.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert!(object.keys().all(|key| !key.contains('_')));
        let text = payload.to_string();
        assert!(!text.contains("request_id"));
        assert!(!text.contains("pty_count"));
    }

    #[test]
    fn exit_requested_decision_issues_a_fresh_request_for_every_exit_attempt() {
        let gate = AppExitGate::default();
        let mut issued = Vec::new();
        for _ in 0..2 {
            match decide_exit_request(&gate, 1, 0, true) {
                ExitRequestDecision::PreventAndAskMain { .. } => issued.push(gate.begin_request()),
                other => panic!("{other:?}"),
            }
        }
        assert_ne!(issued[0].id, issued[1].id);
        let first = issued[0].clone();
        let stale = confirm_exit_with(&gate, &first.id, || Ok::<(), AppError>(()));
        assert_eq!(error_code(&stale.unwrap_err()), "exit.request_mismatch");

        let run_event = &LIB_RS[LIB_RS.find("fn handle_run_event").unwrap()
            ..LIB_RS.find("fn exit_cleanup_targets").unwrap()];
        assert_eq!(run_event.matches("begin_request()").count(), 1);
        assert_eq!(run_event.matches("exit_requested_payload(").count(), 1);
        assert!(
            run_event.find("begin_request()").unwrap()
                > run_event.find("PreventAndAskMain").unwrap()
        );
        assert!(!run_event.contains("serde_json::json!"));
    }

    #[test]
    fn exit_authorization_expires_and_cannot_be_reused() {
        let t0 = Instant::now();

        let gate = AppExitGate::default();
        gate.authorize_at(t0);
        assert!(!gate.consume_authorization_at(t0 + Duration::from_secs(6)));

        let gate = AppExitGate::default();
        gate.authorize_at(t0);
        assert!(gate.consume_authorization_at(t0 + Duration::from_secs(1)));
        assert!(!gate.consume_authorization_at(t0 + Duration::from_secs(1)));

        let gate = AppExitGate::default();
        gate.authorize_at(t0);
        assert!(gate.consume_authorization_at(t0 + Duration::from_millis(4999)));

        let gate = AppExitGate::default();
        gate.authorize_at(t0);
        assert!(!gate.consume_authorization_at(t0 + Duration::from_secs(5)));

        // An expired authorization must not break a later, fresh one.
        gate.authorize_at(t0);
        assert!(gate.consume_authorization_at(t0 + Duration::from_secs(1)));
    }

    fn lifecycle() -> super::AppLifecycle {
        super::AppLifecycle::with_counters(
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        )
    }

    #[test]
    fn wait_for_starts_returns_true_immediately_when_no_start_is_in_flight() {
        let lifecycle = lifecycle();
        let began = Instant::now();

        assert!(lifecycle.wait_for_starts(Duration::from_millis(500)));
        assert!(began.elapsed() < Duration::from_millis(200));
    }

    #[test]
    fn wait_for_starts_blocks_until_the_last_start_permit_drops() {
        use super::Operation;
        let lifecycle = lifecycle();
        let permit = lifecycle.admit(Operation::PtyStart).unwrap();
        let began = Instant::now();
        let dropper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(permit);
        });

        let drained = lifecycle.wait_for_starts(Duration::from_secs(5));

        assert!(drained);
        assert_eq!(lifecycle.inflight_starts(), 0);
        let waited = began.elapsed();
        assert!(waited >= Duration::from_millis(80), "waited {waited:?}");
        assert!(waited < Duration::from_secs(3), "waited {waited:?}");
        dropper.join().unwrap();
    }

    #[test]
    fn wait_for_starts_times_out_while_a_start_permit_is_held() {
        use super::Operation;
        let lifecycle = lifecycle();
        let permit = lifecycle.admit(Operation::ExecStart).unwrap();
        let began = Instant::now();

        assert!(!lifecycle.wait_for_starts(Duration::from_millis(200)));

        let waited = began.elapsed();
        assert!(waited >= Duration::from_millis(150), "waited {waited:?}");
        assert!(waited < Duration::from_secs(2), "waited {waited:?}");
        assert_eq!(lifecycle.inflight_starts(), 1);
        drop(permit);
        assert!(lifecycle.wait_for_starts(Duration::from_millis(200)));
    }

    #[test]
    fn new_starts_are_rejected_while_exit_waits_for_in_flight_starts() {
        use super::{Operation, Phase};
        let lifecycle = lifecycle();
        let held = lifecycle.admit(Operation::PtyStart).unwrap();
        lifecycle.admit(Operation::Exit).unwrap().keep_exiting();
        let waiter = {
            let lifecycle = lifecycle.clone();
            std::thread::spawn(move || lifecycle.wait_for_starts(Duration::from_secs(5)))
        };

        for operation in [Operation::PtyStart, Operation::ExecStart] {
            let error = lifecycle.admit(operation).unwrap_err();
            assert_eq!(error_code(&error), "app.exiting");
        }
        assert_eq!(lifecycle.phase(), Phase::Exiting);
        assert_eq!(
            lifecycle.inflight_starts(),
            1,
            "the earlier start is untouched"
        );

        drop(held);
        assert!(waiter.join().unwrap());
    }

    #[test]
    fn every_waiter_wakes_when_the_last_start_permit_drops() {
        use super::Operation;
        let lifecycle = lifecycle();
        let held = lifecycle.admit(Operation::PtyStart).unwrap();
        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let lifecycle = lifecycle.clone();
                std::thread::spawn(move || {
                    let began = Instant::now();
                    let drained = lifecycle.wait_for_starts(Duration::from_secs(5));
                    (drained, began.elapsed())
                })
            })
            .collect();
        std::thread::sleep(Duration::from_millis(50));

        drop(held);

        for waiter in waiters {
            let (drained, waited) = waiter.join().unwrap();
            assert!(drained);
            assert!(
                waited < Duration::from_secs(3),
                "a waiter was not woken: {waited:?}"
            );
        }
    }

    #[test]
    fn only_start_permits_count_as_in_flight_starts_for_the_exit_wait() {
        use super::{DataReplaceKind, Operation};
        let lifecycle = lifecycle();
        let replace = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::RestoreBackup))
            .unwrap();
        let began = Instant::now();

        assert!(lifecycle.wait_for_starts(Duration::from_secs(2)));
        assert!(began.elapsed() < Duration::from_millis(500));
        assert_eq!(lifecycle.inflight_starts(), 0);
        drop(replace);

        lifecycle.admit(Operation::Exit).unwrap().keep_exiting();
        let repeated = lifecycle.admit(Operation::Exit).unwrap();
        assert!(lifecycle.wait_for_starts(Duration::from_millis(200)));
        drop(repeated);
    }

    #[test]
    fn activity_probes_run_under_the_state_lock() {
        use super::{DataReplaceKind, Operation};
        use std::sync::{Arc, Mutex};
        // Documents the lock order (state first, then the probes' own tables): a probe must never
        // call back into the lifecycle, because it runs while `state` is held.
        let slot: Arc<Mutex<Option<super::AppLifecycle>>> = Arc::new(Mutex::new(None));
        let observed: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let probe_slot = Arc::clone(&slot);
        let probe_observed = Arc::clone(&observed);
        let lifecycle = super::AppLifecycle::new(
            || 0,
            move || {
                let held = probe_slot
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|lifecycle| lifecycle.inner.state.try_lock().is_err());
                probe_observed.lock().unwrap().push(held.unwrap_or(false));
                0
            },
        );
        *slot.lock().unwrap() = Some(lifecycle.clone());

        let permit = lifecycle
            .admit(Operation::DataReplace(DataReplaceKind::ImportConfig))
            .unwrap();
        drop(permit);

        let observed = observed.lock().unwrap().clone();
        assert!(!observed.is_empty(), "the probe must have been read");
        assert!(observed.iter().all(|held| *held));
        // Drop the cycle so the test does not leak the shared state.
        *slot.lock().unwrap() = None;
    }

    #[test]
    fn a_new_request_during_termination_returns_the_confirming_request() {
        let gate = AppExitGate::default();
        let request = gate.begin_request();
        let seen: Cell<Option<String>> = Cell::new(None);

        let result = confirm_exit_with(&gate, &request.id, || {
            let newer = gate.begin_request();
            seen.set(Some(newer.id));
            Ok::<(), AppError>(())
        });

        assert!(result.is_ok(), "the confirmation must not be superseded");
        assert_eq!(seen.take(), Some(request.id.clone()));
        assert_eq!(gate.pending_request_id(), None);
        assert!(gate.consume_authorization());
    }

    #[test]
    fn a_failed_termination_releases_the_lock_so_newer_requests_supersede() {
        let gate = AppExitGate::default();
        let request = gate.begin_request();

        let result = confirm_exit_with(&gate, &request.id, || {
            Err::<(), AppError>(AppError::internal("terminate failed"))
        });

        assert!(result.is_err());
        assert_eq!(gate.pending_request_id(), Some(request.id.clone()));
        let newer = gate.begin_request();
        assert_ne!(newer.id, request.id);
        assert_eq!(gate.pending_request_id(), Some(newer.id));
    }

    #[test]
    fn one_confirmation_finishing_does_not_unlock_another_that_is_still_terminating() {
        let gate = AppExitGate::default();
        let request = gate.begin_request();

        let result = confirm_exit_with(&gate, &request.id, || {
            // A second confirmation of the same request starts and finishes meanwhile.
            drop(gate.lock_for_termination(&request.id).unwrap());
            let during = gate.begin_request();
            assert_eq!(
                during.id, request.id,
                "the first confirmation is still terminating"
            );
            Ok::<(), AppError>(())
        });

        assert!(result.is_ok());
    }
}
