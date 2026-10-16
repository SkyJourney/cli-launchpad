//! Names of the events Rust sends to windows (`contracts/events.json`).
//! This is the only place these strings are spelled in Rust.

pub const APP_EXIT_REQUESTED: &str = "app-exit-requested";
pub const EXECUTION_TASK_LOG: &str = "execution-task-log";
pub const EXECUTION_TASK_UPDATED: &str = "execution-task-updated";
pub const PTY_SESSION_OWNER_LOST: &str = "pty-session-owner-lost";
pub const WINDOW_MESSAGE: &str = "window-message";
pub const WORKSPACE_CONTENT_WINDOW_LOST: &str = "workspace-content-window-lost";
pub const WORKSPACE_DATA_RESTORED: &str = "workspace-data-restored";

/// Every Rust-emitted event; only the contract tests read it.
#[cfg(test)]
pub const ALL: &[&str] = &[
    APP_EXIT_REQUESTED,
    EXECUTION_TASK_LOG,
    EXECUTION_TASK_UPDATED,
    PTY_SESSION_OWNER_LOST,
    WINDOW_MESSAGE,
    WORKSPACE_CONTENT_WINDOW_LOST,
    WORKSPACE_DATA_RESTORED,
];
