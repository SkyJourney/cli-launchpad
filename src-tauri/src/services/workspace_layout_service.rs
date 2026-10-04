use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{directory_repo, pty_session_repo, workspace_layout_repo};
use crate::models::workspace_layout::{
    validate_preset_name, WorkspaceLayoutApplyPlan, WorkspaceLayoutDocument, WorkspaceLayoutNode,
    WorkspaceLayoutPreset, WorkspaceLayoutPresetSummary, WorkspaceLayoutSaveResult,
    WorkspaceLayoutSlot, WorkspaceLayoutStateRead, WorkspaceLayoutStateStatus,
    WorkspacePaneContentRef, WorkspaceSlotState, WorkspaceSlotStateKind,
    MAX_WORKSPACE_LAYOUT_PRESETS, WORKSPACE_LAYOUT_SCHEMA_VERSION,
};
use crate::{models::workspace_layout::WorkspaceLayoutError, AppError};

pub fn read_current(connection: &Connection) -> Result<WorkspaceLayoutStateRead, AppError> {
    let Some(row) = workspace_layout_repo::get_current(connection)? else {
        return Ok(WorkspaceLayoutStateRead {
            status: WorkspaceLayoutStateStatus::Missing,
            revision: None,
            schema_version: None,
            updated_at_ms: None,
            layout: None,
            slot_states: Vec::new(),
        });
    };

    if !is_supported_layout_version(row.schema_version) {
        return Ok(needs_reset(
            row.revision,
            row.schema_version,
            row.updated_at_ms,
            format!("不支持工作区布局版本 {}", row.schema_version),
        ));
    }
    if source_layout_version(&row.payload_json) != Some(row.schema_version) {
        return Ok(needs_reset(
            row.revision,
            row.schema_version,
            row.updated_at_ms,
            "布局 JSON 版本与数据库版本不一致".to_string(),
        ));
    }
    let mut layout = match WorkspaceLayoutDocument::from_json(&row.payload_json) {
        Ok(layout) => layout,
        Err(error) => {
            return Ok(needs_reset(
                row.revision,
                row.schema_version,
                row.updated_at_ms,
                error.to_string(),
            ));
        }
    };
    let slot_states = resolve_layout_slots(connection, &mut layout)?;
    Ok(WorkspaceLayoutStateRead {
        status: WorkspaceLayoutStateStatus::Ready,
        revision: Some(row.revision),
        schema_version: Some(i64::from(layout.schema_version)),
        updated_at_ms: Some(row.updated_at_ms),
        layout: Some(layout),
        slot_states,
    })
}

pub fn save_current(
    connection: &mut Connection,
    revision: i64,
    layout: &WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutSaveResult, AppError> {
    if revision <= 0 {
        return Err(AppError::msg("工作区 revision 必须大于 0"));
    }
    let payload_json = serialize_layout(layout, false)?;

    // Do not let routine autosaves replace data that needs explicit recovery.
    if let Some(current) = workspace_layout_repo::get_current(connection)? {
        if !is_supported_layout_version(current.schema_version) {
            return Err(AppError::msg(
                "当前布局版本不受支持；请先显式重置工作区后再保存",
            ));
        }
        let stored = WorkspaceLayoutDocument::from_json(&current.payload_json)
            .map_err(|error| AppError::msg(format!("当前布局需要显式重置：{error}")))?;
        if source_layout_version(&current.payload_json) != Some(current.schema_version) {
            return Err(AppError::msg("当前布局版本信息不一致；请先显式重置工作区"));
        }
        let _ = stored;
    }

    let (saved, current_revision) = workspace_layout_repo::save_current(
        connection,
        i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
        revision,
        &payload_json,
        now_ms(),
    )?;
    Ok(WorkspaceLayoutSaveResult {
        saved,
        revision: current_revision,
    })
}

pub fn reset_current(connection: &mut Connection) -> Result<i64, AppError> {
    if let Some(current) = workspace_layout_repo::get_current(connection)? {
        if is_supported_layout_version(current.schema_version)
            && WorkspaceLayoutDocument::from_json(&current.payload_json).is_ok()
        {
            return Err(AppError::msg("当前布局可以正常读取，无需执行恢复性重置"));
        }
    }
    let layout = empty_layout();
    let payload_json = serialize_layout(&layout, false)?;
    Ok(workspace_layout_repo::reset_current(
        connection,
        i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
        &payload_json,
        now_ms(),
    )?)
}

pub fn list_presets(
    connection: &Connection,
) -> Result<Vec<WorkspaceLayoutPresetSummary>, AppError> {
    Ok(workspace_layout_repo::list_presets(connection)?)
}

pub fn get_preset(connection: &Connection, id: &str) -> Result<WorkspaceLayoutPreset, AppError> {
    let row = workspace_layout_repo::get_preset(connection, id)?
        .ok_or_else(|| AppError::msg("命名布局不存在"))?;
    let layout = parse_preset_layout(row.summary.schema_version, &row.payload_json)?;
    let mut layout = layout;
    let slot_states = resolve_layout_slots(connection, &mut layout)?;
    let mut summary = row.summary;
    summary.schema_version = i64::from(layout.schema_version);
    Ok(WorkspaceLayoutPreset {
        summary,
        layout,
        slot_states,
    })
}

pub fn create_preset(
    connection: &mut Connection,
    name: &str,
    layout: &WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutPresetSummary, AppError> {
    let name = validate_preset_name(name).map_err(layout_error)?;
    let payload_json = serialize_layout(layout, true)?;
    let id = Uuid::new_v4().to_string();
    workspace_layout_repo::create_preset(
        connection,
        &id,
        &name,
        i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
        &payload_json,
        now_ms(),
        MAX_WORKSPACE_LAYOUT_PRESETS,
    )
    .map_err(map_preset_write_error)?;
    workspace_layout_repo::get_preset(connection, &id)?
        .map(|row| row.summary)
        .ok_or_else(|| AppError::msg("布局保存后无法读取"))
}

pub fn update_preset(
    connection: &Connection,
    id: &str,
    layout: &WorkspaceLayoutDocument,
) -> Result<bool, AppError> {
    let payload_json = serialize_layout(layout, true)?;
    workspace_layout_repo::update_preset(
        connection,
        id,
        i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
        &payload_json,
        now_ms(),
    )
    .map_err(map_preset_write_error)
}

pub fn rename_preset(connection: &Connection, id: &str, name: &str) -> Result<bool, AppError> {
    let name = validate_preset_name(name).map_err(layout_error)?;
    workspace_layout_repo::rename_preset(connection, id, &name, now_ms())
        .map_err(map_preset_write_error)
}

pub fn delete_preset(connection: &Connection, id: &str) -> Result<bool, AppError> {
    Ok(workspace_layout_repo::delete_preset(connection, id)?)
}

/// Build a pure presentation plan. This deliberately writes no workspace state
/// and never calls PTY lifecycle or handoff operations.
pub fn plan_apply_preset(
    connection: &Connection,
    id: &str,
    active_layout: &WorkspaceLayoutDocument,
) -> Result<WorkspaceLayoutApplyPlan, AppError> {
    active_layout.validate().map_err(layout_error)?;
    let row = workspace_layout_repo::get_preset(connection, id)?
        .ok_or_else(|| AppError::msg("命名布局不存在"))?;
    let mut layout = parse_preset_layout(row.summary.schema_version, &row.payload_json)?;

    let mut additions = Vec::new();
    let mut detached_slot_ids = Vec::new();
    let mut detached_tree_slot_ids = Vec::new();
    for active_slot in &active_layout.slots {
        let mut slot = active_slot.clone();
        let state = resolve_slot(connection, &mut slot)?;

        if active_layout.detached_slot_ids.contains(&slot.instance_id) {
            if matches!(
                state.state,
                WorkspaceSlotStateKind::Ended | WorkspaceSlotStateKind::MissingSession
            ) {
                continue;
            }

            if let Some(target_index) = layout.slots.iter().position(|target| {
                target.instance_id == slot.instance_id
                    || slot
                        .session_id
                        .as_ref()
                        .is_some_and(|session_id| target.session_id.as_ref() == Some(session_id))
            }) {
                let saved_slot = layout.slots.remove(target_index);
                detached_tree_slot_ids.push(saved_slot.instance_id);
            }

            detached_tree_slot_ids.push(slot.instance_id.clone());
            detached_slot_ids.push(slot.instance_id.clone());
            layout.slots.push(slot);
            continue;
        }

        if !matches!(
            state.state,
            WorkspaceSlotStateKind::Running | WorkspaceSlotStateKind::Pending
        ) {
            continue;
        }
        if let Some(target) = layout.slots.iter_mut().find(|target| {
            target.instance_id == slot.instance_id
                || slot
                    .session_id
                    .as_ref()
                    .is_some_and(|session_id| target.session_id.as_ref() == Some(session_id))
        }) {
            // Presets may contain an old descriptor for a still-running PTY.
            // Keep its saved position and title but trust the verified live
            // project's CLI/session identity.
            refresh_slot_identity(target, &slot);
            continue;
        }
        let source_pane = pane_identity_for_slot(&active_layout.tree, &slot.instance_id);
        let target_pane_id = source_pane
            .as_ref()
            .and_then(|(pane_id, _)| {
                contains_pane_id(&layout.tree, pane_id).then(|| pane_id.clone())
            })
            .or_else(|| {
                source_pane
                    .as_ref()
                    .and_then(|(_, pane_number)| pane_id_by_number(&layout.tree, *pane_number))
            })
            .unwrap_or_else(|| layout.focused_pane_id.clone());
        if !append_to_pane(&mut layout.tree, &target_pane_id, &slot.instance_id) {
            return Err(AppError::msg("命名布局的目标窗格不存在"));
        }
        additions.push(slot);
    }

    if !additions.is_empty() {
        layout.slots.extend(additions);
    }

    remove_slot_references(&mut layout.tree, &detached_tree_slot_ids);
    layout.detached_slot_ids = detached_slot_ids;

    let mut slot_states = resolve_layout_slots(connection, &mut layout)?;
    let ended_slot_ids: Vec<String> = slot_states
        .iter()
        .filter(|slot| slot.state == WorkspaceSlotStateKind::Ended)
        .map(|slot| slot.instance_id.clone())
        .collect();
    if !ended_slot_ids.is_empty() {
        remove_slot_references(&mut layout.tree, &ended_slot_ids);
        layout
            .slots
            .retain(|slot| !ended_slot_ids.contains(&slot.instance_id));
        layout
            .detached_slot_ids
            .retain(|instance_id| !ended_slot_ids.contains(instance_id));
        slot_states.retain(|slot| !ended_slot_ids.contains(&slot.instance_id));
    }
    layout.validate().map_err(layout_error)?;
    Ok(WorkspaceLayoutApplyPlan {
        layout,
        slot_states,
    })
}

pub fn empty_layout() -> WorkspaceLayoutDocument {
    WorkspaceLayoutDocument {
        schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
        tree: WorkspaceLayoutNode::Pane {
            id: "workspace-root".to_string(),
            pane_number: 1,
            contents: Vec::new(),
            active_content: None,
        },
        focused_pane_id: "workspace-root".to_string(),
        slots: Vec::new(),
        documents: Vec::new(),
        detached_slot_ids: Vec::new(),
    }
}

fn needs_reset(
    revision: i64,
    schema_version: i64,
    updated_at_ms: i64,
    reason: String,
) -> WorkspaceLayoutStateRead {
    WorkspaceLayoutStateRead {
        status: WorkspaceLayoutStateStatus::NeedsReset(reason),
        revision: Some(revision),
        schema_version: Some(schema_version),
        updated_at_ms: Some(updated_at_ms),
        layout: None,
        slot_states: Vec::new(),
    }
}

fn serialize_layout(layout: &WorkspaceLayoutDocument, as_preset: bool) -> Result<String, AppError> {
    if as_preset {
        layout.validate_as_preset().map_err(layout_error)?;
    } else {
        layout.validate().map_err(layout_error)?;
    }
    layout.to_json().map_err(layout_error)
}

fn parse_preset_layout(
    stored_schema_version: i64,
    payload_json: &str,
) -> Result<WorkspaceLayoutDocument, AppError> {
    if !is_supported_layout_version(stored_schema_version) {
        return Err(AppError::msg(format!(
            "该命名布局使用不支持的版本 {stored_schema_version}"
        )));
    }
    let layout = WorkspaceLayoutDocument::from_json(payload_json).map_err(layout_error)?;
    if source_layout_version(payload_json) != Some(stored_schema_version) {
        return Err(AppError::msg("命名布局 JSON 版本与数据库版本不一致"));
    }
    if i64::from(layout.schema_version) != i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION) {
        return Err(AppError::msg("命名布局未能迁移到当前版本"));
    }
    layout.validate_as_preset().map_err(layout_error)?;
    Ok(layout)
}

fn is_supported_layout_version(version: i64) -> bool {
    (1..=i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION)).contains(&version)
}

fn source_layout_version(payload_json: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(payload_json)
        .ok()?
        .get("schemaVersion")?
        .as_i64()
}

fn resolve_layout_slots(
    connection: &Connection,
    layout: &mut WorkspaceLayoutDocument,
) -> Result<Vec<WorkspaceSlotState>, AppError> {
    layout
        .slots
        .iter_mut()
        .map(|slot| resolve_slot(connection, slot))
        .collect()
}

fn resolve_slot(
    connection: &Connection,
    slot: &mut WorkspaceLayoutSlot,
) -> Result<WorkspaceSlotState, AppError> {
    let Some(directory) = directory_repo::get(connection, slot.directory_id)? else {
        return Ok(slot_state(
            slot,
            WorkspaceSlotStateKind::MissingProject,
            None,
        ));
    };
    if !crate::platform::path_identity::paths_equal(&directory.path, &slot.directory_path) {
        return Ok(slot_state(
            slot,
            WorkspaceSlotStateKind::ProjectIdentityMismatch,
            None,
        ));
    }
    slot.project_name.clone_from(&directory.name);
    let Some(session_id) = slot.session_id.as_deref() else {
        return Ok(slot_state(
            slot,
            WorkspaceSlotStateKind::Pending,
            Some(directory.name),
        ));
    };
    let Some(session) = pty_session_repo::get_by_id(connection, session_id)? else {
        return Ok(slot_state(
            slot,
            WorkspaceSlotStateKind::MissingSession,
            Some(directory.name),
        ));
    };
    if session.directory_id != slot.directory_id
        || session.tool_key != slot.tool_key
        || !crate::platform::path_identity::paths_equal(
            &session.working_directory,
            &slot.directory_path,
        )
    {
        return Ok(slot_state(
            slot,
            WorkspaceSlotStateKind::SessionIdentityMismatch,
            Some(directory.name),
        ));
    }
    let state = if session.state == "running" {
        WorkspaceSlotStateKind::Running
    } else {
        WorkspaceSlotStateKind::Ended
    };
    Ok(slot_state(slot, state, Some(directory.name)))
}

fn slot_state(
    slot: &WorkspaceLayoutSlot,
    state: WorkspaceSlotStateKind,
    current_project_name: Option<String>,
) -> WorkspaceSlotState {
    WorkspaceSlotState {
        instance_id: slot.instance_id.clone(),
        state,
        current_project_name,
    }
}

fn refresh_slot_identity(target: &mut WorkspaceLayoutSlot, active: &WorkspaceLayoutSlot) {
    target.directory_id = active.directory_id;
    target.directory_path.clone_from(&active.directory_path);
    target.project_name.clone_from(&active.project_name);
    target.tool_key = active.tool_key;
    target.sequence = active.sequence;
    target.session_id.clone_from(&active.session_id);
    target
        .resume_session_id
        .clone_from(&active.resume_session_id);
}

fn pane_identity_for_slot(node: &WorkspaceLayoutNode, slot_id: &str) -> Option<(String, u32)> {
    match node {
        WorkspaceLayoutNode::Pane {
            id,
            pane_number,
            contents,
            ..
        } => contents
            .iter()
            .any(|content| matches!(content, WorkspacePaneContentRef::Pty { slot_id: id } if id == slot_id))
            .then(|| (id.clone(), *pane_number)),
        WorkspaceLayoutNode::Split { first, second, .. } => pane_identity_for_slot(first, slot_id)
            .or_else(|| pane_identity_for_slot(second, slot_id)),
    }
}

fn contains_pane_id(node: &WorkspaceLayoutNode, pane_id: &str) -> bool {
    match node {
        WorkspaceLayoutNode::Pane { id, .. } => id == pane_id,
        WorkspaceLayoutNode::Split { first, second, .. } => {
            contains_pane_id(first, pane_id) || contains_pane_id(second, pane_id)
        }
    }
}

fn pane_id_by_number(node: &WorkspaceLayoutNode, pane_number: u32) -> Option<String> {
    match node {
        WorkspaceLayoutNode::Pane {
            id,
            pane_number: current_number,
            ..
        } => (*current_number == pane_number).then(|| id.clone()),
        WorkspaceLayoutNode::Split { first, second, .. } => {
            pane_id_by_number(first, pane_number).or_else(|| pane_id_by_number(second, pane_number))
        }
    }
}

fn append_to_pane(node: &mut WorkspaceLayoutNode, pane_id: &str, slot_id: &str) -> bool {
    match node {
        WorkspaceLayoutNode::Pane {
            id,
            contents,
            active_content,
            ..
        } if id == pane_id => {
            let content = WorkspacePaneContentRef::Pty {
                slot_id: slot_id.to_string(),
            };
            if !contents.contains(&content) {
                contents.push(content.clone());
            }
            if active_content.is_none() {
                *active_content = Some(content);
            }
            true
        }
        WorkspaceLayoutNode::Pane { .. } => false,
        WorkspaceLayoutNode::Split { first, second, .. } => {
            append_to_pane(first, pane_id, slot_id) || append_to_pane(second, pane_id, slot_id)
        }
    }
}

fn remove_slot_references(node: &mut WorkspaceLayoutNode, removed_slot_ids: &[String]) {
    match node {
        WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } => {
            let active_index = active_content
                .as_ref()
                .and_then(|active| contents.iter().position(|content| content == active));
            let active_was_removed = active_content
                .as_ref()
                .is_some_and(|active| matches!(active, WorkspacePaneContentRef::Pty { slot_id } if removed_slot_ids.contains(slot_id)));
            contents.retain(|content| {
                !matches!(content, WorkspacePaneContentRef::Pty { slot_id } if removed_slot_ids.contains(slot_id))
            });
            if active_was_removed {
                let replacement_index = active_index
                    .unwrap_or(0)
                    .min(contents.len().saturating_sub(1));
                *active_content = contents.get(replacement_index).cloned();
            }
        }
        WorkspaceLayoutNode::Split { first, second, .. } => {
            remove_slot_references(first, removed_slot_ids);
            remove_slot_references(second, removed_slot_ids);
        }
    }
}

fn layout_error(error: WorkspaceLayoutError) -> AppError {
    AppError::msg(error.to_string())
}

fn map_preset_write_error(error: rusqlite::Error) -> AppError {
    match &error {
        rusqlite::Error::InvalidParameterName(message)
            if message == "workspace layout preset limit reached" =>
        {
            AppError::msg(format!(
                "命名布局最多支持 {MAX_WORKSPACE_LAYOUT_PRESETS} 个"
            ))
        }
        _ if error.to_string().contains("UNIQUE constraint failed") => {
            AppError::msg("布局名称已存在，请使用其他名称")
        }
        _ => AppError::from(error),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{connection, directory_repo, pty_session_repo};
    use crate::models::tool::ToolKey;
    use crate::models::workspace_layout::{WorkspaceSlotTitle, WorkspaceSplitDirection};
    use std::collections::HashSet;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        connection
    }

    fn layout_with_slot(
        directory_id: i64,
        directory_path: &str,
        project_name: &str,
        session_id: Option<String>,
    ) -> WorkspaceLayoutDocument {
        let instance_id = Uuid::new_v4().to_string();
        WorkspaceLayoutDocument {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            tree: WorkspaceLayoutNode::Pane {
                id: "workspace-root".to_string(),
                pane_number: 1,
                contents: vec![WorkspacePaneContentRef::Pty {
                    slot_id: instance_id.clone(),
                }],
                active_content: Some(WorkspacePaneContentRef::Pty {
                    slot_id: instance_id.clone(),
                }),
            },
            focused_pane_id: "workspace-root".to_string(),
            slots: vec![WorkspaceLayoutSlot {
                instance_id,
                directory_id,
                directory_path: directory_path.to_string(),
                project_name: project_name.to_string(),
                tool_key: ToolKey::Claude,
                sequence: 1,
                session_id,
                resume_session_id: None,
                title: WorkspaceSlotTitle::Automatic,
            }],
            documents: Vec::new(),
            detached_slot_ids: Vec::new(),
        }
    }

    fn two_pane_layout(
        first_pane_id: &str,
        first_pane_number: u32,
        first_session_ids: Vec<String>,
        second_pane_id: &str,
        second_pane_number: u32,
        second_session_ids: Vec<String>,
        focused_pane_id: &str,
        slots: Vec<WorkspaceLayoutSlot>,
    ) -> WorkspaceLayoutDocument {
        WorkspaceLayoutDocument {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            tree: WorkspaceLayoutNode::Split {
                id: "split-root".to_string(),
                direction: WorkspaceSplitDirection::Horizontal,
                ratio: 0.5,
                first: Box::new(WorkspaceLayoutNode::Pane {
                    id: first_pane_id.to_string(),
                    pane_number: first_pane_number,
                    contents: first_session_ids
                        .iter()
                        .cloned()
                        .map(|slot_id| WorkspacePaneContentRef::Pty { slot_id })
                        .collect(),
                    active_content: first_session_ids
                        .first()
                        .cloned()
                        .map(|slot_id| WorkspacePaneContentRef::Pty { slot_id }),
                }),
                second: Box::new(WorkspaceLayoutNode::Pane {
                    id: second_pane_id.to_string(),
                    pane_number: second_pane_number,
                    contents: second_session_ids
                        .iter()
                        .cloned()
                        .map(|slot_id| WorkspacePaneContentRef::Pty { slot_id })
                        .collect(),
                    active_content: second_session_ids
                        .first()
                        .cloned()
                        .map(|slot_id| WorkspacePaneContentRef::Pty { slot_id }),
                }),
            },
            focused_pane_id: focused_pane_id.to_string(),
            slots,
            documents: Vec::new(),
            detached_slot_ids: Vec::new(),
        }
    }

    fn pane_session_ids(node: &WorkspaceLayoutNode, pane_id: &str) -> Option<Vec<String>> {
        match node {
            WorkspaceLayoutNode::Pane { id, contents, .. } => (id == pane_id).then(|| {
                contents
                    .iter()
                    .filter_map(|content| match content {
                        WorkspacePaneContentRef::Pty { slot_id } => Some(slot_id.clone()),
                        WorkspacePaneContentRef::File { .. } => None,
                    })
                    .collect()
            }),
            WorkspaceLayoutNode::Split { first, second, .. } => {
                pane_session_ids(first, pane_id).or_else(|| pane_session_ids(second, pane_id))
            }
        }
    }

    fn active_layout_with_running_session_in_second_pane(
        connection: &Connection,
        directory_id: i64,
        directory_path: &str,
        source_pane_id: &str,
        source_pane_number: u32,
    ) -> (WorkspaceLayoutDocument, String, String) {
        let session_id = Uuid::new_v4().to_string();
        pty_session_repo::insert_running(
            connection,
            &session_id,
            directory_id,
            ToolKey::Claude,
            directory_path,
            1,
        )
        .unwrap();
        let slot_layout = layout_with_slot(
            directory_id,
            directory_path,
            "work",
            Some(session_id.clone()),
        );
        let slot_id = slot_layout.slots[0].instance_id.clone();
        let active = two_pane_layout(
            "source-pane-1",
            1,
            Vec::new(),
            source_pane_id,
            source_pane_number,
            vec![slot_id.clone()],
            source_pane_id,
            slot_layout.slots,
        );
        (active, session_id, slot_id)
    }

    #[test]
    fn current_layout_preserves_invalid_or_future_payload_until_explicit_reset() {
        let mut connection = database();
        connection
            .execute(
                "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, 2, 8, '{\"future\":true}', 10)",
                [],
            )
            .unwrap();

        let read = read_current(&connection).unwrap();
        assert!(matches!(
            read.status,
            WorkspaceLayoutStateStatus::NeedsReset(_)
        ));
        assert!(read.layout.is_none());
        let error = save_current(&mut connection, 9, &empty_layout()).unwrap_err();
        assert!(error.to_string().contains("显式重置"));
        assert_eq!(reset_current(&mut connection).unwrap(), 9);
        assert!(matches!(
            read_current(&connection).unwrap().status,
            WorkspaceLayoutStateStatus::Ready
        ));
    }

    #[test]
    fn malformed_current_payload_is_not_overwritten_by_autosave() {
        let mut connection = database();
        connection
            .execute(
                "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, 1, 4, '{broken', 10)",
                [],
            )
            .unwrap();

        let read = read_current(&connection).unwrap();
        assert!(matches!(
            read.status,
            WorkspaceLayoutStateStatus::NeedsReset(_)
        ));
        assert!(save_current(&mut connection, 5, &empty_layout()).is_err());
        let stored = workspace_layout_repo::get_current(&connection)
            .unwrap()
            .unwrap();
        assert_eq!(stored.payload_json, "{broken");
        assert_eq!(stored.revision, 4);
    }

    #[test]
    fn recovery_reset_is_rejected_when_current_layout_is_valid() {
        let mut connection = database();
        save_current(&mut connection, 1, &empty_layout()).unwrap();

        assert!(reset_current(&mut connection)
            .unwrap_err()
            .to_string()
            .contains("无需执行"));
        assert_eq!(
            workspace_layout_repo::get_current(&connection)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
    }

    #[test]
    fn slot_resolution_checks_project_path_session_tool_and_running_state() {
        let connection = database();
        let directory =
            directory_repo::add(&connection, "新项目名", "C:\\Projects\\work", None).unwrap();
        pty_session_repo::insert_running(
            &connection,
            &Uuid::new_v4().to_string(),
            directory.id,
            ToolKey::Claude,
            &directory.path,
            1,
        )
        .unwrap();
        let running_id: String = connection
            .query_row("select session_id from pty_sessions", [], |row| row.get(0))
            .unwrap();
        let mut layout =
            layout_with_slot(directory.id, &directory.path, "旧项目名", Some(running_id));
        let states = resolve_layout_slots(&connection, &mut layout).unwrap();
        assert_eq!(states[0].state, WorkspaceSlotStateKind::Running);
        assert_eq!(states[0].current_project_name.as_deref(), Some("新项目名"));
        assert_eq!(layout.slots[0].project_name, "新项目名");

        layout.slots[0].directory_path = "C:\\Projects\\different".to_string();
        assert_eq!(
            resolve_slot(&connection, &mut layout.slots[0])
                .unwrap()
                .state,
            WorkspaceSlotStateKind::ProjectIdentityMismatch
        );
    }

    #[test]
    fn applying_preset_merges_workspace_sessions_and_preserves_detached_sessions() {
        let connection = database();
        let directory =
            directory_repo::add(&connection, "work", "C:\\Projects\\work", None).unwrap();
        let session_a = Uuid::new_v4().to_string();
        let session_b = Uuid::new_v4().to_string();
        pty_session_repo::insert_running(
            &connection,
            &session_a,
            directory.id,
            ToolKey::Claude,
            &directory.path,
            1,
        )
        .unwrap();
        pty_session_repo::insert_running(
            &connection,
            &session_b,
            directory.id,
            ToolKey::Codex,
            &directory.path,
            2,
        )
        .unwrap();

        let active_a = layout_with_slot(
            directory.id,
            &directory.path,
            "work",
            Some(session_a.clone()),
        );
        let active_b = layout_with_slot(
            directory.id,
            &directory.path,
            "work",
            Some(session_b.clone()),
        );
        let mut active = active_a.clone();
        let mut b_slot = active_b.slots[0].clone();
        b_slot.tool_key = ToolKey::Codex;
        active.slots.push(b_slot.clone());
        active.detached_slot_ids.push(b_slot.instance_id.clone());

        let preset_layout = layout_with_slot(
            directory.id,
            &directory.path,
            "work",
            Some(session_b.clone()),
        );
        let mut connection = connection;
        let preset = create_preset(&mut connection, "团队工作区", &preset_layout).unwrap();
        let plan = plan_apply_preset(&connection, &preset.id, &active).unwrap();

        assert_eq!(plan.layout.slots.len(), 2);
        let session_ids: HashSet<String> = plan
            .layout
            .slots
            .iter()
            .filter_map(|slot| slot.session_id.clone())
            .collect();
        assert_eq!(session_ids, HashSet::from([session_a, session_b.clone()]));
        assert_eq!(
            plan.layout
                .slots
                .iter()
                .find(|slot| slot.session_id.as_deref() == Some(session_b.as_str()))
                .unwrap()
                .tool_key,
            ToolKey::Codex
        );
        assert_eq!(plan.layout.detached_slot_ids, vec![b_slot.instance_id]);
        let WorkspaceLayoutNode::Pane { contents, .. } = &plan.layout.tree else {
            panic!("preset fixture keeps its root pane");
        };
        assert_eq!(
            contents,
            &vec![WorkspacePaneContentRef::Pty {
                slot_id: active_a.slots[0].instance_id.clone()
            }]
        );

        let repeated_plan = plan_apply_preset(&connection, &preset.id, &active).unwrap();
        assert_eq!(repeated_plan.layout.slots.len(), 2);
        let still_running: i64 = connection
            .query_row(
                "select count(*) from pty_sessions where state = 'running'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_running, 2);
        assert!(workspace_layout_repo::get_current(&connection)
            .unwrap()
            .is_none());
    }

    #[test]
    fn applying_empty_preset_keeps_detached_sessions_outside_the_pane_tree() {
        let mut connection = database();
        let directory =
            directory_repo::add(&connection, "work", "C:\\Projects\\work", None).unwrap();
        let session = Uuid::new_v4().to_string();
        pty_session_repo::insert_running(
            &connection,
            &session,
            directory.id,
            ToolKey::Claude,
            &directory.path,
            1,
        )
        .unwrap();
        let mut active = layout_with_slot(directory.id, &directory.path, "work", Some(session));
        let WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } = &mut active.tree
        else {
            panic!("one-slot fixture keeps its root pane");
        };
        contents.clear();
        *active_content = None;
        active
            .detached_slot_ids
            .push(active.slots[0].instance_id.clone());
        let preset = create_preset(&mut connection, "空布局", &empty_layout()).unwrap();

        let plan = plan_apply_preset(&connection, &preset.id, &active).unwrap();

        assert_eq!(plan.layout.detached_slot_ids, active.detached_slot_ids);
        assert_eq!(plan.layout.slots.len(), 1);
        let WorkspaceLayoutNode::Pane { contents, .. } = &plan.layout.tree else {
            panic!("empty preset keeps its focused root pane");
        };
        assert!(contents.is_empty());
    }

    #[test]
    fn applying_preset_keeps_unlisted_running_session_in_matching_pane_id() {
        let mut connection = database();
        let directory =
            directory_repo::add(&connection, "work", "C:\\Projects\\work", None).unwrap();
        let (active, session_id, slot_id) = active_layout_with_running_session_in_second_pane(
            &connection,
            directory.id,
            &directory.path,
            "pane-2",
            2,
        );
        let preset_layout = two_pane_layout(
            "pane-1",
            1,
            Vec::new(),
            "pane-2",
            2,
            Vec::new(),
            "pane-1",
            Vec::new(),
        );
        let preset = create_preset(&mut connection, "保持窗格", &preset_layout).unwrap();

        let plan = plan_apply_preset(&connection, &preset.id, &active).unwrap();

        assert!(pane_session_ids(&plan.layout.tree, "pane-1")
            .unwrap()
            .is_empty());
        assert_eq!(
            pane_session_ids(&plan.layout.tree, "pane-2").unwrap(),
            [slot_id]
        );
        assert_eq!(plan.slot_states[0].state, WorkspaceSlotStateKind::Running);
        assert_eq!(
            plan.layout.slots[0].session_id.as_deref(),
            Some(session_id.as_str())
        );
        let still_running: i64 = connection
            .query_row(
                "select count(*) from pty_sessions where state = 'running'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_running, 1);
    }

    #[test]
    fn applying_preset_uses_pane_number_when_stable_id_changed() {
        let mut connection = database();
        let directory =
            directory_repo::add(&connection, "work", "C:\\Projects\\work", None).unwrap();
        let (active, _, slot_id) = active_layout_with_running_session_in_second_pane(
            &connection,
            directory.id,
            &directory.path,
            "active-pane-2",
            2,
        );
        let preset_layout = two_pane_layout(
            "saved-pane-1",
            1,
            Vec::new(),
            "saved-pane-2",
            2,
            Vec::new(),
            "saved-pane-1",
            Vec::new(),
        );
        let preset = create_preset(&mut connection, "按编号归位", &preset_layout).unwrap();

        let plan = plan_apply_preset(&connection, &preset.id, &active).unwrap();

        assert!(pane_session_ids(&plan.layout.tree, "saved-pane-1")
            .unwrap()
            .is_empty());
        assert_eq!(
            pane_session_ids(&plan.layout.tree, "saved-pane-2").unwrap(),
            [slot_id]
        );
    }

    #[test]
    fn applying_preset_falls_back_to_its_focused_pane_when_source_is_missing() {
        let mut connection = database();
        let directory =
            directory_repo::add(&connection, "work", "C:\\Projects\\work", None).unwrap();
        let (active, _, slot_id) = active_layout_with_running_session_in_second_pane(
            &connection,
            directory.id,
            &directory.path,
            "active-pane-3",
            3,
        );
        let preset_layout = two_pane_layout(
            "saved-pane-1",
            1,
            Vec::new(),
            "saved-pane-4",
            4,
            Vec::new(),
            "saved-pane-4",
            Vec::new(),
        );
        let preset = create_preset(&mut connection, "焦点窗格兜底", &preset_layout).unwrap();

        let plan = plan_apply_preset(&connection, &preset.id, &active).unwrap();

        assert!(pane_session_ids(&plan.layout.tree, "saved-pane-1")
            .unwrap()
            .is_empty());
        assert_eq!(
            pane_session_ids(&plan.layout.tree, "saved-pane-4").unwrap(),
            [slot_id]
        );
    }

    #[test]
    fn applying_preset_omits_ended_slots_and_preserves_empty_panes() {
        let mut connection = database();
        let directory =
            directory_repo::add(&connection, "work", "C:\\Projects\\work", None).unwrap();
        let session_id = Uuid::new_v4().to_string();
        pty_session_repo::insert_running(
            &connection,
            &session_id,
            directory.id,
            ToolKey::Claude,
            &directory.path,
            1,
        )
        .unwrap();
        pty_session_repo::finish(&connection, &session_id, "exited", 2, Some(0)).unwrap();

        let mut preset_layout =
            layout_with_slot(directory.id, &directory.path, "work", Some(session_id));
        let ended_slot_id = preset_layout.slots[0].instance_id.clone();
        preset_layout.tree = WorkspaceLayoutNode::Split {
            id: "split-root".to_string(),
            direction: WorkspaceSplitDirection::Horizontal,
            ratio: 0.62,
            first: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-1".to_string(),
                pane_number: 1,
                contents: vec![WorkspacePaneContentRef::Pty {
                    slot_id: ended_slot_id.clone(),
                }],
                active_content: Some(WorkspacePaneContentRef::Pty {
                    slot_id: ended_slot_id,
                }),
            }),
            second: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-2".to_string(),
                pane_number: 2,
                contents: Vec::new(),
                active_content: None,
            }),
        };
        preset_layout.focused_pane_id = "pane-2".to_string();
        let preset = create_preset(&mut connection, "结束会话布局", &preset_layout).unwrap();

        let plan = plan_apply_preset(&connection, &preset.id, &empty_layout()).unwrap();

        assert!(plan.layout.slots.is_empty());
        assert!(plan.slot_states.is_empty());
        assert_eq!(plan.layout.focused_pane_id, "pane-2");
        let WorkspaceLayoutNode::Split {
            ratio,
            first,
            second,
            ..
        } = &plan.layout.tree
        else {
            panic!("expected the saved split layout to remain intact");
        };
        assert_eq!(*ratio, 0.62);
        assert!(matches!(
            &**first,
            WorkspaceLayoutNode::Pane {
                id,
                pane_number: 1,
                contents,
                active_content: None,
                ..
            } if id == "pane-1" && contents.is_empty()
        ));
        assert!(matches!(
            &**second,
            WorkspaceLayoutNode::Pane {
                id,
                pane_number: 2,
                contents,
                active_content: None,
                ..
            } if id == "pane-2" && contents.is_empty()
        ));
    }

    #[test]
    fn duplicate_preset_names_are_rejected_and_bad_preset_remains_deletable() {
        let mut connection = database();
        let layout = empty_layout();
        let preset = create_preset(&mut connection, "布局", &layout).unwrap();
        let error = create_preset(&mut connection, " 布局 ", &layout).unwrap_err();
        assert!(error.to_string().contains("已存在"));
        connection
            .execute(
                "update workspace_layout_presets set payload_json = '{bad json' where id = ?1",
                [&preset.id],
            )
            .unwrap();
        assert!(get_preset(&connection, &preset.id).is_err());
        assert!(delete_preset(&connection, &preset.id).unwrap());
    }
}
