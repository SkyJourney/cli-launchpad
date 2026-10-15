use tauri::{AppHandle, State};

use crate::db::execution_task_repo;
use crate::models::execution::{ExecutionTask, ExecutionTaskDetail};
use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;
use crate::services::{
    app_lifecycle::{AppLifecycle, Operation},
    execution_service::ExecutionTaskManager,
    install_service,
};
use crate::{AppError, Db};

#[tauri::command]
pub async fn start_execution_task(
    app: AppHandle,
    manager: State<'_, ExecutionTaskManager>,
    db: State<'_, Db>,
    tool_key: ToolKey,
    kind: InstallKind,
    expected_fingerprint: String,
    lifecycle: State<'_, AppLifecycle>,
) -> Result<ExecutionTask, AppError> {
    let plan: InstallPlan =
        tauri::async_runtime::spawn_blocking(move || install_service::plan(tool_key, kind))
            .await
            .map_err(|error| AppError::msg(error.to_string()))??;
    install_service::verify_expected_fingerprint(&plan, &expected_fingerprint).map_err(|_| {
        AppError::coded(
            crate::error_codes::EXEC_PLAN_CHANGED,
            "安装计划已变化，请重新确认",
        )
    })?;
    // Held across the start so the admission covers the whole registration.
    let _start_permit = lifecycle.admit(Operation::ExecStart)?;
    manager.start(db.inner(), &app, plan).await
}

#[tauri::command]
pub async fn list_execution_tasks(state: State<'_, Db>) -> Result<Vec<ExecutionTask>, AppError> {
    state
        .call("exec.list", |connection| {
            Ok(execution_task_repo::list_recent(connection)?)
        })
        .await
}

#[tauri::command]
pub async fn get_execution_task(
    state: State<'_, Db>,
    task_id: String,
) -> Result<ExecutionTaskDetail, AppError> {
    state
        .call("exec.get_detail", move |connection| {
            execution_task_repo::detail(connection, &task_id)?
                .ok_or_else(|| AppError::msg("执行任务不存在"))
        })
        .await
}

#[tauri::command]
pub async fn cancel_execution_task(
    app: AppHandle,
    manager: State<'_, ExecutionTaskManager>,
    task_id: String,
) -> Result<ExecutionTask, AppError> {
    manager.cancel(&app, &task_id).await
}

#[tauri::command]
pub async fn clear_execution_task(state: State<'_, Db>, task_id: String) -> Result<(), AppError> {
    state
        .call("exec.clear_task", move |connection| {
            if execution_task_repo::delete_finished(connection, &task_id)? {
                Ok(())
            } else {
                Err(AppError::msg("执行中的任务不能清理，或任务不存在"))
            }
        })
        .await
}

#[tauri::command]
pub async fn clear_execution_history(state: State<'_, Db>) -> Result<usize, AppError> {
    state
        .call("exec.clear_history", |connection| {
            Ok(execution_task_repo::clear_finished(connection)?)
        })
        .await
}
