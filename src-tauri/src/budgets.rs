//! Centralized time budgets for blocking work started from commands.
//! Every call to `crate::blocking` takes one of these constants so budgets
//! can be reviewed and changed in one place.

use std::time::Duration;

/// Verifying a project path snapshot and opening the project directory.
pub const PROJECT_DIRECTORY: Duration = Duration::from_secs(10);
/// File reads, writes, directory listings and CAS saves.
pub const FILE_OPERATION: Duration = Duration::from_secs(30);
/// Executable resolution (`where.exe`, `which`).
pub const EXECUTABLE_PROBE: Duration = Duration::from_secs(10);
/// Building install and update previews.
pub const INSTALL_PLAN: Duration = Duration::from_secs(10);

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
