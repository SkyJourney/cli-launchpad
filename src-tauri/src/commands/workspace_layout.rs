use std::collections::HashSet;

use tauri::State;

use crate::models::workspace_layout::{
    WorkspaceLayoutApplyPlan, WorkspaceLayoutDocument, WorkspaceLayoutPresetSummary,
    WorkspaceLayoutSaveResult, WorkspaceLayoutStateRead,
};
use crate::services::pty_session_service::PtySessionManager;
use crate::services::workspace_layout_service::{self, LayoutReadStage};
use crate::{blocking, budgets, with_conn, AppError, Db};

/// Open session ids from the in-memory table (the liveness authority). Earlier `finish` writes
/// are retried first so the rows catch up; this is its own short step, never inside the
/// database lock.
async fn open_session_ids(
    sessions: &PtySessionManager,
    db: &Db,
) -> Result<HashSet<String>, AppError> {
    let manager = sessions.clone();
    let db = db.clone();
    blocking(
        "workspace_layout.running_sessions",
        budgets::PROJECT_DIRECTORY,
        move || {
            manager.flush_pending_persistence(&db);
            Ok(manager.running_session_ids())
        },
    )
    .await
}

#[tauri::command]
pub async fn get_workspace_layout(
    state: State<'_, Db>,
    sessions: State<'_, PtySessionManager>,
) -> Result<WorkspaceLayoutStateRead, AppError> {
    let running = open_session_ids(sessions.inner(), state.inner()).await?;
    let stage = state
        .call("workspace_layout.read", |connection| {
            workspace_layout_service::read_current_stage(connection)
        })
        .await?;
    match stage {
        LayoutReadStage::Done(read) => Ok(read),
        LayoutReadStage::Resolve(pending) => {
            blocking(
                "workspace_layout.resolve_slots",
                budgets::PROJECT_DIRECTORY,
                move || Ok(pending.finish(&running)),
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn save_workspace_layout(
    state: State<'_, Db>,
    revision: i64,
    layout: WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutSaveResult, AppError> {
    state
        .call("workspace_layout.save", move |connection| {
            workspace_layout_service::save_current(connection, revision, &layout)
        })
        .await
}

/// Explicitly replace an unreadable or unsupported workspace with the empty
/// default. Normal autosave must use `save_workspace_layout` instead.
#[tauri::command]
pub fn reset_workspace_layout(state: State<'_, Db>) -> Result<i64, AppError> {
    with_conn(&state, workspace_layout_service::reset_current)
}

#[tauri::command]
pub fn list_workspace_layout_presets(
    state: State<'_, Db>,
) -> Result<Vec<WorkspaceLayoutPresetSummary>, AppError> {
    with_conn(&state, |connection| {
        workspace_layout_service::list_presets(connection)
    })
}

#[tauri::command]
pub fn create_workspace_layout_preset(
    state: State<'_, Db>,
    name: String,
    layout: WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutPresetSummary, AppError> {
    with_conn(&state, |connection| {
        workspace_layout_service::create_preset(connection, &name, &layout)
    })
}

/// Replaces the selected named snapshot. The UI must ask for overwrite
/// confirmation before calling this explicit operation.
#[tauri::command]
pub fn update_workspace_layout_preset(
    state: State<'_, Db>,
    id: String,
    layout: WorkspaceLayoutDocument,
) -> Result<bool, AppError> {
    with_conn(&state, |connection| {
        workspace_layout_service::update_preset(connection, &id, &layout)
    })
}

#[tauri::command]
pub fn rename_workspace_layout_preset(
    state: State<'_, Db>,
    id: String,
    name: String,
) -> Result<bool, AppError> {
    with_conn(&state, |connection| {
        workspace_layout_service::rename_preset(connection, &id, &name)
    })
}

#[tauri::command]
pub fn delete_workspace_layout_preset(state: State<'_, Db>, id: String) -> Result<bool, AppError> {
    with_conn(&state, |connection| {
        workspace_layout_service::delete_preset(connection, &id)
    })
}

/// Produce the target presentation only; React applies it and performs any
/// detached-window handoff through the existing PTY handoff commands.
#[tauri::command]
pub async fn plan_apply_workspace_layout_preset(
    state: State<'_, Db>,
    sessions: State<'_, PtySessionManager>,
    id: String,
    active_layout: WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutApplyPlan, AppError> {
    let running = open_session_ids(sessions.inner(), state.inner()).await?;
    let pending = state
        .call("workspace_layout.plan_load", move |connection| {
            workspace_layout_service::plan_apply_preset_stage(connection, &id, &active_layout)
        })
        .await?;
    blocking(
        "workspace_layout.plan_compute",
        budgets::PROJECT_DIRECTORY,
        move || pending.finish(&running),
    )
    .await
}
