use tauri::{ipc::Channel, Manager, State};

use crate::{
    blocking, bounded, budgets,
    models::window_kind::{CallerWindow, WindowKind},
    models::{
        pty_session::{
            PtyEvent, PtyFrontendStage, PtyHandoff, PtySession, PtySessionWindowStatusReport,
            PtySizeUpdate, PtyTerminalSnapshot,
        },
        tool::ToolKey,
    },
    services::{
        app_lifecycle::{AppExitGate, AppLifecycle, Operation},
        launch_service,
        project_directory::ProjectDirectory,
        pty_session_service::PtySessionManager,
        session_service,
    },
    AppError, Db,
};

#[tauri::command]
pub async fn create_pty_session(
    state: State<'_, PtySessionManager>,
    db: State<'_, Db>,
    lifecycle: State<'_, AppLifecycle>,
    directory_id: i64,
    tool_key: ToolKey,
    resume_session_id: Option<String>,
    size: PtySizeUpdate,
    on_event: Channel<PtyEvent>,
    caller: CallerWindow,
) -> Result<PtySession, AppError> {
    caller.require(&[WindowKind::Main])?;
    // One open: the directory row, the path check and the directory handle identity. `_root` must
    // stay bound until the command ends (it keeps the directory handle open); never rename it to `_`.
    let (_root, project) = ProjectDirectory::open_ref(&db, directory_id, None).await?;
    db.call("pty.tool_configured", move |connection| {
        Ok(launch_service::ensure_tool_configured(
            connection, tool_key,
        )?)
    })
    .await?;
    if let Some(session_id) = resume_session_id.as_deref() {
        let belongs = bounded("pty.session_belongs", budgets::PTY_LAUNCH_PREPARE, async {
            Ok::<bool, AppError>(
                session_service::session_belongs_to_directory(tool_key, &project.path, session_id)
                    .await?,
            )
        })
        .await?;
        if !belongs {
            return Err(AppError::msg("该会话不属于当前项目目录，已拒绝恢复"));
        }
    }
    let payload = bounded("pty.resolve_payload", budgets::PTY_LAUNCH_PREPARE, async {
        Ok::<_, AppError>(
            launch_service::resolve_payload_at_directory(
                project.path.clone(),
                tool_key,
                resume_session_id.as_deref(),
            )
            .await?,
        )
    })
    .await?;
    // The permit covers only the synchronous registration in `manager.create`.
    let start_permit = lifecycle.admit(Operation::PtyStart)?;
    let manager = state.inner().clone();
    let database = db.inner().clone();
    let window_label = caller.label().as_str().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _start_permit = start_permit;
        manager.create(
            &database,
            &project,
            tool_key,
            &payload,
            resume_session_id.as_deref(),
            size,
            &window_label,
            on_event,
        )
    })
    .await
    .map_err(|error| AppError::msg(format!("PTY 启动任务失败: {error}")))?
}

#[tauri::command]
// sync: 纯内存：入队，不等待写线程
pub fn write_pty_session(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    state.write(&session_id, caller.label().as_str(), data.as_bytes())
}

#[tauri::command]
pub async fn resize_pty_session(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    size: PtySizeUpdate,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    let manager = state.inner().clone();
    let label = caller.label().as_str().to_string();
    blocking("pty.resize", budgets::PTY_CONTROL, move || {
        manager.resize(&session_id, &label, size)
    })
    .await
}

#[tauri::command]
// sync: 纯内存：释放流控额度
pub fn acknowledge_pty_output(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    sequence: u64,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    state.acknowledge(&session_id, caller.label().as_str(), sequence)
}

#[tauri::command]
// sync: 纯内存：只记日志
pub fn report_pty_frontend_stage(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    stage: PtyFrontendStage,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    state.report_frontend_stage(&session_id, caller.label().as_str(), stage)
}

#[tauri::command]
pub async fn terminate_pty_session(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    let manager = state.inner().clone();
    let label = caller.label().as_str().to_string();
    blocking("pty.terminate", budgets::PTY_CONTROL, move || {
        manager.terminate(&session_id, &label)
    })
    .await
}

#[tauri::command]
// sync: 纯内存：状态机转移与流控暂停
pub fn begin_pty_handoff(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    target_window_label: String,
) -> Result<PtyHandoff, AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    state.begin_handoff(&session_id, caller.label().as_str(), &target_window_label)
}

#[tauri::command]
// sync: 纯内存：保存快照
pub fn stage_pty_handoff_snapshot(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    token: String,
    sequence: u64,
    snapshot: PtyTerminalSnapshot,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    state.stage_handoff_snapshot(
        &session_id,
        caller.label().as_str(),
        &token,
        sequence,
        snapshot,
    )
}

#[tauri::command]
pub async fn complete_pty_handoff(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    token: String,
    on_event: Channel<PtyEvent>,
) -> Result<PtySession, AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    let manager = state.inner().clone();
    let label = caller.label().as_str().to_string();
    blocking("pty.complete_handoff", budgets::PTY_CONTROL, move || {
        manager.complete_handoff(&session_id, &label, &token, on_event)
    })
    .await
}

#[tauri::command]
pub async fn finalize_pty_handoff(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    token: String,
    size: PtySizeUpdate,
) -> Result<PtySession, AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    let manager = state.inner().clone();
    let label = caller.label().as_str().to_string();
    blocking("pty.finalize_handoff", budgets::PTY_CONTROL, move || {
        manager.finalize_handoff(&session_id, &label, &token, size)
    })
    .await
}

#[tauri::command]
// sync: 纯内存：状态机转移
pub fn cancel_pty_handoff(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    token: String,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    state.cancel_handoff(&session_id, caller.label().as_str(), &token)
}

#[tauri::command]
// sync: 纯内存：读取路由快照
pub fn get_pty_session_window_status(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
) -> Result<PtySessionWindowStatusReport, AppError> {
    caller.require(&[WindowKind::Main, WindowKind::Terminal])?;
    state.window_status_report(&session_id, caller.label().as_str())
}

#[tauri::command]
pub async fn reattach_pty_session(
    state: State<'_, PtySessionManager>,
    caller: CallerWindow,
    session_id: String,
    on_event: Channel<PtyEvent>,
    snapshot: PtyTerminalSnapshot,
    sequence: u64,
    size: PtySizeUpdate,
) -> Result<PtySession, AppError> {
    caller.require(&[WindowKind::Main])?;
    let manager = state.inner().clone();
    let label = caller.label().as_str().to_string();
    blocking("pty.reattach", budgets::PTY_CONTROL, move || {
        manager.reattach(&session_id, &label, on_event, snapshot, sequence, size)
    })
    .await
}

#[tauri::command]
pub async fn confirm_app_exit(
    caller: CallerWindow,
    state: State<'_, PtySessionManager>,
    lifecycle: State<'_, AppLifecycle>,
    app: tauri::AppHandle,
    request_id: String,
) -> Result<(), AppError> {
    caller.require(&[WindowKind::Main])?;
    // Held until the process exits: termination failure drops it and rolls the phase back.
    let exit_permit = lifecycle.admit(Operation::Exit)?;
    let starts_lifecycle = lifecycle.inner().clone();
    let sessions = state.inner().clone();
    let blocking_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let exit_gate = blocking_app.state::<AppExitGate>();
        crate::services::app_lifecycle::confirm_exit_with(&exit_gate, &request_id, || {
            crate::services::exit_cleanup::terminate_ptys_after_starts_drain(
                &starts_lifecycle,
                &sessions,
                std::time::Duration::from_secs(3),
            )
        })
    })
    .await
    .map_err(|error| AppError::msg(format!("结束 PTY 会话任务异常：{error}")))??;
    // confirm_exit_with has already authorized the exit; 031 requires the "exiting" phase to stay
    // in place until app.exit, so the permit is kept.
    exit_permit.keep_exiting();
    app.exit(0);
    Ok(())
}
