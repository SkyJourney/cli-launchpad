use tauri::{ipc::Channel, State};

use crate::{
    db::pty_session_repo,
    models::{
        pty_session::{PtyEvent, PtyFrontendStage, PtySession, PtySizeUpdate},
        tool::ToolKey,
    },
    services::{pty_session_service::PtySessionManager, session_service},
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
) -> Result<PtySession, AppError> {
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
            on_event,
        )
    })
}

#[tauri::command]
pub fn write_pty_session(
    state: State<'_, PtySessionManager>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    state.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_pty_session(
    state: State<'_, PtySessionManager>,
    session_id: String,
    size: PtySizeUpdate,
) -> Result<(), AppError> {
    state.resize(&session_id, size)
}

#[tauri::command]
pub fn acknowledge_pty_output(
    state: State<'_, PtySessionManager>,
    session_id: String,
    sequence: u64,
) -> Result<(), AppError> {
    state.acknowledge(&session_id, sequence)
}

#[tauri::command]
pub fn report_pty_frontend_stage(
    state: State<'_, PtySessionManager>,
    session_id: String,
    stage: PtyFrontendStage,
) -> Result<(), AppError> {
    state.report_frontend_stage(&session_id, stage)
}

#[tauri::command]
pub fn terminate_pty_session(
    state: State<'_, PtySessionManager>,
    session_id: String,
) -> Result<(), AppError> {
    state.terminate(&session_id)
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
pub fn confirm_pty_exit(
    state: State<'_, PtySessionManager>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    state.terminate_all()?;
    state.authorize_exit();
    app.exit(0);
    Ok(())
}
