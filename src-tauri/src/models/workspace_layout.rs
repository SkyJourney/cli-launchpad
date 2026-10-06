use std::collections::{HashMap, HashSet};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;
use uuid::Uuid;

use super::tool::ToolKey;

pub const WORKSPACE_LAYOUT_SCHEMA_VERSION: u32 = 5;
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
    pub documents: Vec<WorkspaceFileDocument>,
    #[serde(default)]
    pub detached_contents: Vec<WorkspacePaneContentRef>,
}

impl WorkspaceLayoutDocument {
    pub fn from_json(json: &str) -> Result<Self, WorkspaceLayoutError> {
        if json.len() > MAX_WORKSPACE_LAYOUT_BYTES {
            return Err(WorkspaceLayoutError::PayloadTooLarge);
        }

        let mut value: serde_json::Value = serde_json::from_str(json)
            .map_err(|error| WorkspaceLayoutError::InvalidJson(error.to_string()))?;
        let source_version = value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| WorkspaceLayoutError::InvalidJson("缺少 schemaVersion".into()))?;
        if source_version == 4 {
            value["schemaVersion"] = serde_json::Value::from(WORKSPACE_LAYOUT_SCHEMA_VERSION);
        } else if source_version == 1 || source_version == 2 {
            migrate_legacy_content_refs(&mut value, source_version);
            migrate_detached_slot_ids(&mut value);
        } else if source_version == 3 {
            migrate_detached_slot_ids(&mut value);
        }
        let document: Self = serde_json::from_value(value)
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
        if self.slots.len() > MAX_WORKSPACE_LAYOUT_SLOTS
            || self.documents.len() > MAX_WORKSPACE_LAYOUT_SLOTS
        {
            return invalid("会话或文件文档数量超过限制");
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

        let mut documents_by_id = HashMap::with_capacity(self.documents.len());
        let mut document_paths = HashSet::new();
        for document in &self.documents {
            validate_file_document(document)?;
            if documents_by_id
                .insert(document.id.as_str(), document)
                .is_some()
            {
                return invalid("文件文档身份重复");
            }
            if !document_paths.insert((document.directory_id, document.relative_path.as_str())) {
                return invalid("同一项目文件不能重复打开");
            }
        }

        let mut node_ids = HashSet::new();
        let mut pane_numbers = HashSet::new();
        let mut referenced_slots = HashSet::new();
        let mut referenced_documents = HashSet::new();
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
            &mut referenced_documents,
            &documents_by_id,
        )?;

        if !pane_ids.contains(self.focused_pane_id.as_str()) {
            return invalid("焦点 pane 不存在");
        }

        if self.detached_contents.len() > MAX_WORKSPACE_LAYOUT_SLOTS {
            return invalid("独立窗口内容数量超过限制");
        }
        let mut detached_slots = HashSet::new();
        let mut detached_documents = HashSet::new();
        for content in &self.detached_contents {
            match content {
                WorkspacePaneContentRef::Pty { slot_id } => {
                    if !slots_by_id.contains_key(slot_id.as_str()) {
                        return invalid("独立窗口引用了不存在的 slot");
                    }
                    if !detached_slots.insert(slot_id.as_str()) {
                        return invalid("独立窗口 slot 重复");
                    }
                    if !referenced_slots.insert(slot_id.as_str()) {
                        return invalid("slot 同时出现在 pane 和独立窗口");
                    }
                }
                WorkspacePaneContentRef::File { document_id } => {
                    if !documents_by_id.contains_key(document_id.as_str()) {
                        return invalid("独立窗口引用了不存在的文件文档");
                    }
                    if !detached_documents.insert(document_id.as_str()) {
                        return invalid("独立窗口文件文档重复");
                    }
                    if !referenced_documents.insert(document_id.as_str()) {
                        return invalid("文件文档同时出现在 pane 和独立窗口");
                    }
                }
                WorkspacePaneContentRef::Unknown { original_kind, raw } => {
                    validate_unknown_content_ref(original_kind, raw)?;
                }
            }
        }

        if referenced_slots.len() != slots_by_id.len() {
            return invalid("存在未归属 pane 或独立窗口的 slot");
        }
        if referenced_documents.len() != documents_by_id.len() {
            return invalid("存在未归属 pane 的文件文档");
        }

        Ok(())
    }

    pub fn validate_as_preset(&self) -> Result<(), WorkspaceLayoutError> {
        self.validate()?;
        if !self.detached_contents.is_empty() {
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
        contents: Vec<WorkspacePaneContentRef>,
        #[serde(default)]
        active_content: Option<WorkspacePaneContentRef>,
    },
    Split {
        id: String,
        direction: WorkspaceSplitDirection,
        ratio: f64,
        first: Box<WorkspaceLayoutNode>,
        second: Box<WorkspaceLayoutNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspacePaneContentRef {
    Pty {
        slot_id: String,
    },
    File {
        document_id: String,
    },
    Unknown {
        original_kind: String,
        raw: serde_json::Value,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum KnownWorkspacePaneContentRef {
    Pty { slot_id: String },
    File { document_id: String },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnknownWorkspacePaneContentEnvelope {
    kind: String,
    original_kind: String,
    raw: serde_json::Value,
}

impl Serialize for WorkspacePaneContentRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Pty { slot_id } => KnownWorkspacePaneContentRef::Pty {
                slot_id: slot_id.clone(),
            }
            .serialize(serializer),
            Self::File { document_id } => KnownWorkspacePaneContentRef::File {
                document_id: document_id.clone(),
            }
            .serialize(serializer),
            Self::Unknown { original_kind, raw } => UnknownWorkspacePaneContentEnvelope {
                kind: "unknown".to_string(),
                original_kind: original_kind.clone(),
                raw: raw.clone(),
            }
            .serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for WorkspacePaneContentRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let Some(kind) = value.get("kind").and_then(serde_json::Value::as_str) else {
            return Err(D::Error::custom("content reference kind must be a string"));
        };
        match kind {
            "pty" => serde_json::from_value::<KnownWorkspacePaneContentRef>(value)
                .map(|content| match content {
                    KnownWorkspacePaneContentRef::Pty { slot_id } => Self::Pty { slot_id },
                    KnownWorkspacePaneContentRef::File { .. } => unreachable!(),
                })
                .map_err(D::Error::custom),
            "file" => serde_json::from_value::<KnownWorkspacePaneContentRef>(value)
                .map(|content| match content {
                    KnownWorkspacePaneContentRef::File { document_id } => {
                        Self::File { document_id }
                    }
                    KnownWorkspacePaneContentRef::Pty { .. } => unreachable!(),
                })
                .map_err(D::Error::custom),
            "unknown" => serde_json::from_value::<UnknownWorkspacePaneContentEnvelope>(value)
                .map(|envelope| Self::Unknown {
                    original_kind: envelope.original_kind,
                    raw: envelope.raw,
                })
                .map_err(D::Error::custom),
            other => Ok(Self::Unknown {
                original_kind: other.to_string(),
                raw: value,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileDocument {
    pub id: String,
    pub directory_id: i64,
    pub directory_path: String,
    pub relative_path: String,
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
    referenced_documents: &mut HashSet<&'a str>,
    documents_by_id: &HashMap<&'a str, &'a WorkspaceFileDocument>,
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
            contents,
            active_content,
        } => {
            validate_text(id, MAX_ID_CHARS, "pane ID")?;
            if !node_ids.insert(id) {
                return invalid("pane/split ID 重复");
            }
            if *pane_number == 0 || !pane_numbers.insert(*pane_number) {
                return invalid("pane 编号无效或重复");
            }
            pane_ids.insert(id);
            if contents.len() > MAX_WORKSPACE_LAYOUT_SLOTS {
                return invalid("单个 pane 的内容数量超过限制");
            }
            let mut pane_contents = HashSet::new();
            for content in contents {
                match content {
                    WorkspacePaneContentRef::Pty { slot_id } => {
                        if !slots_by_id.contains_key(slot_id.as_str()) {
                            return invalid("pane 引用了不存在的 slot");
                        }
                        if !referenced_slots.insert(slot_id.as_str())
                            || !pane_contents.insert(("pty", slot_id.as_str()))
                        {
                            return invalid("slot 在多个 pane 或内容项中重复出现");
                        }
                    }
                    WorkspacePaneContentRef::File { document_id } => {
                        if !documents_by_id.contains_key(document_id.as_str()) {
                            return invalid("pane 引用了不存在的文件文档");
                        }
                        if !referenced_documents.insert(document_id.as_str())
                            || !pane_contents.insert(("file", document_id.as_str()))
                        {
                            return invalid("文件文档在多个 pane 或内容项中重复出现");
                        }
                    }
                    WorkspacePaneContentRef::Unknown { original_kind, raw } => {
                        validate_unknown_content_ref(original_kind, raw)?;
                    }
                }
            }
            match active_content {
                None => {}
                Some(active) if contents.contains(active) => {}
                Some(_) => return invalid("活动内容与 pane 内容列表不匹配"),
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
                referenced_documents,
                documents_by_id,
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
                referenced_documents,
                documents_by_id,
            )?;
        }
    }
    Ok(())
}

fn migrate_legacy_content_refs(layout: &mut serde_json::Value, source_version: u64) {
    if let Some(object) = layout.as_object_mut() {
        object.insert(
            "schemaVersion".to_string(),
            serde_json::Value::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
        );
        if let Some(tree) = object.get_mut("tree") {
            migrate_legacy_content_node(tree, source_version);
        }
    }
}

fn migrate_detached_slot_ids(layout: &mut serde_json::Value) {
    let Some(object) = layout.as_object_mut() else {
        return;
    };
    let legacy = object.remove("detachedSlotIds");
    let detached_contents = match legacy {
        Some(serde_json::Value::Array(slot_ids)) => slot_ids
            .into_iter()
            .map(|value| match value.as_str() {
                Some(slot_id) => serde_json::json!({ "kind": "pty", "slotId": slot_id }),
                None => value,
            })
            .collect(),
        Some(value) => value,
        None => serde_json::Value::Array(Vec::new()),
    };
    object.insert(
        "schemaVersion".to_string(),
        serde_json::Value::from(WORKSPACE_LAYOUT_SCHEMA_VERSION),
    );
    object.insert("detachedContents".to_string(), detached_contents);
}

fn migrate_legacy_content_node(node: &mut serde_json::Value, source_version: u64) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    match object.get("kind").and_then(serde_json::Value::as_str) {
        Some("pane") => {
            let session_ids = object
                .remove("sessionIds")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let document_ids = object
                .remove("documentIds")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let active_session_id = object.remove("activeSessionId");
            let legacy_active_content = object.remove("activeContent");
            let mut contents = Vec::with_capacity(session_ids.len() + document_ids.len());
            contents.extend(session_ids.iter().filter_map(|value| {
                value
                    .as_str()
                    .map(|slot_id| serde_json::json!({ "kind": "pty", "slotId": slot_id }))
            }));
            contents.extend(document_ids.iter().filter_map(|value| {
                value.as_str().map(
                    |document_id| serde_json::json!({ "kind": "file", "documentId": document_id }),
                )
            }));
            let active_content = if source_version >= 2 {
                legacy_active_content.filter(|value| !value.is_null())
            } else {
                None
            }
            .or_else(|| {
                active_session_id
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .filter(|active| {
                        session_ids
                            .iter()
                            .any(|session_id| session_id.as_str() == Some(*active))
                    })
                    .map(|slot_id| serde_json::json!({ "kind": "pty", "slotId": slot_id }))
            })
            .or_else(|| contents.first().cloned());
            object.insert("contents".to_string(), serde_json::Value::Array(contents));
            object.insert(
                "activeContent".to_string(),
                active_content.unwrap_or(serde_json::Value::Null),
            );
        }
        Some("split") => {
            if let Some(first) = object.get_mut("first") {
                migrate_legacy_content_node(first, source_version);
            }
            if let Some(second) = object.get_mut("second") {
                migrate_legacy_content_node(second, source_version);
            }
        }
        _ => {}
    }
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

fn validate_file_document(document: &WorkspaceFileDocument) -> Result<(), WorkspaceLayoutError> {
    validate_uuid(&document.id, "文件文档 ID")?;
    if document.directory_id <= 0 {
        return invalid("文件项目 ID 无效");
    }
    validate_text(
        &document.directory_path,
        MAX_DIRECTORY_PATH_CHARS,
        "文件项目路径",
    )?;
    validate_text(
        &document.relative_path,
        MAX_DIRECTORY_PATH_CHARS,
        "项目内相对路径",
    )?;
    if document.relative_path.is_empty()
        || crate::services::project_directory::ProjectDirectory::validate_relative_path(
            &document.relative_path,
        )
        .is_err()
    {
        return invalid("文件引用必须是规范的项目内相对路径");
    }
    Ok(())
}

fn validate_unknown_content_ref(
    original_kind: &str,
    raw: &serde_json::Value,
) -> Result<(), WorkspaceLayoutError> {
    validate_text(original_kind, MAX_ID_CHARS, "未知内容类型")?;
    if matches!(original_kind, "pty" | "file" | "unknown")
        || !raw.is_object()
        || raw.get("kind").and_then(serde_json::Value::as_str) != Some(original_kind)
    {
        return invalid("未知内容引用的原始数据无效");
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
                directory_id: 1,
                directory_path: "C:\\Projects\\example".to_string(),
                project_name: "example".to_string(),
                tool_key: ToolKey::Claude,
                sequence: 1,
                session_id: Some(Uuid::new_v4().to_string()),
                resume_session_id: None,
                title: WorkspaceSlotTitle::Automatic,
            }],
            documents: Vec::new(),
            detached_contents: Vec::new(),
        }
    }

    #[test]
    fn workspace_layout_round_trips_as_versioned_camel_case_json() {
        let document = valid_document();
        let json = document.to_json().expect("serialize valid layout");
        let restored = WorkspaceLayoutDocument::from_json(&json).expect("parse valid layout");

        assert_eq!(restored, document);
        assert!(json.contains("schemaVersion"));
        assert!(json.contains("contents"));
    }

    #[test]
    fn workspace_layout_rejects_unsupported_versions() {
        let mut document = valid_document();
        document.schema_version += 1;

        assert_eq!(
            document.validate(),
            Err(WorkspaceLayoutError::UnsupportedVersion(
                WORKSPACE_LAYOUT_SCHEMA_VERSION + 1
            ))
        );
    }

    #[test]
    fn workspace_layout_allows_temporarily_inactive_detached_content() {
        let mut document = valid_document();
        let WorkspaceLayoutNode::Pane { active_content, .. } = &mut document.tree else {
            panic!("expected root pane");
        };
        *active_content = None;

        document
            .validate()
            .expect("detached handoff may leave content without active focus");
    }

    #[test]
    fn workspace_layout_rejects_active_content_not_owned_by_pane() {
        let mut document = valid_document();
        let WorkspaceLayoutNode::Pane { active_content, .. } = &mut document.tree else {
            panic!("expected root pane");
        };
        *active_content = Some(WorkspacePaneContentRef::File {
            document_id: Uuid::new_v4().to_string(),
        });

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("活动内容")
        ));
    }

    #[test]
    fn workspace_layout_migrates_legacy_pty_active_content() {
        let document = valid_document();
        let mut legacy = serde_json::to_value(&document).expect("serialize base layout");
        legacy["schemaVersion"] = serde_json::json!(1);
        let pane = legacy["tree"].as_object_mut().unwrap();
        pane.remove("contents");
        pane.remove("activeContent");
        pane.insert(
            "sessionIds".into(),
            serde_json::json!([document.slots[0].instance_id]),
        );
        pane.insert(
            "activeSessionId".into(),
            serde_json::json!(document.slots[0].instance_id),
        );
        pane.insert("documentIds".into(), serde_json::json!([]));
        let json = serde_json::to_string(&legacy).expect("serialize legacy layout");
        let migrated = WorkspaceLayoutDocument::from_json(&json).expect("migrate layout");

        assert_eq!(migrated.schema_version, WORKSPACE_LAYOUT_SCHEMA_VERSION);
        assert!(matches!(
            &migrated.tree,
            WorkspaceLayoutNode::Pane {
                active_content: Some(WorkspacePaneContentRef::Pty { slot_id }),
                ..
            } if slot_id == &migrated.slots[0].instance_id
        ));
    }

    #[test]
    fn workspace_layout_migrates_v3_detached_slots_to_v5_content_refs() {
        let mut document = valid_document();
        document.tree = WorkspaceLayoutNode::Pane {
            id: "workspace-root".to_string(),
            pane_number: 1,
            contents: Vec::new(),
            active_content: None,
        };
        let slot_id = document.slots[0].instance_id.clone();
        let mut legacy = serde_json::to_value(&document).expect("serialize v3 layout");
        legacy["schemaVersion"] = serde_json::json!(3);
        legacy["detachedSlotIds"] = serde_json::json!([slot_id.clone()]);
        legacy.as_object_mut().unwrap().remove("detachedContents");
        let json = serde_json::to_string(&legacy).expect("serialize v3 layout");

        let migrated = WorkspaceLayoutDocument::from_json(&json).expect("migrate v3 layout");

        assert_eq!(migrated.schema_version, 5);
        assert_eq!(
            migrated.detached_contents,
            vec![WorkspacePaneContentRef::Pty { slot_id }]
        );
    }

    #[test]
    fn workspace_layout_migrates_v4_and_preserves_unknown_content_payloads() {
        let mut document = valid_document();
        document.schema_version = 4;
        let unknown_raw = serde_json::json!({
            "kind": "markdownPreview",
            "previewId": "preview-1",
            "content": { "source": "README.md", "enabled": true }
        });
        let mut legacy = serde_json::to_value(&document).expect("serialize v4 layout");
        legacy["schemaVersion"] = serde_json::json!(4);
        legacy["tree"]["contents"]
            .as_array_mut()
            .expect("pane contents")
            .push(unknown_raw.clone());
        let json = serde_json::to_string(&legacy).expect("encode v4 layout");

        let migrated = WorkspaceLayoutDocument::from_json(&json).expect("migrate v4 layout");
        assert_eq!(migrated.schema_version, 5);
        let WorkspaceLayoutNode::Pane { contents, .. } = &migrated.tree else {
            panic!("expected migrated root pane");
        };
        assert!(contents.contains(&WorkspacePaneContentRef::Unknown {
            original_kind: "markdownPreview".to_string(),
            raw: unknown_raw.clone(),
        }));

        let saved = migrated.to_json().expect("serialize migrated layout");
        let restored = WorkspaceLayoutDocument::from_json(&saved).expect("read saved layout");
        let WorkspaceLayoutNode::Pane { contents, .. } = restored.tree else {
            panic!("expected restored root pane");
        };
        assert!(contents.contains(&WorkspacePaneContentRef::Unknown {
            original_kind: "markdownPreview".to_string(),
            raw: unknown_raw,
        }));
    }

    #[test]
    fn workspace_layout_round_trips_a_future_content_kind_as_raw_json() {
        let document = valid_document();
        let future_content = serde_json::json!({
            "kind": "markdownPreview",
            "previewId": "preview-1",
            "content": { "source": "README.md", "enabled": true }
        });
        let mut future_layout = serde_json::to_value(&document).expect("serialize layout");
        future_layout["tree"]["contents"]
            .as_array_mut()
            .expect("pane contents")
            .push(future_content.clone());
        let future_json = serde_json::to_string(&future_layout).expect("encode future layout");

        let restored =
            WorkspaceLayoutDocument::from_json(&future_json).expect("read future content kind");
        let WorkspaceLayoutNode::Pane { contents, .. } = &restored.tree else {
            panic!("expected root pane");
        };
        assert!(contents.contains(&WorkspacePaneContentRef::Unknown {
            original_kind: "markdownPreview".to_string(),
            raw: future_content.clone(),
        }));

        let saved = restored.to_json().expect("save layout with future content");
        let restored_again =
            WorkspaceLayoutDocument::from_json(&saved).expect("read saved future content");
        let WorkspaceLayoutNode::Pane { contents, .. } = restored_again.tree else {
            panic!("expected restored root pane");
        };
        assert!(contents.contains(&WorkspacePaneContentRef::Unknown {
            original_kind: "markdownPreview".to_string(),
            raw: future_content,
        }));
    }

    #[test]
    fn workspace_layout_rejects_detached_content_also_referenced_by_tree() {
        let mut document = valid_document();
        document.detached_contents = vec![WorkspacePaneContentRef::Pty {
            slot_id: document.slots[0].instance_id.clone(),
        }];

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("同时出现在 pane")
        ));
    }

    #[test]
    fn workspace_layout_rejects_detached_file_also_referenced_by_tree() {
        let mut document = valid_document();
        let document_id = Uuid::new_v4().to_string();
        document.documents.push(WorkspaceFileDocument {
            id: document_id.clone(),
            directory_id: 1,
            directory_path: "C:\\Projects\\example".to_string(),
            relative_path: "README.md".to_string(),
        });
        let WorkspaceLayoutNode::Pane { contents, .. } = &mut document.tree else {
            panic!("expected root pane");
        };
        contents.push(WorkspacePaneContentRef::File {
            document_id: document_id.clone(),
        });
        document.detached_contents = vec![WorkspacePaneContentRef::File { document_id }];

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("同时出现在 pane")
        ));
    }

    #[test]
    fn workspace_layout_migrates_v2_mixed_content_and_preserves_active_file() {
        let mut document = valid_document();
        let document_id = Uuid::new_v4().to_string();
        document.documents.push(WorkspaceFileDocument {
            id: document_id.clone(),
            directory_id: 1,
            directory_path: "C:\\Projects\\example".to_string(),
            relative_path: "README.md".to_string(),
        });
        let mut legacy = serde_json::to_value(&document).expect("serialize base layout");
        legacy["schemaVersion"] = serde_json::json!(2);
        let pane = legacy["tree"].as_object_mut().unwrap();
        pane.remove("contents");
        pane.insert(
            "sessionIds".into(),
            serde_json::json!([document.slots[0].instance_id]),
        );
        pane.insert(
            "documentIds".into(),
            serde_json::json!([document_id.clone()]),
        );
        legacy["tree"]["activeContent"] = serde_json::json!({
            "kind": "file",
            "documentId": document_id,
        });
        let json = serde_json::to_string(&legacy).expect("serialize v2 layout");

        let migrated = WorkspaceLayoutDocument::from_json(&json).expect("migrate v2 layout");
        let WorkspaceLayoutNode::Pane {
            contents,
            active_content,
            ..
        } = migrated.tree
        else {
            panic!("expected root pane");
        };
        assert_eq!(contents.len(), 2);
        assert_eq!(
            active_content,
            Some(WorkspacePaneContentRef::File {
                document_id: migrated.documents[0].id.clone()
            })
        );
    }

    #[test]
    fn workspace_layout_rejects_file_path_traversal() {
        let mut document = valid_document();
        let file_id = Uuid::new_v4().to_string();
        document.documents.push(WorkspaceFileDocument {
            id: file_id.clone(),
            directory_id: 1,
            directory_path: "C:\\Projects\\example".to_string(),
            relative_path: "../outside.txt".to_string(),
        });
        if let WorkspaceLayoutNode::Pane { contents, .. } = &mut document.tree {
            contents.push(WorkspacePaneContentRef::File {
                document_id: file_id,
            });
        }

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("相对路径")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn workspace_layout_uses_unix_file_name_rules() {
        let mut document = valid_document();
        let file_id = Uuid::new_v4().to_string();
        document.documents.push(WorkspaceFileDocument {
            id: file_id.clone(),
            directory_id: 1,
            directory_path: "/tmp/project".to_string(),
            relative_path: r"notes:final/a\b.txt".to_string(),
        });
        if let WorkspaceLayoutNode::Pane { contents, .. } = &mut document.tree {
            contents.push(WorkspacePaneContentRef::File {
                document_id: file_id,
            });
        }

        assert!(document.validate().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn workspace_layout_rejects_windows_ads_and_reserved_file_names() {
        for relative_path in ["file:stream.txt", "CON.txt", "name."] {
            let mut document = valid_document();
            let file_id = Uuid::new_v4().to_string();
            document.documents.push(WorkspaceFileDocument {
                id: file_id.clone(),
                directory_id: 1,
                directory_path: "C:\\Projects\\example".to_string(),
                relative_path: relative_path.to_string(),
            });
            if let WorkspaceLayoutNode::Pane { contents, .. } = &mut document.tree {
                contents.push(WorkspacePaneContentRef::File {
                    document_id: file_id,
                });
            }
            assert!(document.validate().is_err(), "{relative_path}");
        }
    }

    #[test]
    fn workspace_layout_rejects_duplicate_open_file_identity() {
        let mut document = valid_document();
        let first_id = Uuid::new_v4().to_string();
        let second_id = Uuid::new_v4().to_string();
        for id in [&first_id, &second_id] {
            document.documents.push(WorkspaceFileDocument {
                id: id.clone(),
                directory_id: 1,
                directory_path: "C:\\Projects\\example".to_string(),
                relative_path: "src/main.rs".to_string(),
            });
        }
        if let WorkspaceLayoutNode::Pane { contents, .. } = &mut document.tree {
            contents.extend(
                [first_id, second_id]
                    .map(|document_id| WorkspacePaneContentRef::File { document_id }),
            );
        }

        assert!(matches!(
            document.validate(),
            Err(WorkspaceLayoutError::Invalid(message)) if message.contains("不能重复打开")
        ));
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
                contents: vec![WorkspacePaneContentRef::Pty {
                    slot_id: slot_id.clone(),
                }],
                active_content: Some(WorkspacePaneContentRef::Pty {
                    slot_id: slot_id.clone(),
                }),
            }),
            second: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-2".to_string(),
                pane_number: 2,
                contents: vec![WorkspacePaneContentRef::Pty { slot_id }],
                active_content: None,
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
        if let WorkspaceLayoutNode::Pane { contents, .. } = &mut document.tree {
            contents.push(WorkspacePaneContentRef::Pty {
                slot_id: duplicate_instance_id,
            });
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
                contents: Vec::new(),
                active_content: None,
            }),
            second: Box::new(WorkspaceLayoutNode::Pane {
                id: "pane-2".to_string(),
                pane_number: 2,
                contents: Vec::new(),
                active_content: None,
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
            contents: Vec::new(),
            active_content: None,
        };
        document.detached_contents = vec![WorkspacePaneContentRef::Pty { slot_id }];
        document.validate().expect("detached slot is still managed");

        document
            .detached_contents
            .push(WorkspacePaneContentRef::Pty {
                slot_id: document.slots[0].instance_id.clone(),
            });
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
            contents: Vec::new(),
            active_content: None,
        };
        document.detached_contents = vec![WorkspacePaneContentRef::Pty { slot_id }];

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
                    contents: Vec::new(),
                    active_content: None,
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
                    contents: Vec::new(),
                    active_content: None,
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
                    contents: Vec::new(),
                    active_content: None,
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
