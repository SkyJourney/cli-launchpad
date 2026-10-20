use std::path::{Path, PathBuf};
use std::time::Duration;

use super::launch_environment::LaunchEnvironment;

#[cfg(windows)]
const WHERE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedExecutable {
    /// The candidate command name that matched (for example `agy`).
    pub command: String,
    pub path: PathBuf,
}

/// Resolve the first matching candidate within `budget`. Returns `None` when
/// nothing matches, the budget is exhausted, or the blocking task panics.
pub async fn resolve(
    candidates: &[&str],
    extra_dirs: &[PathBuf],
    env: &LaunchEnvironment,
    budget: Duration,
) -> Option<ResolvedExecutable> {
    let candidates: Vec<String> = candidates
        .iter()
        .map(|value| (*value).to_string())
        .collect();
    let extra_dirs = extra_dirs.to_vec();
    let env = env.clone();
    resolve_with(
        move || {
            let candidates: Vec<&str> = candidates.iter().map(String::as_str).collect();
            resolve_blocking(&candidates, &extra_dirs, &env)
        },
        budget,
    )
    .await
}

async fn resolve_with(
    operation: impl FnOnce() -> Option<ResolvedExecutable> + Send + 'static,
    budget: Duration,
) -> Option<ResolvedExecutable> {
    match tokio::time::timeout(budget, tokio::task::spawn_blocking(operation)).await {
        Ok(Ok(found)) => found,
        _ => None,
    }
}

/// Synchronous resolution: the candidates in order on the launch PATH, then
/// the known per-user install directories. Only call from a blocking thread
/// (it may run `where.exe` on Windows).
pub fn resolve_blocking(
    candidates: &[&str],
    extra_dirs: &[PathBuf],
    env: &LaunchEnvironment,
) -> Option<ResolvedExecutable> {
    for command in candidates {
        if let Some(path) = which_on_path(command, env) {
            return Some(ResolvedExecutable {
                command: (*command).to_string(),
                path,
            });
        }
    }
    for command in candidates {
        if let Some(path) = find_in_known_dirs(command, extra_dirs) {
            return Some(ResolvedExecutable {
                command: (*command).to_string(),
                path,
            });
        }
    }
    None
}

#[cfg(not(windows))]
fn which_on_path(command: &str, env: &LaunchEnvironment) -> Option<PathBuf> {
    find_on_path(&env.path_dirs(), command)
}

#[cfg(windows)]
fn which_on_path(command: &str, env: &LaunchEnvironment) -> Option<PathBuf> {
    let program_path = super::detect::system32("where.exe");
    let mut process = super::process::cli_std_command(Path::new(&program_path), [command]);
    env.apply_to_std(&mut process);
    let output = super::process::run_bounded_sync(process, WHERE_TIMEOUT, 64 * 1024).ok()?;
    if !output.status.success() {
        return None;
    }
    pick_executable(&String::from_utf8_lossy(&output.stdout)).map(PathBuf::from)
}

#[cfg(not(windows))]
fn find_on_path(directories: &[PathBuf], command: &str) -> Option<PathBuf> {
    directories
        .iter()
        .map(|directory| absolute_candidate(directory, command))
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

/// Look for an executable in known per-user install directories that may be
/// absent from the current process PATH (npm global, WinGet links, ~/.local/bin).
/// Used only to distinguish "installed but not on PATH" from "missing".
fn find_in_known_dirs(command: &str, additional_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in candidate_dirs()
        .into_iter()
        .chain(additional_dirs.iter().cloned())
    {
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
        }
        dirs.extend(windows_user_install_dirs(std::env::var_os("USERPROFILE")));
    }

    // `/usr/local/bin`, Volta and nvm all follow the same layout on Linux
    // and macOS; only Homebrew's Apple Silicon prefix is macOS-specific.
    #[cfg(not(windows))]
    if let Some(home) = crate::platform::home::posix_home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(home.join(".volta/bin"));
        dirs.extend(nvm_bin_dirs(&home));

        #[cfg(target_os = "macos")]
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs
}

#[cfg(windows)]
fn windows_user_install_dirs(user_profile: Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(user_profile) = user_profile {
        let profile = PathBuf::from(user_profile);
        dirs.push(profile.join(".local").join("bin"));
    }
    dirs
}

#[cfg(not(windows))]
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
    use super::*;

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

    fn make_executable(directory: &Path, command: &str) -> PathBuf {
        #[cfg(windows)]
        let file = directory.join(format!("{command}.cmd"));
        #[cfg(not(windows))]
        let file = directory.join(command);
        std::fs::write(&file, b"@echo off\r\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        file
    }

    fn environment_with(directory: &Path) -> LaunchEnvironment {
        LaunchEnvironment::from_path(Some(std::env::join_paths([directory]).unwrap()))
    }

    #[test]
    fn resolves_from_the_launch_environment_path() {
        let directory = tempfile::tempdir().unwrap();
        let file = make_executable(directory.path(), "m6069-path-cli");

        let found = resolve_blocking(
            &["m6069-path-cli"],
            &[],
            &environment_with(directory.path()),
        )
        .expect("命令应在启动环境的 PATH 里被找到");

        assert_eq!(found.command, "m6069-path-cli");
        assert_eq!(found.path.file_name(), file.file_name());
        // 反向断言：进程 PATH 不含该临时目录，空的启动环境找不到它。
        assert!(resolve_blocking(
            &["m6069-path-cli"],
            &[],
            &LaunchEnvironment::from_path(None)
        )
        .is_none());
    }

    #[test]
    fn falls_back_to_the_extra_install_directories() {
        let directory = tempfile::tempdir().unwrap();
        let file = make_executable(directory.path(), "m6069-known-cli");

        let found = resolve_blocking(
            &["m6069-known-cli"],
            &[directory.path().to_path_buf()],
            &LaunchEnvironment::from_path(None),
        )
        .expect("命令应在额外安装目录里被找到");

        assert_eq!(found.path.file_name(), file.file_name());
        assert_eq!(found.path.parent(), Some(directory.path()));
    }

    #[test]
    fn returns_none_when_no_candidate_matches() {
        let directory = tempfile::tempdir().unwrap();

        assert!(resolve_blocking(
            &["m6069-missing-cli-a", "m6069-missing-cli-b"],
            &[directory.path().to_path_buf()],
            &environment_with(directory.path()),
        )
        .is_none());
    }

    #[test]
    fn candidates_are_tried_in_order() {
        let directory = tempfile::tempdir().unwrap();
        let first = make_executable(directory.path(), "m6069-order-first");
        make_executable(directory.path(), "m6069-order-second");

        let found = resolve_blocking(
            &["m6069-order-first", "m6069-order-second"],
            &[],
            &environment_with(directory.path()),
        )
        .unwrap();

        assert_eq!(found.command, "m6069-order-first");
        assert_eq!(found.path.file_name(), first.file_name());
    }

    #[tokio::test]
    async fn async_resolution_matches_blocking_and_a_slow_one_is_abandoned() {
        let directory = tempfile::tempdir().unwrap();
        make_executable(directory.path(), "m6069-async-cli");
        let environment = environment_with(directory.path());

        let blocking = resolve_blocking(&["m6069-async-cli"], &[], &environment);
        let resolved = resolve(
            &["m6069-async-cli"],
            &[],
            &environment,
            Duration::from_secs(30),
        )
        .await;
        assert!(blocking.is_some());
        assert_eq!(resolved, blocking);

        // 慢解析在预算耗尽后被放弃，结果为 None。
        let abandoned = resolve_with(
            || {
                std::thread::sleep(Duration::from_millis(300));
                Some(ResolvedExecutable {
                    command: "slow".to_string(),
                    path: PathBuf::from("slow"),
                })
            },
            Duration::from_millis(10),
        )
        .await;
        assert!(abandoned.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn known_windows_install_dirs_include_user_local_bin() {
        use std::ffi::OsString;
        use std::path::PathBuf;

        let dirs = super::windows_user_install_dirs(Some(OsString::from(r"C:\Users\tester")));
        assert_eq!(dirs, vec![PathBuf::from(r"C:\Users\tester\.local\bin")]);
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
