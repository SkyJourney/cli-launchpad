//! IPC DTO 的确定性样本、camelCase 键校验与 golden fixture 渲染。
//!
//! Rust 侧生成 `contracts/fixtures/*.json`，前端测试只从该目录导入。样本不得使用随机值、
//! 系统时间或 `Uuid::new_v4()`，否则 fixture 会逐次变化。

use crate::error_codes::ErrorCode;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Map, Value};

use crate::error::AppError;
use crate::models::app_setting::CloseBehavior;
use crate::models::backup::{BackupManifest, BackupReason};
use crate::models::cache::CacheStats;
use crate::models::cli_status::{CliAvailability, CliStatus};
use crate::models::directory::Directory;
use crate::models::execution::{
    ExecutionLogChunk, ExecutionStatus, ExecutionStream, ExecutionTask, ExecutionTaskDetail,
};
use crate::models::install::{
    InstallKind, InstallPlan, LatestVersion, ManagedUpdateStatus, UpdateAvailability,
};
use crate::models::launch_history::{LaunchAction, LaunchHistoryEntry};
use crate::models::pty_session::{
    PtyEvent, PtyHandoff, PtySession, PtySessionWindowStatus, PtySessionWindowStatusReport,
};
use crate::models::session::{
    SessionInfo, SessionPage, SessionSearchIndexRefresh, SessionSearchResults,
};
use crate::models::tool::ToolKey;
use crate::models::window_kind::WindowKind;
use crate::models::workspace_layout::{
    WorkspaceFileDocument, WorkspaceLayoutApplyPlan, WorkspaceLayoutDocument, WorkspaceLayoutNode,
    WorkspaceLayoutPresetSummary, WorkspaceLayoutSaveRejection, WorkspaceLayoutSaveResult,
    WorkspaceLayoutSlot, WorkspaceLayoutStateRead, WorkspaceLayoutStateStatus,
    WorkspacePaneContentRef, WorkspaceSlotState, WorkspaceSlotStateKind, WorkspaceSlotTitle,
    WorkspaceSplitDirection,
};
use crate::platform::case_sensitivity::{CaseSensitivity, PathSemantics, Tri};
use crate::services::file_service::{
    FileIdentityComparison, ProjectDirectoryListing, ProjectFileCasResidue,
    ProjectFileCasResidueListing, ProjectFileEntry, ProjectFileKind, ProjectFileOpenResult,
    ProjectFileUnsupportedReason, ProjectTextFileSaveResult, ProjectTextFileSaveWarning,
};
use crate::services::startup_notices::{StartupNotice, StartupNoticeKind};
use crate::services::window_inbox::{InboxMessage, InboxSource, WindowInboxSubscription};
use crate::services::window_lifecycle::AppEvent;
use crate::services::window_relay::SendWindowMessageResult;

pub(crate) struct DtoSamples {
    pub fixture_file: Option<&'static str>,
    pub type_name: &'static str,
    pub cases: Vec<(String, Value)>,
}

/// 递归遍历对象键：任何键含 `_` 或以大写字母开头即 panic，信息含完整 JSON 路径
/// （形如 `Type.case.field.child`）。`path` 等于 `allow` 中某项或以“某项 + '.'”开头时，
/// 不再向下检查（用于透传的不透明载荷）。
pub(crate) fn assert_camel_case_keys(value: &Value, path: &str, allow: &[&str]) {
    if allow
        .iter()
        .any(|item| path == *item || path.starts_with(&format!("{item}.")))
    {
        return;
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                assert!(
                    !key.contains('_') && !key.starts_with(|c: char| c.is_ascii_uppercase()),
                    "non camelCase key `{key}` at {path}"
                );
                assert_camel_case_keys(child, &format!("{path}.{key}"), allow);
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                assert_camel_case_keys(child, &format!("{path}[{index}]"), allow);
            }
        }
        _ => {}
    }
}

/// 返回 `{"schema":1,"type":name,"cases":[{"name":…,"value":…}, …]}`，cases 顺序保持。
pub(crate) fn golden_fixture(name: &str, cases: Vec<(&str, Value)>) -> Value {
    json!({
        "schema": 1,
        "type": name,
        "cases": cases
            .into_iter()
            .map(|(case, value)| json!({"name": case, "value": value}))
            .collect::<Vec<_>>(),
    })
}

/// 递归把所有对象的键按字典序重建后用两空格缩进输出，末尾追加单个 `\n`。
/// 不依赖 `serde_json` 的默认 map 顺序（依赖图里可能开启 `preserve_order`）。
pub(crate) fn render_fixture(fixture: &Value) -> String {
    let mut text = serde_json::to_string_pretty(&sort_keys(fixture)).expect("render fixture");
    text.push('\n');
    text
}

fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), sort_keys(&object[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

/// 序列化样本，并断言反序列化往返一致。
fn sample<T: Serialize + DeserializeOwned>(
    cases: &mut Vec<(String, Value)>,
    type_name: &str,
    name: &str,
    value: T,
) {
    let json = serde_json::to_value(&value)
        .unwrap_or_else(|error| panic!("serialize {type_name}.{name}: {error}"));
    let back: T = serde_json::from_value(json.clone())
        .unwrap_or_else(|error| panic!("deserialize {type_name}.{name}: {error}"));
    let again = serde_json::to_value(&back)
        .unwrap_or_else(|error| panic!("re-serialize {type_name}.{name}: {error}"));
    assert_eq!(again, json, "{type_name}.{name} does not round trip");
    cases.push((name.to_string(), json));
}

/// 没有 `Deserialize` 的类型（例如 `AppError`）：只序列化，不做往返。
fn sample_serialize_only<T: Serialize>(
    cases: &mut Vec<(String, Value)>,
    type_name: &str,
    name: &str,
    value: T,
) {
    let json = serde_json::to_value(&value)
        .unwrap_or_else(|error| panic!("serialize {type_name}.{name}: {error}"));
    cases.push((name.to_string(), json));
}

/// Registers a sample whose value is already a JSON value (for example an event
/// payload built by its production constructor). No round trip is possible.
pub(crate) fn sample_value(cases: &mut Vec<(String, Value)>, name: &str, value: Value) {
    cases.push((name.to_string(), value));
}

const SLOT_ID: &str = "11111111-2222-4333-8444-555555555551";
const SESSION_ID: &str = "11111111-2222-4333-8444-555555555552";
const DOCUMENT_ID: &str = "11111111-2222-4333-8444-555555555553";
const PROJECT_PATH: &str = "C:\\Projects\\sample";
const TIMESTAMP_MS: i64 = 1_700_000_000_000;

fn sample_layout() -> WorkspaceLayoutDocument {
    let document = WorkspaceLayoutDocument {
        schema_version: 5,
        tree: WorkspaceLayoutNode::Pane {
            id: "pane-1".to_string(),
            pane_number: 1,
            contents: vec![
                WorkspacePaneContentRef::Pty {
                    slot_id: SLOT_ID.to_string(),
                },
                WorkspacePaneContentRef::File {
                    document_id: DOCUMENT_ID.to_string(),
                },
            ],
            active_content: Some(WorkspacePaneContentRef::Pty {
                slot_id: SLOT_ID.to_string(),
            }),
        },
        focused_pane_id: "pane-1".to_string(),
        slots: vec![WorkspaceLayoutSlot {
            instance_id: SLOT_ID.to_string(),
            directory_id: 42,
            directory_path: PROJECT_PATH.to_string(),
            project_name: "sample".to_string(),
            tool_key: ToolKey::Codex,
            sequence: 1,
            session_id: Some(SESSION_ID.to_string()),
            resume_session_id: Some("resume-1".to_string()),
            title: WorkspaceSlotTitle::Custom("Review".to_string()),
        }],
        documents: vec![WorkspaceFileDocument {
            id: DOCUMENT_ID.to_string(),
            directory_id: 42,
            directory_path: PROJECT_PATH.to_string(),
            relative_path: "src/main.rs".to_string(),
        }],
        detached_contents: Vec::new(),
    };
    document
        .validate()
        .expect("the sample workspace layout must be a valid document");
    document
}

fn sample_slot_states() -> Vec<WorkspaceSlotState> {
    vec![WorkspaceSlotState {
        instance_id: SLOT_ID.to_string(),
        state: WorkspaceSlotStateKind::Running,
        current_project_name: Some("sample".to_string()),
    }]
}

pub(crate) fn ipc_dto_samples() -> Vec<DtoSamples> {
    let mut all = Vec::new();

    // ProjectFileOpenResult
    let mut cases = Vec::new();
    let name = "ProjectFileOpenResult";
    sample(
        &mut cases,
        name,
        "text",
        ProjectFileOpenResult::Text {
            content: "hello".to_string(),
            revision: "r1".to_string(),
        },
    );
    sample(
        &mut cases,
        name,
        "image",
        ProjectFileOpenResult::Image {
            mime_type: "image/png".to_string(),
            base64_data: "cG5n".to_string(),
        },
    );
    for (case, reason) in [
        ("unsupportedBinary", ProjectFileUnsupportedReason::Binary),
        (
            "unsupportedTooLarge",
            ProjectFileUnsupportedReason::TooLarge,
        ),
        (
            "unsupportedInvalidImage",
            ProjectFileUnsupportedReason::InvalidImage,
        ),
        (
            "unsupportedUnsupportedImage",
            ProjectFileUnsupportedReason::UnsupportedImage,
        ),
    ] {
        sample(
            &mut cases,
            name,
            case,
            ProjectFileOpenResult::Unsupported { reason },
        );
    }
    all.push(DtoSamples {
        fixture_file: Some("project-file-open-result.json"),
        type_name: name,
        cases,
    });

    // ProjectTextFileSaveResult
    let mut cases = Vec::new();
    let name = "ProjectTextFileSaveResult";
    sample(
        &mut cases,
        name,
        "savedWithWarning",
        ProjectTextFileSaveResult::Saved {
            content: "saved".to_string(),
            revision: "r2".to_string(),
            warning: Some(ProjectTextFileSaveWarning::PermissionsNotRestored),
        },
    );
    sample(
        &mut cases,
        name,
        "savedWithoutWarning",
        ProjectTextFileSaveResult::Saved {
            content: "saved".to_string(),
            revision: "r2".to_string(),
            warning: None,
        },
    );
    sample(
        &mut cases,
        name,
        "conflict",
        ProjectTextFileSaveResult::Conflict,
    );
    all.push(DtoSamples {
        fixture_file: Some("project-text-file-save-result.json"),
        type_name: name,
        cases,
    });

    // ProjectFileUnsupportedReason
    let mut cases = Vec::new();
    let name = "ProjectFileUnsupportedReason";
    for (case, reason) in [
        ("binary", ProjectFileUnsupportedReason::Binary),
        ("tooLarge", ProjectFileUnsupportedReason::TooLarge),
        ("invalidImage", ProjectFileUnsupportedReason::InvalidImage),
        (
            "unsupportedImage",
            ProjectFileUnsupportedReason::UnsupportedImage,
        ),
    ] {
        sample(&mut cases, name, case, reason);
    }
    all.push(DtoSamples {
        fixture_file: None,
        type_name: name,
        cases,
    });

    // ProjectDirectoryListing（含 ProjectFileEntry）
    let mut cases = Vec::new();
    let name = "ProjectDirectoryListing";
    sample(
        &mut cases,
        name,
        "withEntries",
        ProjectDirectoryListing {
            entries: vec![
                ProjectFileEntry {
                    name: "main.rs".to_string(),
                    relative_path: "src/main.rs".to_string(),
                    kind: ProjectFileKind::File,
                    size: 128,
                    hidden: false,
                    ignored: true,
                    symbolic_link: false,
                },
                ProjectFileEntry {
                    name: "src".to_string(),
                    relative_path: "src".to_string(),
                    kind: ProjectFileKind::Directory,
                    size: 0,
                    hidden: true,
                    ignored: false,
                    symbolic_link: true,
                },
                ProjectFileEntry {
                    name: "fifo".to_string(),
                    relative_path: "fifo".to_string(),
                    kind: ProjectFileKind::Other,
                    size: 0,
                    hidden: false,
                    ignored: false,
                    symbolic_link: false,
                },
            ],
            truncated: true,
            skipped_count: 3,
            path_semantics: PathSemantics {
                case: CaseSensitivity::Insensitive,
                normalization_insensitive: Tri::Yes,
            },
        },
    );
    sample(
        &mut cases,
        name,
        "empty",
        ProjectDirectoryListing {
            entries: Vec::new(),
            truncated: false,
            skipped_count: 0,
            path_semantics: PathSemantics::UNKNOWN,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("project-directory-listing.json"),
        type_name: name,
        cases,
    });

    // PathSemantics（get_project_path_semantics 的返回值，列目录结果里也带一份）
    let mut cases = Vec::new();
    let name = "PathSemantics";
    for (case, case_axis, normalization) in [
        ("sensitiveNo", CaseSensitivity::Sensitive, Tri::No),
        ("insensitiveYes", CaseSensitivity::Insensitive, Tri::Yes),
        ("unknown", CaseSensitivity::Unknown, Tri::Unknown),
    ] {
        sample(
            &mut cases,
            name,
            case,
            PathSemantics {
                case: case_axis,
                normalization_insensitive: normalization,
            },
        );
    }
    all.push(DtoSamples {
        fixture_file: Some("path-semantics.json"),
        type_name: name,
        cases,
    });

    // FileIdentityComparison（check_project_files_same_identity 的返回值）
    let mut cases = Vec::new();
    let name = "FileIdentityComparison";
    for (case, comparison) in [
        ("same", FileIdentityComparison::Same),
        ("different", FileIdentityComparison::Different),
        ("unavailable", FileIdentityComparison::Unavailable),
    ] {
        sample(&mut cases, name, case, comparison);
    }
    all.push(DtoSamples {
        fixture_file: Some("file-identity-comparison.json"),
        type_name: name,
        cases,
    });

    // ManagedUpdateStatus
    let mut cases = Vec::new();
    let name = "ManagedUpdateStatus";
    sample(&mut cases, name, "allowed", ManagedUpdateStatus::Allowed);
    sample(
        &mut cases,
        name,
        "denied",
        ManagedUpdateStatus::Denied {
            reason_key: "settings.grokUpdateSourceDenied".to_string(),
        },
    );
    sample(
        &mut cases,
        name,
        "notApplicable",
        ManagedUpdateStatus::NotApplicable,
    );
    all.push(DtoSamples {
        fixture_file: Some("managed-update-status.json"),
        type_name: name,
        cases,
    });

    // PtyEvent
    let mut cases = Vec::new();
    let name = "PtyEvent";
    sample(
        &mut cases,
        name,
        "output",
        PtyEvent::Output {
            session_id: SESSION_ID.to_string(),
            sequence: 1,
            data_base64: "aGk=".to_string(),
        },
    );
    sample(
        &mut cases,
        name,
        "snapshot",
        PtyEvent::Snapshot {
            session_id: SESSION_ID.to_string(),
            sequence: 2,
            data: "hi".to_string(),
            cols: 120,
            rows: 30,
        },
    );
    sample(
        &mut cases,
        name,
        "exitedWithCode",
        PtyEvent::Exited {
            session_id: SESSION_ID.to_string(),
            state: "exited".to_string(),
            exit_code: Some(0),
        },
    );
    sample(
        &mut cases,
        name,
        "exitedWithoutCode",
        PtyEvent::Exited {
            session_id: SESSION_ID.to_string(),
            state: "terminated".to_string(),
            exit_code: None,
        },
    );
    sample(
        &mut cases,
        name,
        "failed",
        PtyEvent::Failed {
            session_id: SESSION_ID.to_string(),
            message: "spawn failed".to_string(),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("pty-event.json"),
        type_name: name,
        cases,
    });

    // PtySession
    let mut cases = Vec::new();
    let name = "PtySession";
    sample(
        &mut cases,
        name,
        "runningMinimal",
        PtySession {
            session_id: SESSION_ID.to_string(),
            directory_id: 42,
            tool_key: ToolKey::Claude,
            working_directory: PROJECT_PATH.to_string(),
            state: "running".to_string(),
            started_at_ms: TIMESTAMP_MS,
            ended_at_ms: None,
            exit_code: None,
        },
    );
    sample(
        &mut cases,
        name,
        "endedFull",
        PtySession {
            session_id: SESSION_ID.to_string(),
            directory_id: 42,
            tool_key: ToolKey::Claude,
            working_directory: PROJECT_PATH.to_string(),
            state: "exited".to_string(),
            started_at_ms: TIMESTAMP_MS,
            ended_at_ms: Some(TIMESTAMP_MS + 1_000),
            exit_code: Some(0),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("pty-session.json"),
        type_name: name,
        cases,
    });

    // PtyHandoff
    let mut cases = Vec::new();
    let name = "PtyHandoff";
    sample(
        &mut cases,
        name,
        "handoff",
        PtyHandoff {
            token: "token-1".to_string(),
            sequence: 7,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("pty-handoff.json"),
        type_name: name,
        cases,
    });

    // PtySessionWindowStatusReport：get_pty_session_window_status 的返回值（m6-025 起带所有者标签）。
    // 只有 Serialize，没有 Deserialize，所以用 sample_serialize_only。
    let mut cases = Vec::new();
    let name = "PtySessionWindowStatusReport";
    sample_serialize_only(
        &mut cases,
        name,
        "running",
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::Running,
            owner_window_label: Some("main".to_string()),
        },
    );
    sample_serialize_only(
        &mut cases,
        name,
        "ended",
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::Ended,
            owner_window_label: None,
        },
    );
    sample_serialize_only(
        &mut cases,
        name,
        "ownedByAnotherWindow",
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::OwnedByAnotherWindow,
            owner_window_label: Some("terminal-11111111-1111-4111-8111-111111111111".to_string()),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("pty-session-window-status.json"),
        type_name: name,
        cases,
    });

    // WorkspaceLayoutStateRead
    let mut cases = Vec::new();
    let name = "WorkspaceLayoutStateRead";
    sample(
        &mut cases,
        name,
        "missing",
        WorkspaceLayoutStateRead {
            status: WorkspaceLayoutStateStatus::Missing,
            revision: None,
            schema_version: None,
            updated_at_ms: None,
            layout: None,
            slot_states: Vec::new(),
        },
    );
    sample(
        &mut cases,
        name,
        "readyFull",
        WorkspaceLayoutStateRead {
            status: WorkspaceLayoutStateStatus::Ready,
            revision: Some(3),
            schema_version: Some(5),
            updated_at_ms: Some(TIMESTAMP_MS),
            layout: Some(sample_layout()),
            slot_states: sample_slot_states(),
        },
    );
    sample(
        &mut cases,
        name,
        "needsReset",
        WorkspaceLayoutStateRead {
            status: WorkspaceLayoutStateStatus::NeedsReset("bad".to_string()),
            revision: Some(4),
            schema_version: Some(99),
            updated_at_ms: Some(TIMESTAMP_MS),
            layout: None,
            slot_states: Vec::new(),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("workspace-layout-state-read.json"),
        type_name: name,
        cases,
    });

    // WorkspaceLayoutSaveResult
    let mut cases = Vec::new();
    let name = "WorkspaceLayoutSaveResult";
    sample(
        &mut cases,
        name,
        "saved",
        WorkspaceLayoutSaveResult {
            saved: true,
            revision: 4,
            reason: None,
        },
    );
    sample(
        &mut cases,
        name,
        "stale",
        WorkspaceLayoutSaveResult {
            saved: false,
            revision: 7,
            reason: Some(WorkspaceLayoutSaveRejection::Stale),
        },
    );
    sample(
        &mut cases,
        name,
        "incompatible",
        WorkspaceLayoutSaveResult {
            saved: false,
            revision: 3,
            reason: Some(WorkspaceLayoutSaveRejection::Incompatible),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("workspace-layout-save-result.json"),
        type_name: name,
        cases,
    });

    // WorkspaceLayoutApplyPlan
    let mut cases = Vec::new();
    let name = "WorkspaceLayoutApplyPlan";
    sample(
        &mut cases,
        name,
        "plan",
        WorkspaceLayoutApplyPlan {
            layout: sample_layout(),
            slot_states: sample_slot_states(),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("workspace-layout-apply-plan.json"),
        type_name: name,
        cases,
    });

    // WorkspacePaneContentRef
    let mut cases = Vec::new();
    let name = "WorkspacePaneContentRef";
    sample(
        &mut cases,
        name,
        "pty",
        WorkspacePaneContentRef::Pty {
            slot_id: SLOT_ID.to_string(),
        },
    );
    sample(
        &mut cases,
        name,
        "file",
        WorkspacePaneContentRef::File {
            document_id: DOCUMENT_ID.to_string(),
        },
    );
    sample(
        &mut cases,
        name,
        "unknown",
        WorkspacePaneContentRef::Unknown {
            original_kind: "markdownPreview".to_string(),
            raw: json!({"kind": "markdownPreview", "previewId": "preview-1"}),
        },
    );
    all.push(DtoSamples {
        fixture_file: None,
        type_name: name,
        cases,
    });

    // ExecutionTask
    let mut cases = Vec::new();
    let name = "ExecutionTask";
    sample(
        &mut cases,
        name,
        "runningMinimal",
        ExecutionTask {
            id: "task-1".to_string(),
            tool_key: ToolKey::Claude,
            kind: InstallKind::Update,
            source: "Claude Code built-in update command".to_string(),
            preview: "claude update".to_string(),
            status: ExecutionStatus::Running,
            started_at_ms: TIMESTAMP_MS,
            finished_at_ms: None,
            exit_code: None,
            error_message: None,
            log_truncated: false,
        },
    );
    sample(
        &mut cases,
        name,
        "failedFull",
        ExecutionTask {
            id: "task-2".to_string(),
            tool_key: ToolKey::Codex,
            kind: InstallKind::Install,
            source: "Codex installer".to_string(),
            preview: "codex install".to_string(),
            status: ExecutionStatus::Failed,
            started_at_ms: TIMESTAMP_MS,
            finished_at_ms: Some(TIMESTAMP_MS + 2_000),
            exit_code: Some(1),
            error_message: Some("exit status 1".to_string()),
            log_truncated: true,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("execution-task.json"),
        type_name: name,
        cases,
    });

    // ExecutionLogChunk
    let mut cases = Vec::new();
    let name = "ExecutionLogChunk";
    sample(
        &mut cases,
        name,
        "chunk",
        ExecutionLogChunk {
            task_id: "task-1".to_string(),
            sequence: 1,
            stream: ExecutionStream::Stdout,
            content: "downloading".to_string(),
            created_at_ms: TIMESTAMP_MS,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("execution-log-chunk.json"),
        type_name: name,
        cases,
    });

    // InstallPlan
    let mut cases = Vec::new();
    let name = "InstallPlan";
    let mut plan = InstallPlan {
        tool_key: ToolKey::Grok,
        kind: InstallKind::Install,
        program: "C:\\tools\\installer.exe".to_string(),
        args: vec!["--stable".to_string()],
        fingerprint: String::new(),
        source: "official installer".to_string(),
        preview: "C:\\tools\\installer.exe --stable".to_string(),
    };
    plan.refresh_fingerprint();
    sample(&mut cases, name, "install", plan);
    all.push(DtoSamples {
        fixture_file: Some("install-plan.json"),
        type_name: name,
        cases,
    });

    // LatestVersion
    let mut cases = Vec::new();
    let name = "LatestVersion";
    sample(
        &mut cases,
        name,
        "latestFull",
        LatestVersion {
            tool_key: ToolKey::Grok,
            latest: Some("1.2.3".to_string()),
            update_availability: UpdateAvailability::Available,
            commits_behind: Some(2),
            error: Some("network unavailable".to_string()),
            from_cache: true,
            managed_update: ManagedUpdateStatus::Denied {
                reason_key: "settings.grokUpdateSourceDenied".to_string(),
            },
        },
    );
    sample(
        &mut cases,
        name,
        "latestMinimal",
        LatestVersion {
            tool_key: ToolKey::Claude,
            latest: None,
            update_availability: UpdateAvailability::Unknown,
            commits_behind: None,
            error: None,
            from_cache: false,
            managed_update: ManagedUpdateStatus::NotApplicable,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("latest-version.json"),
        type_name: name,
        cases,
    });

    // CliStatus
    let mut cases = Vec::new();
    let name = "CliStatus";
    sample(
        &mut cases,
        name,
        "availableFull",
        CliStatus {
            tool_key: ToolKey::Antigravity,
            status: CliAvailability::Available,
            path: Some("C:\\tools\\agy.exe".to_string()),
            resolved_command: Some("agy".to_string()),
            version: Some("0.9.1".to_string()),
            version_error: Some("version probe failed".to_string()),
            latest_version: Some("0.9.2".to_string()),
        },
    );
    sample(
        &mut cases,
        name,
        "missingMinimal",
        CliStatus {
            tool_key: ToolKey::Hermes,
            status: CliAvailability::Missing,
            path: None,
            resolved_command: None,
            version: None,
            version_error: None,
            latest_version: None,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("cli-status.json"),
        type_name: name,
        cases,
    });

    // AppError（只序列化）
    let mut cases = Vec::new();
    let name = "AppError";
    sample_serialize_only(
        &mut cases,
        name,
        "withoutParams",
        AppError::coded(ErrorCode::ProjectNotFound, "file not found"),
    );
    sample_serialize_only(
        &mut cases,
        name,
        "withParams",
        AppError::coded_with_params(
            ErrorCode::FileTooLarge,
            "file too large",
            json!({"count": 1}),
        ),
    );
    all.push(DtoSamples {
        fixture_file: Some("app-error.json"),
        type_name: name,
        cases,
    });

    // BackupManifest
    let mut cases = Vec::new();
    let name = "BackupManifest";
    sample(
        &mut cases,
        name,
        "manifest",
        BackupManifest {
            id: "backup-1".to_string(),
            created_at_ms: TIMESTAMP_MS,
            reason: BackupReason::PreImport,
            schema_version: 14,
            database_filename: "cli-launchpad.db".to_string(),
            size_bytes: 4096,
        },
    );
    for (case, reason) in [
        ("manual", BackupReason::Manual),
        ("preImport", BackupReason::PreImport),
        ("preRestore", BackupReason::PreRestore),
        ("preMigration", BackupReason::PreMigration),
        ("preCaseMerge", BackupReason::PreCaseMerge),
    ] {
        sample(
            &mut cases,
            name,
            case,
            BackupManifest {
                id: format!("backup-{case}"),
                created_at_ms: TIMESTAMP_MS,
                reason,
                schema_version: 14,
                database_filename: "cli-launchpad.db".to_string(),
                size_bytes: 4096,
            },
        );
    }
    all.push(DtoSamples {
        fixture_file: Some("backup-manifest.json"),
        type_name: name,
        cases,
    });

    // CacheStats
    let mut cases = Vec::new();
    let name = "CacheStats";
    sample(
        &mut cases,
        name,
        "stats",
        CacheStats {
            size_bytes: 2048,
            entry_count: 5,
            session_entry_count: 2,
            newest_entry_at_ms: Some(TIMESTAMP_MS),
        },
    );
    sample(
        &mut cases,
        name,
        "statsEmpty",
        CacheStats {
            size_bytes: 0,
            entry_count: 0,
            session_entry_count: 0,
            newest_entry_at_ms: None,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("cache-stats.json"),
        type_name: name,
        cases,
    });

    // WorkspaceLayoutNode（Pane 与 Split 两种变体）
    let mut cases = Vec::new();
    let name = "WorkspaceLayoutNode";
    let pane = |id: &str, pane_number: u32| WorkspaceLayoutNode::Pane {
        id: id.to_string(),
        pane_number,
        contents: vec![WorkspacePaneContentRef::Pty {
            slot_id: SLOT_ID.to_string(),
        }],
        active_content: None,
    };
    sample(&mut cases, name, "pane", pane("pane-1", 1));
    sample(
        &mut cases,
        name,
        "split",
        WorkspaceLayoutNode::Split {
            id: "split-1".to_string(),
            direction: WorkspaceSplitDirection::Horizontal,
            ratio: 0.5,
            first: Box::new(pane("pane-1", 1)),
            second: Box::new(pane("pane-2", 2)),
        },
    );
    all.push(DtoSamples {
        fixture_file: None,
        type_name: name,
        cases,
    });

    // WorkspaceSlotTitle
    let mut cases = Vec::new();
    let name = "WorkspaceSlotTitle";
    sample(&mut cases, name, "automatic", WorkspaceSlotTitle::Automatic);
    sample(
        &mut cases,
        name,
        "custom",
        WorkspaceSlotTitle::Custom("Review".to_string()),
    );
    all.push(DtoSamples {
        fixture_file: None,
        type_name: name,
        cases,
    });

    // ExitRequestedPayload (m6-044): fixed request ids, never a random one.
    let mut cases = Vec::new();
    let name = "ExitRequestedPayload";
    sample(
        &mut cases,
        name,
        "pending-work",
        crate::services::app_lifecycle::exit_requested_payload(
            &crate::services::app_lifecycle::ExitRequest {
                id: "req-1".to_string(),
            },
            2,
            3,
        ),
    );
    sample(
        &mut cases,
        name,
        "idle",
        crate::services::app_lifecycle::exit_requested_payload(
            &crate::services::app_lifecycle::ExitRequest {
                id: "req-2".to_string(),
            },
            0,
            0,
        ),
    );
    all.push(DtoSamples {
        fixture_file: Some("exit-requested-payload.json"),
        type_name: name,
        cases,
    });

    // Directory (m6-071)
    let mut cases = Vec::new();
    let name = "Directory";
    sample(
        &mut cases,
        name,
        "pinnedWithNote",
        Directory {
            id: 1,
            name: "sample".to_string(),
            path: PROJECT_PATH.to_string(),
            sort_order: 3,
            pinned: true,
            last_used_at: Some("2023-11-14T22:13:20Z".to_string()),
            note: Some("main project".to_string()),
        },
    );
    sample(
        &mut cases,
        name,
        "plain",
        Directory {
            id: 2,
            name: "other".to_string(),
            path: "C:\\Projects\\other".to_string(),
            sort_order: 4,
            pinned: false,
            last_used_at: None,
            note: None,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("directory.json"),
        type_name: name,
        cases,
    });

    // WorkspaceLayoutPresetSummary (m6-071)
    let mut cases = Vec::new();
    let name = "WorkspaceLayoutPresetSummary";
    sample(
        &mut cases,
        name,
        "summary",
        WorkspaceLayoutPresetSummary {
            id: "preset-1".to_string(),
            name: "Review".to_string(),
            schema_version: 5,
            created_at_ms: TIMESTAMP_MS,
            updated_at_ms: TIMESTAMP_MS + 1_000,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("workspace-layout-preset-summary.json"),
        type_name: name,
        cases,
    });

    // LaunchHistoryEntry (m6-071)
    let mut cases = Vec::new();
    let name = "LaunchHistoryEntry";
    sample(
        &mut cases,
        name,
        "successWithSession",
        LaunchHistoryEntry {
            id: 1,
            directory_name: "sample".to_string(),
            directory_path: PROJECT_PATH.to_string(),
            tool_key: ToolKey::Claude,
            action: LaunchAction::Launch,
            success: true,
            error_category: None,
            launched_at: "2023-11-14T22:13:20Z".to_string(),
            pty_session_id: Some(SESSION_ID.to_string()),
        },
    );
    sample(
        &mut cases,
        name,
        "failureWithoutSession",
        LaunchHistoryEntry {
            id: 2,
            directory_name: "sample".to_string(),
            directory_path: PROJECT_PATH.to_string(),
            tool_key: ToolKey::Codex,
            action: LaunchAction::Resume,
            success: false,
            error_category: Some("spawn_failed".to_string()),
            launched_at: "2023-11-14T22:14:20Z".to_string(),
            pty_session_id: None,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("launch-history-entry.json"),
        type_name: name,
        cases,
    });

    // ProjectFileCasResidueListing (m6-071)
    let mut cases = Vec::new();
    let name = "ProjectFileCasResidueListing";
    sample(
        &mut cases,
        name,
        "withEntries",
        ProjectFileCasResidueListing {
            entries: vec![ProjectFileCasResidue {
                relative_path: "src/.main.rs.cas-1".to_string(),
                size_bytes: 12,
                modified_at_ms: 1_700_000_000_000,
                file_identity: "file-id-1".to_string(),
            }],
            truncated: true,
            skipped_count: 2,
        },
    );
    sample(
        &mut cases,
        name,
        "empty",
        ProjectFileCasResidueListing {
            entries: Vec::new(),
            truncated: false,
            skipped_count: 0,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("project-file-cas-residue-listing.json"),
        type_name: name,
        cases,
    });

    // SessionPage (m6-071)
    let mut cases = Vec::new();
    let name = "SessionPage";
    sample(
        &mut cases,
        name,
        "withItems",
        SessionPage {
            items: vec![
                SessionInfo {
                    tool_key: ToolKey::Claude,
                    session_id: SESSION_ID.to_string(),
                    title: "Fix the build".to_string(),
                    alias: Some("build".to_string()),
                    last_active_ms: Some(TIMESTAMP_MS),
                },
                SessionInfo {
                    tool_key: ToolKey::Codex,
                    session_id: "session-2".to_string(),
                    title: "Review".to_string(),
                    alias: None,
                    last_active_ms: None,
                },
            ],
            next_cursor: Some("cursor-2".to_string()),
        },
    );
    sample(
        &mut cases,
        name,
        "lastPage",
        SessionPage {
            items: Vec::new(),
            next_cursor: None,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("session-page.json"),
        type_name: name,
        cases,
    });

    // SessionSearchIndexRefresh (m6-071)
    let mut cases = Vec::new();
    let name = "SessionSearchIndexRefresh";
    sample(
        &mut cases,
        name,
        "partial",
        SessionSearchIndexRefresh {
            incomplete_tools: vec![ToolKey::Codex],
            indexed_sessions: 3,
        },
    );
    sample(
        &mut cases,
        name,
        "complete",
        SessionSearchIndexRefresh {
            incomplete_tools: Vec::new(),
            indexed_sessions: 0,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("session-search-index-refresh.json"),
        type_name: name,
        cases,
    });

    // SessionSearchResults (m6-071)
    let mut cases = Vec::new();
    let name = "SessionSearchResults";
    sample(
        &mut cases,
        name,
        "withIncompleteTools",
        SessionSearchResults {
            items: vec![SessionInfo {
                tool_key: ToolKey::Grok,
                session_id: "session-3".to_string(),
                title: "Search hit".to_string(),
                alias: None,
                last_active_ms: Some(TIMESTAMP_MS),
            }],
            incomplete_tools: vec![ToolKey::Hermes],
        },
    );
    sample(
        &mut cases,
        name,
        "empty",
        SessionSearchResults {
            items: Vec::new(),
            incomplete_tools: Vec::new(),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("session-search-results.json"),
        type_name: name,
        cases,
    });

    // ExecutionTaskDetail (m6-071)
    let mut cases = Vec::new();
    let name = "ExecutionTaskDetail";
    sample(
        &mut cases,
        name,
        "withLogs",
        ExecutionTaskDetail {
            task: ExecutionTask {
                id: "task-2".to_string(),
                tool_key: ToolKey::Codex,
                kind: InstallKind::Install,
                source: "Codex installer".to_string(),
                preview: "codex install".to_string(),
                status: ExecutionStatus::Failed,
                started_at_ms: TIMESTAMP_MS,
                finished_at_ms: Some(TIMESTAMP_MS + 2_000),
                exit_code: Some(1),
                error_message: Some("exit status 1".to_string()),
                log_truncated: true,
            },
            logs: vec![
                ExecutionLogChunk {
                    task_id: "task-2".to_string(),
                    sequence: 1,
                    stream: ExecutionStream::Stdout,
                    content: "downloading".to_string(),
                    created_at_ms: TIMESTAMP_MS,
                },
                ExecutionLogChunk {
                    task_id: "task-2".to_string(),
                    sequence: 2,
                    stream: ExecutionStream::System,
                    content: "exit status 1".to_string(),
                    created_at_ms: TIMESTAMP_MS + 2_000,
                },
            ],
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("execution-task-detail.json"),
        type_name: name,
        cases,
    });

    // CloseBehavior (m6-071): one case per variant.
    let mut cases = Vec::new();
    let name = "CloseBehavior";
    sample(
        &mut cases,
        name,
        "minimizeToTray",
        CloseBehavior::MinimizeToTray,
    );
    sample(&mut cases, name, "quit", CloseBehavior::Quit);
    all.push(DtoSamples {
        fixture_file: Some("close-behavior.json"),
        type_name: name,
        cases,
    });

    // Commands whose results are serialize-only (m6-071: R-1 found them returned without a fixture).
    let mut cases = Vec::new();
    let name = "SendWindowMessageResult";
    sample_serialize_only(
        &mut cases,
        name,
        "delivered",
        SendWindowMessageResult { delivered: true },
    );
    sample_serialize_only(
        &mut cases,
        name,
        "notDelivered",
        SendWindowMessageResult { delivered: false },
    );
    all.push(DtoSamples {
        fixture_file: Some("send-window-message-result.json"),
        type_name: name,
        cases,
    });

    let mut cases = Vec::new();
    let name = "StartupNotice";
    sample_serialize_only(
        &mut cases,
        name,
        "abnormalExitWithStart",
        StartupNotice {
            kind: StartupNoticeKind::AbnormalExitDetected,
            started_at_ms: Some(TIMESTAMP_MS),
        },
    );
    sample_serialize_only(
        &mut cases,
        name,
        "abnormalExitWithoutStart",
        StartupNotice {
            kind: StartupNoticeKind::AbnormalExitDetected,
            started_at_ms: None,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("startup-notice.json"),
        type_name: name,
        cases,
    });

    let mut cases = Vec::new();
    let name = "WindowInboxSubscription";
    sample_serialize_only(
        &mut cases,
        name,
        "first",
        WindowInboxSubscription {
            replaced: false,
            flushed: 0,
            dropped: 0,
        },
    );
    sample_serialize_only(
        &mut cases,
        name,
        "replacedAfterBuffering",
        WindowInboxSubscription {
            replaced: true,
            flushed: 2,
            dropped: 1,
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("window-inbox-subscription.json"),
        type_name: name,
        cases,
    });

    // Event payloads built by their production constructors (m6-071).
    let lost_payload = AppEvent::WorkspaceContentWindowLost {
        window_label: "workspace-content-8e783338-f464-4b10-b15e-b534748c6241".to_string(),
    }
    .payload();
    let mut cases = Vec::new();
    let name = "WorkspaceContentWindowLostPayload";
    sample_value(&mut cases, "lost", lost_payload.clone());
    all.push(DtoSamples {
        fixture_file: Some("event-workspace-content-window-lost.json"),
        type_name: name,
        cases,
    });

    let mut cases = Vec::new();
    let name = "PtySessionOwnerLostPayload";
    sample_value(
        &mut cases,
        "lost",
        AppEvent::PtySessionOwnerLost {
            session_id: "8e783338-f464-4b10-b15e-b534748c6241".to_string(),
        }
        .payload(),
    );
    all.push(DtoSamples {
        fixture_file: Some("event-pty-session-owner-lost.json"),
        type_name: name,
        cases,
    });

    let mut cases = Vec::new();
    let name = "InboxMessage";
    sample_serialize_only(
        &mut cases,
        name,
        "withoutSource",
        InboxMessage {
            seq: 1,
            event: "workspace-content-window-lost".to_string(),
            payload: lost_payload,
            source: None,
        },
    );
    sample_serialize_only(
        &mut cases,
        name,
        "withSource",
        InboxMessage {
            seq: 2,
            event: "window-message".to_string(),
            payload: json!({"apiVersion": 1, "type": "pty-detached-ready", "payload": {}}),
            source: Some(InboxSource {
                label: "terminal-8e783338-f464-4b10-b15e-b534748c6241".to_string(),
                kind: WindowKind::Terminal,
            }),
        },
    );
    all.push(DtoSamples {
        fixture_file: Some("event-inbox-message.json"),
        type_name: name,
        cases,
    });

    all
}

const LAYOUT_SLOT_A: &str = "8e783338-f464-4b10-b15e-b534748c6241";
const LAYOUT_SLOT_B: &str = "9f3a1c52-6d7e-4a8b-9c0d-1e2f3a4b5c6d";
const LAYOUT_DOC_A: &str = "11111111-2222-4333-8444-555555555555";
const LAYOUT_DOC_B: &str = "66666666-7777-4888-9999-aaaaaaaaaaaa";

fn layout_slot(instance_id: &str, sequence: u32) -> serde_json::Value {
    serde_json::json!({
        "instanceId": instance_id,
        "directoryId": 1,
        "directoryPath": "/work/demo",
        "projectName": "demo",
        "toolKey": "claude",
        "sequence": sequence,
        "sessionId": null,
        "resumeSessionId": null,
        "title": { "kind": "automatic" }
    })
}

fn layout_document_ref(id: &str, relative_path: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "directoryId": 1,
        "directoryPath": "/work/demo",
        "relativePath": relative_path
    })
}

fn layout_pty(slot_id: &str) -> serde_json::Value {
    serde_json::json!({ "kind": "pty", "slotId": slot_id })
}

fn layout_file(document_id: &str) -> serde_json::Value {
    serde_json::json!({ "kind": "file", "documentId": document_id })
}

fn layout_pane(id: &str, number: u32, contents: Vec<serde_json::Value>) -> serde_json::Value {
    let active = contents.first().cloned();
    serde_json::json!({
        "kind": "pane",
        "id": id,
        "paneNumber": number,
        "contents": contents,
        "activeContent": active
    })
}

fn layout_document(
    tree: serde_json::Value,
    focused_pane_id: &str,
    slots: Vec<serde_json::Value>,
    documents: Vec<serde_json::Value>,
    detached: Vec<serde_json::Value>,
) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 5,
        "tree": tree,
        "focusedPaneId": focused_pane_id,
        "slots": slots,
        "documents": documents,
        "detachedContents": detached
    })
}

fn layout_split_base() -> serde_json::Value {
    layout_document(
        serde_json::json!({
            "kind": "split",
            "id": "split-1",
            "direction": "horizontal",
            "ratio": 0.5,
            "first": layout_pane("pane-1", 1, vec![layout_pty(LAYOUT_SLOT_A)]),
            "second": layout_pane("pane-2", 2, vec![layout_file(LAYOUT_DOC_A)])
        }),
        "pane-1",
        vec![layout_slot(LAYOUT_SLOT_A, 1)],
        vec![layout_document_ref(LAYOUT_DOC_A, "src/main.rs")],
        vec![],
    )
}

/// (目录 "valid" 或 "invalid", 文件名不含扩展名, 文档)。valid 由 Rust 与 TypeScript 都接受，
/// invalid 由两端都拒绝；这些文档只覆盖两端都实现了的校验。
pub(crate) fn layout_fixture_documents() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    let base = layout_split_base();
    let mut out: Vec<(&'static str, &'static str, serde_json::Value)> = Vec::new();

    out.push((
        "valid",
        "single-pane",
        layout_document(
            layout_pane("pane-1", 1, vec![layout_pty(LAYOUT_SLOT_A)]),
            "pane-1",
            vec![layout_slot(LAYOUT_SLOT_A, 1)],
            vec![],
            vec![],
        ),
    ));
    out.push(("valid", "split-with-file", base.clone()));
    out.push((
        "valid",
        "detached-slot",
        layout_document(
            layout_pane("pane-1", 1, vec![layout_pty(LAYOUT_SLOT_A)]),
            "pane-1",
            vec![layout_slot(LAYOUT_SLOT_A, 1), layout_slot(LAYOUT_SLOT_B, 2)],
            vec![],
            vec![layout_pty(LAYOUT_SLOT_B)],
        ),
    ));

    let mutate = |change: &dyn Fn(&mut serde_json::Value)| {
        let mut copy = base.clone();
        change(&mut copy);
        copy
    };
    out.push((
        "invalid",
        "duplicate-slot-id",
        mutate(&|doc| {
            doc["slots"] =
                serde_json::json!([layout_slot(LAYOUT_SLOT_A, 1), layout_slot(LAYOUT_SLOT_A, 2)])
        }),
    ));
    out.push((
        "invalid",
        "unsupported-schema-version",
        mutate(&|doc| doc["schemaVersion"] = serde_json::json!(99)),
    ));
    out.push((
        "invalid",
        "pane-references-missing-slot",
        mutate(&|doc| doc["slots"] = serde_json::json!([])),
    ));
    out.push((
        "invalid",
        "focused-pane-missing",
        mutate(&|doc| doc["focusedPaneId"] = serde_json::json!("pane-9")),
    ));
    out.push((
        "invalid",
        "slot-owned-twice",
        mutate(&|doc| doc["detachedContents"] = serde_json::json!([layout_pty(LAYOUT_SLOT_A)])),
    ));
    out.push((
        "invalid",
        "unowned-slot",
        mutate(&|doc| {
            doc["slots"] =
                serde_json::json!([layout_slot(LAYOUT_SLOT_A, 1), layout_slot(LAYOUT_SLOT_B, 2)])
        }),
    ));
    out.push((
        "invalid",
        "duplicate-document-id",
        mutate(&|doc| {
            doc["documents"] = serde_json::json!([
                layout_document_ref(LAYOUT_DOC_A, "src/main.rs"),
                layout_document_ref(LAYOUT_DOC_A, "src/lib.rs")
            ])
        }),
    ));
    out.push((
        "invalid",
        "unowned-document",
        mutate(&|doc| {
            doc["documents"] = serde_json::json!([
                layout_document_ref(LAYOUT_DOC_A, "src/main.rs"),
                layout_document_ref(LAYOUT_DOC_B, "src/other.rs")
            ])
        }),
    ));
    out
}
