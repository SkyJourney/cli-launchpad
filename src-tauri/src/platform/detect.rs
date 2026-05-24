use std::path::PathBuf;
use std::time::Duration;

use tokio::process::Command;

const WHERE_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: Duration = Duration::from_secs(8);

/// Resolve a command on the current PATH using Windows `where.exe`.
/// Returns the first resolved path when found. Bounded by a timeout; the child
/// is killed on drop so a hung probe cannot leak.
pub async fn which(command: &str) -> Option<PathBuf> {
    let future = Command::new("where")
        .arg(command)
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(WHERE_TIMEOUT, future)
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

/// Look for an executable in known per-user install directories that may be
/// absent from the current process PATH (npm global, WinGet links, ~/.local/bin).
/// Used only to distinguish "installed but not on PATH" from "missing".
pub fn find_in_known_dirs(command: &str) -> Option<PathBuf> {
    for dir in candidate_dirs() {
        for ext in ["cmd", "exe", "bat", "ps1"] {
            let candidate = dir.join(format!("{command}.{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(
            PathBuf::from(&local)
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
        );
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(profile).join(".local").join("bin"));
    }
    dirs
}

/// Run `<command> --version` through `cmd /C` so PATH shims (.cmd/.ps1) resolve
/// the same way an interactive shell would. Bounded by a timeout with the child
/// killed on drop. Falls back to stderr because some CLIs print the version
/// there, and the exit status is not required to be zero.
pub async fn run_version(command: &str) -> Option<String> {
    let future = Command::new("cmd")
        .args(["/C", command, "--version"])
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(VERSION_TIMEOUT, future)
        .await
        .ok()?
        .ok()?;
    parse_version_output(&String::from_utf8_lossy(&output.stdout))
        .or_else(|| parse_version_output(&String::from_utf8_lossy(&output.stderr)))
}

/// Extract a concise version string from raw `--version` output.
fn parse_version_output(raw: &str) -> Option<String> {
    raw.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::parse_version_output;

    #[test]
    fn takes_first_non_empty_line() {
        assert_eq!(
            parse_version_output("\n  2.1.150 (Claude Code)\nextra\n").as_deref(),
            Some("2.1.150 (Claude Code)")
        );
    }

    #[test]
    fn empty_output_is_none() {
        assert_eq!(parse_version_output("   \n\n"), None);
    }
}
