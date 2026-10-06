use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
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

pub const TASK_UPDATED_EVENT: &str = "execution-task-updated";
pub const TASK_LOG_EVENT: &str = "execution-task-log";
const TASK_TIMEOUT: Duration = Duration::from_secs(600);
const TERMINATION_GRACE: Duration = Duration::from_secs(2);

struct ActiveTask {
    id: String,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct ActiveTasks {
    by_tool: HashMap<ToolKey, ActiveTask>,
}

impl ActiveTasks {
    fn contains_tool(&self, tool_key: ToolKey) -> bool {
        self.by_tool.contains_key(&tool_key)
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
    }
}

#[derive(Clone, Default)]
pub struct ExecutionTaskManager {
    active: std::sync::Arc<Mutex<ActiveTasks>>,
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
    pub fn start(&self, app: &AppHandle, plan: InstallPlan) -> Result<ExecutionTask, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::msg("执行任务状态锁中毒"))?;
        if active.contains_tool(plan.tool_key) {
            return Err(AppError::msg(format!(
                "{} 已有安装或更新任务正在执行，请等待其结束或先终止任务",
                plan.tool_key.as_str()
            )));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let task = with_db(app, |connection| {
            Ok(execution_task_repo::insert(
                connection,
                &id,
                &plan,
                now_ms(),
            )?)
        })?;
        let (cancel, cancel_rx) = oneshot::channel();
        active.insert(
            plan.tool_key,
            ActiveTask {
                id: id.clone(),
                cancel: Some(cancel),
            },
        );
        emit_task(app, &task);

        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_task(app, id, plan, cancel_rx).await;
        });
        Ok(task)
    }

    pub fn cancel(&self, app: &AppHandle, id: &str) -> Result<ExecutionTask, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::msg("执行任务状态锁中毒"))?;
        let running = active
            .get_mut_by_id(id)
            .ok_or_else(|| AppError::msg("该任务当前未在执行，无法终止"))?;

        if let Some(cancel) = running.cancel.take() {
            let task = update_status(app, id, ExecutionStatus::Cancelling, None, None, None)?;
            let _ = cancel.send(());
            Ok(task)
        } else {
            get_task(app, id)
        }
    }

    fn transition_running(&self, app: &AppHandle, id: &str) -> Result<ExecutionTask, AppError> {
        let active = self
            .active
            .lock()
            .map_err(|_| AppError::msg("执行任务状态锁中毒"))?;
        let running = active
            .get_by_id(id)
            .ok_or_else(|| AppError::msg("执行任务状态已丢失"))?;
        if running.cancel.is_none() {
            return get_task(app, id);
        }
        update_status(app, id, ExecutionStatus::Running, None, None, None)
    }

    fn complete(
        &self,
        app: &AppHandle,
        id: &str,
        status: ExecutionStatus,
        exit_code: Option<i32>,
        error_message: Option<&str>,
    ) -> Result<ExecutionTask, AppError> {
        debug_assert!(status.is_terminal());
        let task = self.release_before(id, || {
            update_status(app, id, status, Some(now_ms()), exit_code, error_message)
        })
        .map_err(|error| {
            log::error!("unable to persist terminal execution task state task_id={id} error={error}");
            if let Err(emit_error) = app.emit_to(
                "main",
                "execution-task-persistence-failed",
                serde_json::json!({
                    "taskId": id,
                    "status": status.as_str(),
                    "message": error.to_string(),
                }),
            ) {
                log::warn!("unable to emit execution task persistence failure task_id={id} error={emit_error}");
            }
            error
        })?;
        if let Err(error) = with_db(app, |connection| {
            execution_task_repo::prune_old_finished(connection)?;
            Ok(())
        }) {
            log::warn!("unable to prune execution task history task_id={id} error={error}");
        }
        Ok(task)
    }

    fn release_before<T>(
        &self,
        id: &str,
        persist: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::msg("执行任务状态锁中毒"))?;
        active.remove_by_id(id);
        drop(active);
        persist()
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

async fn run_task(app: AppHandle, id: String, plan: InstallPlan, cancel: oneshot::Receiver<()>) {
    let task_app = app.clone();
    let task_id = id.clone();
    let task = tokio::spawn(run_task_inner(app, id, plan, cancel));
    if let Err(error) = task.await {
        finish_failed(&task_app, &task_id, format!("执行任务异常退出：{error}"));
    }
}

async fn run_task_inner(
    app: AppHandle,
    id: String,
    plan: InstallPlan,
    mut cancel: oneshot::Receiver<()>,
) {
    let manager = app.state::<ExecutionTaskManager>();
    let _active_task_guard = manager.guard(&id);
    if let Err(error) = manager.transition_running(&app, &id) {
        log::error!("unable to mark execution task running task_id={id} error={error}");
        finish_failed(&app, &id, format!("无法更新执行任务状态：{error}"));
        return;
    }
    append_system_log(&app, &id, "任务已启动。\n");

    let preflight_plan = plan.clone();
    let preflight = tokio::task::spawn_blocking(move || {
        cli_adapters::execution_preflight_message(&preflight_plan)
    });
    let preflight = match tokio::select! {
        biased;
        _ = &mut cancel => {
            finish_cancelled(&app, &id, "用户在执行前校验期间终止了任务".to_string());
            return;
        }
        result = preflight => result,
    } {
        Ok(Ok(preflight)) => preflight,
        Ok(Err(error)) => {
            finish_failed(&app, &id, error);
            return;
        }
        Err(error) => {
            finish_failed(&app, &id, format!("CLI 执行前校验任务异常：{error}"));
            return;
        }
    };
    if let Some(message) = preflight {
        append_system_log(&app, &id, &format!("{message}\n"));
    }

    let version_before_update = match cli_adapters::should_verify_update_result(&plan) {
        Ok(true) => match cli_adapters::probe_plan_version(&plan).await {
            Ok(version) => {
                append_system_log(&app, &id, &format!("更新前目标版本：{version}\n"));
                Some(version)
            }
            Err(error) => {
                finish_failed(
                    &app,
                    &id,
                    format!("无法读取更新前的目标 CLI 版本，已取消更新：{error}"),
                );
                return;
            }
        },
        Ok(false) => None,
        Err(error) => {
            finish_failed(&app, &id, error);
            return;
        }
    };

    let process_tree = match ProcessTree::new() {
        Ok(process_tree) => process_tree,
        Err(error) => {
            finish_failed(&app, &id, format!("无法创建进程树控制器：{error}"));
            return;
        }
    };

    let mut command = match cli_adapters::prepare_command(&plan) {
        Ok(command) => command,
        Err(error) => {
            finish_failed(&app, &id, error.to_string());
            return;
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Err(error) = process_tree.configure(&mut command) {
        finish_failed(&app, &id, format!("无法配置任务进程树：{error}"));
        return;
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish_failed(
                &app,
                &id,
                format!("无法启动命令 `{}`：{error}", plan.program),
            );
            return;
        }
    };

    if let Err(error) = process_tree.attach(&child) {
        let _ = child.kill().await;
        finish_failed(&app, &id, format!("无法将子进程加入任务进程树：{error}"));
        return;
    }

    let stdout_task = child.stdout.take().map(|stdout| {
        tauri::async_runtime::spawn(pump_output(
            app.clone(),
            id.clone(),
            ExecutionStream::Stdout,
            stdout,
        ))
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        tauri::async_runtime::spawn(pump_output(
            app.clone(),
            id.clone(),
            ExecutionStream::Stderr,
            stderr,
        ))
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
        Completion::Cancelled => (
            ExecutionStatus::Cancelled,
            None,
            Some("用户终止了任务".to_string()),
            "任务已由用户终止。更新中断时可能需要重新安装对应 CLI。\n".to_string(),
        ),
        Completion::TimedOut => (
            ExecutionStatus::TimedOut,
            None,
            Some("命令执行超过 10 分钟".to_string()),
            "任务执行超时，已终止完整进程树。\n".to_string(),
        ),
    };
    append_system_log(&app, &id, &message);

    if let Err(error) = manager.complete(&app, &id, status, exit_code, error_message.as_deref()) {
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

async fn pump_output<R>(app: AppHandle, task_id: String, stream: ExecutionStream, mut reader: R)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => return,
            Ok(read) => {
                let content = String::from_utf8_lossy(&buffer[..read]);
                if let Err(error) = append_log(&app, &task_id, stream, &content) {
                    log::error!("unable to persist execution log task_id={task_id} error={error}");
                }
            }
            Err(error) => {
                append_system_log(&app, &task_id, &format!("读取任务输出失败：{error}。\n"));
                return;
            }
        }
    }
}

fn finish_failed(app: &AppHandle, id: &str, message: String) {
    append_system_log(app, id, &format!("{message}\n"));
    let manager = app.state::<ExecutionTaskManager>();
    if let Err(error) = manager.complete(app, id, ExecutionStatus::Failed, None, Some(&message)) {
        log::error!("unable to mark execution task failed task_id={id} error={error}");
    }
}

fn finish_cancelled(app: &AppHandle, id: &str, message: String) {
    append_system_log(app, id, &format!("任务已取消：{message}。\n"));
    let manager = app.state::<ExecutionTaskManager>();
    if let Err(error) = manager.complete(app, id, ExecutionStatus::Cancelled, None, Some(&message))
    {
        log::error!("unable to mark execution task cancelled task_id={id} error={error}");
    }
}

fn append_system_log(app: &AppHandle, id: &str, message: &str) {
    if let Err(error) = append_log(app, id, ExecutionStream::System, message) {
        log::error!("unable to persist system execution log task_id={id} error={error}");
    }
}

fn append_log(
    app: &AppHandle,
    id: &str,
    stream: ExecutionStream,
    content: &str,
) -> Result<(), AppError> {
    let (chunk, newly_truncated) = with_db(app, |connection| {
        Ok(execution_task_repo::append_log(
            connection,
            id,
            stream,
            content,
            now_ms(),
        )?)
    })?;
    if let Some(chunk) = chunk {
        emit_log(app, &chunk);
    }
    if newly_truncated {
        emit_task(app, &get_task(app, id)?);
    }
    Ok(())
}

fn get_task(app: &AppHandle, id: &str) -> Result<ExecutionTask, AppError> {
    with_db(app, |connection| {
        execution_task_repo::get(connection, id)?.ok_or_else(|| AppError::msg("执行任务不存在"))
    })
}

fn update_status(
    app: &AppHandle,
    id: &str,
    status: ExecutionStatus,
    finished_at_ms: Option<i64>,
    exit_code: Option<i32>,
    error_message: Option<&str>,
) -> Result<ExecutionTask, AppError> {
    let task = with_db(app, |connection| {
        Ok(execution_task_repo::update_status(
            connection,
            id,
            status,
            finished_at_ms,
            exit_code,
            error_message,
        )?)
    })?;
    emit_task(app, &task);
    Ok(task)
}

fn with_db<T>(
    app: &AppHandle,
    action: impl FnOnce(&mut rusqlite::Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let state = app.state::<Db>();
    let mut connection = state
        .0
        .lock()
        .map_err(|_| AppError::msg("数据库连接锁中毒"))?;
    action(&mut connection)
}

fn emit_task(app: &AppHandle, task: &ExecutionTask) {
    if let Err(error) = app.emit(TASK_UPDATED_EVENT, task) {
        log::warn!(
            "unable to emit execution task update task_id={} error={error}",
            task.id
        );
    }
}

fn emit_log(app: &AppHandle, chunk: &ExecutionLogChunk) {
    if let Err(error) = app.emit(TASK_LOG_EVENT, chunk) {
        log::warn!(
            "unable to emit execution log task_id={} error={error}",
            chunk.task_id
        );
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_task(id: &str) -> ActiveTask {
        let (cancel, _cancel_rx) = oneshot::channel();
        ActiveTask {
            id: id.to_string(),
            cancel: Some(cancel),
        }
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

    #[test]
    fn completion_persistence_failure_still_releases_the_tool_slot() {
        let manager = ExecutionTaskManager::default();
        manager
            .active
            .lock()
            .unwrap()
            .insert(ToolKey::Codex, active_task("codex-task"));

        let result: Result<(), AppError> = manager.release_before("codex-task", || {
            Err(AppError::msg("injected database write failure"))
        });

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
}
