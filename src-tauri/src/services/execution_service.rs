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
use crate::platform::execution_process::ProcessTree;
use crate::services::install_service;
use crate::{AppError, Db};

pub const TASK_UPDATED_EVENT: &str = "execution-task-updated";
pub const TASK_LOG_EVENT: &str = "execution-task-log";
const TASK_TIMEOUT: Duration = Duration::from_secs(600);

struct ActiveTask {
    id: String,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct ExecutionTaskManager {
    active: Mutex<Option<ActiveTask>>,
}

impl ExecutionTaskManager {
    pub fn start(&self, app: &AppHandle, plan: InstallPlan) -> Result<ExecutionTask, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::msg("执行任务状态锁中毒"))?;
        if active.is_some() {
            return Err(AppError::msg(
                "已有安装或更新任务正在执行，请等待其结束或先终止任务",
            ));
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
        *active = Some(ActiveTask {
            id: id.clone(),
            cancel: Some(cancel),
        });
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
            .as_mut()
            .filter(|running| running.id == id)
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
            .as_ref()
            .filter(|running| running.id == id)
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
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::msg("执行任务状态锁中毒"))?;
        let task = update_status(app, id, status, Some(now_ms()), exit_code, error_message)?;
        if active.as_ref().map(|running| running.id.as_str()) == Some(id) {
            *active = None;
        }
        with_db(app, |connection| {
            execution_task_repo::prune_old_finished(connection)?;
            Ok(())
        })?;
        Ok(task)
    }
}

enum Completion {
    Exited(std::io::Result<std::process::ExitStatus>),
    Cancelled,
    TimedOut,
}

async fn run_task(
    app: AppHandle,
    id: String,
    plan: InstallPlan,
    mut cancel: oneshot::Receiver<()>,
) {
    let manager = app.state::<ExecutionTaskManager>();
    if let Err(error) = manager.transition_running(&app, &id) {
        log::error!("unable to mark execution task running task_id={id} error={error}");
        return;
    }
    append_system_log(&app, &id, "任务已启动。\n");

    let process_tree = match ProcessTree::new() {
        Ok(process_tree) => process_tree,
        Err(error) => {
            finish_failed(&app, &id, format!("无法创建进程树控制器：{error}"));
            return;
        }
    };

    let mut command = install_service::build_command(&plan);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
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
        let _ = child.wait().await;
    }
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }

    let (status, exit_code, error_message, message) = match completion {
        Completion::Exited(Ok(exit)) if exit.success() => (
            ExecutionStatus::Succeeded,
            exit.code(),
            None,
            "任务执行成功。\n".to_string(),
        ),
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
