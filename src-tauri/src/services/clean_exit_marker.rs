//! Clean-exit marker for the abnormal-exit notice (PD-12).
//!
//! The running marker lives in `data_dir` (not `cache_dir`, which "clear cache" may wipe) and
//! holds only a start timestamp and a process id. `end_session_cleanly` is called only from the
//! `RunEvent::Exit` branch: `ExitRequested` can be prevented, so clearing there would lie.
//! Every IO failure is logged and never blocks startup.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::services::storage_service::StoragePaths;

pub const MARKER_FILE_NAME: &str = "session-running.marker";
pub const LAST_CLEAN_EXIT_FILE_NAME: &str = "last-clean-exit.marker";
const TEMP_MARKER_FILE_NAME: &str = "session-running.marker.tmp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviousExit {
    FirstRun,
    Clean,
    Abnormal { started_at_ms: Option<i64> },
    Unreadable,
}

/// Reads the previous session's state, then records this session's marker.
pub fn begin_session(paths: &StoragePaths, now_ms: i64) -> PreviousExit {
    if let Err(error) = std::fs::create_dir_all(&paths.data_dir) {
        log::warn!("clean-exit marker: unable to create data dir: {error}");
        return PreviousExit::Unreadable;
    }
    let previous = match std::fs::symlink_metadata(marker_path(paths)) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if last_clean_path(paths).is_file() {
                PreviousExit::Clean
            } else {
                PreviousExit::FirstRun
            }
        }
        Err(error) => {
            log::warn!("clean-exit marker: unable to inspect marker: {error}");
            return PreviousExit::Unreadable;
        }
        Ok(metadata) if !metadata.is_file() => {
            log::warn!("clean-exit marker path is not a regular file; leaving it untouched");
            return PreviousExit::Unreadable;
        }
        Ok(_) => read_abnormal(&marker_path(paths)),
    };
    write_marker(paths, now_ms);
    previous
}

/// Clears the running marker after a graceful exit and records that the last exit was clean.
/// Never panics and never returns an error; it removes only files, never directories.
pub fn end_session_cleanly(paths: &StoragePaths) {
    match std::fs::remove_file(marker_path(paths)) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            log::warn!("clean-exit marker: unable to remove marker: {error}");
            return;
        }
    }
    if let Err(error) = std::fs::write(last_clean_path(paths), "{}") {
        log::warn!("clean-exit marker: unable to record clean exit: {error}");
    }
}

fn marker_path(paths: &StoragePaths) -> PathBuf {
    paths.data_dir.join(MARKER_FILE_NAME)
}

fn last_clean_path(paths: &StoragePaths) -> PathBuf {
    paths.data_dir.join(LAST_CLEAN_EXIT_FILE_NAME)
}

fn read_abnormal(marker: &Path) -> PreviousExit {
    // Anything unexpected in the file still means the previous session did not exit cleanly.
    let started_at_ms = std::fs::read(marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value["startedAtMs"].as_i64());
    PreviousExit::Abnormal { started_at_ms }
}

fn write_marker(paths: &StoragePaths, now_ms: i64) {
    let content =
        serde_json::json!({ "startedAtMs": now_ms, "pid": std::process::id() }).to_string();
    let temp = paths.data_dir.join(TEMP_MARKER_FILE_NAME);
    let result =
        std::fs::write(&temp, content).and_then(|()| std::fs::rename(&temp, marker_path(paths)));
    if let Err(error) = result {
        log::warn!("clean-exit marker: unable to write marker: {error}");
        let _ = std::fs::remove_file(&temp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_paths() -> (tempfile::TempDir, StoragePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = StoragePaths::from_root(dir.path().to_path_buf());
        (dir, paths)
    }

    fn read_marker(paths: &StoragePaths) -> serde_json::Value {
        let bytes = std::fs::read(paths.data_dir.join(MARKER_FILE_NAME)).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn first_run_has_no_marker_and_writes_one() {
        let (_dir, paths) = new_paths();
        assert_eq!(begin_session(&paths, 1000), PreviousExit::FirstRun);
        let marker = read_marker(&paths);
        let mut keys: Vec<&str> = marker
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["pid", "startedAtMs"]);
        assert_eq!(marker["startedAtMs"].as_i64(), Some(1000));
        assert_eq!(marker["pid"].as_u64(), Some(u64::from(std::process::id())));
        let text = std::fs::read_to_string(paths.data_dir.join(MARKER_FILE_NAME)).unwrap();
        assert!(!text.contains(paths.root.to_string_lossy().as_ref()));
        assert!(!paths.data_dir.join("session-running.marker.tmp").exists());
    }

    #[test]
    fn clean_exit_removes_the_marker() {
        let (_dir, paths) = new_paths();
        assert_eq!(begin_session(&paths, 1000), PreviousExit::FirstRun);
        end_session_cleanly(&paths);
        assert!(!paths.data_dir.join(MARKER_FILE_NAME).exists());
        assert_eq!(begin_session(&paths, 2000), PreviousExit::Clean);
        assert_eq!(read_marker(&paths)["startedAtMs"].as_i64(), Some(2000));
    }

    #[test]
    fn leftover_marker_reports_abnormal_with_the_previous_start_time() {
        let (_dir, paths) = new_paths();
        begin_session(&paths, 1000);
        assert_eq!(
            begin_session(&paths, 2000),
            PreviousExit::Abnormal {
                started_at_ms: Some(1000)
            }
        );
        assert_eq!(read_marker(&paths)["startedAtMs"].as_i64(), Some(2000));
        end_session_cleanly(&paths);
        assert_eq!(begin_session(&paths, 3000), PreviousExit::Clean);
    }

    #[test]
    fn corrupt_marker_is_still_abnormal_not_an_error() {
        let contents: [&[u8]; 5] = [
            b"{broken",
            b"",
            &[0xff, 0xfe, 0x00, 0x80],
            br#"{"startedAtMs":"x"}"#,
            br#"{"pid":1}"#,
        ];
        for bytes in contents {
            let (_dir, paths) = new_paths();
            std::fs::create_dir_all(&paths.data_dir).unwrap();
            std::fs::write(paths.data_dir.join(MARKER_FILE_NAME), bytes).unwrap();
            let previous = begin_session(&paths, 5000);
            assert_eq!(
                previous,
                PreviousExit::Abnormal {
                    started_at_ms: None
                },
                "content {bytes:?}"
            );
            assert_eq!(read_marker(&paths)["startedAtMs"].as_i64(), Some(5000));
        }
    }

    #[test]
    fn unwritable_data_dir_never_blocks_startup() {
        // A: the marker path is occupied by a directory.
        let (_dir_a, paths_a) = new_paths();
        std::fs::create_dir_all(&paths_a.data_dir).unwrap();
        std::fs::create_dir(paths_a.data_dir.join(MARKER_FILE_NAME)).unwrap();
        assert_eq!(begin_session(&paths_a, 1), PreviousExit::Unreadable);
        assert!(paths_a.data_dir.join(MARKER_FILE_NAME).is_dir());
        end_session_cleanly(&paths_a);
        assert!(paths_a.data_dir.join(MARKER_FILE_NAME).is_dir());

        // B: data_dir itself is a file.
        let (_dir_b, paths_b) = new_paths();
        std::fs::create_dir_all(&paths_b.root).unwrap();
        std::fs::write(&paths_b.data_dir, b"x").unwrap();
        assert_eq!(begin_session(&paths_b, 1), PreviousExit::Unreadable);
        end_session_cleanly(&paths_b);
    }

    #[test]
    fn end_session_is_idempotent() {
        let (_dir, paths) = new_paths();
        begin_session(&paths, 1);
        end_session_cleanly(&paths);
        end_session_cleanly(&paths);
        end_session_cleanly(&paths);
        assert!(!paths.data_dir.join(MARKER_FILE_NAME).exists());
        assert!(paths.data_dir.join(LAST_CLEAN_EXIT_FILE_NAME).exists());
        assert!(!paths.data_dir.join("session-running.marker.tmp").exists());

        let (_other_dir, other) = new_paths();
        end_session_cleanly(&other);
    }

    #[test]
    fn marker_is_started_only_from_setup_and_cleared_only_on_graceful_exit() {
        const LIB_RS: &str = include_str!("../lib.rs");
        assert_eq!(LIB_RS.matches("begin_session(").count(), 1);
        let setup =
            &LIB_RS[LIB_RS.find(".setup(|app|").unwrap()..LIB_RS.find(".invoke_handler(").unwrap()];
        assert_eq!(setup.matches("begin_session(").count(), 1);
        // lib.rs no longer calls end_session_cleanly directly: the Exit arm delegates.
        assert_eq!(LIB_RS.matches("end_session_cleanly(").count(), 0);
        let run_event = &LIB_RS[LIB_RS.find("fn handle_run_event").unwrap()
            ..LIB_RS.find("fn show_main_window").unwrap()];
        let exit_index = run_event.find("tauri::RunEvent::Exit =>").unwrap();
        assert!(run_event[exit_index..].contains("on_run_event_exit("));
        assert!(!run_event[..exit_index].contains("on_run_event_exit("));
        assert!(!run_event[..exit_index].contains("begin_session("));
        // the only call site lives inside on_run_event_exit
        const EXIT_CLEANUP_RS: &str = include_str!("exit_cleanup.rs");
        assert_eq!(EXIT_CLEANUP_RS.matches("end_session_cleanly(").count(), 1);
        let handler = &EXIT_CLEANUP_RS[EXIT_CLEANUP_RS.find("pub fn on_run_event_exit").unwrap()..];
        assert!(handler.contains("end_session_cleanly("));
    }
}
