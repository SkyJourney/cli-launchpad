use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::tool::ToolKey;

pub const WORKSPACE_LAYOUT_SCHEMA_VERSION: u32 = 1;
pub const MAX_WORKSPACE_LAYOUT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_WORKSPACE_LAYOUT_DEPTH: usize = 32;
pub const MAX_WORKSPACE_LAYOUT_NODES: usize = 511;
pub const MAX_WORKSPACE_LAYOUT_SLOTS: usize = 2048;
pub const MAX_WORKSPACE_LAYOUT_PRESETS: usize = 100;
pub const MAX_WORKSPACE_LAYOUT_PRESET_NAME_CHARS: usize = 64;

const MAX_ID_CHARS: usize = 128;
const MAX_PROJECT_NAME_CHARS: usize = 256;
const MAX_DIRECTORY_PATH_CHARS: usize = 32_767;
const MAX_RESUME_SESSION_ID_CHARS: usize = 512;
const MAX_CUSTOM_TITLE_CHARS: usize = 128;
const MIN_SPLIT_RATIO: f64 = 0.05;
const MAX_SPLIT_RATIO: f64 = 0.95;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkspaceLayoutError {
    #[error("工作区布局超过大小限制")]
    PayloadTooLarge,
    #[error("工作区布局 JSON 无效：{0}")]
    InvalidJson(String),
    #[error("不支持工作区布局版本 {0}")]
    UnsupportedVersion(u32),
    #[error("工作区布局无效：{0}")]
    Invalid(String),
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLayoutDocument {
    pub schema_version: u32,
    pub tree: WorkspaceLayoutNode,
    pub focused_pane_id: String,
    pub slots: Vec<WorkspaceLayoutSlot>,
    #[serde(default)]
    pub detached_slot_ids: Vec<String>,
}

impl WorkspaceLayoutDocument {
    pub fn from_json(json: &str) -> Result<Self, WorkspaceLayoutError> {
        if json.len() > MAX_WORKSPACE_LAYOUT_BYTES {
            return Err(WorkspaceLayoutError::PayloadTooLarge);
        }

        let document: Self = serde_json::from_str(json)
            .map_err(|error| WorkspaceLayoutError::InvalidJson(error.to_string()))?;
        document.validate()?;
        Ok(document)
    }

    pub fn to_json(&self) -> Result<String, WorkspaceLayoutError> {
        self.validate()?;
        let json = serde_json::to_string(self)
            .map_err(|error| WorkspaceLayoutError::InvalidJson(error.to_string()))?;
        if json.len() > MAX_WORKSPACE_LAYOUT_BYTES {
            return Err(WorkspaceLayoutError::PayloadTooLarge);
        }
        Ok(json)
    }

    pub fn validate(&self) -> Result<(), WorkspaceLayoutError> {
        if self.schema_version != WORKSPACE_LAYOUT_SCHEMA_VERSION {
            return Err(WorkspaceLayoutError::UnsupportedVersion(
                self.schema_version,
            ));
        }
        if self.slots.len() > MAX_WORKSPACE_LAYOUT_SLOTS {
            return invalid("会话数量超过限制");
        }

        let mut slots_by_id = HashMap::with_capacity(self.slots.len());
        let mut session_ids = HashSet::new();
        for slot in &self.slots {
            validate_slot(slot)?;
            if slots_by_id
                .insert(slot.instance_id.as_str(), slot)
                .is_some()
            {
                return invalid("slot 身份重复");
            }
            if slot
                .session_id
                .as_ref()
                .is_some_and(|session_id| !session_ids.insert(session_id.as_str()))
            {
                return invalid("PTY session 在多个 slot 中重复出现");
            }
        }

        let mut node_ids = HashSet::new();
        let mut pane_numbers = HashSet::new();
        let mut referenced_slots = HashSet::new();
        let mut node_count = 0;
        let mut pane_ids = HashSet::new();
        validate_node(
            &self.tree,
            1,
            &mut node_count,
            &mut node_ids,
            &mut pane_numbers,
            &mut pane_ids,
            &mut referenced_slots,
            &slots_by_id,
        )?;

        if !pane_ids.contains(self.focused_pane_id.as_str()) {
            return invalid("焦点 pane 不存在");
        }

        let mut detached_ids = HashSet::new();
        for instance_id in &self.detached_slot_ids {
            if !slots_by_id.contains_key(instance_id.as_str()) {
                return invalid("独立窗口引用了不存在的 slot");
            }
            if !detached_ids.insert(instance_id.as_str()) {
                return invalid("独立窗口 slot 重复");
            }
            if !referenced_slots.insert(instance_id.as_str()) {
                return invalid("slot 同时出现在 pane 和独立窗口");
            }
        }

        if referenced_slots.len() != slots_by_id.len() {
            return invalid("存在未归属 pane 或独立窗口的 slot");
        }

        Ok(())
    }

    pub fn validate_as_preset(&self) -> Result<(), WorkspaceLayoutError> {
        self.validate()?;
        if !self.detached_slot_ids.is_empty() {
            return invalid("命名布局不能包含独立窗口会话");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceLayoutNode {
    Pane {
        id: String,
        pane_number: u32,
        session_ids: Vec<String>,
        active_session_id: Option<String>,
    },
    Split {
        id: String,
        direction: WorkspaceSplitDirection,
        ratio: f64,
        first: Box<WorkspaceLayoutNode>,
        second: Box<WorkspaceLayoutNode>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLayoutSlot {
    pub instance_id: String,
    pub directory_id: i64,
    pub directory_path: String,
    pub project_name: String,
    pub tool_key: ToolKey,
    pub sequence: u32,
    pub session_id: Option<String>,
    pub resume_session_id: Option<String>,
    pub title: WorkspaceSlotTitle,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutStateRead {
    pub status: WorkspaceLayoutStateStatus,
    pub revision: Option<i64>,
    pub schema_version: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub layout: Option<WorkspaceLayoutDocument>,
    pub slot_states: Vec<WorkspaceSlotState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "status", content = "reason", rename_all = "camelCase")]
pub enum WorkspaceLayoutStateStatus {
    Missing,
    Ready,
    NeedsReset(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSlotState {
    pub instance_id: String,
    pub state: WorkspaceSlotStateKind,
    pub current_project_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSlotStateKind {
    Pending,
    Running,
    Ended,
    MissingProject,
    ProjectIdentityMismatch,
    MissingSession,
    SessionIdentityMismatch,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutSaveResult {
    pub saved: bool,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutPresetSummary {
    pub id: String,
    pub name: String,
    pub schema_version: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutPreset {
    pub summary: WorkspaceLayoutPresetSummary,
    pub layout: WorkspaceLayoutDocument,
    pub slot_states: Vec<WorkspaceSlotState>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutApplyPlan {
    pub layout: WorkspaceLayoutDocument,
    pub slot_states: Vec<WorkspaceSlotState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceSlotTitle {
    Automatic,
    Custom(String),
}

pub fn validate_preset_name(name: &str) -> Result<String, WorkspaceLayoutError> {
    let normalized = name.trim();
    let length = normalized.chars().count();
    if length == 0 {
        return invalid("布局名称不能为空");
    }
    if length > MAX_WORKSPACE_LAYOUT_PRESET_NAME_CHARS {
        return invalid("布局名称超过 64 个字符");
    }
    if normalized.chars().any(char::is_control) {
        return invalid("布局名称不能包含控制字符");
    }
    Ok(normalized.to_string())
}

fn validate_node<'a>(
    node: &'a WorkspaceLayoutNode,
    depth: usize,
    node_count: &mut usize,
    node_ids: &mut HashSet<&'a str>,
    pane_numbers: &mut HashSet<u32>,
    pane_ids: &mut HashSet<&'a str>,
    referenced_slots: &mut HashSet<&'a str>,
    slots_by_id: &HashMap<&'a str, &'a WorkspaceLayoutSlot>,
) -> Result<(), WorkspaceLayoutError> {
    if depth > MAX_WORKSPACE_LAYOUT_DEPTH {
        return invalid("布局嵌套层级超过限制");
    }
    *node_count += 1;
    if *node_count > MAX_WORKSPACE_LAYOUT_NODES {
        return invalid("窗格和分栏节点数量超过限制");
    }

    match node {
        WorkspaceLayoutNode::Pane {
            id,
            pane_number,
            session_ids,
            active_session_id,
        } => {
            validate_text(id, MAX_ID_CHARS, "pane ID")?;
            if !node_ids.insert(id) {
                return invalid("pane/split ID 重复");
            }
            if *pane_number == 0 || !pane_numbers.insert(*pane_number) {
                return invalid("pane 编号无效或重复");
            }
            pane_ids.insert(id);
            if session_ids.len() > MAX_WORKSPACE_LAYOUT_SLOTS {
                return invalid("单个 pane 的会话数量超过限制");
            }
            for instance_id in session_ids {
                if !slots_by_id.contains_key(instance_id.as_str()) {
                    return invalid("pane 引用了不存在的 slot");
                }
                if !referenced_slots.insert(instance_id.as_str()) {
                    return invalid("slot 在多个 pane 中重复出现");
                }
            }
            match (session_ids.is_empty(), active_session_id.as_deref()) {
                (true, None) => {}
                (false, Some(active)) if session_ids.iter().any(|id| id == active) => {}
                _ => return invalid("活动 slot 与 pane 会话列表不匹配"),
            }
        }
        WorkspaceLayoutNode::Split {
            id,
            ratio,
            first,
            second,
            ..
        } => {
            validate_text(id, MAX_ID_CHARS, "split ID")?;
            if !node_ids.insert(id) {
                return invalid("pane/split ID 重复");
            }
            if !ratio.is_finite() || !(MIN_SPLIT_RATIO..=MAX_SPLIT_RATIO).contains(ratio) {
                return invalid("分栏比例超出 0.05–0.95 范围");
            }
            validate_node(
                first,
                depth + 1,
                node_count,
                node_ids,
                pane_numbers,
                pane_ids,
                referenced_slots,
                slots_by_id,
            )?;
            validate_node(
                second,
                depth + 1,
                node_count,
                node_ids,
                pane_numbers,
                pane_ids,
                referenced_slots,
                slots_by_id,
            )?;
        }
    }
    Ok(())
}

fn validate_slot(slot: &WorkspaceLayoutSlot) -> Result<(), WorkspaceLayoutError> {
    validate_uuid(&slot.instance_id, "slot ID")?;
    if slot.directory_id <= 0 {
        return invalid("项目目录 ID 无效");
    }
    validate_text(
        &slot.directory_path,
        MAX_DIRECTORY_PATH_CHARS,
        "项目目录路径",
    )?;
    validate_text(&slot.project_name, MAX_PROJECT_NAME_CHARS, "项目名称")?;
    if slot.sequence == 0 {
        return invalid("会话序号无效");
    }
    if let Some(session_id) = &slot.session_id {
        validate_uuid(session_id, "PTY session ID")?;
    }
    if let Some(resume_session_id) = &slot.resume_session_id {
        validate_text(
            resume_session_id,
            MAX_RESUME_SESSION_ID_CHARS,
            "CLI 恢复会话 ID",
        )?;
    }
    if let WorkspaceSlotTitle::Custom(title) = &slot.title {
        validate_text(title, MAX_CUSTOM_TITLE_CHARS, "自定义标题")?;
    }
    Ok(())
}

fn validate_uuid(value: &str, label: &str) -> Result<(), WorkspaceLayoutError> {
    if value.len() > MAX_ID_CHARS || Uuid::parse_str(value).is_err() {
        return invalid_owned(format!("{label} 无效"));
    }
    Ok(())
}

fn validate_text(value: &str, max_chars: usize, label: &str) -> Result<(), WorkspaceLayoutError> {
    let length = value.chars().count();
    if value.trim().is_empty() || length > max_chars || value.chars().any(char::is_control) {
        return invalid_owned(format!("{label} 为空、过长或包含控制字符"));
    }
    Ok(())
}

fn invalid<T>(message: &'static str) -> Result<T, WorkspaceLayoutError> {
    Err(WorkspaceLayoutError::Invalid(message.to_string()))
}

fn invalid_owned<T>(message: String) -> Result<T, WorkspaceLayoutError> {
    Err(WorkspaceLayoutError::Invalid(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_document() -> WorkspaceLayoutDocument {
        let instance_id = Uuid::new_v4().to_string();
        WorkspaceLayoutDocument {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            tree: WorkspaceLayoutNode::Pane {
                id: "workspace-root".to_string(),
                pane_number: 1,
                session_ids: vec![instance_id.clone()],
                active_session_id: Some(instance_id.clone()),
            },
            focused_pane_id: "workspace-root".to_string(),
            slots: vec![WorkspaceLayoutSlot {
                instance_id,
                directory_id: 1,
                directory_path: "C:\\Projects\\example".to_string(),
                project_name: "example".to_string(),
                tool_key: ToolKey::Claude,
                sequence: 1,
                session_id: Some(Uuid::new_v4().to_string()),
                resume_session_id: None,
                title: WorkspaceSlotTitle::Automatic,
            }],
            detached_slot_ids: Vec::new(),
        }
    }

    #[test]
    fn workspace_layout_round_trips_as_versioned_camel_case_json() {
        let document = valid_document();
        let json = document.to_json().expect("serialize valid layout");
        let restored = WorkspaceLayoutDocument::from_json(&json).expect("parse valid layout");

        assert_eq!(restored, document);
        assert!(json.contains("schemaVersion"));
        assert!(json.contains("activeSessionId"));
    }

    #[test]
    fn workspace_layout_rejects_unsupported_versions() {
        let mut document = valid_document();
        document.schema_version += 1;

        assert_eq!(
            document.validate(),
            Err(WorkspaceLayoutError::UnsupportedVersion(2))
        );
    }

    #[test]
    fn workspace_layout_rejects_payloads_over_the_byte_limit() {
        let json = format!(
            "{{\"padding\":\"{}\"}}",
            "x".repeat(MAX_WORKSPACE_LAYOUT_BYTES)
        );

        assert_eq!(
            WorkspaceLayoutDocument::from_json(&json),
            Err(WorkspaceLayoutError::PayloadTooLarge)
        );
    }

    #[test]
    fn workspace_layout_rejects_duplicate_slot_references() {
        let mut document = valid_document();
        let slot_id = document.slots[0].instance_id.clone();
        document.tree = WorkspaceLayoutNode::Split {
            id: "split-1".to_string(),
            direction: WorkspaceSplitDirection::Horizontal,
            ratio: 0.5,
            first: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-1".to_string(),
                pane_number: 1,
                session_ids: vec![slot_id.clone()],
                active_session_id: Some(slot_id.clone()),
            }),
            second: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-2".to_string(),
                pane_number: 2,
                session_ids: vec![slot_id.clone()],
                active_session_id: Some(slot_id),
            }),
        };
        document.focused_pane_id = "pane-1".to_string();

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("重复")
        ));
    }

    #[test]
    fn workspace_layout_rejects_one_pty_session_in_multiple_slots() {
        let mut document = valid_document();
        let mut duplicate = document.slots[0].clone();
        duplicate.instance_id = Uuid::new_v4().to_string();
        let duplicate_instance_id = duplicate.instance_id.clone();
        document.slots.push(duplicate);
        if let WorkspaceLayoutNode::Pane {
            session_ids,
            active_session_id,
            ..
        } = &mut document.tree
        {
            session_ids.push(duplicate_instance_id.clone());
            *active_session_id = Some(duplicate_instance_id);
        }

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("多个 slot")
        ));
    }

    #[test]
    fn workspace_layout_rejects_invalid_split_ratio_and_focus() {
        let mut document = valid_document();
        document.tree = WorkspaceLayoutNode::Split {
            id: "split-1".to_string(),
            direction: WorkspaceSplitDirection::Vertical,
            ratio: f64::NAN,
            first: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-1".to_string(),
                pane_number: 1,
                session_ids: Vec::new(),
                active_session_id: None,
            }),
            second: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-2".to_string(),
                pane_number: 2,
                session_ids: Vec::new(),
                active_session_id: None,
            }),
        };
        document.focused_pane_id = "pane-1".to_string();

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("比例")
        ));

        let mut document = valid_document();
        document.focused_pane_id = "missing-pane".to_string();
        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("焦点")
        ));
    }

    #[test]
    fn workspace_layout_validates_detached_slots_as_unique_references() {
        let mut document = valid_document();
        let slot_id = document.slots[0].instance_id.clone();
        document.tree = WorkspaceLayoutNode::Pane {
            id: "workspace-root".to_string(),
            pane_number: 1,
            session_ids: Vec::new(),
            active_session_id: None,
        };
        document.detached_slot_ids = vec![slot_id];
        document.validate().expect("detached slot is still managed");

        document
            .detached_slot_ids
            .push(document.slots[0].instance_id.clone());
        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("重复")
        ));
    }

    #[test]
    fn named_layouts_cannot_capture_detached_window_sessions() {
        let mut document = valid_document();
        let slot_id = document.slots[0].instance_id.clone();
        document.tree = WorkspaceLayoutNode::Pane {
            id: "workspace-root".to_string(),
            pane_number: 1,
            session_ids: Vec::new(),
            active_session_id: None,
        };
        document.detached_slot_ids = vec![slot_id];

        assert!(document.validate().is_ok());
        assert!(matches!(
            document.validate_as_preset(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("独立窗口")
        ));
    }

    #[test]
    fn workspace_layout_rejects_trees_deeper_than_the_limit() {
        fn split_chain(depth: usize) -> WorkspaceLayoutNode {
            if depth == MAX_WORKSPACE_LAYOUT_DEPTH + 1 {
                return WorkspaceLayoutNode::Pane {
                    id: "deepest-pane".to_string(),
                    pane_number: 1,
                    session_ids: Vec::new(),
                    active_session_id: None,
                };
            }
            WorkspaceLayoutNode::Split {
                id: format!("split-{depth}"),
                direction: WorkspaceSplitDirection::Horizontal,
                ratio: 0.5,
                first: Box::new(split_chain(depth + 1)),
                second: Box::new(WorkspaceLayoutNode::Pane {
                    id: format!("pane-{depth}"),
                    pane_number: depth as u32 + 1,
                    session_ids: Vec::new(),
                    active_session_id: None,
                }),
            }
        }

        let mut document = valid_document();
        document.tree = split_chain(1);
        document.focused_pane_id = "deepest-pane".to_string();

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("层级")
        ));
    }

    #[test]
    fn workspace_layout_rejects_trees_with_too_many_nodes() {
        fn full_tree(
            depth: usize,
            next_id: &mut usize,
            next_pane_number: &mut u32,
            first_pane_id: &mut Option<String>,
        ) -> WorkspaceLayoutNode {
            let id = format!("node-{}", *next_id);
            *next_id += 1;
            if depth == 1 {
                let pane_number = *next_pane_number;
                *next_pane_number += 1;
                if first_pane_id.is_none() {
                    *first_pane_id = Some(id.clone());
                }
                return WorkspaceLayoutNode::Pane {
                    id,
                    pane_number,
                    session_ids: Vec::new(),
                    active_session_id: None,
                };
            }
            WorkspaceLayoutNode::Split {
                id,
                direction: WorkspaceSplitDirection::Vertical,
                ratio: 0.5,
                first: Box::new(full_tree(
                    depth - 1,
                    next_id,
                    next_pane_number,
                    first_pane_id,
                )),
                second: Box::new(full_tree(
                    depth - 1,
                    next_id,
                    next_pane_number,
                    first_pane_id,
                )),
            }
        }

        let mut document = valid_document();
        document.slots.clear();
        let mut next_id = 1;
        let mut next_pane_number = 1;
        let mut first_pane_id = None;
        document.tree = full_tree(10, &mut next_id, &mut next_pane_number, &mut first_pane_id);
        document.focused_pane_id = first_pane_id.expect("tree contains a pane");

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("节点数量")
        ));
    }

    #[test]
    fn workspace_layout_preset_names_are_trimmed_and_bounded() {
        assert_eq!(
            validate_preset_name("  后端工作区  ").unwrap(),
            "后端工作区"
        );
        assert!(validate_preset_name("  ").is_err());
        assert!(validate_preset_name(&"界".repeat(65)).is_err());
        assert!(validate_preset_name("坏\n名称").is_err());
    }
}
