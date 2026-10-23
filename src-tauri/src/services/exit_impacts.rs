//! m6-101：退出影响由 Rust 重算并随退出请求下发。
//!
//! 协议：Rust 发出 `app-exit-requested`；前端收集脏文件后调用 `report_exit_impacts`，Rust 用
//! `AppLifecycle` 重算 PTY 数与执行任务数并与上报的脏文件合并；确认时 `confirm_app_exit` 只覆盖
//! 已上报的影响：重算值超过上报值则拒绝（`exit.impacts_changed`），没有上报则拒绝
//! （`exit.impacts_not_reported`）。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error_codes::ErrorCode;
use crate::services::app_lifecycle::{
    confirm_exit_with, exit_confirm_error, AppExitGate, AppLifecycle,
};
pub use crate::services::app_lifecycle::{ExitActivity, ReportedImpacts};
use crate::AppError;

pub const MAX_REPORTED_DIRTY_FILES: usize = 2000;
pub const MAX_DOCUMENT_ID_CHARS: usize = 128;
pub const MAX_RELATIVE_PATH_CHARS: usize = 4096;

/// 主窗口上报的一个未保存文件（线上格式为 camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedDirtyFile {
    pub document_id: String,
    pub relative_path: String,
}

/// `report_exit_impacts` 的返回值：权威的影响与是否需要询问用户。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitImpactsView {
    pub request_id: String,
    pub pty_count: usize,
    pub execution_task_count: usize,
    pub dirty_files: Vec<ReportedDirtyFile>,
    pub requires_prompt: bool,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::coded(ErrorCode::ExitReportInvalid, message.into())
}

fn has_control_character(text: &str) -> bool {
    text.chars().any(char::is_control)
}

/// 校验上报的脏文件：数量、字段长度与控制字符；重复的 `documentId` 只保留第一个，顺序保持。
pub fn validate_reported_dirty_files(
    files: Vec<ReportedDirtyFile>,
) -> Result<Vec<ReportedDirtyFile>, AppError> {
    if files.len() > MAX_REPORTED_DIRTY_FILES {
        return Err(invalid(format!("条目数超过 {MAX_REPORTED_DIRTY_FILES} 个")));
    }
    let mut seen = HashSet::new();
    let mut kept = Vec::with_capacity(files.len());
    for file in files {
        let id = file.document_id.trim();
        if id.is_empty()
            || file.document_id.chars().count() > MAX_DOCUMENT_ID_CHARS
            || has_control_character(&file.document_id)
        {
            return Err(invalid("documentId 为空、过长或含控制字符"));
        }
        let path = file.relative_path.trim();
        if path.is_empty()
            || file.relative_path.chars().count() > MAX_RELATIVE_PATH_CHARS
            || has_control_character(&file.relative_path)
        {
            return Err(invalid("relativePath 为空、过长或含控制字符"));
        }
        if seen.insert(file.document_id.clone()) {
            kept.push(file);
        }
    }
    Ok(kept)
}

/// 纯合并：`requires_prompt` 只由 Rust 的数字与脏文件决定。
pub fn merge_exit_impacts(
    request_id: &str,
    activity: ExitActivity,
    dirty_files: Vec<ReportedDirtyFile>,
) -> ExitImpactsView {
    let requires_prompt =
        activity.pty_count > 0 || activity.execution_task_count > 0 || !dirty_files.is_empty();
    ExitImpactsView {
        request_id: request_id.to_string(),
        pty_count: activity.pty_count,
        execution_task_count: activity.execution_task_count,
        dirty_files,
        requires_prompt,
    }
}

/// 核对规则：确认只覆盖已上报的影响；数量减少允许，增长拒绝，没有上报拒绝。
pub fn check_confirmable(
    reported: Option<&ReportedImpacts>,
    now: ExitActivity,
) -> Result<(), AppError> {
    let Some(reported) = reported else {
        return Err(AppError::coded(
            ErrorCode::ExitImpactsNotReported,
            "尚未上报退出影响",
        ));
    };
    if now.pty_count > reported.activity.pty_count
        || now.execution_task_count > reported.activity.execution_task_count
    {
        return Err(AppError::coded(
            ErrorCode::ExitImpactsChanged,
            "退出影响已经增加，请重新确认",
        ));
    }
    Ok(())
}

/// `report_exit_impacts` 的业务函数：先校验请求，再校验载荷，最后重算并记录。
pub fn report(
    gate: &AppExitGate,
    lifecycle: &AppLifecycle,
    request_id: &str,
    dirty_files: Vec<ReportedDirtyFile>,
) -> Result<ExitImpactsView, AppError> {
    gate.check_pending(request_id).map_err(exit_confirm_error)?;
    let dirty_files = validate_reported_dirty_files(dirty_files)?;
    let counts = lifecycle.activity();
    let activity = ExitActivity {
        pty_count: counts.pty,
        execution_task_count: counts.exec,
    };
    let view = merge_exit_impacts(request_id, activity, dirty_files);
    gate.record_report(
        request_id,
        ReportedImpacts {
            activity,
            dirty_file_count: view.dirty_files.len(),
            requires_prompt: view.requires_prompt,
        },
    )
    .map_err(exit_confirm_error)?;
    Ok(view)
}

/// `confirm_app_exit` 的核对入口：请求校验优先，核对在终止之前，失败时请求与上报都保持待决。
pub fn confirm_with_impacts<T>(
    gate: &AppExitGate,
    lifecycle: &AppLifecycle,
    request_id: &str,
    terminate: impl FnOnce() -> Result<T, AppError>,
) -> Result<(), AppError> {
    confirm_exit_with(gate, request_id, || {
        let counts = lifecycle.activity();
        check_confirmable(
            gate.reported_for(request_id).as_ref(),
            ExitActivity {
                pty_count: counts.pty,
                execution_task_count: counts.exec,
            },
        )?;
        terminate()
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    fn file(id: &str, path: &str) -> ReportedDirtyFile {
        ReportedDirtyFile {
            document_id: id.to_string(),
            relative_path: path.to_string(),
        }
    }

    /// Lifecycle whose activity probes read shared counters (m6-031).
    fn lifecycle(pty: usize, exec: usize) -> (AppLifecycle, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let pty = Arc::new(AtomicUsize::new(pty));
        let exec = Arc::new(AtomicUsize::new(exec));
        (
            AppLifecycle::with_counters(pty.clone(), exec.clone()),
            pty,
            exec,
        )
    }

    fn code(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn activity(pty_count: usize, execution_task_count: usize) -> ExitActivity {
        ExitActivity {
            pty_count,
            execution_task_count,
        }
    }

    #[test]
    fn merge_uses_rust_counts_and_requires_a_prompt_for_any_impact() {
        let cases = [
            (activity(0, 0), vec![], false),
            (activity(1, 0), vec![], true),
            (activity(0, 2), vec![], true),
            (activity(0, 0), vec![file("d1", "a.ts")], true),
        ];
        for (counts, dirty, expected) in cases {
            let view = merge_exit_impacts("r1", counts, dirty.clone());
            assert_eq!(view.requires_prompt, expected, "{counts:?} {dirty:?}");
            assert_eq!(view.request_id, "r1");
            assert_eq!(view.pty_count, counts.pty_count);
            assert_eq!(view.execution_task_count, counts.execution_task_count);
            assert_eq!(view.dirty_files, dirty);
        }
        let quiet = merge_exit_impacts("r1", activity(0, 0), vec![]);
        assert!(quiet.dirty_files.is_empty() && !quiet.requires_prompt);
    }

    #[test]
    fn validation_keeps_order_and_merges_duplicate_document_ids() {
        let validated = validate_reported_dirty_files(vec![
            file("b", "b.ts"),
            file("a", "a.ts"),
            file("b", "other.ts"),
            file("c", "c.ts"),
        ])
        .unwrap();
        assert_eq!(
            validated,
            vec![file("b", "b.ts"), file("a", "a.ts"), file("c", "c.ts")]
        );
        assert_eq!(validate_reported_dirty_files(vec![]).unwrap(), vec![]);
    }

    #[test]
    fn validation_rejects_malformed_reports_with_exit_report_invalid() {
        let too_many: Vec<ReportedDirtyFile> = (0..=MAX_REPORTED_DIRTY_FILES)
            .map(|i| file(&format!("d{i}"), "a.ts"))
            .collect();
        let malformed = vec![
            (too_many, "条目数"),
            (vec![file("", "a.ts")], "documentId"),
            (vec![file("   ", "a.ts")], "documentId"),
            (
                vec![file(&"x".repeat(MAX_DOCUMENT_ID_CHARS + 1), "a.ts")],
                "documentId",
            ),
            (vec![file("d\u{0007}", "a.ts")], "documentId"),
            (vec![file("d", "")], "relativePath"),
            (
                vec![file("d", &"p".repeat(MAX_RELATIVE_PATH_CHARS + 1))],
                "relativePath",
            ),
            (vec![file("d", "a\nb.ts")], "relativePath"),
        ];
        for (files, field) in malformed {
            let error = validate_reported_dirty_files(files).unwrap_err();
            assert_eq!(code(&error), "exit.report_invalid");
            assert!(error.to_string().contains(field) || format!("{error:?}").contains(field));
        }
        // Exactly at the limits is accepted.
        let at_limit: Vec<ReportedDirtyFile> = (0..MAX_REPORTED_DIRTY_FILES)
            .map(|i| file(&format!("d{i}"), "a.ts"))
            .collect();
        assert!(validate_reported_dirty_files(at_limit).is_ok());
        assert!(validate_reported_dirty_files(vec![file(
            &"x".repeat(MAX_DOCUMENT_ID_CHARS),
            &"p".repeat(MAX_RELATIVE_PATH_CHARS),
        )])
        .is_ok());
    }

    #[test]
    fn check_confirmable_allows_only_what_was_reported() {
        let reported = |p, e| ReportedImpacts {
            activity: activity(p, e),
            dirty_file_count: 0,
            requires_prompt: false,
        };
        assert_eq!(
            code(&check_confirmable(None, activity(0, 0)).unwrap_err()),
            "exit.impacts_not_reported"
        );
        assert!(check_confirmable(Some(&reported(1, 1)), activity(1, 1)).is_ok());
        assert_eq!(
            code(&check_confirmable(Some(&reported(1, 1)), activity(2, 1)).unwrap_err()),
            "exit.impacts_changed"
        );
        assert_eq!(
            code(&check_confirmable(Some(&reported(1, 1)), activity(1, 2)).unwrap_err()),
            "exit.impacts_changed"
        );
        assert!(check_confirmable(Some(&reported(1, 1)), activity(0, 0)).is_ok());
        assert!(check_confirmable(Some(&reported(1, 1)), activity(1, 0)).is_ok());
        assert!(check_confirmable(Some(&reported(0, 0)), activity(0, 0)).is_ok());
    }

    #[test]
    fn report_recomputes_counts_from_the_lifecycle_probes() {
        let gate = AppExitGate::default();
        let id = gate.begin_request().id;
        let (lifecycle, _, _) = lifecycle(3, 2);
        let view = report(
            &gate,
            &lifecycle,
            &id,
            vec![file("d1", "a.ts"), file("d2", "b.ts")],
        )
        .unwrap();
        assert_eq!(view.request_id, id);
        assert_eq!(view.pty_count, 3);
        assert_eq!(view.execution_task_count, 2);
        assert_eq!(view.dirty_files.len(), 2);
        assert!(view.requires_prompt);
        assert_eq!(
            gate.reported_for(&id),
            Some(ReportedImpacts {
                activity: activity(3, 2),
                dirty_file_count: 2,
                requires_prompt: true,
            })
        );
        // A later report replaces the earlier one.
        let (quiet, _, _) = lifecycle_with_zero();
        let view = report(&gate, &quiet, &id, vec![]).unwrap();
        assert!(!view.requires_prompt);
        assert_eq!(gate.reported_for(&id).unwrap().activity, activity(0, 0));
    }

    fn lifecycle_with_zero() -> (AppLifecycle, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        lifecycle(0, 0)
    }

    #[test]
    fn report_checks_the_request_before_the_payload_and_records_only_valid_reports() {
        let gate = AppExitGate::default();
        let (lifecycle, _, _) = lifecycle(0, 0);
        let bad = vec![file("", "a.ts")];
        assert_eq!(
            code(&report(&gate, &lifecycle, "x", bad.clone()).unwrap_err()),
            "exit.no_pending_request"
        );
        let id = gate.begin_request().id;
        assert_eq!(
            code(&report(&gate, &lifecycle, "other", bad.clone()).unwrap_err()),
            "exit.request_mismatch"
        );
        assert_eq!(
            code(&report(&gate, &lifecycle, &id, bad.clone()).unwrap_err()),
            "exit.report_invalid"
        );
        assert!(gate.reported_for(&id).is_none());

        report(&gate, &lifecycle, &id, vec![file("d1", "a.ts")]).unwrap();
        let kept = gate.reported_for(&id);
        assert!(kept.is_some());
        assert_eq!(
            code(&report(&gate, &lifecycle, &id, bad).unwrap_err()),
            "exit.report_invalid"
        );
        assert_eq!(gate.reported_for(&id), kept);
    }

    #[test]
    fn confirm_with_impacts_enforces_report_then_unchanged_counts() {
        let gate = AppExitGate::default();
        let id = gate.begin_request().id;
        let (lifecycle, pty, exec) = lifecycle(1, 0);
        let terminated = AtomicUsize::new(0);
        let terminate = || {
            terminated.fetch_add(1, Ordering::SeqCst);
            Ok::<(), AppError>(())
        };

        assert_eq!(
            code(&confirm_with_impacts(&gate, &lifecycle, &id, terminate).unwrap_err()),
            "exit.impacts_not_reported"
        );
        assert_eq!(terminated.load(Ordering::SeqCst), 0);
        assert_eq!(gate.pending_request_id(), Some(id.clone()));

        report(&gate, &lifecycle, &id, vec![]).unwrap();
        pty.store(2, Ordering::SeqCst);
        assert_eq!(
            code(&confirm_with_impacts(&gate, &lifecycle, &id, terminate).unwrap_err()),
            "exit.impacts_changed"
        );
        assert_eq!(terminated.load(Ordering::SeqCst), 0);
        assert_eq!(gate.pending_request_id(), Some(id.clone()));
        assert!(gate.reported_for(&id).is_some());

        pty.store(1, Ordering::SeqCst);
        exec.store(1, Ordering::SeqCst);
        assert_eq!(
            code(&confirm_with_impacts(&gate, &lifecycle, &id, terminate).unwrap_err()),
            "exit.impacts_changed"
        );

        exec.store(0, Ordering::SeqCst);
        confirm_with_impacts(&gate, &lifecycle, &id, terminate).unwrap();
        assert_eq!(terminated.load(Ordering::SeqCst), 1);
        assert!(gate.consume_authorization());
        assert!(gate.pending_request_id().is_none());
        assert!(gate.reported_for(&id).is_none());

        let stale_gate = AppExitGate::default();
        assert_eq!(
            code(&confirm_with_impacts(&stale_gate, &lifecycle, "x", terminate).unwrap_err()),
            "exit.no_pending_request"
        );
        assert_eq!(terminated.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn reported_dirty_file_uses_camel_case_on_the_wire() {
        assert_eq!(
            serde_json::from_str::<ReportedDirtyFile>(
                r#"{"documentId":"d1","relativePath":"a.ts"}"#
            )
            .unwrap(),
            file("d1", "a.ts")
        );
        assert_eq!(
            serde_json::to_value(file("d1", "a.ts")).unwrap(),
            serde_json::json!({"documentId":"d1","relativePath":"a.ts"})
        );
        assert!(serde_json::from_str::<ReportedDirtyFile>(
            r#"{"document_id":"d1","relative_path":"a.ts"}"#
        )
        .is_err());
    }
}
