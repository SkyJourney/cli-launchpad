use crate::error_codes::ErrorCode;
use crate::models::workspace_layout::{LayoutResetCode, LayoutResetReason};
use std::{
    collections::{HashMap, HashSet},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::workspace_layout_repo::SaveCurrentOutcome;
use crate::db::{directory_repo, pty_session_repo, workspace_layout_repo};
use crate::models::directory::Directory;
use crate::models::pty_session::PtySession;
use crate::models::workspace_layout::{
    validate_preset_name, WorkspaceLayoutApplyPlan, WorkspaceLayoutDocument, WorkspaceLayoutNode,
    WorkspaceLayoutPresetSummary, WorkspaceLayoutSaveRejection, WorkspaceLayoutSaveResult,
    WorkspaceLayoutSlot, WorkspaceLayoutStateRead, WorkspaceLayoutStateStatus,
    WorkspacePaneContentRef, WorkspaceSlotState, WorkspaceSlotStateKind,
    MAX_WORKSPACE_LAYOUT_PRESETS, WORKSPACE_LAYOUT_SCHEMA_VERSION,
};
use crate::platform::case_sensitivity::{CaseSensitivity, PathSemantics};
use crate::platform::path_identity::ProjectPathKey;
use crate::platform::path_key::PathKey;
use crate::{models::workspace_layout::WorkspaceLayoutError, AppError};

pub enum LayoutReadStage {
    /// No slot resolution needed (missing row or needs-reset states).
    Done(WorkspaceLayoutStateRead),
    Resolve(PendingLayoutRead),
}

pub struct PendingLayoutRead {
    revision: i64,
    updated_at_ms: i64,
    layout: WorkspaceLayoutDocument,
    facts: SlotFacts,
}

impl PendingLayoutRead {
    /// No database access: compares project paths (canonicalize) in memory.
    pub fn finish(mut self, running: &HashSet<String>) -> WorkspaceLayoutStateRead {
        let slot_states = resolve_layout_slots_with(&self.facts, &mut self.layout, running);
        WorkspaceLayoutStateRead {
            status: WorkspaceLayoutStateStatus::Ready,
            revision: Some(self.revision),
            schema_version: Some(i64::from(self.layout.schema_version)),
            updated_at_ms: Some(self.updated_at_ms),
            layout: Some(self.layout),
            slot_states,
        }
    }
}

pub fn read_current_stage(connection: &Connection) -> Result<LayoutReadStage, AppError> {
    let Some(row) = workspace_layout_repo::get_current(connection)? else {
        return Ok(LayoutReadStage::Done(WorkspaceLayoutStateRead {
            status: WorkspaceLayoutStateStatus::Missing,
            revision: None,
            schema_version: None,
            updated_at_ms: None,
            layout: None,
            slot_states: Vec::new(),
        }));
    };

    if !is_supported_layout_version(row.schema_version) {
        return Ok(LayoutReadStage::Done(needs_reset(
            row.revision,
            row.schema_version,
            row.updated_at_ms,
            LayoutResetReason {
                code: LayoutResetCode::UnsupportedVersion,
                detail: format!("不支持工作区布局版本 {}", row.schema_version),
            },
        )));
    }
    if source_layout_version(&row.payload_json) != Some(row.schema_version) {
        return Ok(LayoutReadStage::Done(needs_reset(
            row.revision,
            row.schema_version,
            row.updated_at_ms,
            LayoutResetReason {
                code: LayoutResetCode::VersionMismatch,
                detail: "布局 JSON 版本与数据库版本不一致".to_string(),
            },
        )));
    }
    let layout = match WorkspaceLayoutDocument::from_json_degrading_invalid_files(&row.payload_json)
    {
        Ok((layout, degraded)) => {
            for item in &degraded {
                log::warn!(
                    "当前布局的文件引用在本平台无效，已降级为占位 document_id={} path={}",
                    item.document_id,
                    item.relative_path
                );
            }
            layout
        }
        Err(error) => {
            return Ok(LayoutReadStage::Done(needs_reset(
                row.revision,
                row.schema_version,
                row.updated_at_ms,
                LayoutResetReason {
                    code: LayoutResetCode::InvalidPayload,
                    detail: error.to_string(),
                },
            )));
        }
    };
    let facts = SlotFacts::load(connection, layout.slots.iter())?;
    Ok(LayoutReadStage::Resolve(PendingLayoutRead {
        revision: row.revision,
        updated_at_ms: row.updated_at_ms,
        layout,
        facts,
    }))
}

#[cfg(test)]
pub fn read_current(
    connection: &Connection,
    running: &HashSet<String>,
) -> Result<WorkspaceLayoutStateRead, AppError> {
    Ok(match read_current_stage(connection)? {
        LayoutReadStage::Done(state) => state,
        LayoutReadStage::Resolve(pending) => pending.finish(running),
    })
}

/// What `save_current` needs from outside the database (PD-10). Neither member touches the
/// filesystem: `semantics_of` reads the cache, `backup_before_case_merge` copies the database.
pub struct SaveContext<'a> {
    /// The cached semantics of a project root; `None` is read as `Unknown`.
    pub semantics_of: &'a dyn Fn(i64, &str) -> Option<PathSemantics>,
    /// Runs once, before the first write of a layout whose case duplicates were merged.
    pub backup_before_case_merge: &'a dyn Fn(&Connection) -> Result<(), AppError>,
}

#[cfg(test)]
impl SaveContext<'static> {
    /// No cached semantics and no backup: the behaviour before PD-10.
    pub const INERT: SaveContext<'static> = SaveContext {
        semantics_of: &|_, _| None,
        backup_before_case_merge: &|_| Ok(()),
    };
}

/// Groups of file documents of one project whose paths differ only by case, judged by the
/// cached semantics. Only an `Insensitive` project has groups: `Sensitive` and `Unknown`
/// never fold. Ids inside a group and the groups themselves are sorted.
fn case_duplicate_groups(
    layout: &WorkspaceLayoutDocument,
    context: &SaveContext,
) -> Vec<Vec<String>> {
    let mut groups: HashMap<(i64, PathKey), Vec<String>> = HashMap::new();
    for document in &layout.documents {
        let semantics = (context.semantics_of)(document.directory_id, &document.directory_path)
            .unwrap_or(PathSemantics::UNKNOWN);
        if semantics.case != CaseSensitivity::Insensitive {
            continue;
        }
        groups
            .entry((
                document.directory_id,
                PathKey::of(&document.relative_path, &semantics),
            ))
            .or_default()
            .push(document.id.clone());
    }
    let mut groups: Vec<Vec<String>> = groups
        .into_values()
        .filter(|ids| ids.len() > 1)
        .map(|mut ids| {
            ids.sort();
            ids
        })
        .collect();
    groups.sort();
    groups
}

pub fn save_current(
    connection: &mut Connection,
    revision: i64,
    layout: &WorkspaceLayoutDocument,
    context: &SaveContext,
) -> Result<WorkspaceLayoutSaveResult, AppError> {
    if revision <= 0 {
        return Err(AppError::internal("工作区 revision 必须大于 0"));
    }
    let payload_json = serialize_layout(layout, false)?;

    // A save that is already stale is answered as stale: repairing a layout the repository would
    // refuse anyway only costs the front end a pointless retry.
    let stored = workspace_layout_repo::get_current(connection)?;
    let is_stale = stored.as_ref().is_some_and(|row| revision <= row.revision);

    // Folding is decided by the cached semantics only. The front end merges case variants after
    // hydrate; a layout that still holds them is refused so it can repair and retry once.
    let duplicates = if is_stale {
        Vec::new()
    } else {
        case_duplicate_groups(layout, context)
    };
    if !duplicates.is_empty() {
        let mut document_ids = duplicates.concat();
        document_ids.sort();
        return Err(AppError::coded_with_params(
            ErrorCode::LayoutCaseDuplicate,
            "布局中存在仅大小写不同的重复文件",
            serde_json::json!({ "documentIds": document_ids }),
        ));
    }

    // Do not let routine autosaves replace data that needs explicit recovery.
    let mut observed_revision = 0;
    if let Some(current) = stored {
        observed_revision = current.revision;
        if !is_supported_layout_version(current.schema_version) {
            return Err(AppError::internal(
                "当前布局版本不受支持；请先显式重置工作区后再保存",
            ));
        }
        let stored =
            WorkspaceLayoutDocument::from_json_degrading_invalid_files(&current.payload_json)
                .map(|(layout, _)| layout)
                .map_err(|error| AppError::internal(format!("当前布局需要显式重置：{error}")))?;
        if source_layout_version(&current.payload_json) != Some(current.schema_version) {
            return Err(AppError::internal(
                "当前布局版本信息不一致；请先显式重置工作区",
            ));
        }
        // The stored layout still holds case duplicates that this one has merged: keep a copy
        // of the database before the first merged layout is written. A stale save is refused
        // by the repository and must not leave a backup behind (automatic backups share one
        // retention pool with the protective ones).
        if revision > current.revision && !case_duplicate_groups(&stored, context).is_empty() {
            (context.backup_before_case_merge)(connection)?;
        }
    }

    let outcome = workspace_layout_repo::save_current(
        connection,
        i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
        revision,
        &payload_json,
        now_ms(),
    )?;
    Ok(save_result_from_outcome(outcome, observed_revision))
}

fn save_result_from_outcome(
    outcome: SaveCurrentOutcome,
    observed_revision: i64,
) -> WorkspaceLayoutSaveResult {
    match outcome {
        SaveCurrentOutcome::Saved { revision } => WorkspaceLayoutSaveResult {
            saved: true,
            revision,
            reason: None,
        },
        SaveCurrentOutcome::Stale { current_revision } => WorkspaceLayoutSaveResult {
            saved: false,
            revision: current_revision,
            reason: Some(WorkspaceLayoutSaveRejection::Stale),
        },
        SaveCurrentOutcome::Incompatible { .. } => WorkspaceLayoutSaveResult {
            saved: false,
            revision: observed_revision,
            reason: Some(WorkspaceLayoutSaveRejection::Incompatible),
        },
    }
}

pub fn reset_current(connection: &mut Connection) -> Result<i64, AppError> {
    if let Some(current) = workspace_layout_repo::get_current(connection)? {
        if is_supported_layout_version(current.schema_version)
            && WorkspaceLayoutDocument::from_json_degrading_invalid_files(&current.payload_json)
                .is_ok()
        {
            return Err(AppError::internal(
                "当前布局可以正常读取，无需执行恢复性重置",
            ));
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
        .ok_or_else(|| AppError::internal("布局保存后无法读取"))
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

pub struct PendingApplyPlan {
    preset_layout: WorkspaceLayoutDocument,
    active_layout: WorkspaceLayoutDocument,
    facts: SlotFacts,
}

/// Database stage: validates the active layout, loads and parses the preset,
/// and loads the rows every involved slot refers to.
pub fn plan_apply_preset_stage(
    connection: &Connection,
    id: &str,
    active_layout: &WorkspaceLayoutDocument,
) -> Result<PendingApplyPlan, AppError> {
    active_layout.validate().map_err(layout_error)?;
    let row = workspace_layout_repo::get_preset(connection, id)?
        .ok_or_else(|| AppError::internal("命名布局不存在"))?;
    let preset_layout = parse_preset_layout(row.summary.schema_version, &row.payload_json)?;
    let facts = SlotFacts::load(
        connection,
        active_layout.slots.iter().chain(preset_layout.slots.iter()),
    )?;
    Ok(PendingApplyPlan {
        preset_layout,
        active_layout: active_layout.clone(),
        facts,
    })
}

impl PendingApplyPlan {
    /// No database access: the original plan algorithm, resolving slots from `facts`.
    /// Build a pure presentation plan. This deliberately writes no workspace state
    /// and never calls PTY lifecycle or handoff operations.
    pub fn finish(self, running: &HashSet<String>) -> Result<WorkspaceLayoutApplyPlan, AppError> {
        let PendingApplyPlan {
            preset_layout,
            active_layout,
            facts,
        } = self;
        let active_layout = &active_layout;
        let mut layout = preset_layout;
        let mut additions = Vec::new();
        let mut detached_contents = Vec::new();
        let active_detached_slot_ids: HashSet<&str> = active_layout
            .detached_contents
            .iter()
            .filter_map(|content| match content {
                WorkspacePaneContentRef::Pty { slot_id } => Some(slot_id.as_str()),
                WorkspacePaneContentRef::File { .. } | WorkspacePaneContentRef::Unknown { .. } => {
                    None
                }
            })
            .collect();
        let mut detached_tree_slot_ids = Vec::new();
        for active_slot in &active_layout.slots {
            let mut slot = active_slot.clone();
            let state = resolve_slot_with(&facts, &mut slot, running);

            if active_detached_slot_ids.contains(slot.instance_id.as_str()) {
                if matches!(
                    state.state,
                    WorkspaceSlotStateKind::Ended | WorkspaceSlotStateKind::MissingSession
                ) {
                    continue;
                }

                if let Some(target_index) = layout.slots.iter().position(|target| {
                    target.instance_id == slot.instance_id
                        || slot.session_id.as_ref().is_some_and(|session_id| {
                            target.session_id.as_ref() == Some(session_id)
                        })
                }) {
                    let saved_slot = layout.slots.remove(target_index);
                    detached_tree_slot_ids.push(saved_slot.instance_id);
                }

                detached_tree_slot_ids.push(slot.instance_id.clone());
                detached_contents.push(WorkspacePaneContentRef::Pty {
                    slot_id: slot.instance_id.clone(),
                });
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
                return Err(AppError::internal("命名布局的目标窗格不存在"));
            }
            additions.push(slot);
        }

        if !additions.is_empty() {
            layout.slots.extend(additions);
        }

        remove_slot_references(&mut layout.tree, &detached_tree_slot_ids);
        layout.detached_contents = detached_contents;
        preserve_detached_unknown_contents(&mut layout, active_layout);
        preserve_detached_file_contents(&mut layout, active_layout);

        let mut slot_states = resolve_layout_slots_with(&facts, &mut layout, running);
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
            layout.detached_contents.retain(|content| {
                !matches!(
                    content,
                    WorkspacePaneContentRef::Pty { slot_id } if ended_slot_ids.contains(slot_id)
                )
            });
            slot_states.retain(|slot| !ended_slot_ids.contains(&slot.instance_id));
        }
        layout.validate().map_err(layout_error)?;
        Ok(WorkspaceLayoutApplyPlan {
            layout,
            slot_states,
        })
    }
}

#[cfg(test)]
pub fn plan_apply_preset(
    connection: &Connection,
    id: &str,
    active_layout: &WorkspaceLayoutDocument,
    running: &HashSet<String>,
) -> Result<WorkspaceLayoutApplyPlan, AppError> {
    plan_apply_preset_stage(connection, id, active_layout)?.finish(running)
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
        detached_contents: Vec::new(),
    }
}

fn needs_reset(
    revision: i64,
    schema_version: i64,
    updated_at_ms: i64,
    reason: LayoutResetReason,
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
        return Err(AppError::internal(format!(
            "该命名布局使用不支持的版本 {stored_schema_version}"
        )));
    }
    let layout = WorkspaceLayoutDocument::from_json(payload_json).map_err(layout_error)?;
    if source_layout_version(payload_json) != Some(stored_schema_version) {
        return Err(AppError::internal("命名布局 JSON 版本与数据库版本不一致"));
    }
    if i64::from(layout.schema_version) != i64::from(WORKSPACE_LAYOUT_SCHEMA_VERSION) {
        return Err(AppError::internal("命名布局未能迁移到当前版本"));
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

/// Directory and session rows a set of slots refers to, loaded in one
/// database stage so slot states can be resolved afterwards without the
/// connection (the path identity comparison is lexical and needs no filesystem).
#[derive(Debug, Default)]
pub struct SlotFacts {
    directories: HashMap<i64, Option<Directory>>,
    sessions: HashMap<String, Option<PtySession>>,
}

impl SlotFacts {
    pub fn load<'a>(
        connection: &Connection,
        slots: impl IntoIterator<Item = &'a WorkspaceLayoutSlot>,
    ) -> Result<Self, AppError> {
        let mut facts = Self::default();
        for slot in slots {
            if !facts.directories.contains_key(&slot.directory_id) {
                let directory = directory_repo::get(connection, slot.directory_id)?;
                facts.directories.insert(slot.directory_id, directory);
            }
            if let Some(session_id) = slot.session_id.as_deref() {
                if !facts.sessions.contains_key(session_id) {
                    let session = pty_session_repo::get_by_id(connection, session_id)?;
                    facts.sessions.insert(session_id.to_string(), session);
                }
            }
        }
        Ok(facts)
    }
}

fn resolve_layout_slots_with(
    facts: &SlotFacts,
    layout: &mut WorkspaceLayoutDocument,
    running: &HashSet<String>,
) -> Vec<WorkspaceSlotState> {
    layout
        .slots
        .iter_mut()
        .map(|slot| resolve_slot_with(facts, slot, running))
        .collect()
}

fn resolve_slot_with(
    facts: &SlotFacts,
    slot: &mut WorkspaceLayoutSlot,
    running: &HashSet<String>,
) -> WorkspaceSlotState {
    let Some(directory) = facts
        .directories
        .get(&slot.directory_id)
        .and_then(Option::as_ref)
    else {
        return slot_state(slot, WorkspaceSlotStateKind::MissingProject, None);
    };
    if ProjectPathKey::of(&directory.path) != ProjectPathKey::of(&slot.directory_path) {
        return slot_state(slot, WorkspaceSlotStateKind::ProjectIdentityMismatch, None);
    }
    slot.project_name.clone_from(&directory.name);
    let Some(session_id) = slot.session_id.as_deref() else {
        return slot_state(
            slot,
            WorkspaceSlotStateKind::Pending,
            Some(directory.name.clone()),
        );
    };
    let Some(session) = facts.sessions.get(session_id).and_then(Option::as_ref) else {
        return slot_state(
            slot,
            WorkspaceSlotStateKind::MissingSession,
            Some(directory.name.clone()),
        );
    };
    if session.directory_id != slot.directory_id
        || session.tool_key != slot.tool_key
        || ProjectPathKey::of(&session.working_directory)
            != ProjectPathKey::of(&slot.directory_path)
    {
        return slot_state(
            slot,
            WorkspaceSlotStateKind::SessionIdentityMismatch,
            Some(directory.name.clone()),
        );
    }
    // Liveness comes from the in-memory session table, never from the row's state column.
    let state = if running.contains(&session.session_id) {
        WorkspaceSlotStateKind::Running
    } else {
        WorkspaceSlotStateKind::Ended
    };
    slot_state(slot, state, Some(directory.name.clone()))
}

#[cfg(test)]
fn resolve_layout_slots(
    connection: &Connection,
    layout: &mut WorkspaceLayoutDocument,
    running: &HashSet<String>,
) -> Result<Vec<WorkspaceSlotState>, AppError> {
    let facts = SlotFacts::load(connection, layout.slots.iter())?;
    Ok(resolve_layout_slots_with(&facts, layout, running))
}

#[cfg(test)]
fn resolve_slot(
    connection: &Connection,
    slot: &mut WorkspaceLayoutSlot,
    running: &HashSet<String>,
) -> Result<WorkspaceSlotState, AppError> {
    let facts = SlotFacts::load(connection, std::iter::once(&*slot))?;
    Ok(resolve_slot_with(&facts, slot, running))
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

fn remove_file_references(node: &mut WorkspaceLayoutNode, removed_document_ids: &[String]) {
    match node {
        WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } => {
            let active_index = active_content
                .as_ref()
                .and_then(|active| contents.iter().position(|content| content == active));
            let active_was_removed = active_content.as_ref().is_some_and(|active| {
                matches!(active, WorkspacePaneContentRef::File { document_id } if removed_document_ids.contains(document_id))
            });
            let replacement_index = active_index
                .map(|index| {
                    contents[..index]
                        .iter()
                        .filter(|content| {
                            !matches!(content, WorkspacePaneContentRef::File { document_id } if removed_document_ids.contains(document_id))
                        })
                        .count()
                })
                .unwrap_or(0);
            contents.retain(|content| {
                !matches!(content, WorkspacePaneContentRef::File { document_id } if removed_document_ids.contains(document_id))
            });
            if active_was_removed {
                *active_content = contents
                    .get(replacement_index)
                    .or_else(|| {
                        replacement_index
                            .checked_sub(1)
                            .and_then(|index| contents.get(index))
                    })
                    .cloned();
            }
        }
        WorkspaceLayoutNode::Split { first, second, .. } => {
            remove_file_references(first, removed_document_ids);
            remove_file_references(second, removed_document_ids);
        }
    }
}

/// `Unknown` 内容来自更新版本写入的布局：应用命名布局时必须原样保留，
/// 不能因为当前版本不认识就丢弃（它们不属于任何 slot 或文档，保留不影响其他校验）。
fn preserve_detached_unknown_contents(
    layout: &mut WorkspaceLayoutDocument,
    active_layout: &WorkspaceLayoutDocument,
) {
    for detached in &active_layout.detached_contents {
        if matches!(detached, WorkspacePaneContentRef::Unknown { .. })
            && !layout.detached_contents.contains(detached)
        {
            layout.detached_contents.push(detached.clone());
        }
    }
}

fn preserve_detached_file_contents(
    layout: &mut WorkspaceLayoutDocument,
    active_layout: &WorkspaceLayoutDocument,
) {
    for detached in &active_layout.detached_contents {
        let WorkspacePaneContentRef::File { document_id } = detached else {
            continue;
        };
        let Some(document) = active_layout
            .documents
            .iter()
            .find(|document| document.id == *document_id)
            .cloned()
        else {
            continue;
        };
        let replaced_ids: Vec<String> = layout
            .documents
            .iter()
            .filter(|candidate| {
                candidate.id == document.id
                    || (candidate.directory_id == document.directory_id
                        && candidate.relative_path == document.relative_path)
            })
            .map(|candidate| candidate.id.clone())
            .collect();
        if !replaced_ids.is_empty() {
            remove_file_references(&mut layout.tree, &replaced_ids);
            layout
                .documents
                .retain(|candidate| !replaced_ids.contains(&candidate.id));
        }
        layout.documents.push(document);
        layout.detached_contents.push(detached.clone());
    }
}

fn layout_error(error: WorkspaceLayoutError) -> AppError {
    AppError::internal(error.to_string())
}

fn map_preset_write_error(error: rusqlite::Error) -> AppError {
    match &error {
        rusqlite::Error::InvalidParameterName(message)
            if message == "workspace layout preset limit reached" =>
        {
            AppError::coded_with_params(
                ErrorCode::LayoutPresetLimit,
                format!("命名布局最多支持 {MAX_WORKSPACE_LAYOUT_PRESETS} 个"),
                serde_json::json!({ "max": MAX_WORKSPACE_LAYOUT_PRESETS }),
            )
        }
        _ if error.to_string().contains("UNIQUE constraint failed") => AppError::coded(
            ErrorCode::LayoutNameExists,
            "布局名称已存在，请使用其他名称",
        ),
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
    use crate::models::workspace_layout::{
        legacy_payload_json, WorkspaceLayoutSaveRejection, WorkspaceSlotTitle,
        WorkspaceSplitDirection,
    };
    use std::collections::HashSet;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        connection
    }

    /// The fixtures write `running` rows for the sessions they want open; treat those
    /// sessions as open in memory (production passes the manager's open-session set).
    fn running_ids(connection: &Connection) -> HashSet<String> {
        let mut statement = connection
            .prepare("select session_id from pty_sessions where state = 'running'")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap()
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
            detached_contents: Vec::new(),
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
            detached_contents: Vec::new(),
        }
    }

    fn pane_session_ids(node: &WorkspaceLayoutNode, pane_id: &str) -> Option<Vec<String>> {
        match node {
            WorkspaceLayoutNode::Pane { id, contents, .. } => (id == pane_id).then(|| {
                contents
                    .iter()
                    .filter_map(|content| match content {
                        WorkspacePaneContentRef::Pty { slot_id } => Some(slot_id.clone()),
                        WorkspacePaneContentRef::File { .. }
                        | WorkspacePaneContentRef::Unknown { .. } => None,
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

        let read = read_current(&connection, &HashSet::new()).unwrap();
        assert!(matches!(
            read.status,
            WorkspaceLayoutStateStatus::NeedsReset(_)
        ));
        assert!(read.layout.is_none());
        let error =
            save_current(&mut connection, 9, &empty_layout(), &SaveContext::INERT).unwrap_err();
        assert!(error.to_string().contains("显式重置"));
        assert_eq!(reset_current(&mut connection).unwrap(), 9);
        assert!(matches!(
            read_current(&connection, &HashSet::new()).unwrap().status,
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

        let read = read_current(&connection, &HashSet::new()).unwrap();
        assert!(matches!(
            read.status,
            WorkspaceLayoutStateStatus::NeedsReset(_)
        ));
        assert!(save_current(&mut connection, 5, &empty_layout(), &SaveContext::INERT).is_err());
        let stored = workspace_layout_repo::get_current(&connection)
            .unwrap()
            .unwrap();
        assert_eq!(stored.payload_json, "{broken");
        assert_eq!(stored.revision, 4);
    }

    #[test]
    fn recovery_reset_is_rejected_when_current_layout_is_valid() {
        let mut connection = database();
        save_current(&mut connection, 1, &empty_layout(), &SaveContext::INERT).unwrap();

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
        let states =
            resolve_layout_slots(&connection, &mut layout, &running_ids(&connection)).unwrap();
        assert_eq!(states[0].state, WorkspaceSlotStateKind::Running);
        assert_eq!(states[0].current_project_name.as_deref(), Some("新项目名"));
        assert_eq!(layout.slots[0].project_name, "新项目名");

        layout.slots[0].directory_path = "C:\\Projects\\different".to_string();
        assert_eq!(
            resolve_slot(&connection, &mut layout.slots[0], &running_ids(&connection))
                .unwrap()
                .state,
            WorkspaceSlotStateKind::ProjectIdentityMismatch
        );
    }

    #[test]
    fn slot_identity_compares_stored_paths_lexically() {
        let connection = database();
        // Nothing here exists on disk: the comparison must not touch the filesystem.
        #[cfg(windows)]
        let stored = "C:\\Projects\\l2-demo";
        #[cfg(not(windows))]
        let stored = "/projects/l2-demo";
        let directory = directory_repo::add(&connection, "项目", stored, None).unwrap();

        #[cfg(windows)]
        let same_identity = vec![
            stored.to_string(),
            format!("{stored}{}", std::path::MAIN_SEPARATOR),
            stored.to_uppercase(),
            format!(r"\\?\{stored}"),
        ];
        #[cfg(not(windows))]
        let same_identity = vec![
            stored.to_string(),
            format!("{stored}{}", std::path::MAIN_SEPARATOR),
        ];
        for path in same_identity {
            let mut slot = layout_with_slot(directory.id, &path, "项目", None)
                .slots
                .remove(0);
            let state = resolve_slot(&connection, &mut slot, &HashSet::new()).unwrap();
            assert_eq!(
                state.state,
                WorkspaceSlotStateKind::Pending,
                "{path} must match the stored path"
            );
        }

        let mut other = layout_with_slot(directory.id, "/another/place", "项目", None)
            .slots
            .remove(0);
        let state = resolve_slot(&connection, &mut other, &HashSet::new()).unwrap();
        assert_eq!(state.state, WorkspaceSlotStateKind::ProjectIdentityMismatch);
    }

    #[test]
    fn slot_is_running_only_when_the_session_is_open_in_memory() {
        let connection = database();
        let directory =
            directory_repo::add(&connection, "项目", "C:\\Projects\\work", None).unwrap();
        pty_session_repo::insert_running(
            &connection,
            "s1",
            directory.id,
            ToolKey::Claude,
            &directory.path,
            1,
        )
        .unwrap();
        let mut slot = layout_with_slot(
            directory.id,
            &directory.path,
            "项目",
            Some("s1".to_string()),
        )
        .slots
        .remove(0);

        // The database row still says running, but memory does not know the session.
        assert_eq!(
            resolve_slot(&connection, &mut slot, &HashSet::new())
                .unwrap()
                .state,
            WorkspaceSlotStateKind::Ended
        );
        let open = HashSet::from(["s1".to_string()]);
        assert_eq!(
            resolve_slot(&connection, &mut slot, &open).unwrap().state,
            WorkspaceSlotStateKind::Running
        );

        // Identity is checked before liveness: a session without a row stays missing.
        let mut missing = layout_with_slot(
            directory.id,
            &directory.path,
            "项目",
            Some("ghost".to_string()),
        )
        .slots
        .remove(0);
        let open_ghost = HashSet::from(["ghost".to_string()]);
        assert_eq!(
            resolve_slot(&connection, &mut missing, &open_ghost)
                .unwrap()
                .state,
            WorkspaceSlotStateKind::MissingSession
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
        active.detached_contents.push(WorkspacePaneContentRef::Pty {
            slot_id: b_slot.instance_id.clone(),
        });

        let preset_layout = layout_with_slot(
            directory.id,
            &directory.path,
            "work",
            Some(session_b.clone()),
        );
        let mut connection = connection;
        let preset = create_preset(&mut connection, "团队工作区", &preset_layout).unwrap();
        let plan =
            plan_apply_preset(&connection, &preset.id, &active, &running_ids(&connection)).unwrap();

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
        assert_eq!(
            plan.layout.detached_contents,
            vec![WorkspacePaneContentRef::Pty {
                slot_id: b_slot.instance_id
            }]
        );
        let WorkspaceLayoutNode::Pane { contents, .. } = &plan.layout.tree else {
            panic!("preset fixture keeps its root pane");
        };
        assert_eq!(
            contents,
            &vec![WorkspacePaneContentRef::Pty {
                slot_id: active_a.slots[0].instance_id.clone()
            }]
        );

        let repeated_plan =
            plan_apply_preset(&connection, &preset.id, &active, &running_ids(&connection)).unwrap();
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
        active.detached_contents.push(WorkspacePaneContentRef::Pty {
            slot_id: active.slots[0].instance_id.clone(),
        });
        let preset = create_preset(&mut connection, "空布局", &empty_layout()).unwrap();

        let plan =
            plan_apply_preset(&connection, &preset.id, &active, &running_ids(&connection)).unwrap();

        assert_eq!(plan.layout.detached_contents, active.detached_contents);
        assert_eq!(plan.layout.slots.len(), 1);
        let WorkspaceLayoutNode::Pane { contents, .. } = &plan.layout.tree else {
            panic!("empty preset keeps its focused root pane");
        };
        assert!(contents.is_empty());
    }

    #[test]
    fn removing_replaced_files_keeps_the_next_active_content() {
        let mut tree = WorkspaceLayoutNode::Pane {
            id: "workspace-root".to_string(),
            pane_number: 1,
            contents: vec![
                WorkspacePaneContentRef::File {
                    document_id: "removed-before".to_string(),
                },
                WorkspacePaneContentRef::Pty {
                    slot_id: "slot-before-active".to_string(),
                },
                WorkspacePaneContentRef::File {
                    document_id: "removed-active".to_string(),
                },
                WorkspacePaneContentRef::Pty {
                    slot_id: "slot-after-active".to_string(),
                },
            ],
            active_content: Some(WorkspacePaneContentRef::File {
                document_id: "removed-active".to_string(),
            }),
        };

        remove_file_references(
            &mut tree,
            &["removed-before".to_string(), "removed-active".to_string()],
        );

        let WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } = tree
        else {
            panic!("expected root pane");
        };
        assert_eq!(
            contents,
            vec![
                WorkspacePaneContentRef::Pty {
                    slot_id: "slot-before-active".to_string(),
                },
                WorkspacePaneContentRef::Pty {
                    slot_id: "slot-after-active".to_string(),
                },
            ]
        );
        assert_eq!(
            active_content,
            Some(WorkspacePaneContentRef::Pty {
                slot_id: "slot-after-active".to_string(),
            })
        );
    }

    #[test]
    fn applying_preset_keeps_active_detached_file_outside_the_pane_tree() {
        let mut connection = database();
        let file_path = "src/main.rs";
        let preset_document = crate::models::workspace_layout::WorkspaceFileDocument {
            id: Uuid::new_v4().to_string(),
            directory_id: 1,
            directory_path: "C:\\Projects\\work".to_string(),
            relative_path: file_path.to_string(),
        };
        let mut preset_layout = empty_layout();
        preset_layout.documents.push(preset_document.clone());
        let WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } = &mut preset_layout.tree
        else {
            panic!("empty preset keeps its root pane");
        };
        let preset_ref = WorkspacePaneContentRef::File {
            document_id: preset_document.id.clone(),
        };
        contents.push(preset_ref.clone());
        *active_content = Some(preset_ref);
        let preset = create_preset(&mut connection, "文件窗口布局", &preset_layout).unwrap();

        let active_document = crate::models::workspace_layout::WorkspaceFileDocument {
            id: Uuid::new_v4().to_string(),
            directory_id: 1,
            directory_path: "C:\\Projects\\work".to_string(),
            relative_path: file_path.to_string(),
        };
        let mut active_layout = empty_layout();
        active_layout.documents.push(active_document.clone());
        active_layout
            .detached_contents
            .push(WorkspacePaneContentRef::File {
                document_id: active_document.id.clone(),
            });

        let plan =
            plan_apply_preset(&connection, &preset.id, &active_layout, &HashSet::new()).unwrap();

        assert_eq!(plan.layout.documents, vec![active_document.clone()]);
        assert_eq!(
            plan.layout.detached_contents,
            vec![WorkspacePaneContentRef::File {
                document_id: active_document.id
            }]
        );
        let WorkspaceLayoutNode::Pane { ref contents, .. } = plan.layout.tree else {
            panic!("preset keeps its root pane");
        };
        assert!(contents.is_empty());
        plan.layout
            .validate()
            .expect("detached file layout is valid");
    }

    #[test]
    fn applying_preset_preserves_detached_unknown_contents() {
        let mut connection = database();
        let preset = create_preset(&mut connection, "未来内容布局", &empty_layout()).unwrap();
        let unknown = WorkspacePaneContentRef::Unknown {
            original_kind: "markdownPreview".to_string(),
            raw: serde_json::json!({
                "kind": "markdownPreview",
                "documentId": "8e783338-f464-4b10-b15e-b534748c6241"
            }),
        };
        let mut active = empty_layout();
        active.detached_contents.push(unknown.clone());
        active
            .validate()
            .expect("active layout with a detached unknown content is valid");

        let plan = plan_apply_preset(&connection, &preset.id, &active, &HashSet::new()).unwrap();

        let kept: Vec<&WorkspacePaneContentRef> = plan
            .layout
            .detached_contents
            .iter()
            .filter(|content| matches!(content, WorkspacePaneContentRef::Unknown { .. }))
            .collect();
        assert_eq!(kept, vec![&unknown]);
        plan.layout
            .validate()
            .expect("layout with a preserved unknown content is valid");

        let repeated =
            plan_apply_preset(&connection, &preset.id, &plan.layout, &HashSet::new()).unwrap();
        assert_eq!(
            repeated
                .layout
                .detached_contents
                .iter()
                .filter(|content| matches!(content, WorkspacePaneContentRef::Unknown { .. }))
                .count(),
            1
        );
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

        let plan =
            plan_apply_preset(&connection, &preset.id, &active, &running_ids(&connection)).unwrap();

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

        let plan =
            plan_apply_preset(&connection, &preset.id, &active, &running_ids(&connection)).unwrap();

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

        let plan =
            plan_apply_preset(&connection, &preset.id, &active, &running_ids(&connection)).unwrap();

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

        let plan =
            plan_apply_preset(&connection, &preset.id, &empty_layout(), &HashSet::new()).unwrap();

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
        assert!(plan_apply_preset(&connection, &preset.id, &layout, &HashSet::new()).is_err());
        assert!(delete_preset(&connection, &preset.id).unwrap());
    }

    fn insert_state_row(
        connection: &Connection,
        schema_version: i64,
        revision: i64,
        payload: &str,
    ) {
        connection
            .execute(
                "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, ?1, ?2, ?3, 0)",
                rusqlite::params![schema_version, revision, payload],
            )
            .unwrap();
    }

    #[test]
    fn legacy_schema_rows_are_saved_after_in_memory_migration_to_current_version() {
        for version in 1..=4u32 {
            let mut connection = database();
            insert_state_row(
                &connection,
                i64::from(version),
                3,
                &legacy_payload_json(version),
            );

            let read = read_current(&connection, &HashSet::new()).unwrap();
            assert!(
                matches!(read.status, WorkspaceLayoutStateStatus::Ready),
                "v{version}: legacy rows must read as ready"
            );
            assert_eq!(read.schema_version, Some(5), "v{version}");
            assert_eq!(read.revision, Some(3), "v{version}");
            let layout = read.layout.clone().expect("ready read carries a layout");

            let saved = save_current(&mut connection, 4, &layout, &SaveContext::INERT).unwrap();
            assert!(saved.saved, "v{version}: the first save must be accepted");
            assert_eq!(saved.revision, 4, "v{version}");
            assert_eq!(saved.reason, None, "v{version}");
            assert!(
                serde_json::to_value(&saved)
                    .unwrap()
                    .get("reason")
                    .is_none(),
                "v{version}: a successful save serializes without a reason key"
            );

            let row = workspace_layout_repo::get_current(&connection)
                .unwrap()
                .unwrap();
            assert_eq!(row.schema_version, 5, "v{version}");
            assert_eq!(row.revision, 4, "v{version}");
            let stored: serde_json::Value = serde_json::from_str(&row.payload_json).unwrap();
            assert_eq!(stored["schemaVersion"], 5, "v{version}");

            let reread = read_current(&connection, &HashSet::new()).unwrap();
            assert_eq!(reread.layout, Some(layout.clone()), "v{version}");

            let again = save_current(&mut connection, 4, &layout, &SaveContext::INERT).unwrap();
            assert!(!again.saved, "v{version}: the same revision is stale");
            assert_eq!(
                again.reason,
                Some(WorkspaceLayoutSaveRejection::Stale),
                "v{version}"
            );
            assert_eq!(again.revision, 4, "v{version}");
            let unchanged = workspace_layout_repo::get_current(&connection)
                .unwrap()
                .unwrap();
            assert_eq!(unchanged.revision, 4, "v{version}");
            assert_eq!(unchanged.payload_json, row.payload_json, "v{version}");
        }
    }

    #[test]
    fn concurrent_saves_of_one_revision_on_a_legacy_row_have_one_winner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db.sqlite");
        let first = connection::init_database(&path).unwrap();
        insert_state_row(&first, 1, 3, &legacy_payload_json(1));
        let layout = read_current(&first, &HashSet::new())
            .unwrap()
            .layout
            .unwrap();
        let second = connection::open_database(&path).unwrap();

        let results: Vec<WorkspaceLayoutSaveResult> = std::thread::scope(|scope| {
            let handles: Vec<_> = [first, second]
                .into_iter()
                .map(|mut conn| {
                    let layout = &layout;
                    scope.spawn(move || {
                        save_current(&mut conn, 4, layout, &SaveContext::INERT).unwrap()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect()
        });

        let winners = results.iter().filter(|result| result.saved).count();
        assert_eq!(winners, 1, "{results:?}");
        let loser = results.iter().find(|result| !result.saved).unwrap();
        assert_eq!(loser.reason, Some(WorkspaceLayoutSaveRejection::Stale));
        let verify = connection::open_database(&path).unwrap();
        let row = workspace_layout_repo::get_current(&verify)
            .unwrap()
            .unwrap();
        assert_eq!(row.revision, 4);
        assert_eq!(row.schema_version, 5);
    }

    #[test]
    fn save_result_maps_outcomes_to_camel_case_dto() {
        let saved = serde_json::to_value(save_result_from_outcome(
            SaveCurrentOutcome::Saved { revision: 4 },
            3,
        ))
        .unwrap();
        assert_eq!(saved, serde_json::json!({"saved": true, "revision": 4}));

        let stale = serde_json::to_value(save_result_from_outcome(
            SaveCurrentOutcome::Stale {
                current_revision: 7,
            },
            3,
        ))
        .unwrap();
        assert_eq!(
            stale,
            serde_json::json!({"saved": false, "revision": 7, "reason": "stale"})
        );

        let incompatible = serde_json::to_value(save_result_from_outcome(
            SaveCurrentOutcome::Incompatible {
                stored_schema_version: 99,
            },
            3,
        ))
        .unwrap();
        assert_eq!(
            incompatible,
            serde_json::json!({"saved": false, "revision": 3, "reason": "incompatible"})
        );
    }

    #[test]
    fn future_schema_row_is_never_overwritten_by_autosave() {
        let mut connection = database();
        insert_state_row(&connection, 99, 5, "{\"schemaVersion\":99}");

        let error =
            save_current(&mut connection, 6, &empty_layout(), &SaveContext::INERT).unwrap_err();
        assert!(error.to_string().contains("不受支持"), "{error}");

        let row = workspace_layout_repo::get_current(&connection)
            .unwrap()
            .unwrap();
        assert_eq!(row.schema_version, 99);
        assert_eq!(row.revision, 5);
        assert_eq!(row.payload_json, "{\"schemaVersion\":99}");
    }

    #[test]
    fn staged_layout_read_resolves_a_running_slot() {
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
        let layout = layout_with_slot(directory.id, &directory.path, "work", Some(session_id));
        save_current(&mut connection, 1, &layout, &SaveContext::INERT).unwrap();

        let staged = match read_current_stage(&connection).unwrap() {
            LayoutReadStage::Resolve(pending) => pending.finish(&running_ids(&connection)),
            LayoutReadStage::Done(_) => panic!("a valid layout must need slot resolution"),
        };

        assert_eq!(staged.status, WorkspaceLayoutStateStatus::Ready);
        assert!(staged.layout.is_some());
        assert_eq!(staged.slot_states.len(), 1);
        assert_eq!(staged.slot_states[0].state, WorkspaceSlotStateKind::Running);
        assert_eq!(
            staged.slot_states[0].current_project_name.as_deref(),
            Some("work")
        );
        assert!(matches!(
            read_current_stage(&database()).unwrap(),
            LayoutReadStage::Done(_)
        ));
    }

    #[test]
    fn staged_apply_plan_resolves_a_running_slot() {
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
        let active = layout_with_slot(
            directory.id,
            &directory.path,
            "work",
            Some(session_id.clone()),
        );
        let preset_layout =
            layout_with_slot(directory.id, &directory.path, "work", Some(session_id));
        let preset = create_preset(&mut connection, "团队工作区", &preset_layout).unwrap();

        let staged = plan_apply_preset_stage(&connection, &preset.id, &active)
            .unwrap()
            .finish(&running_ids(&connection))
            .unwrap();

        assert_eq!(staged.layout.slots.len(), 1);
        assert_eq!(staged.slot_states.len(), 1);
        assert_eq!(staged.slot_states[0].state, WorkspaceSlotStateKind::Running);
        assert!(
            plan_apply_preset_stage(&connection, "missing-preset", &active).is_err(),
            "a missing preset must fail in the database stage"
        );
    }

    #[test]
    fn slot_facts_cover_every_directory_and_session_referenced_by_a_layout() {
        let connection = database();
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
        let mut with_session =
            layout_with_slot(directory.id, &directory.path, "work", Some(session_id));
        let mut missing = layout_with_slot(9999, "C:\\Projects\\gone", "gone", None);
        let facts = SlotFacts::load(
            &connection,
            with_session.slots.iter().chain(missing.slots.iter()),
        )
        .unwrap();
        let running = running_ids(&connection);
        drop(connection);

        assert_eq!(
            resolve_slot_with(&facts, &mut with_session.slots[0], &running).state,
            WorkspaceSlotStateKind::Running
        );
        assert_eq!(
            resolve_slot_with(&facts, &mut missing.slots[0], &HashSet::new()).state,
            WorkspaceSlotStateKind::MissingProject
        );
    }

    fn current_row_with_file_path(
        connection: &Connection,
        revision: i64,
        relative_path: &str,
    ) -> String {
        let mut layout = layout_with_slot(1, "/tmp/project", "project", None);
        let document_id = Uuid::new_v4().to_string();
        layout
            .documents
            .push(crate::models::workspace_layout::WorkspaceFileDocument {
                id: document_id.clone(),
                directory_id: 1,
                directory_path: "/tmp/project".to_string(),
                relative_path: "ok.txt".to_string(),
            });
        if let WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } = &mut layout.tree
        {
            let file = WorkspacePaneContentRef::File {
                document_id: document_id.clone(),
            };
            contents.push(file.clone());
            *active_content = Some(file);
        }
        layout.validate().unwrap();
        let mut value = serde_json::to_value(&layout).unwrap();
        value["documents"][0]["relativePath"] = serde_json::json!(relative_path);
        connection
            .execute(
                "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, 5, ?1, ?2, 10)",
                rusqlite::params![revision, value.to_string()],
            )
            .unwrap();
        document_id
    }

    fn assert_file_degrades_to_placeholder(
        connection: &mut Connection,
        document_id: &str,
        relative_path: &str,
    ) {
        let read = read_current(connection, &HashSet::new()).unwrap();
        assert!(
            matches!(read.status, WorkspaceLayoutStateStatus::Ready),
            "{:?}",
            read.status
        );
        let layout = read.layout.clone().expect("a degradable layout must load");
        assert!(layout.documents.is_empty());
        let WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } = &layout.tree
        else {
            panic!("the root must remain a pane");
        };
        assert_eq!(contents.len(), 2);
        assert!(matches!(contents[0], WorkspacePaneContentRef::Pty { .. }));
        let WorkspacePaneContentRef::Unknown { original_kind, raw } = &contents[1] else {
            panic!(
                "the file reference must become a placeholder: {:?}",
                contents[1]
            );
        };
        assert_eq!(original_kind, "invalidFile");
        assert_eq!(raw["documentId"], document_id);
        assert_eq!(raw["relativePath"], relative_path);
        assert!(raw["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty()));
        assert_eq!(raw["incomplete"], true);
        assert_eq!(active_content.as_ref(), Some(&contents[1]));
        assert_eq!(layout.focused_pane_id, "workspace-root");
        assert_eq!(layout.slots.len(), 1);
        layout.validate().unwrap();

        let revision = read.revision.unwrap();
        let saved = save_current(connection, revision + 1, &layout, &SaveContext::INERT).unwrap();
        assert!(saved.saved, "a degraded layout must be saveable: {saved:?}");

        let reread = read_current(connection, &HashSet::new()).unwrap();
        assert!(matches!(reread.status, WorkspaceLayoutStateStatus::Ready));
        let stable = reread.layout.expect("the saved layout must load");
        assert!(stable.documents.is_empty());
        let WorkspaceLayoutNode::Pane { contents, .. } = &stable.tree else {
            panic!("the root must remain a pane");
        };
        assert_eq!(
            contents
                .iter()
                .filter(|content| matches!(content, WorkspacePaneContentRef::Unknown { .. }))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn current_layout_with_platform_invalid_file_name_degrades_the_item() {
        let mut connection = database();
        let document_id = current_row_with_file_path(&connection, 3, "notes:final.txt");
        assert_file_degrades_to_placeholder(&mut connection, &document_id, "notes:final.txt");
    }

    #[test]
    fn current_layout_with_an_invalid_file_path_degrades_the_item() {
        let mut connection = database();
        let document_id = current_row_with_file_path(&connection, 3, "a//b.txt");
        assert!(reset_current(&mut connection).is_err());
        assert_file_degrades_to_placeholder(&mut connection, &document_id, "a//b.txt");
    }

    #[test]
    fn current_layout_with_a_structurally_invalid_file_document_still_needs_reset() {
        let mut connection = database();
        let document_id = current_row_with_file_path(&connection, 3, "ok.txt");
        connection
            .execute(
                "update workspace_state set payload_json = replace(payload_json, ?1, 'not-a-uuid') where id = 1",
                rusqlite::params![document_id],
            )
            .unwrap();
        let read = read_current(&connection, &HashSet::new()).unwrap();
        assert!(matches!(
            read.status,
            WorkspaceLayoutStateStatus::NeedsReset(_)
        ));
        assert!(read.layout.is_none());
        assert!(save_current(&mut connection, 4, &empty_layout(), &SaveContext::INERT).is_err());
    }

    #[test]
    fn applying_presets_saved_by_every_supported_layout_version() {
        use crate::models::workspace_layout::legacy_payload_json;

        fn preset_payload(version: u32) -> String {
            let payload = legacy_payload_json(version);
            if version != 3 {
                return payload;
            }
            // The v3 fixture parks its slot in detachedSlotIds, which a named
            // layout may not contain (validate_as_preset); move it into the pane.
            let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
            let slot_id = value["detachedSlotIds"][0].clone();
            assert!(
                slot_id.is_string(),
                "the v3 fixture must carry one detached slot"
            );
            value["detachedSlotIds"] = serde_json::json!([]);
            let reference = serde_json::json!({ "kind": "pty", "slotId": slot_id });
            value["tree"]["contents"] = serde_json::json!([reference.clone()]);
            value["tree"]["activeContent"] = reference;
            serde_json::to_string(&value).unwrap()
        }

        for version in 1u32..=4 {
            let connection = database();
            let payload = preset_payload(version);
            let raw: serde_json::Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(raw["schemaVersion"], serde_json::json!(version));
            let raw_slots = raw["slots"].as_array().map_or(0, Vec::len);
            let raw_documents = raw["documents"].as_array().map_or(0, Vec::len);
            assert!(raw_slots >= 1, "v{version} fixture must contain a slot");
            if version == 2 {
                assert!(
                    raw_documents >= 1,
                    "v2 fixture must contain a file document"
                );
            }
            let id = format!("preset-v{version}");
            connection
                .execute(
                    "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values (?1, ?2, ?3, ?4, 0, 0)",
                    rusqlite::params![id, format!("Preset v{version}"), version, payload],
                )
                .unwrap();

            let plan = plan_apply_preset(&connection, &id, &empty_layout(), &HashSet::new())
                .unwrap_or_else(|error| panic!("applying the v{version} preset failed: {error:?}"));

            plan.layout.validate().unwrap();
            assert_eq!(plan.layout.schema_version, WORKSPACE_LAYOUT_SCHEMA_VERSION);
            assert_eq!(plan.layout.slots.len(), raw_slots, "v{version} slot count");
            assert_eq!(
                plan.layout.documents.len(),
                raw_documents,
                "v{version} document count"
            );
            // Reverse: no detached content appears, and planning does not rewrite the stored row.
            assert!(plan.layout.detached_contents.is_empty());
            let stored: (i64, String) = connection
                .query_row(
                    "select schema_version, payload_json from workspace_layout_presets where id = ?1",
                    rusqlite::params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(stored, (i64::from(version), payload));
        }
    }

    /// A document id: layouts only accept UUIDs, so a readable name becomes a fixed one.
    fn uuid_for(name: &str) -> String {
        let number = name
            .bytes()
            .fold(0u128, |number, byte| number * 256 + u128::from(byte));
        uuid::Uuid::from_u128(number).to_string()
    }

    fn files_layout(files: &[(&str, &str)]) -> WorkspaceLayoutDocument {
        use crate::models::workspace_layout::WorkspaceFileDocument;
        let contents: Vec<WorkspacePaneContentRef> = files
            .iter()
            .map(|(id, _)| WorkspacePaneContentRef::File {
                document_id: uuid_for(id),
            })
            .collect();
        WorkspaceLayoutDocument {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            tree: WorkspaceLayoutNode::Pane {
                id: "workspace-root".to_string(),
                pane_number: 1,
                active_content: contents.first().cloned(),
                contents,
            },
            focused_pane_id: "workspace-root".to_string(),
            slots: Vec::new(),
            documents: files
                .iter()
                .map(|(id, relative_path)| WorkspaceFileDocument {
                    id: uuid_for(id),
                    directory_id: 1,
                    directory_path: "/work/project".to_string(),
                    relative_path: (*relative_path).to_string(),
                })
                .collect(),
            detached_contents: Vec::new(),
        }
    }

    fn insensitive() -> PathSemantics {
        PathSemantics {
            case: CaseSensitivity::Insensitive,
            normalization_insensitive: crate::platform::case_sensitivity::Tri::No,
        }
    }

    #[test]
    fn save_rejects_case_variants_only_when_the_cached_flag_is_insensitive() {
        let variants = files_layout(&[("doc-b", "A.txt"), ("doc-a", "a.txt")]);
        let sensitive = PathSemantics {
            case: CaseSensitivity::Sensitive,
            normalization_insensitive: crate::platform::case_sensitivity::Tri::No,
        };
        for (label, flag) in [
            ("sensitive", Some(sensitive)),
            ("unknown", Some(PathSemantics::UNKNOWN)),
            ("cache miss", None),
        ] {
            let mut connection = database();
            let semantics_of = move |_: i64, _: &str| flag;
            let context = SaveContext {
                semantics_of: &semantics_of,
                backup_before_case_merge: &|_| Ok(()),
            };
            assert!(
                save_current(&mut connection, 1, &variants, &context).is_ok(),
                "{label} must not refuse case variants"
            );
        }

        let mut connection = database();
        let semantics_of = |_: i64, _: &str| Some(insensitive());
        let context = SaveContext {
            semantics_of: &semantics_of,
            backup_before_case_merge: &|_| Ok(()),
        };
        let error = save_current(&mut connection, 1, &variants, &context).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "layout.case_duplicate");
        let mut expected_ids = vec![uuid_for("doc-a"), uuid_for("doc-b")];
        expected_ids.sort();
        assert_eq!(
            value["params"]["documentIds"],
            serde_json::json!(expected_ids),
            "both documents of the group, sorted"
        );
        assert!(
            workspace_layout_repo::get_current(&connection)
                .unwrap()
                .is_none(),
            "a refused layout is not stored"
        );

        // Reverse: an insensitive project without case variants saves normally.
        let distinct = files_layout(&[("doc-a", "a.txt"), ("doc-b", "b.txt")]);
        assert!(save_current(&mut connection, 1, &distinct, &context).is_ok());
    }

    #[test]
    fn save_creates_a_protective_backup_before_the_first_merged_layout() {
        use std::cell::{Cell, RefCell};

        let mut connection = database();
        let backups = Cell::new(0);
        let revision_seen_by_backup = RefCell::new(Vec::new());
        let flag = Cell::new(Some(PathSemantics::UNKNOWN));
        let semantics_of = |_: i64, _: &str| flag.get();
        let backup = |connection: &Connection| -> Result<(), AppError> {
            backups.set(backups.get() + 1);
            let revision = workspace_layout_repo::get_current(connection)
                .unwrap()
                .map(|row| row.revision);
            revision_seen_by_backup.borrow_mut().push(revision);
            Ok(())
        };
        let context = SaveContext {
            semantics_of: &semantics_of,
            backup_before_case_merge: &backup,
        };

        // 1. Case variants are stored while the project is `Unknown`: no backup.
        let variants = files_layout(&[("doc-a", "a.txt"), ("doc-b", "A.txt")]);
        assert!(
            save_current(&mut connection, 1, &variants, &context)
                .unwrap()
                .saved
        );
        assert_eq!(backups.get(), 0);

        // 2. The project turns out to be insensitive and the merged layout is saved: one backup,
        //    taken before the write (the stored revision is still the old one).
        flag.set(Some(insensitive()));
        let merged = files_layout(&[("doc-a", "a.txt")]);
        let saved = save_current(&mut connection, 2, &merged, &context).unwrap();
        assert!(saved.saved);
        assert_eq!(backups.get(), 1);
        assert_eq!(*revision_seen_by_backup.borrow(), vec![Some(1)]);

        // 3. Saving the merged layout again does not back up again.
        assert!(
            save_current(&mut connection, 3, &merged, &context)
                .unwrap()
                .saved
        );
        assert_eq!(backups.get(), 1);

        // Reverse: an insensitive project that never had duplicates is never backed up.
        let mut fresh = database();
        assert!(
            save_current(&mut fresh, 1, &merged, &context)
                .unwrap()
                .saved
        );
        assert_eq!(backups.get(), 1);
    }

    #[test]
    fn a_stale_save_leaves_no_protective_backup_and_a_failed_backup_aborts_the_save() {
        use std::cell::Cell;

        let mut connection = database();
        let flag = Cell::new(Some(PathSemantics::UNKNOWN));
        let semantics_of = |_: i64, _: &str| flag.get();
        let backups = Cell::new(0);
        let counting_backup = |_: &Connection| -> Result<(), AppError> {
            backups.set(backups.get() + 1);
            Ok(())
        };
        let context = SaveContext {
            semantics_of: &semantics_of,
            backup_before_case_merge: &counting_backup,
        };
        let variants = files_layout(&[("doc-a", "a.txt"), ("doc-b", "A.txt")]);
        let merged = files_layout(&[("doc-a", "a.txt")]);
        assert!(
            save_current(&mut connection, 5, &variants, &context)
                .unwrap()
                .saved
        );

        // The project is insensitive now; the merged layout arrives with an old revision.
        flag.set(Some(insensitive()));
        let stale = save_current(&mut connection, 5, &merged, &context).unwrap();
        assert!(!stale.saved, "an old revision is refused");
        assert_eq!(backups.get(), 0, "a refused save takes no backup");

        // A backup that fails stops the save: the stored layout is unchanged.
        let failing_backup =
            |_: &Connection| -> Result<(), AppError> { Err(AppError::internal("backup failed")) };
        let failing = SaveContext {
            semantics_of: &semantics_of,
            backup_before_case_merge: &failing_backup,
        };
        assert!(save_current(&mut connection, 6, &merged, &failing).is_err());
        let stored = workspace_layout_repo::get_current(&connection)
            .unwrap()
            .unwrap();
        assert_eq!(stored.revision, 5);

        // And with a working backup the same save goes through, once.
        assert!(
            save_current(&mut connection, 6, &merged, &context)
                .unwrap()
                .saved
        );
        assert_eq!(backups.get(), 1);
    }

    #[test]
    fn a_stale_save_with_case_variants_reports_stale_not_case_duplicate() {
        let mut connection = database();
        let semantics_of = |_: i64, _: &str| Some(insensitive());
        let context = SaveContext {
            semantics_of: &semantics_of,
            backup_before_case_merge: &|_| Ok(()),
        };
        let clean = files_layout(&[("doc-a", "a.txt")]);
        assert!(
            save_current(&mut connection, 5, &clean, &context)
                .unwrap()
                .saved
        );

        // The same revision again, now with case variants: stale, not a duplicate error.
        let variants = files_layout(&[("doc-a", "a.txt"), ("doc-b", "A.txt")]);
        let stale = save_current(&mut connection, 5, &variants, &context).unwrap();
        assert!(!stale.saved);
        assert_eq!(stale.revision, 5);

        // Reverse: with a newer revision the duplicate is refused as before.
        let error = save_current(&mut connection, 6, &variants, &context).unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["code"],
            "layout.case_duplicate"
        );
    }

    #[test]
    fn needs_reset_reasons_are_structured_codes() {
        let supported = WORKSPACE_LAYOUT_SCHEMA_VERSION as i64;
        let structurally_invalid = format!("{{\"schemaVersion\":{supported}}}");
        let cases = [
            (99_i64, "{\"schemaVersion\":99}", "unsupportedVersion"),
            (supported, "{\"schemaVersion\":1}", "versionMismatch"),
            (supported, structurally_invalid.as_str(), "invalidPayload"),
        ];
        for (schema_version, payload, expected_code) in cases {
            let connection = database();
            connection
                .execute(
                    "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, ?1, 3, ?2, 10)",
                    rusqlite::params![schema_version, payload],
                )
                .unwrap();
            let read = read_current(&connection, &HashSet::new()).unwrap();
            let value = serde_json::to_value(&read.status).unwrap();
            assert_eq!(value["status"], "needsReset", "{payload}");
            assert_eq!(value["reason"]["code"], expected_code, "{payload}");
            assert!(
                value["reason"]["detail"]
                    .as_str()
                    .is_some_and(|d| !d.is_empty()),
                "{payload}"
            );
            // Reverse: the reason is an object, not the old free-text string.
            assert!(value["reason"].is_object(), "{payload}");
        }
    }

    #[test]
    fn duplicate_preset_names_report_layout_name_exists() {
        let mut connection = database();
        create_preset(&mut connection, "A", &empty_layout()).unwrap();
        let error = create_preset(&mut connection, "A", &empty_layout()).unwrap_err();
        assert_eq!(error.code(), "layout.name_exists");

        // Reverse: a different name still succeeds.
        create_preset(&mut connection, "B", &empty_layout()).unwrap();
    }

    #[test]
    fn preset_limit_reports_layout_preset_limit_with_max() {
        let mut connection = database();
        for index in 0..MAX_WORKSPACE_LAYOUT_PRESETS {
            create_preset(
                &mut connection,
                &format!("preset{index:03}"),
                &empty_layout(),
            )
            .unwrap_or_else(|_| panic!("preset {index} must be created"));
        }
        let error = create_preset(&mut connection, "one-too-many", &empty_layout()).unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "layout.preset_limit");
        assert_eq!(value["params"]["max"], MAX_WORKSPACE_LAYOUT_PRESETS);
    }
}
