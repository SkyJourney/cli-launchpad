use crate::error_codes::ErrorCode;
use crate::util::time::now_ms;
use std::collections::HashMap;
use std::future::Future;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::oneshot;

use crate::db::execution_task_repo;
use crate::models::execution::{
    ExecutionLogChunk, ExecutionStatus, ExecutionStream, ExecutionTask,
};
use crate::models::install::InstallPlan;
use crate::models::tool::ToolKey;
use crate::platform::execution_process::ProcessTree;
use crate::services::cli_adapters;
use crate::{AppError, Db};

pub const TASK_UPDATED_EVENT: &str = crate::events::EXECUTION_TASK_UPDATED;
pub const TASK_LOG_EVENT: &str = crate::events::EXECUTION_TASK_LOG;
const TASK_TIMEOUT: Duration = Duration::from_secs(600);
const TERMINATION_GRACE: Duration = Duration::from_secs(2);

struct ActiveTask {
    id: String,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct ActiveTasks {
    by_tool: HashMap<ToolKey, ActiveTask>,
    /// Slots taken before the database write; they have no cancel sender yet.
    reserved: HashMap<ToolKey, String>,
}

impl ActiveTasks {
    fn contains_tool(&self, tool_key: ToolKey) -> bool {
        self.by_tool.contains_key(&tool_key) || self.reserved.contains_key(&tool_key)
    }

    fn insert(&mut self, tool_key: ToolKey, task: ActiveTask) {
        self.by_tool.insert(tool_key, task);
    }

    fn get_mut_by_id(&mut self, id: &str) -> Option<&mut ActiveTask> {
        self.by_tool.values_mut().find(|task| task.id == id)
    }

    fn get_by_id(&self, id: &str) -> Option<&ActiveTask> {
        self.by_tool.values().find(|task| task.id == id)
    }

    fn remove_by_id(&mut self, id: &str) {
        self.by_tool.retain(|_, task| task.id != id);
        self.reserved.retain(|_, reserved| reserved != id);
    }
}

#[derive(Clone, Default)]
pub struct ExecutionTaskManager {
    active: std::sync::Arc<Mutex<ActiveTasks>>,
    /// Set once exit cleanup starts cancelling; cancelled tasks then end as `interrupted`.
    exiting: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Serializes status transitions (`cancel`, `transition_running`) across their database
    /// writes, so the `active` lock never has to be held over an `.await`.
    transition: std::sync::Arc<tokio::sync::Mutex<()>>,
}

/// A tool slot taken in memory before the task row is written. Dropping it unconfirmed gives
/// the slot back; `confirm` turns it into an active task with a cancel sender.
pub(crate) struct Reservation {
    manager: ExecutionTaskManager,
    tool_key: ToolKey,
    id: String,
    confirmed: bool,
}

impl Reservation {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn confirm(mut self, cancel: oneshot::Sender<()>) -> Result<(), AppError> {
        let mut active =
            self.manager.active.lock().map_err(|_| {
                AppError::coded(ErrorCode::InternalLockPoisoned, "执行任务状态锁中毒")
            })?;
        if self.manager.is_exiting() || active.reserved.remove(&self.tool_key).is_none() {
            // Exit cleanup already cleared the reservation table.
            return Err(AppError::coded(
                ErrorCode::AppExiting,
                "应用正在退出，任务未启动",
            ));
        }
        active.insert(
            self.tool_key,
            ActiveTask {
                id: self.id.clone(),
                cancel: Some(cancel),
            },
        );
        drop(active);
        self.confirmed = true;
        Ok(())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.confirmed {
            return;
        }
        match self.manager.active.lock() {
            Ok(mut active) => {
                if active.reserved.get(&self.tool_key) == Some(&self.id) {
                    active.reserved.remove(&self.tool_key);
                }
            }
            Err(_) => log::error!(
                "execution task state lock poisoned while releasing a reservation task_id={}",
                self.id
            ),
        }
    }
}

struct ActiveTaskGuard {
    active: std::sync::Arc<Mutex<ActiveTasks>>,
    id: String,
}

impl Drop for ActiveTaskGuard {
    fn drop(&mut self) {
        match self.active.lock() {
            Ok(mut active) => active.remove_by_id(&self.id),
            Err(_) => log::error!(
                "execution task state lock poisoned while releasing task_id={}",
                self.id
            ),
        }
    }
}

impl ExecutionTaskManager {
    pub fn is_exiting(&self) -> bool {
        self.exiting.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Exit-time helper: take every pending cancel signal sender out of the table.
    fn take_cancel_senders_for_exit(&self) -> Result<Vec<oneshot::Sender<()>>, AppError> {
        self.exiting
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::coded(ErrorCode::InternalLockPoisoned, "执行任务状态锁中毒"))?;
        Ok(active
            .by_tool
            .values_mut()
            .filter_map(|task| task.cancel.take())
            .collect())
    }

    /// Exit-time helper: drop every remaining slot (active and reserved) and report how many
    /// there were. A reservation cleared here makes the later `confirm` fail.
    fn clear_all_for_exit(&self) -> Result<usize, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::coded(ErrorCode::InternalLockPoisoned, "执行任务状态锁中毒"))?;
        let remaining = active.by_tool.len() + active.reserved.len();
        active.by_tool.clear();
        active.reserved.clear();
        Ok(remaining)
    }

    /// 当前活动的执行任务数（退出请求载荷使用），预留中的任务计入。只在读取长度期间持锁。
    pub fn active_count(&self) -> usize {
        self.active
            .lock()
            .map(|active| active.by_tool.len() + active.reserved.len())
            .unwrap_or(0)
    }

    /// Takes the tool slot in memory only (no IO under the `active` lock).
    pub(crate) fn reserve(&self, tool_key: ToolKey) -> Result<Reservation, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::coded(ErrorCode::InternalLockPoisoned, "执行任务状态锁中毒"))?;
        if active.contains_tool(tool_key) {
            return Err(AppError::coded(
                ErrorCode::ExecBusy,
                format!(
                    "{} 已有安装或更新任务正在执行，请等待其结束或先终止任务",
                    tool_key.as_str()
                ),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        active.reserved.insert(tool_key, id.clone());
        drop(active);
        Ok(Reservation {
            manager: self.clone(),
            tool_key,
            id,
            confirmed: false,
        })
    }

    /// Reserve, then write the task row outside the `active` lock. A failed write drops the
    /// reservation and gives the slot back.
    pub(crate) async fn reserve_and_persist(
        &self,
        db: &Db,
        plan: &InstallPlan,
    ) -> Result<(Reservation, ExecutionTask), AppError> {
        let reservation = self.reserve(plan.tool_key)?;
        let id = reservation.id().to_string();
        let plan = plan.clone();
        let task = db
            .call("exec.insert", move |connection| {
                Ok(execution_task_repo::insert(
                    connection,
                    &id,
                    &plan,
                    now_ms(),
                )?)
            })
            .await?;
        Ok((reservation, task))
    }

    pub async fn start(
        &self,
        db: &Db,
        app: &AppHandle,
        plan: InstallPlan,
    ) -> Result<ExecutionTask, AppError> {
        let (reservation, task) = self.reserve_and_persist(db, &plan).await?;
        let id = task.id.clone();
        let (cancel, cancel_rx) = oneshot::channel();
        // If exit cleanup already cleared the reservation this fails and the row stays
        // `preparing`; `mark_unfinished_interrupted` (exit cleanup, or the next start) settles it.
        reservation.confirm(cancel)?;
        emit_task(app, &task);

        let app = app.clone();
        spawn_logged(format!("execution task {id}"), async move {
            run_task(app, id, plan, cancel_rx).await;
        });
        Ok(task)
    }

    pub async fn cancel(&self, app: &AppHandle, id: &str) -> Result<ExecutionTask, AppError> {
        let _transition = self.transition.lock().await;
        let cancel = {
            let mut active = self.active.lock().map_err(|_| {
                AppError::coded(ErrorCode::InternalLockPoisoned, "执行任务状态锁中毒")
            })?;
            let running = active
                .get_mut_by_id(id)
                .ok_or_else(|| AppError::internal("该任务当前未在执行，无法终止"))?;
            running.cancel.take()
        };
        match cancel {
            Some(cancel) => {
                let task =
                    update_status(app, id, ExecutionStatus::Cancelling, None, None, None).await?;
                let _ = cancel.send(());
                Ok(task)
            }
            None => get_task(app, id).await,
        }
    }

    async fn transition_running(
        &self,
        app: &AppHandle,
        id: &str,
    ) -> Result<ExecutionTask, AppError> {
        let _transition = self.transition.lock().await;
        let can_run = {
            let active = self.active.lock().map_err(|_| {
                AppError::coded(ErrorCode::InternalLockPoisoned, "执行任务状态锁中毒")
            })?;
            let running = active
                .get_by_id(id)
                .ok_or_else(|| AppError::internal("执行任务状态已丢失"))?;
            running.cancel.is_some()
        };
        if !can_run {
            return get_task(app, id).await;
        }
        update_status(app, id, ExecutionStatus::Running, None, None, None).await
    }

    async fn complete(
        &self,
        app: &AppHandle,
        id: &str,
        status: ExecutionStatus,
        exit_code: Option<i32>,
        error_message: Option<&str>,
    ) -> Result<ExecutionTask, AppError> {
        debug_assert!(status.is_terminal());
        let task = self
            .settle(
                id,
                update_status(app, id, status, Some(now_ms()), exit_code, error_message),
            )
            .await
            .map_err(|error| {
                log::error!(
                    "unable to persist terminal execution task state task_id={id} error={error}"
                );
                error
            })?;
        if let Err(error) = db_call(app, "exec.prune", |connection| {
            execution_task_repo::prune_old_finished(connection)?;
            Ok(())
        })
        .await
        {
            log::warn!("unable to prune execution task history task_id={id} error={error}");
        }
        Ok(task)
    }

    /// Terminal persistence: waits for an in-flight status transition (a `Cancelling` write
    /// must never land after the terminal state), then frees the slot and persists.
    async fn settle<T>(
        &self,
        id: &str,
        persist: impl Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        let _transition = self.transition.lock().await;
        self.release_before(id, persist).await
    }

    /// Frees the slot first (short lock), then awaits the persistence of the terminal state.
    async fn release_before<T>(
        &self,
        id: &str,
        persist: impl Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        {
            let mut active = self.active.lock().map_err(|_| {
                AppError::coded(ErrorCode::InternalLockPoisoned, "执行任务状态锁中毒")
            })?;
            active.remove_by_id(id);
        }
        persist.await
    }

    fn guard(&self, id: &str) -> ActiveTaskGuard {
        ActiveTaskGuard {
            active: self.active.clone(),
            id: id.to_string(),
        }
    }
}

enum Completion {
    Exited(std::io::Result<std::process::ExitStatus>),
    Cancelled,
    TimedOut,
}

/// Runs `task` on its own tokio task so a panic inside it cannot take the
/// supervisor down, and reports any abnormal exit (panic or cancellation).
pub(crate) async fn supervise_task<F, E>(task: F, on_abnormal_exit: E)
where
    F: std::future::Future<Output = ()> + Send + 'static,
    E: FnOnce(String) + Send,
{
    if let Err(error) = tokio::spawn(task).await {
        on_abnormal_exit(format!("执行任务异常退出：{error}"));
    }
}

async fn run_task(app: AppHandle, id: String, plan: InstallPlan, cancel: oneshot::Receiver<()>) {
    let task_app = app.clone();
    let task_id = id.clone();
    supervise_task(run_task_inner(app, id, plan, cancel), move |message| {
        finish_failed(&task_app, &task_id, message);
    })
    .await;
}

async fn run_task_inner(
    app: AppHandle,
    id: String,
    plan: InstallPlan,
    mut cancel: oneshot::Receiver<()>,
) {
    let manager = app.state::<ExecutionTaskManager>();
    let _active_task_guard = manager.guard(&id);
    if let Err(error) = manager.transition_running(&app, &id).await {
        log::error!("unable to mark execution task running task_id={id} error={error}");
        finish_failed_now(&app, &id, format!("无法更新执行任务状态：{error}")).await;
        return;
    }
    append_system_log(&app, &id, "任务已启动。\n").await;

    let preflight = cli_adapters::execution_preflight(plan.clone());
    let preflight = match tokio::select! {
        biased;
        _ = &mut cancel => {
            if app_is_exiting(&app) {
                finish_interrupted_on_exit(&app, &id).await;
            } else {
                finish_cancelled(&app, &id, "用户在执行前校验期间终止了任务".to_string()).await;
            }
            return;
        }
        result = preflight => result,
    } {
        Ok(preflight) => preflight,
        Err(error) => {
            finish_failed_now(&app, &id, error).await;
            return;
        }
    };
    if let Some(message) = preflight.message {
        append_system_log(&app, &id, &format!("{message}\n")).await;
    }

    let version_before_update = if preflight.verify_update_result {
        match cli_adapters::probe_plan_version(&plan).await {
            Ok(version) => {
                append_system_log(&app, &id, &format!("更新前目标版本：{version}\n")).await;
                Some(version)
            }
            Err(error) => {
                finish_failed_now(
                    &app,
                    &id,
                    format!("无法读取更新前的目标 CLI 版本，已取消更新：{error}"),
                )
                .await;
                return;
            }
        }
    } else {
        None
    };

    let process_tree = match ProcessTree::new() {
        Ok(process_tree) => process_tree,
        Err(error) => {
            finish_failed_now(&app, &id, format!("无法创建进程树控制器：{error}")).await;
            return;
        }
    };

    let mut command = match cli_adapters::prepare_command(&plan) {
        Ok(command) => command,
        Err(error) => {
            finish_failed_now(&app, &id, error.to_string()).await;
            return;
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Err(error) = process_tree.configure(&mut command) {
        finish_failed_now(&app, &id, format!("无法配置任务进程树：{error}")).await;
        return;
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish_failed_now(
                &app,
                &id,
                format!("无法启动命令 `{}`：{error}", plan.program),
            )
            .await;
            return;
        }
    };

    if let Err(error) = process_tree.attach(&child) {
        let _ = child.kill().await;
        finish_failed_now(&app, &id, format!("无法将子进程加入任务进程树：{error}")).await;
        return;
    }

    let stdout_task = child.stdout.take().map(|stdout| {
        spawn_logged(
            format!("execution log pump {id} stdout"),
            pump_output_to(
                AppLogSink::new(app.clone(), id.clone()),
                ExecutionStream::Stdout,
                stdout,
            ),
        )
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        spawn_logged(
            format!("execution log pump {id} stderr"),
            pump_output_to(
                AppLogSink::new(app.clone(), id.clone()),
                ExecutionStream::Stderr,
                stderr,
            ),
        )
    });

    let completion = tokio::select! {
        status = child.wait() => Completion::Exited(status),
        _ = &mut cancel => Completion::Cancelled,
        _ = tokio::time::sleep(TASK_TIMEOUT) => Completion::TimedOut,
    };

    if matches!(completion, Completion::Cancelled | Completion::TimedOut) {
        if let Err(error) = process_tree.terminate() {
            log::error!("unable to terminate execution process tree task_id={id} error={error}");
            let _ = child.kill().await;
        }
        let exited = matches!(
            tokio::time::timeout(TERMINATION_GRACE, child.wait()).await,
            Ok(Ok(_))
        );
        if !exited {
            if let Err(error) = process_tree.force_kill() {
                log::error!(
                    "unable to force kill execution process tree task_id={id} error={error}"
                );
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
        }
    }
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }

    let update_version_verification = match (version_before_update.as_deref(), &completion) {
        (Some(version_before), Completion::Exited(Ok(exit))) if exit.success() => {
            Some(match cli_adapters::probe_plan_version(&plan).await {
                Ok(version_after) => verify_updated_version(version_before, version_after),
                Err(error) => Err(format!(
                    "更新命令退出成功，但无法读取目标 CLI 的更新后版本：{error}"
                )),
            })
        }
        _ => None,
    };

    let (status, exit_code, error_message, message) = match completion {
        Completion::Exited(Ok(exit)) if exit.success() => match update_version_verification {
            Some(Ok(version_after)) => {
                let version_before = version_before_update.as_deref().unwrap_or_default();
                (
                    ExecutionStatus::Succeeded,
                    exit.code(),
                    None,
                    format!(
                        "任务执行成功，目标 CLI 版本已从 {version_before} 更新为 {version_after}。\n"
                    ),
                )
            }
            Some(Err(error)) => (
                ExecutionStatus::Failed,
                exit.code(),
                Some(error.clone()),
                format!("任务未通过更新后版本核验：{error}。\n"),
            ),
            None => (
                ExecutionStatus::Succeeded,
                exit.code(),
                None,
                "任务执行成功。\n".to_string(),
            ),
        },
        Completion::Exited(Ok(exit)) => {
            let message = match exit.code() {
                Some(code) => format!("命令退出码为 {code}"),
                None => "命令被系统终止".to_string(),
            };
            (
                ExecutionStatus::Failed,
                exit.code(),
                Some(message.clone()),
                format!("任务执行失败：{message}。\n"),
            )
        }
        Completion::Exited(Err(error)) => (
            ExecutionStatus::Failed,
            None,
            Some(error.to_string()),
            format!("等待命令结束时发生错误：{error}。\n"),
        ),
        Completion::Cancelled => {
            let (status, message, log_line) = cancelled_outcome(app_is_exiting(&app));
            (
                status,
                None,
                Some(message.to_string()),
                log_line.to_string(),
            )
        }
        Completion::TimedOut => (
            ExecutionStatus::TimedOut,
            None,
            Some("命令执行超过 10 分钟".to_string()),
            "任务执行超时，已终止完整进程树。\n".to_string(),
        ),
    };
    append_system_log(&app, &id, &message).await;

    if let Err(error) = manager
        .complete(&app, &id, status, exit_code, error_message.as_deref())
        .await
    {
        log::error!("unable to complete execution task task_id={id} error={error}");
    }
}

fn verify_updated_version(version_before: &str, version_after: String) -> Result<String, String> {
    if version_before == version_after {
        Err(format!(
            "更新命令退出成功，但目标 CLI 版本仍为 {version_after}；更新可能作用于其他安装位置"
        ))
    } else {
        Ok(version_after)
    }
}

/// Spawns `future` on the async runtime inside its own tokio task, so a panic in it is logged
/// (with `label`) instead of vanishing with a dropped join handle.
fn spawn_logged<F>(label: String, future: F) -> tauri::async_runtime::JoinHandle<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        if let Err(error) = tokio::spawn(future).await {
            log::error!("{label} ended abnormally: {error}");
        }
    })
}

pub(crate) const LOG_FLUSH_BYTES: usize = 32 * 1024;
pub(crate) const LOG_FLUSH_INTERVAL: Duration = Duration::from_millis(100);

/// Merges small output reads into larger log writes. A pure data structure: the caller passes
/// the time, so it can be tested deterministically.
pub(crate) struct LogCoalescer {
    buffer: Vec<u8>,
    first_at: Option<Instant>,
    max_bytes: usize,
    interval: Duration,
}

impl LogCoalescer {
    pub(crate) fn new(max_bytes: usize, interval: Duration) -> Self {
        Self {
            buffer: Vec::new(),
            first_at: None,
            max_bytes,
            interval,
        }
    }

    /// Appends `bytes`; returns everything buffered when it reached `max_bytes` or when `now`
    /// is at least `interval` after the first unflushed byte arrived.
    pub(crate) fn push(&mut self, bytes: &[u8], now: Instant) -> Option<Vec<u8>> {
        if bytes.is_empty() {
            return None;
        }
        if self.buffer.is_empty() {
            self.first_at = Some(now);
        }
        self.buffer.extend_from_slice(bytes);
        let due = self
            .first_at
            .is_some_and(|first| now.saturating_duration_since(first) >= self.interval);
        if self.buffer.len() >= self.max_bytes || due {
            self.take()
        } else {
            None
        }
    }

    /// When the buffered bytes must be flushed at the latest; `None` while empty.
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.first_at.map(|first| first + self.interval)
    }

    /// The remainder, exactly once; `None` when empty.
    pub(crate) fn take(&mut self) -> Option<Vec<u8>> {
        self.first_at = None;
        if self.buffer.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buffer))
        }
    }
}

/// Where merged log chunks go (the database in production, a recorder in tests).
pub(crate) trait LogSink {
    fn task_id(&self) -> &str;
    fn append(
        &self,
        stream: ExecutionStream,
        content: String,
    ) -> impl Future<Output = Result<(), AppError>> + Send;
}

pub(crate) struct AppLogSink {
    app: AppHandle,
    task_id: String,
}

impl AppLogSink {
    fn new(app: AppHandle, task_id: String) -> Self {
        Self { app, task_id }
    }
}

impl LogSink for AppLogSink {
    fn task_id(&self) -> &str {
        &self.task_id
    }

    fn append(
        &self,
        stream: ExecutionStream,
        content: String,
    ) -> impl Future<Output = Result<(), AppError>> + Send {
        let app = self.app.clone();
        let task_id = self.task_id.clone();
        async move { append_log(&app, &task_id, stream, &content).await }
    }
}

/// Reads `reader` until EOF and writes the output through `sink` in coalesced chunks (at most
/// every `LOG_FLUSH_INTERVAL` or `LOG_FLUSH_BYTES`). A failed write is logged, never fatal.
pub(crate) async fn pump_output_to<R, S>(sink: S, stream: ExecutionStream, mut reader: R)
where
    R: AsyncRead + Unpin,
    S: LogSink,
{
    let mut coalescer = LogCoalescer::new(LOG_FLUSH_BYTES, LOG_FLUSH_INTERVAL);
    let mut buffer = [0_u8; 8192];

    async fn write<S: LogSink>(sink: &S, stream: ExecutionStream, batch: Vec<u8>) {
        let content = String::from_utf8_lossy(&batch).into_owned();
        if let Err(error) = sink.append(stream, content).await {
            log::error!(
                "unable to persist execution log task_id={} error={error}",
                sink.task_id()
            );
        }
    }

    loop {
        let read = match coalescer.deadline() {
            Some(deadline) => {
                tokio::select! {
                    result = reader.read(&mut buffer) => Some(result),
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => None,
                }
            }
            None => Some(reader.read(&mut buffer).await),
        };
        match read {
            None => {
                if let Some(batch) = coalescer.take() {
                    write(&sink, stream, batch).await;
                }
            }
            Some(Ok(0)) => {
                if let Some(batch) = coalescer.take() {
                    write(&sink, stream, batch).await;
                }
                return;
            }
            Some(Ok(read)) => {
                if let Some(batch) = coalescer.push(&buffer[..read], Instant::now()) {
                    write(&sink, stream, batch).await;
                }
            }
            Some(Err(error)) => {
                if let Some(batch) = coalescer.take() {
                    write(&sink, stream, batch).await;
                }
                if let Err(append_error) = sink
                    .append(
                        ExecutionStream::System,
                        format!("读取任务输出失败：{error}。\n"),
                    )
                    .await
                {
                    log::error!(
                        "unable to persist system execution log task_id={} error={append_error}",
                        sink.task_id()
                    );
                }
                return;
            }
        }
    }
}

/// Entry point for the supervisor callback, which is synchronous: the persistence runs on its
/// own task. Code already inside an async task calls `finish_failed_now` directly.
fn finish_failed(app: &AppHandle, id: &str, message: String) {
    let app = app.clone();
    let id = id.to_string();
    spawn_logged(format!("finish failed {id}"), async move {
        finish_failed_now(&app, &id, message).await;
    });
}

async fn finish_failed_now(app: &AppHandle, id: &str, message: String) {
    append_system_log(app, id, &format!("{message}\n")).await;
    let manager = app.state::<ExecutionTaskManager>();
    if let Err(error) = manager
        .complete(app, id, ExecutionStatus::Failed, None, Some(&message))
        .await
    {
        log::error!("unable to mark execution task failed task_id={id} error={error}");
    }
}

/// Outcome of a task cancelled while running. During exit cleanup the cancellation is not a
/// user action, so the task is recorded as interrupted (PD-12②).
fn cancelled_outcome(exiting: bool) -> (ExecutionStatus, &'static str, &'static str) {
    if exiting {
        (
            ExecutionStatus::Interrupted,
            "应用退出时任务被中断",
            "任务已因应用退出而中断。更新中断时可能需要重新安装对应 CLI。\n",
        )
    } else {
        (
            ExecutionStatus::Cancelled,
            "用户终止了任务",
            "任务已由用户终止。更新中断时可能需要重新安装对应 CLI。\n",
        )
    }
}

fn app_is_exiting(app: &AppHandle) -> bool {
    app.try_state::<ExecutionTaskManager>()
        .is_some_and(|manager| manager.is_exiting())
}

async fn finish_interrupted_on_exit(app: &AppHandle, id: &str) {
    let (status, message, log_line) = cancelled_outcome(true);
    append_system_log(app, id, log_line).await;
    let manager = app.state::<ExecutionTaskManager>();
    if let Err(error) = manager.complete(app, id, status, None, Some(message)).await {
        log::error!("unable to mark execution task interrupted on exit task_id={id} error={error}");
    }
}

async fn finish_cancelled(app: &AppHandle, id: &str, message: String) {
    append_system_log(app, id, &format!("任务已取消：{message}。\n")).await;
    let manager = app.state::<ExecutionTaskManager>();
    if let Err(error) = manager
        .complete(app, id, ExecutionStatus::Cancelled, None, Some(&message))
        .await
    {
        log::error!("unable to mark execution task cancelled task_id={id} error={error}");
    }
}

async fn append_system_log(app: &AppHandle, id: &str, message: &str) {
    if let Err(error) = append_log(app, id, ExecutionStream::System, message).await {
        log::error!("unable to persist system execution log task_id={id} error={error}");
    }
}

async fn append_log(
    app: &AppHandle,
    id: &str,
    stream: ExecutionStream,
    content: &str,
) -> Result<(), AppError> {
    let task_id = id.to_string();
    let content = content.to_string();
    let (chunk, newly_truncated) = db_call(app, "exec.append_log", move |connection| {
        Ok(execution_task_repo::append_log(
            connection,
            &task_id,
            stream,
            &content,
            now_ms(),
        )?)
    })
    .await?;
    if let Some(chunk) = chunk {
        emit_log(app, &chunk);
    }
    if newly_truncated {
        emit_task(app, &get_task(app, id).await?);
    }
    Ok(())
}

async fn get_task(app: &AppHandle, id: &str) -> Result<ExecutionTask, AppError> {
    let id = id.to_string();
    db_call(app, "exec.get", move |connection| {
        execution_task_repo::get(connection, &id)?
            .ok_or_else(|| AppError::internal("执行任务不存在"))
    })
    .await
}

async fn update_status(
    app: &AppHandle,
    id: &str,
    status: ExecutionStatus,
    finished_at_ms: Option<i64>,
    exit_code: Option<i32>,
    error_message: Option<&str>,
) -> Result<ExecutionTask, AppError> {
    let task_id = id.to_string();
    let error_message = error_message.map(str::to_string);
    let task = db_call(app, "exec.update_status", move |connection| {
        Ok(execution_task_repo::update_status(
            connection,
            &task_id,
            status,
            finished_at_ms,
            exit_code,
            error_message.as_deref(),
        )?)
    })
    .await?;
    emit_task(app, &task);
    Ok(task)
}

/// Every database access of the execution service goes through `Db::call` (blocking pool,
/// never the async worker).
async fn db_call<T: Send + 'static>(
    app: &AppHandle,
    op: &'static str,
    action: impl FnOnce(&mut rusqlite::Connection) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let db = app.state::<Db>().inner().clone();
    db.call(op, action).await
}

fn emit_task(app: &AppHandle, task: &ExecutionTask) {
    let payload = match serde_json::to_value(task) {
        Ok(payload) => payload,
        Err(error) => {
            log::warn!(
                "unable to serialize execution task update task_id={} error={error}",
                task.id
            );
            return;
        }
    };
    if crate::services::window_inbox::notify_main(app, TASK_UPDATED_EVENT, payload)
        == crate::services::window_inbox::DeliverOutcome::NoInbox
    {
        log::warn!(
            "unable to emit execution task update task_id={}: main window inbox is unavailable",
            task.id
        );
    }
}

fn emit_log(app: &AppHandle, chunk: &ExecutionLogChunk) {
    let payload = match serde_json::to_value(chunk) {
        Ok(payload) => payload,
        Err(error) => {
            log::warn!(
                "unable to serialize execution log task_id={} error={error}",
                chunk.task_id
            );
            return;
        }
    };
    if crate::services::window_inbox::notify_main(app, TASK_LOG_EVENT, payload)
        == crate::services::window_inbox::DeliverOutcome::NoInbox
    {
        log::warn!(
            "unable to emit execution log task_id={}: main window inbox is unavailable",
            chunk.task_id
        );
    }
}

pub struct ExecutionExitCleanup {
    manager: ExecutionTaskManager,
    db: Db,
}

impl ExecutionExitCleanup {
    pub fn new(manager: ExecutionTaskManager, db: Db) -> Self {
        Self { manager, db }
    }
}

impl crate::services::exit_cleanup::ExitCleanupTarget for ExecutionExitCleanup {
    fn name(&self) -> &'static str {
        "execution_tasks"
    }

    fn terminate_all(&self, budget: Duration) -> Result<usize, AppError> {
        let active = self.manager.active_count();
        for cancel in self.manager.take_cancel_senders_for_exit()? {
            let _ = cancel.send(());
        }
        // Leave 500 ms of the budget for the database update below.
        let deadline =
            std::time::Instant::now() + budget.saturating_sub(Duration::from_millis(500));
        while self.manager.active_count() > 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let leftover = self.manager.clear_all_for_exit()?;
        if leftover != 0 {
            log::warn!("{leftover} execution task(s) did not stop in time during exit");
        }
        let interrupted = self.db.with_sync("exec.exit_cleanup", |connection| {
            Ok(execution_task_repo::mark_unfinished_interrupted(
                connection,
                now_ms(),
            )?)
        })?;
        if interrupted != 0 {
            log::warn!("marked {interrupted} unfinished execution task(s) as interrupted on exit");
        }
        Ok(active)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn active_task(id: &str) -> ActiveTask {
        let (cancel, _cancel_rx) = oneshot::channel();
        ActiveTask {
            id: id.to_string(),
            cancel: Some(cancel),
        }
    }

    #[test]
    fn active_count_reports_registered_tasks() {
        let manager = ExecutionTaskManager::default();
        assert_eq!(manager.active_count(), 0);

        manager.active.lock().unwrap().insert(
            ToolKey::Claude,
            ActiveTask {
                id: "t1".into(),
                cancel: None,
            },
        );
        manager.active.lock().unwrap().insert(
            ToolKey::Codex,
            ActiveTask {
                id: "t2".into(),
                cancel: None,
            },
        );
        assert_eq!(manager.active_count(), 2);

        manager.active.lock().unwrap().remove_by_id("t1");
        assert_eq!(manager.active_count(), 1);
        manager.active.lock().unwrap().remove_by_id("t2");
        assert_eq!(manager.active_count(), 0);

        // 反向断言：同一工具重复登记按工具去重，总数不增加。
        manager.active.lock().unwrap().insert(
            ToolKey::Claude,
            ActiveTask {
                id: "a".into(),
                cancel: None,
            },
        );
        manager.active.lock().unwrap().insert(
            ToolKey::Claude,
            ActiveTask {
                id: "b".into(),
                cancel: None,
            },
        );
        assert_eq!(manager.active_count(), 1);
    }

    #[test]
    fn active_tasks_keep_each_tool_independent() {
        let mut active = ActiveTasks::default();
        active.insert(ToolKey::Claude, active_task("claude-task"));
        active.insert(ToolKey::Codex, active_task("codex-task"));

        assert!(active.contains_tool(ToolKey::Claude));
        assert!(active.contains_tool(ToolKey::Codex));
        assert!(!active.contains_tool(ToolKey::Antigravity));
        assert_eq!(
            active.get_by_id("claude-task").map(|task| task.id.as_str()),
            Some("claude-task")
        );
        assert_eq!(
            active.get_by_id("codex-task").map(|task| task.id.as_str()),
            Some("codex-task")
        );
    }

    #[test]
    fn removing_one_task_only_releases_its_tool() {
        let mut active = ActiveTasks::default();
        active.insert(ToolKey::Claude, active_task("claude-task"));
        active.insert(ToolKey::Codex, active_task("codex-task"));

        active.remove_by_id("claude-task");

        assert!(!active.contains_tool(ToolKey::Claude));
        assert!(active.contains_tool(ToolKey::Codex));
        assert!(active.get_by_id("claude-task").is_none());
        assert!(active.get_by_id("codex-task").is_some());
    }

    #[test]
    fn cancellation_lookup_targets_only_the_matching_task() {
        let mut active = ActiveTasks::default();
        active.insert(ToolKey::Claude, active_task("claude-task"));
        active.insert(ToolKey::Codex, active_task("codex-task"));

        let matching = active.get_mut_by_id("codex-task").unwrap();
        let _cancel = matching.cancel.take();

        assert!(active.get_by_id("codex-task").unwrap().cancel.is_none());
        assert!(active.get_by_id("claude-task").unwrap().cancel.is_some());
    }

    #[tokio::test]
    async fn completion_persistence_failure_still_releases_the_tool_slot() {
        let manager = ExecutionTaskManager::default();
        manager
            .active
            .lock()
            .unwrap()
            .insert(ToolKey::Codex, active_task("codex-task"));

        let result: Result<(), AppError> = manager
            .release_before("codex-task", async {
                Err(AppError::internal("injected database write failure"))
            })
            .await;

        assert!(result.is_err());
        let mut active = manager.active.lock().unwrap();
        assert!(!active.contains_tool(ToolKey::Codex));
        active.insert(ToolKey::Codex, active_task("codex-task-2"));
        assert!(active.contains_tool(ToolKey::Codex));
    }

    #[test]
    fn active_task_guard_releases_slots_after_early_return_and_panic() {
        let manager = ExecutionTaskManager::default();
        manager
            .active
            .lock()
            .unwrap()
            .insert(ToolKey::Claude, active_task("claude-task"));

        {
            let _guard = manager.guard("claude-task");
            // The task body may return early after a state transition failure.
        }
        assert!(!manager
            .active
            .lock()
            .unwrap()
            .contains_tool(ToolKey::Claude));

        manager
            .active
            .lock()
            .unwrap()
            .insert(ToolKey::Claude, active_task("claude-task-panic"));
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = manager.guard("claude-task-panic");
            panic!("injected execution task panic");
        }));
        assert!(panic.is_err());

        let mut active = manager.active.lock().unwrap();
        assert!(!active.contains_tool(ToolKey::Claude));
        active.insert(ToolKey::Claude, active_task("claude-task-retry"));
        assert!(active.contains_tool(ToolKey::Claude));
    }

    #[test]
    fn successful_command_with_unchanged_version_fails_postcondition() {
        let error = super::verify_updated_version("2.1.280", "2.1.280".to_string()).unwrap_err();
        assert!(error.contains("更新可能作用于其他安装位置"));
    }

    #[test]
    fn successful_command_with_changed_version_passes_postcondition() {
        assert_eq!(
            super::verify_updated_version("2.1.280", "2.1.288".to_string()).unwrap(),
            "2.1.288"
        );
    }

    #[test]
    fn cancelled_while_running_is_interrupted_only_during_exit() {
        let (status, message, _) = cancelled_outcome(true);
        assert_eq!(status, ExecutionStatus::Interrupted);
        assert!(message.contains("退出"));
        assert!(status.is_terminal());

        let (status, message, log_line) = cancelled_outcome(false);
        assert_eq!(status, ExecutionStatus::Cancelled);
        assert_eq!(message, "用户终止了任务");
        assert!(log_line.contains("用户终止"));
    }

    #[test]
    fn exit_cleanup_marks_the_manager_as_exiting_before_cancelling() {
        let manager = ExecutionTaskManager::default();
        assert!(!manager.is_exiting());
        let (tx, _rx) = oneshot::channel::<()>();
        {
            let mut active = manager.active.lock().unwrap();
            active.insert(
                ToolKey::Claude,
                ActiveTask {
                    id: "t1".into(),
                    cancel: Some(tx),
                },
            );
        }
        let senders = manager.take_cancel_senders_for_exit().unwrap();
        assert_eq!(senders.len(), 1);
        assert!(manager.is_exiting());
        assert!(manager.clone().is_exiting());
    }

    #[test]
    fn running_execution_tasks_are_marked_interrupted_and_slots_released() {
        use crate::db::execution_task_repo;
        use crate::models::execution::ExecutionStatus;
        use crate::models::install::{InstallKind, InstallPlan};
        use crate::models::tool::ToolKey;
        use crate::services::exit_cleanup::ExitCleanupTarget;

        fn plan(tool_key: ToolKey) -> InstallPlan {
            InstallPlan {
                tool_key,
                kind: InstallKind::Update,
                program: "C:\\tool.exe".to_string(),
                args: vec!["update".to_string()],
                fingerprint: "test-fingerprint".to_string(),
                source: "test".to_string(),
                preview: "C:\\tool.exe update".to_string(),
            }
        }

        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        execution_task_repo::insert(&connection, "t1", &plan(ToolKey::Claude), 100).unwrap();
        execution_task_repo::insert(&connection, "t2", &plan(ToolKey::Codex), 100).unwrap();
        execution_task_repo::update_status(
            &connection,
            "t1",
            ExecutionStatus::Running,
            None,
            None,
            None,
        )
        .unwrap();
        execution_task_repo::update_status(
            &connection,
            "t2",
            ExecutionStatus::Running,
            None,
            None,
            None,
        )
        .unwrap();
        execution_task_repo::insert(&connection, "t3", &plan(ToolKey::Antigravity), 100).unwrap();
        execution_task_repo::update_status(
            &connection,
            "t3",
            ExecutionStatus::Succeeded,
            Some(150),
            Some(0),
            None,
        )
        .unwrap();
        let db = Db::new(connection);

        let manager = ExecutionTaskManager::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut active = manager.active.lock().unwrap();
            active.insert(
                ToolKey::Claude,
                ActiveTask {
                    id: "t1".into(),
                    cancel: None,
                },
            );
            active.insert(
                ToolKey::Codex,
                ActiveTask {
                    id: "t2".into(),
                    cancel: Some(tx),
                },
            );
        }
        let cleanup = ExecutionExitCleanup::new(manager.clone(), db.clone());
        let target: &dyn ExitCleanupTarget = &cleanup;

        assert_eq!(target.terminate_all(Duration::from_millis(100)).unwrap(), 2);
        assert_eq!(manager.active_count(), 0);
        assert!(rx.try_recv().is_ok());
        {
            let connection = db.lock_for_test();
            for id in ["t1", "t2"] {
                let task = execution_task_repo::get(&connection, id).unwrap().unwrap();
                assert_eq!(task.status, ExecutionStatus::Interrupted);
                assert!(task.finished_at_ms.is_some());
            }
            let finished = execution_task_repo::get(&connection, "t3")
                .unwrap()
                .unwrap();
            assert_eq!(finished.status, ExecutionStatus::Succeeded);
            assert_eq!(finished.finished_at_ms, Some(150));
            assert_eq!(
                execution_task_repo::mark_unfinished_interrupted(&connection, 999).unwrap(),
                0
            );
        }
        assert_eq!(target.terminate_all(Duration::from_millis(100)).unwrap(), 0);
    }

    #[tokio::test]
    async fn supervised_task_panic_finishes_failed_and_releases_slot() {
        let manager = ExecutionTaskManager::default();
        manager
            .active
            .lock()
            .unwrap()
            .insert(ToolKey::Claude, active_task("t1"));
        let guard = manager.guard("t1");
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();

        supervise_task(
            async move {
                let _guard = guard;
                panic!("injected panic");
            },
            move |message| recorded.lock().unwrap().push(message),
        )
        .await;

        let messages = calls.lock().unwrap().clone();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("执行任务异常退出"));
        assert!(messages[0].contains("panicked"));
        assert!(!manager
            .active
            .lock()
            .unwrap()
            .contains_tool(ToolKey::Claude));

        // Reverse: a task that finishes normally never reports an abnormal exit.
        let quiet_calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let quiet_recorded = quiet_calls.clone();
        supervise_task(async {}, move |message| {
            quiet_recorded.lock().unwrap().push(message)
        })
        .await;
        assert!(quiet_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn run_task_delegates_panic_handling_to_supervise_task() {
        let source = include_str!("execution_service.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("the source has a production section");
        let run_task = production
            .split("async fn run_task(")
            .nth(1)
            .expect("run_task exists")
            .split("async fn run_task_inner(")
            .next()
            .expect("run_task_inner follows run_task");
        assert!(run_task.contains("supervise_task("));
        assert!(run_task.contains("run_task_inner("));
        assert!(run_task.contains("finish_failed("));
        assert!(
            !run_task.contains("tokio::spawn(")
                && !run_task.contains("tauri::async_runtime::spawn("),
            "run_task must not spawn the inner task itself"
        );

        let supervisor = production
            .split("pub(crate) async fn supervise_task")
            .nth(1)
            .expect("supervise_task exists")
            .split("async fn run_task(")
            .next()
            .expect("run_task follows supervise_task");
        assert!(supervisor.contains("tokio::spawn(task)"));
        assert!(supervisor.contains("on_abnormal_exit("));
        assert!(supervisor.contains("执行任务异常退出"));

        assert_eq!(
            production.matches("supervise_task(").count(),
            1,
            "supervise_task must be called exactly once, from run_task"
        );
    }

    fn test_plan(tool_key: ToolKey) -> InstallPlan {
        InstallPlan {
            tool_key,
            kind: crate::models::install::InstallKind::Update,
            program: "C:\\tool.exe".to_string(),
            args: vec!["update".to_string()],
            fingerprint: "test-fingerprint".to_string(),
            source: "test".to_string(),
            preview: "C:\\tool.exe update".to_string(),
        }
    }

    fn memory_db(migrated: bool) -> Db {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        if migrated {
            crate::db::connection::apply_migrations(&connection).unwrap();
        }
        Db::new(connection)
    }

    #[test]
    fn reserve_blocks_a_second_start_for_the_same_tool_and_counts_as_active() {
        let manager = ExecutionTaskManager::default();

        let first = manager.reserve(ToolKey::Claude).unwrap();
        assert_eq!(manager.active_count(), 1);
        let error = manager.reserve(ToolKey::Claude).err().unwrap();
        assert!(error.to_string().contains("已有安装或更新任务正在执行"));
        let other = manager.reserve(ToolKey::Codex).unwrap();
        assert_eq!(manager.active_count(), 2);
        // A reservation has no cancel sender yet, so it is not an active task.
        assert!(manager.active.lock().unwrap().by_tool.is_empty());
        drop((first, other));
    }

    #[test]
    fn dropping_an_unconfirmed_reservation_releases_the_slot() {
        let manager = ExecutionTaskManager::default();

        drop(manager.reserve(ToolKey::Claude).unwrap());

        assert_eq!(manager.active_count(), 0);
        assert!(manager.reserve(ToolKey::Claude).is_ok());
    }

    #[test]
    fn confirm_moves_the_reservation_into_the_active_table_with_a_cancel_sender() {
        let manager = ExecutionTaskManager::default();
        let (tx, mut rx) = oneshot::channel();

        let reservation = manager.reserve(ToolKey::Claude).unwrap();
        let id = reservation.id().to_string();
        reservation.confirm(tx).unwrap();

        assert_eq!(
            manager.active.lock().unwrap().by_tool[&ToolKey::Claude].id,
            id
        );
        assert_eq!(manager.active_count(), 1);
        assert!(manager.reserve(ToolKey::Claude).is_err());
        let senders = manager.take_cancel_senders_for_exit().unwrap();
        assert_eq!(senders.len(), 1);
        for sender in senders {
            sender.send(()).unwrap();
        }
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn confirm_is_refused_after_exit_cleanup_cleared_the_reservation() {
        let manager = ExecutionTaskManager::default();
        let (tx, _rx) = oneshot::channel();
        let reservation = manager.reserve(ToolKey::Claude).unwrap();

        assert_eq!(manager.clear_all_for_exit().unwrap(), 1);

        let error = reservation.confirm(tx).unwrap_err();
        assert!(error.to_string().contains("应用正在退出"));
        assert_eq!(manager.active_count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reserve_and_persist_does_not_hold_the_active_lock_while_writing() {
        let db = memory_db(true);
        let manager = ExecutionTaskManager::default();
        // Holding the connection lock makes the write block until we let go.
        let held = db.lock_for_test();
        let writer = {
            let manager = manager.clone();
            let db = db.clone();
            tokio::spawn(async move {
                manager
                    .reserve_and_persist(&db, &test_plan(ToolKey::Claude))
                    .await
            })
        };
        // The probe polls and reserves on its own thread: if the `active` lock were held across
        // the blocked write it would block there and the receive below would time out.
        let (sender, receiver) = std::sync::mpsc::channel();
        {
            let probe = manager.clone();
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(2);
                while probe.active_count() == 0 && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                let taken_before_the_write = probe.active_count() == 1;
                let reserved_other = probe.reserve(ToolKey::Codex).is_ok();
                let _ = sender.send((taken_before_the_write, reserved_other));
            });
        }
        let (taken_before_the_write, reserved_other) = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("reserve must not wait for the blocked database write");
        assert!(taken_before_the_write, "the slot is taken before the write");
        assert!(reserved_other);

        drop(held);
        let (reservation, task) = writer.await.unwrap().unwrap();
        assert_eq!(task.status, ExecutionStatus::Preparing);
        drop(reservation);
    }

    #[tokio::test]
    async fn a_failed_insert_rolls_the_reservation_back() {
        let db = memory_db(false); // no execution_tasks table
        let manager = ExecutionTaskManager::default();

        let result = manager
            .reserve_and_persist(&db, &test_plan(ToolKey::Claude))
            .await;

        assert!(result.is_err());
        assert_eq!(manager.active_count(), 0);
        assert!(manager.reserve(ToolKey::Claude).is_ok());
    }

    #[test]
    fn coalescer_merges_small_chunks_until_the_size_limit() {
        let mut c = LogCoalescer::new(10, Duration::from_secs(60));
        let t0 = Instant::now();

        assert_eq!(c.push(b"abcd", t0), None);
        assert_eq!(c.push(b"efgh", t0), None);
        assert_eq!(c.push(b"ij", t0), Some(b"abcdefghij".to_vec()));
        assert_eq!(c.deadline(), None);
        assert_eq!(c.take(), None);
        assert_eq!(c.push(b"x", t0), None);
        assert_eq!(c.deadline(), Some(t0 + Duration::from_secs(60)));
    }

    #[test]
    fn coalescer_flushes_after_the_interval_even_when_small() {
        let mut c = LogCoalescer::new(1024, Duration::from_millis(100));
        let t0 = Instant::now();

        assert_eq!(c.push(b"a", t0), None);
        assert_eq!(c.push(b"b", t0 + Duration::from_millis(99)), None);
        assert_eq!(
            c.push(b"c", t0 + Duration::from_millis(100)),
            Some(b"abc".to_vec())
        );

        let mut other = LogCoalescer::new(1024, Duration::from_millis(100));
        other.push(b"a", t0);
        assert_eq!(other.deadline(), Some(t0 + Duration::from_millis(100)));
    }

    #[test]
    fn coalescer_take_returns_the_remainder_exactly_once() {
        let mut c = LogCoalescer::new(1024, Duration::from_secs(60));
        let t0 = Instant::now();

        assert_eq!(c.push(b"abc", t0), None);
        assert_eq!(c.take(), Some(b"abc".to_vec()));
        assert_eq!(c.take(), None);
        assert_eq!(c.push(b"", t0), None);
        assert_eq!(c.deadline(), None);
    }

    #[derive(Clone, Default)]
    struct FakeLogSink {
        calls: Arc<Mutex<Vec<(ExecutionStream, String)>>>,
    }

    impl LogSink for FakeLogSink {
        fn task_id(&self) -> &str {
            "fake-task"
        }

        fn append(
            &self,
            stream: ExecutionStream,
            content: String,
        ) -> impl Future<Output = Result<(), AppError>> + Send {
            self.calls.lock().unwrap().push((stream, content));
            std::future::ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn pump_output_appends_one_coalesced_chunk_through_the_sink() {
        use tokio::io::AsyncWriteExt;
        let sink = FakeLogSink::default();
        let calls = sink.calls.clone();
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        writer.write_all(b"a").await.unwrap();
        writer.write_all(b"b").await.unwrap();
        writer.write_all(b"c").await.unwrap();
        drop(writer);

        tokio::time::timeout(
            Duration::from_secs(2),
            pump_output_to(sink, ExecutionStream::Stdout, reader),
        )
        .await
        .expect("the pump ends at EOF");

        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "one coalesced write, no empty call at EOF");
        assert_eq!(calls[0].0, ExecutionStream::Stdout);
        assert_eq!(calls[0].1, "abc");
    }

    #[tokio::test]
    async fn pump_output_flushes_on_the_interval_before_the_stream_ends() {
        use tokio::io::AsyncWriteExt;
        let sink = FakeLogSink::default();
        let calls = sink.calls.clone();
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let pump = tokio::spawn(pump_output_to(sink, ExecutionStream::Stderr, reader));
        writer.write_all(b"x").await.unwrap();

        let deadline = Instant::now() + Duration::from_secs(1);
        while calls.lock().unwrap().is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            calls.lock().unwrap().clone(),
            vec![(ExecutionStream::Stderr, "x".to_string())],
            "flushed by the interval while the stream is still open"
        );
        assert!(!pump.is_finished());

        drop(writer);
        tokio::time::timeout(Duration::from_secs(2), pump)
            .await
            .expect("the pump ends at EOF")
            .unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1, "no second call at EOF");
    }

    #[tokio::test]
    async fn settling_a_task_waits_for_an_in_flight_status_transition() {
        let manager = ExecutionTaskManager::default();
        let (cancel, _cancel_rx) = oneshot::channel();
        let reservation = manager.reserve(ToolKey::Claude).unwrap();
        let id = reservation.id().to_string();
        reservation.confirm(cancel).unwrap();
        // A cancel is writing `Cancelling`: the terminal write must not overtake it.
        let transition = manager.transition.lock().await;
        let settled = {
            let manager = manager.clone();
            let id = id.clone();
            tokio::spawn(async move { manager.settle(&id, async { Ok::<_, AppError>(()) }).await })
        };

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !settled.is_finished(),
            "settle must wait for the transition lock"
        );
        assert_eq!(manager.active_count(), 1, "the slot is still held");

        drop(transition);
        settled.await.unwrap().unwrap();
        assert_eq!(manager.active_count(), 0);
    }

    /// Delivers one prepared chunk per read, then EOF.
    struct ChunkedReader {
        chunks: std::collections::VecDeque<&'static [u8]>,
    }

    impl AsyncRead for ChunkedReader {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if let Some(chunk) = self.chunks.pop_front() {
                buf.put_slice(chunk);
            }
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn pump_output_coalesces_reads_delivered_one_chunk_at_a_time() {
        let sink = FakeLogSink::default();
        let calls = sink.calls.clone();
        let reader = ChunkedReader {
            chunks: [b"a".as_slice(), b"b".as_slice(), b"c".as_slice()]
                .into_iter()
                .collect(),
        };

        tokio::time::timeout(
            Duration::from_secs(2),
            pump_output_to(sink, ExecutionStream::Stdout, reader),
        )
        .await
        .expect("the pump ends at EOF");

        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls, vec![(ExecutionStream::Stdout, "abc".to_string())]);
    }

    #[test]
    fn confirm_is_refused_once_exit_cleanup_started_cancelling() {
        let manager = ExecutionTaskManager::default();
        let (tx, _rx) = oneshot::channel();
        let reservation = manager.reserve(ToolKey::Claude).unwrap();

        // Exit cleanup marks the manager as exiting before it takes the cancel senders.
        manager.take_cancel_senders_for_exit().unwrap();

        assert!(reservation.confirm(tx).is_err());
        assert!(manager.active.lock().unwrap().by_tool.is_empty());
    }
}
