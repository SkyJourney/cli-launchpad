use tauri::{AppHandle, State};

use crate::db::execution_task_repo;
use crate::models::execution::{ExecutionTask, ExecutionTaskDetail};
use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::services::{execution_service::ExecutionTaskManager, install_service};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn start_execution_task(
    app: AppHandle,
    manager: State<'_, ExecutionTaskManager>,
    tool_key: ToolKey,
    kind: InstallKind,
) -> Result<ExecutionTask, AppError> {
    let plan: InstallPlan = install_service::plan(tool_key, kind)?;
    manager.start(&app, plan)
}

#[tauri::command]
pub fn list_execution_tasks(state: State<'_, Db>) -> Result<Vec<ExecutionTask>, AppError> {
    with_conn(&state, |connection| {
        Ok(execution_task_repo::list_recent(connection)?)
    })
}

#[tauri::command]
pub fn get_execution_task(
    state: State<'_, Db>,
    task_id: String,
) -> Result<ExecutionTaskDetail, AppError> {
    with_conn(&state, |connection| {
        execution_task_repo::detail(connection, &task_id)?
            .ok_or_else(|| AppError::msg("执行任务不存在"))
    })
}

#[tauri::command]
pub fn cancel_execution_task(
    app: AppHandle,
    manager: State<'_, ExecutionTaskManager>,
    task_id: String,
) -> Result<ExecutionTask, AppError> {
    manager.cancel(&app, &task_id)
}

#[tauri::command]
pub fn clear_execution_task(state: State<'_, Db>, task_id: String) -> Result<(), AppError> {
    with_conn(&state, |connection| {
        if execution_task_repo::delete_finished(connection, &task_id)? {
            Ok(())
        } else {
            Err(AppError::msg("执行中的任务不能清理，或任务不存在"))
        }
    })
}

#[tauri::command]
pub fn clear_execution_history(state: State<'_, Db>) -> Result<usize, AppError> {
    with_conn(&state, |connection| {
        Ok(execution_task_repo::clear_finished(connection)?)
    })
}
