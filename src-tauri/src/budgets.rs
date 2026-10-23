//! Centralized time budgets for blocking work started from commands.
//! Every call to `crate::blocking` takes one of these constants so budgets
//! can be reviewed and changed in one place.

use std::time::Duration;

/// Verifying a project path snapshot and opening the project directory.
pub const PROJECT_DIRECTORY: Duration = Duration::from_secs(10);
/// Probing the case and normalization semantics of a project root (PD-10); a timeout means `Unknown`.
pub const CASE_PROBE: Duration = Duration::from_secs(2);
/// File reads, writes, directory listings and CAS saves.
pub const FILE_OPERATION: Duration = Duration::from_secs(30);
/// Executable resolution (`where.exe`, `which`).
pub const EXECUTABLE_PROBE: Duration = Duration::from_secs(10);
/// Building install and update previews.
pub const INSTALL_PLAN: Duration = Duration::from_secs(10);
/// External awaits before a PTY launch (session file ownership check, executable resolution).
pub const PTY_LAUNCH_PREPARE: Duration = Duration::from_secs(20);
/// PTY control commands that call the OS or move large IPC payloads (resize, terminate, re-attach,
/// hand-off completion and finalization).
pub const PTY_CONTROL: Duration = Duration::from_secs(5);

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn budgets_are_positive_and_bounded() {
        for (name, budget) in [
            ("PROJECT_DIRECTORY", PROJECT_DIRECTORY),
            ("FILE_OPERATION", FILE_OPERATION),
            ("EXECUTABLE_PROBE", EXECUTABLE_PROBE),
            ("INSTALL_PLAN", INSTALL_PLAN),
            ("PTY_LAUNCH_PREPARE", PTY_LAUNCH_PREPARE),
            ("PTY_CONTROL", PTY_CONTROL),
        ] {
            assert!(budget > Duration::ZERO, "{name} must be positive");
            assert!(
                budget <= Duration::from_secs(30),
                "{name} must not exceed 30 seconds"
            );
        }
        assert!(
            FILE_OPERATION >= PROJECT_DIRECTORY,
            "file operations may take at least as long as opening a project directory"
        );
    }
}
