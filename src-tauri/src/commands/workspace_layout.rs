use tauri::State;

use crate::models::workspace_layout::{
    WorkspaceLayoutApplyPlan, WorkspaceLayoutDocument, WorkspaceLayoutPresetSummary,
    WorkspaceLayoutSaveResult, WorkspaceLayoutStateRead,
};
use crate::services::workspace_layout_service::{self, LayoutReadStage};
use crate::{blocking, budgets, with_conn, AppError, Db};

#[tauri::command]
pub async fn get_workspace_layout(
    state: State<'_, Db>,
) -> Result<WorkspaceLayoutStateRead, AppError> {
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
                move || Ok(pending.finish()),
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
    id: String,
    active_layout: WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutApplyPlan, AppError> {
    let pending = state
        .call("workspace_layout.plan_load", move |connection| {
            workspace_layout_service::plan_apply_preset_stage(connection, &id, &active_layout)
        })
        .await?;
    blocking(
        "workspace_layout.plan_compute",
        budgets::PROJECT_DIRECTORY,
        move || pending.finish(),
    )
    .await
}
