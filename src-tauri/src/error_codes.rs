//! Single source of truth for backend error codes (`contracts/error-codes.json`).
//! Codes are `domain.reason`; legacy underscore codes live only in the contract's aliases.

pub const APP_DATA_REPLACE_BLOCKED: &str = "app.data_replace_blocked";
pub const APP_DATA_REPLACE_IN_PROGRESS: &str = "app.data_replace_in_progress";
pub const APP_ERROR: &str = "app.error";
pub const APP_EXIT_DEFERRED: &str = "app.exit_deferred";
pub const APP_EXITING: &str = "app.exiting";
pub const BACKUP_RESTORE_IN_PROGRESS: &str = "backup.restore_in_progress";
pub const BLOCKING_TIMEOUT: &str = "blocking.timeout";
pub const CONFIG_IMPORT_IN_PROGRESS: &str = "config.import_in_progress";
pub const DB_POISONED: &str = "db.poisoned";
pub const DIRECTORY_IN_USE: &str = "directory.in_use";
pub const EXEC_PLAN_CHANGED: &str = "exec.plan_changed";
pub const EXIT_NO_PENDING_REQUEST: &str = "exit.no_pending_request";
pub const EXIT_REQUEST_MISMATCH: &str = "exit.request_mismatch";
pub const INTERNAL_TASK_FAILED: &str = "internal.task_failed";
pub const PROJECT_IDENTITY_CHANGED: &str = "project.identity_changed";
pub const PROJECT_NOT_FOUND: &str = "project.not_found";
pub const PTY_HANDOFF_TARGET_IS_SOURCE: &str = "pty.handoff_target_is_source";
pub const PTY_INPUT_BACKPRESSURE: &str = "pty.input_backpressure";
pub const PTY_INPUT_UNAVAILABLE: &str = "pty.input_unavailable";
pub const PTY_SESSION_STARTING: &str = "pty.session_starting";
pub const PTY_SESSIONS_ACTIVE: &str = "pty.sessions_active";
pub const WINDOW_LABEL_INVALID: &str = "window.label_invalid";
pub const WINDOW_NOT_ALLOWED: &str = "window.not_allowed";

/// Every registered code; only the contract tests read it.
#[cfg(test)]
pub const ALL: &[&str] = &[
    APP_DATA_REPLACE_BLOCKED,
    APP_DATA_REPLACE_IN_PROGRESS,
    APP_ERROR,
    APP_EXIT_DEFERRED,
    APP_EXITING,
    BACKUP_RESTORE_IN_PROGRESS,
    BLOCKING_TIMEOUT,
    CONFIG_IMPORT_IN_PROGRESS,
    DB_POISONED,
    DIRECTORY_IN_USE,
    EXEC_PLAN_CHANGED,
    EXIT_NO_PENDING_REQUEST,
    EXIT_REQUEST_MISMATCH,
    INTERNAL_TASK_FAILED,
    PROJECT_IDENTITY_CHANGED,
    PROJECT_NOT_FOUND,
    PTY_HANDOFF_TARGET_IS_SOURCE,
    PTY_INPUT_BACKPRESSURE,
    PTY_INPUT_UNAVAILABLE,
    PTY_SESSION_STARTING,
    PTY_SESSIONS_ACTIVE,
    WINDOW_LABEL_INVALID,
    WINDOW_NOT_ALLOWED,
];
