#[cfg(not(windows))]
use std::path::Path;
use std::path::PathBuf;

#[cfg(windows)]
use std::time::Duration;

use tokio::process::Command;

#[cfg(windows)]
const WHERE_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Resolve a trusted Windows system binary to its full `System32` path so we do
/// not rely on PATH/CWD for system tools. Falls back to the bare name.
pub fn system32(relative: &str) -> String {
    if let Ok(root) = std::env::var("SystemRoot") {
        let path = std::path::Path::new(&root).join("System32").join(relative);
        if path.is_file() {
            return path.display().to_string();
        }
    }
    relative.to_string()
}

/// Resolve a command on the current platform PATH without running the candidate.
pub async fn which(command: &str) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        return find_on_path(command);
    }

    #[cfg(windows)]
    {
        let mut process = Command::new(system32("where.exe"));
        process.arg(command).kill_on_drop(true);
        process.creation_flags(CREATE_NO_WINDOW);
        let future = process.output();
        let output = tokio::time::timeout(WHERE_TIMEOUT, future)
            .await
            .ok()?
            .ok()?;
        if !output.status.success() {
            return None;
        }
        pick_executable(&String::from_utf8_lossy(&output.stdout)).map(PathBuf::from)
    }
}

/// Run `--version` only after an explicit user refresh. The executable path is
/// already resolved by detection; scripts use their Windows host explicitly so
/// no shell lookup or current-directory execution is involved.
pub async fn probe_version(path: &std::path::Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut process = match extension.as_str() {
        "cmd" | "bat" => {
            let mut process = Command::new(system32("cmd.exe"));
            process.arg("/D").arg("/C").arg(path).arg("--version");
            process
        }
        "ps1" => {
            let mut process = Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe"));
            process
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(path)
                .arg("--version");
            process
        }
        _ => {
            let mut process = Command::new(path);
            process.arg("--version");
            process
        }
    };
    process.kill_on_drop(true);
    #[cfg(windows)]
    process.creation_flags(CREATE_NO_WINDOW);

    let output = tokio::time::timeout(VERSION_TIMEOUT, process.output())
        .await
        .map_err(|_| "版本命令执行超时".to_string())?
        .map_err(|error| format!("无法启动版本命令：{error}"))?;

    if !output.status.success() {
        let detail = first_output_line(&output.stderr)
            .or_else(|| first_output_line(&output.stdout))
            .unwrap_or_else(|| format!("退出码 {}", output.status));
        return Err(format!("版本命令失败：{detail}"));
    }

    first_output_line(&output.stdout)
        .or_else(|| first_output_line(&output.stderr))
        .ok_or_else(|| "版本命令未返回内容".to_string())
}

fn first_output_line(bytes: &[u8]) -> Option<String> {
    let output = String::from_utf8_lossy(bytes);
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(200).collect())
}

/// Synchronous PATH resolution to a full executable path, used on the launch
/// path so commands run by absolute path rather than relying on child PATH.
pub fn which_path_sync(command: &str) -> Option<String> {
    #[cfg(not(windows))]
    {
        return find_on_path(command).map(|path| path.display().to_string());
    }

    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new(system32("where.exe"));
        cmd.arg(command);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output().ok()?;
        if !output.status.success() {
            return None;
        }
        pick_executable(&String::from_utf8_lossy(&output.stdout))
    }
}

#[cfg(not(windows))]
fn find_on_path(command: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| absolute_candidate(&directory, command))
        .find(|candidate| is_executable_file(candidate))
}

#[cfg(not(windows))]
fn absolute_candidate(directory: &Path, command: &str) -> PathBuf {
    let candidate = directory.join(command);
    if candidate.is_absolute() {
        candidate
    } else {
        std::env::current_dir()
            .map(|current| current.join(&candidate))
            .unwrap_or(candidate)
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

/// Choose the best match from `where` output. `where` lists every match (e.g.
/// npm installs both a `.cmd` shim and an extensionless POSIX shell shim that
/// PowerShell cannot run); prefer a directly-executable Windows extension.
#[cfg(any(windows, test))]
fn pick_executable(stdout: &str) -> Option<String> {
    let lines: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    const PREFERRED: [&str; 5] = [".exe", ".cmd", ".bat", ".com", ".ps1"];
    for ext in PREFERRED {
        if let Some(found) = lines.iter().find(|line| line.to_lowercase().ends_with(ext)) {
            return Some((*found).to_string());
        }
    }
    lines.first().map(|line| (*line).to_string())
}

/// Resolve a tool's full executable path the same way detection does: try the
/// PATH first, then known per-user install dirs. Shared by the launch path so
/// "available in detection" and "launchable" stay consistent.
pub fn resolve_executable_path(candidates: &[&str]) -> Option<String> {
    for command in candidates {
        if let Some(path) = which_path_sync(command) {
            return Some(path);
        }
    }
    for command in candidates {
        if let Some(path) = find_in_known_dirs(command) {
            return Some(path.display().to_string());
        }
    }
    None
}

/// Look for an executable in known per-user install directories that may be
/// absent from the current process PATH (npm global, WinGet links, ~/.local/bin).
/// Used only to distinguish "installed but not on PATH" from "missing".
pub fn find_in_known_dirs(command: &str) -> Option<PathBuf> {
    for dir in candidate_dirs() {
        #[cfg(not(windows))]
        {
            let candidate = dir.join(command);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
        #[cfg(windows)]
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
    #[cfg(windows)]
    {
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
            dirs.push(PathBuf::from(&local).join("agy").join("bin"));
            dirs.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join("OpenAI")
                    .join("Codex")
                    .join("bin"),
            );
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            dirs.push(PathBuf::from(profile).join(".local").join("bin"));
        }
    }

    #[cfg(not(windows))]
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/bin"));

        #[cfg(target_os = "macos")]
        {
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            dirs.push(home.join(".volta/bin"));
            dirs.extend(nvm_bin_dirs(&home));
        }
    }
    dirs
}

#[cfg(not(windows))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn nvm_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let versions = home.join(".nvm/versions/node");
    let Ok(entries) = std::fs::read_dir(versions) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin"))
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort_by(|left, right| right.cmp(left));
    dirs
}

#[cfg(test)]
mod tests {
    use super::{first_output_line, pick_executable};

    #[test]
    fn prefers_cmd_over_extensionless_shim() {
        // npm lists both; the extensionless one is a POSIX shell script.
        let stdout = "C:\\nvm4w\\nodejs\\codex\nC:\\nvm4w\\nodejs\\codex.cmd\n";
        assert_eq!(
            pick_executable(stdout).as_deref(),
            Some("C:\\nvm4w\\nodejs\\codex.cmd")
        );
    }

    #[test]
    fn picks_single_exe() {
        assert_eq!(
            pick_executable("C:\\Users\\me\\.local\\bin\\claude.exe\n").as_deref(),
            Some("C:\\Users\\me\\.local\\bin\\claude.exe")
        );
    }

    #[test]
    fn version_output_uses_first_non_empty_line() {
        assert_eq!(
            first_output_line(b"\r\ncodex-cli 0.147.0\r\nextra\r\n").as_deref(),
            Some("codex-cli 0.147.0")
        );
    }

    #[cfg(unix)]
    #[test]
    fn known_directory_requires_executable_permission() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let candidate = directory.path().join("codex");
        std::fs::write(&candidate, "#!/bin/sh\n").unwrap();
        let mut permissions = std::fs::metadata(&candidate).unwrap().permissions();
        permissions.set_mode(0o644);
        std::fs::set_permissions(&candidate, permissions).unwrap();
        assert!(!super::is_executable_file(&candidate));

        let mut permissions = std::fs::metadata(&candidate).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&candidate, permissions).unwrap();
        assert!(super::is_executable_file(&candidate));
    }
}
