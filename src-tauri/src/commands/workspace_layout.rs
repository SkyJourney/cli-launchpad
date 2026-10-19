use std::collections::HashSet;

use tauri::State;

use crate::models::backup::BackupReason;
use crate::models::workspace_layout::{
    WorkspaceLayoutApplyPlan, WorkspaceLayoutDocument, WorkspaceLayoutPresetSummary,
    WorkspaceLayoutSaveResult, WorkspaceLayoutStateRead,
};
use crate::services::backup_service;
use crate::services::project_path_semantics::CaseSensitivityCache;
use crate::services::pty_session_service::PtySessionManager;
use crate::services::storage_service::StoragePaths;
use crate::services::workspace_layout_service::{self, LayoutReadStage, SaveContext};
use crate::{blocking, budgets, AppError, Db};

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
    read_layout_with(state.inner(), running).await
}

/// Layout read after the in-memory open set was taken (m6-112): the slots' `Running` state is
/// decided by `running` alone, never by database rows.
async fn read_layout_with(
    db: &Db,
    running: HashSet<String>,
) -> Result<WorkspaceLayoutStateRead, AppError> {
    let stage = db
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
    semantics: State<'_, std::sync::Arc<CaseSensitivityCache>>,
    paths: State<'_, StoragePaths>,
    revision: i64,
    layout: WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutSaveResult, AppError> {
    let semantics = std::sync::Arc::clone(semantics.inner());
    let paths = paths.inner().clone();
    state
        .call("workspace_layout.save", move |connection| {
            let context = SaveContext {
                semantics_of: &|directory_id, directory_path| {
                    semantics.peek(directory_id, directory_path)
                },
                // The backup copies the database under the connection lock, as `create_with` does.
                backup_before_case_merge: &|connection| {
                    backup_service::create(connection, &paths, BackupReason::PreCaseMerge)
                        .map(|_| ())
                        .map_err(AppError::from)
                },
            };
            workspace_layout_service::save_current(connection, revision, &layout, &context)
        })
        .await
}

/// Explicitly replace an unreadable or unsupported workspace with the empty
/// default. Normal autosave must use `save_workspace_layout` instead.
#[tauri::command]
pub async fn reset_workspace_layout(state: State<'_, Db>) -> Result<i64, AppError> {
    state
        .call(
            "workspace_layout.reset",
            workspace_layout_service::reset_current,
        )
        .await
}

#[tauri::command]
pub async fn list_workspace_layout_presets(
    state: State<'_, Db>,
) -> Result<Vec<WorkspaceLayoutPresetSummary>, AppError> {
    state
        .call("workspace_layout.list_presets", |connection| {
            workspace_layout_service::list_presets(connection)
        })
        .await
}

#[tauri::command]
pub async fn create_workspace_layout_preset(
    state: State<'_, Db>,
    name: String,
    layout: WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutPresetSummary, AppError> {
    state
        .call("workspace_layout.create_preset", move |connection| {
            workspace_layout_service::create_preset(connection, &name, &layout)
        })
        .await
}

/// Replaces the selected named snapshot. The UI must ask for overwrite
/// confirmation before calling this explicit operation.
#[tauri::command]
pub async fn update_workspace_layout_preset(
    state: State<'_, Db>,
    id: String,
    layout: WorkspaceLayoutDocument,
) -> Result<bool, AppError> {
    state
        .call("workspace_layout.update_preset", move |connection| {
            workspace_layout_service::update_preset(connection, &id, &layout)
        })
        .await
}

#[tauri::command]
pub async fn rename_workspace_layout_preset(
    state: State<'_, Db>,
    id: String,
    name: String,
) -> Result<bool, AppError> {
    state
        .call("workspace_layout.rename_preset", move |connection| {
            workspace_layout_service::rename_preset(connection, &id, &name)
        })
        .await
}

#[tauri::command]
pub async fn delete_workspace_layout_preset(
    state: State<'_, Db>,
    id: String,
) -> Result<bool, AppError> {
    state
        .call("workspace_layout.delete_preset", move |connection| {
            workspace_layout_service::delete_preset(connection, &id)
        })
        .await
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
    plan_apply_with(state.inner(), running, id, active_layout).await
}

/// Applying a preset after the in-memory open set was taken (m6-112).
async fn plan_apply_with(
    db: &Db,
    running: HashSet<String>,
    id: String,
    active_layout: WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutApplyPlan, AppError> {
    let pending = db
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

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{open_session_ids, plan_apply_with, read_layout_with};
    use crate::db::{directory_repo, pty_session_repo};
    use crate::models::tool::ToolKey;
    use crate::models::workspace_layout::{
        WorkspaceLayoutDocument, WorkspaceLayoutNode, WorkspaceLayoutSlot, WorkspacePaneContentRef,
        WorkspaceSlotStateKind, WorkspaceSlotTitle, WORKSPACE_LAYOUT_SCHEMA_VERSION,
    };
    use crate::services::pty_session_service::PtySessionManager;
    use crate::services::workspace_layout_service;
    use crate::Db;

    fn memory_db() -> Db {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        Db::new(connection)
    }

    /// A project row for `path` and a layout with one PTY slot that points at `session_id`.
    fn project_with_slot(db: &Db, path: &str, session_id: &str) -> (i64, WorkspaceLayoutDocument) {
        let directory_id = {
            let connection = db.lock_for_test();
            directory_repo::add(&connection, "Project", path, None)
                .unwrap()
                .id
        };
        let slot_id = uuid::Uuid::new_v4().to_string();
        let layout = WorkspaceLayoutDocument {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            tree: WorkspaceLayoutNode::Pane {
                id: "workspace-root".to_string(),
                pane_number: 1,
                contents: vec![WorkspacePaneContentRef::Pty {
                    slot_id: slot_id.clone(),
                }],
                active_content: Some(WorkspacePaneContentRef::Pty {
                    slot_id: slot_id.clone(),
                }),
            },
            focused_pane_id: "workspace-root".to_string(),
            slots: vec![WorkspaceLayoutSlot {
                instance_id: slot_id.clone(),
                directory_id,
                directory_path: path.to_string(),
                project_name: "Project".to_string(),
                tool_key: ToolKey::Claude,
                sequence: 1,
                session_id: Some(session_id.to_string()),
                resume_session_id: None,
                title: WorkspaceSlotTitle::Automatic,
            }],
            documents: Vec::new(),
            detached_contents: Vec::new(),
        };
        (directory_id, layout)
    }

    fn state_of(
        slot_states: &[crate::models::workspace_layout::WorkspaceSlotState],
    ) -> WorkspaceSlotStateKind {
        assert_eq!(slot_states.len(), 1);
        slot_states[0].state
    }

    #[tokio::test]
    async fn open_session_ids_flushes_queued_finishes_then_returns_only_open_sessions() {
        let db = memory_db();
        let directory_id = {
            let connection = db.lock_for_test();
            let directory = directory_repo::add(&connection, "P", "C:/p", None).unwrap();
            pty_session_repo::insert_running(
                &connection,
                "ended-row",
                directory.id,
                ToolKey::Claude,
                "C:/p",
                1,
            )
            .unwrap();
            directory.id
        };
        let manager = PtySessionManager::default();
        manager.queue_failed_finish_for_test("ended-row", "exited", 7, Some(0));
        let open = manager.insert_test_session_in_directory("main", directory_id, None);

        let ids = open_session_ids(&manager, &db).await.unwrap();

        assert_eq!(ids, HashSet::from([open.session_id.clone()]));
        let connection = db.lock_for_test();
        let row = pty_session_repo::get_by_id(&connection, "ended-row")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "exited");
        assert_eq!(row.ended_at_ms, Some(7));
    }

    #[tokio::test]
    async fn layout_read_treats_the_memory_set_as_the_liveness_authority() {
        let session_id = uuid::Uuid::new_v4().to_string();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().display().to_string();
        let db = memory_db();
        let (directory_id, layout) = project_with_slot(&db, &path, &session_id);
        {
            let mut connection = db.lock_for_test();
            pty_session_repo::insert_running(
                &connection,
                &session_id,
                directory_id,
                ToolKey::Claude,
                &path,
                1,
            )
            .unwrap();
            workspace_layout_service::save_current(
                &mut connection,
                1,
                &layout,
                &workspace_layout_service::SaveContext::INERT,
            )
            .unwrap();
        }

        // The row says `running`, but memory does not know the session: it has ended.
        let ended = read_layout_with(&db, HashSet::new()).await.unwrap();
        assert_eq!(state_of(&ended.slot_states), WorkspaceSlotStateKind::Ended);

        let running = read_layout_with(&db, HashSet::from([session_id.clone()]))
            .await
            .unwrap();
        assert_eq!(
            state_of(&running.slot_states),
            WorkspaceSlotStateKind::Running
        );

        // Reverse: a set that holds some other session does not make this slot running.
        let other = read_layout_with(&db, HashSet::from(["other".to_string()]))
            .await
            .unwrap();
        assert_eq!(state_of(&other.slot_states), WorkspaceSlotStateKind::Ended);
    }

    #[tokio::test]
    async fn plan_apply_uses_the_memory_set_for_active_running_slots() {
        let session_id = uuid::Uuid::new_v4().to_string();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().display().to_string();
        let db = memory_db();
        let (directory_id, active) = project_with_slot(&db, &path, &session_id);
        let preset_id = {
            let mut connection = db.lock_for_test();
            pty_session_repo::insert_running(
                &connection,
                &session_id,
                directory_id,
                ToolKey::Claude,
                &path,
                1,
            )
            .unwrap();
            workspace_layout_service::create_preset(
                &mut connection,
                "Empty",
                &workspace_layout_service::empty_layout(),
            )
            .unwrap()
            .id
        };

        let without_memory =
            plan_apply_with(&db, HashSet::new(), preset_id.clone(), active.clone())
                .await
                .unwrap();
        assert!(
            without_memory.layout.slots.is_empty(),
            "an active slot that is not open in memory is dropped from the plan"
        );
        assert!(without_memory.slot_states.is_empty());

        let with_memory =
            plan_apply_with(&db, HashSet::from([session_id.clone()]), preset_id, active)
                .await
                .unwrap();
        assert_eq!(with_memory.layout.slots.len(), 1);
        assert_eq!(
            state_of(&with_memory.slot_states),
            WorkspaceSlotStateKind::Running
        );
    }
}
