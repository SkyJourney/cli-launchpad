use tauri::{ipc::Channel, State, WebviewWindow};

use crate::{
    db::pty_session_repo,
    models::{
        pty_session::{
            PtyEvent, PtyFrontendStage, PtyHandoff, PtySession, PtySessionWindowStatus,
            PtySizeUpdate, PtyTerminalSnapshot,
        },
        tool::ToolKey,
    },
    services::{
        app_lifecycle::AppExitGate, pty_session_service::PtySessionManager, session_service,
    },
    with_conn, AppError, Db,
};

#[tauri::command]
pub async fn create_pty_session(
    state: State<'_, PtySessionManager>,
    db: State<'_, Db>,
    app: tauri::AppHandle,
    directory_id: i64,
    tool_key: ToolKey,
    resume_session_id: Option<String>,
    size: PtySizeUpdate,
    on_event: Channel<PtyEvent>,
    window: WebviewWindow,
) -> Result<PtySession, AppError> {
    let _start_guard = state.begin_session_start()?;
    if let Some(session_id) = resume_session_id.as_deref() {
        let path = with_conn(&db, |connection| {
            Ok(session_service::directory_path(connection, directory_id)?)
        })?;
        if !session_service::session_belongs_to_directory(tool_key, &path, session_id).await? {
            return Err(AppError::msg("该会话不属于当前项目目录，已拒绝恢复"));
        }
    }
    with_conn(&db, |connection| {
        state.create(
            connection,
            &app,
            directory_id,
            tool_key,
            resume_session_id.as_deref(),
            size,
            window.label(),
            on_event,
        )
    })
}

#[tauri::command]
pub fn write_pty_session(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    state.write(&session_id, window.label(), data.as_bytes())
}

#[tauri::command]
pub fn resize_pty_session(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    size: PtySizeUpdate,
) -> Result<(), AppError> {
    state.resize(&session_id, window.label(), size)
}

#[tauri::command]
pub fn acknowledge_pty_output(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    sequence: u64,
) -> Result<(), AppError> {
    state.acknowledge(&session_id, window.label(), sequence)
}

#[tauri::command]
pub fn report_pty_frontend_stage(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    stage: PtyFrontendStage,
) -> Result<(), AppError> {
    state.report_frontend_stage(&session_id, window.label(), stage)
}

#[tauri::command]
pub fn terminate_pty_session(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
) -> Result<(), AppError> {
    state.terminate(&session_id, window.label())
}

#[tauri::command]
pub fn begin_pty_handoff(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
) -> Result<PtyHandoff, AppError> {
    state.begin_handoff(&session_id, window.label())
}

#[tauri::command]
pub fn stage_pty_handoff_snapshot(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    token: String,
    sequence: u64,
    snapshot: PtyTerminalSnapshot,
) -> Result<(), AppError> {
    state.stage_handoff_snapshot(&session_id, window.label(), &token, sequence, snapshot)
}

#[tauri::command]
pub fn complete_pty_handoff(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    token: String,
    on_event: Channel<PtyEvent>,
) -> Result<PtySession, AppError> {
    state.complete_handoff(&session_id, window.label(), &token, on_event)
}

#[tauri::command]
pub fn finalize_pty_handoff(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    token: String,
    size: PtySizeUpdate,
) -> Result<PtySession, AppError> {
    state.finalize_handoff(&session_id, window.label(), &token, size)
}

#[tauri::command]
pub fn cancel_pty_handoff(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    token: String,
) -> Result<(), AppError> {
    state.cancel_handoff(&session_id, window.label(), &token)
}

#[tauri::command]
pub fn get_pty_session_window_status(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
) -> Result<PtySessionWindowStatus, AppError> {
    if window.label() != "main" && !window.label().starts_with("terminal-") {
        return Err(AppError::msg("当前窗口不允许查询终端所有权状态"));
    }
    state.window_status(&session_id, window.label())
}

#[tauri::command]
pub fn reattach_pty_session(
    state: State<'_, PtySessionManager>,
    window: WebviewWindow,
    session_id: String,
    on_event: Channel<PtyEvent>,
    snapshot: PtyTerminalSnapshot,
    sequence: u64,
    size: PtySizeUpdate,
) -> Result<PtySession, AppError> {
    state.reattach(
        &session_id,
        window.label(),
        on_event,
        snapshot,
        sequence,
        size,
    )
}

#[tauri::command]
pub fn list_pty_sessions(
    db: State<'_, Db>,
    directory_id: i64,
) -> Result<Vec<PtySession>, AppError> {
    with_conn(&db, |connection| {
        Ok(pty_session_repo::list_for_directory(
            connection,
            directory_id,
        )?)
    })
}

#[tauri::command]
pub async fn confirm_app_exit(
    state: State<'_, PtySessionManager>,
    exit_gate: State<'_, AppExitGate>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let sessions = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sessions.terminate_all())
        .await
        .map_err(|error| AppError::msg(format!("结束 PTY 会话任务异常：{error}")))??;
    exit_gate.authorize();
    app.exit(0);
    Ok(())
}
