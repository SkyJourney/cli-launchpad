use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, Result};
use rusqlite::Connection;
use serde_json::Value;

use crate::db::directory_repo;
use crate::models::session::SessionInfo;
use crate::models::tool::ToolKey;

const TITLE_MAX_CHARS: usize = 100;

/// Resolve a directory id to its filesystem path (the input to session reading).
pub fn directory_path(conn: &Connection, directory_id: i64) -> Result<String> {
    directory_repo::get(conn, directory_id)?
        .map(|directory| directory.path)
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))
}

pub fn list_sessions(tool_key: ToolKey, directory_path: &str) -> Result<Vec<SessionInfo>> {
    let mut sessions = match tool_key {
        ToolKey::Claude => list_claude_sessions(directory_path)?,
        ToolKey::Codex => list_codex_sessions(directory_path)?,
        // Antigravity does not expose an on-disk session listing.
        ToolKey::Antigravity => Vec::new(),
    };
    sessions.sort_by(|a, b| b.last_active_ms.cmp(&a.last_active_ms));
    Ok(sessions)
}

fn home_dir() -> Result<PathBuf> {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .map_err(|_| anyhow!("无法确定用户主目录，不能读取会话历史"))
}

/// Claude Code stores sessions under `~/.claude/projects/<slug>/`, where the
/// slug replaces every non-alphanumeric path character with `-`.
/// Verified against `C:\Projects\cli-launchpad` -> `C--Projects-cli-launchpad`.
fn claude_slug(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn list_claude_sessions(directory_path: &str) -> Result<Vec<SessionInfo>> {
    let home = home_dir()?;
    let dir = home
        .join(".claude")
        .join("projects")
        .join(claude_slug(directory_path));
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        sessions.push(SessionInfo {
            tool_key: ToolKey::Claude,
            session_id: session_id.to_string(),
            title: claude_title(&path).unwrap_or_else(|| "(无标题会话)".to_string()),
            last_active_ms: mtime_ms(&path),
        });
    }
    Ok(sessions)
}

fn claude_title(path: &Path) -> Option<String> {
    let reader = BufReader::new(File::open(path).ok()?);
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if let Some(text) = message_text(&value) {
            return Some(truncate_chars(&text, TITLE_MAX_CHARS));
        }
    }
    None
}

/// Extract user-authored text from a Claude entry's `message.content`.
fn message_text(entry: &Value) -> Option<String> {
    extract_text_content(entry.get("message")?.get("content")?)
}

/// Extract text from a `content` value that is either a plain string or an
/// array of blocks (`{... "text": "..."}`). Shared by Claude and Codex parsing.
fn extract_text_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(items) = content.as_array() {
        for item in items {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn list_codex_sessions(directory_path: &str) -> Result<Vec<SessionInfo>> {
    let home = home_dir()?;
    let root = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_rollout_files(&root, &mut files, 0)?;

    let mut sessions = Vec::new();
    for path in files {
        if let Some(session) = parse_codex_rollout(&path, directory_path) {
            sessions.push(session);
        }
    }
    Ok(sessions)
}

/// Recursively collect `rollout-*.jsonl` files. Depth-bounded since Codex lays
/// sessions out as `YYYY/MM/DD/rollout-*.jsonl`.
fn collect_rollout_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) -> Result<()> {
    if depth > 5 {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_files(&path, out, depth + 1)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with("rollout-") {
                out.push(path);
            }
        }
    }
    Ok(())
}

pub fn session_belongs_to_directory(
    tool_key: ToolKey,
    directory_path: &str,
    session_id: &str,
) -> Result<bool> {
    if tool_key == ToolKey::Antigravity {
        return Ok(false);
    }
    Ok(list_sessions(tool_key, directory_path)?
        .iter()
        .any(|session| session.session_id == session_id))
}

/// Scan at most this many lines for session metadata; Codex writes the session
/// header at the top, so an unbounded scan of an unrelated file is wasteful.
const CODEX_META_SCAN_LINES: usize = 200;

fn parse_codex_rollout(path: &Path, directory_path: &str) -> Option<SessionInfo> {
    let reader = BufReader::new(File::open(path).ok()?);
    let mut id = None;
    let mut cwd_matched = false;
    let mut title = None;

    for line in reader
        .lines()
        .map_while(Result::ok)
        .take(CODEX_META_SCAN_LINES)
    {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !cwd_matched {
            if let Some(cwd) = find_string_field(&value, "cwd") {
                // Reject as soon as the owning directory is known and differs,
                // so unrelated rollouts are not read in full.
                if !paths_match(&cwd, directory_path) {
                    return None;
                }
                cwd_matched = true;
            }
        }
        if id.is_none() {
            id = find_string_field(&value, "id");
        }
        if title.is_none() {
            title = codex_user_text(&value);
        }
        if cwd_matched && id.is_some() && title.is_some() {
            break;
        }
    }

    if !cwd_matched {
        return None;
    }
    let session_id = id.or_else(|| uuid_from_filename(path))?;

    Some(SessionInfo {
        tool_key: ToolKey::Codex,
        session_id,
        title: title
            .map(|t| truncate_chars(&t, TITLE_MAX_CHARS))
            .unwrap_or_else(|| "(Codex 会话)".to_string()),
        last_active_ms: mtime_ms(path),
    })
}

/// Find a string field by key at the top level or one level under `payload`.
fn find_string_field(value: &Value, key: &str) -> Option<String> {
    if let Some(found) = value.get(key).and_then(Value::as_str) {
        return Some(found.to_string());
    }
    value
        .get("payload")
        .and_then(|p| p.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extract user text from a Codex record (top-level or under `payload`).
fn codex_user_text(value: &Value) -> Option<String> {
    let candidate = if value.get("role").is_some() {
        value
    } else {
        value.get("payload")?
    };
    if candidate.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    extract_text_content(candidate.get("content")?)
}

/// Extract a UUID from a `rollout-<timestamp>-<uuid>` filename. The timestamp
/// also contains hyphens, so we slide a 5-group window and validate the
/// 8-4-4-4-12 hex shape rather than assuming a fixed segment count.
fn uuid_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts: Vec<&str> = stem.split('-').collect();
    parts
        .windows(5)
        .find(|window| is_uuid_groups(window))
        .map(|window| window.join("-"))
}

fn is_uuid_groups(groups: &[&str]) -> bool {
    const EXPECTED: [usize; 5] = [8, 4, 4, 4, 12];
    groups.len() == 5
        && groups
            .iter()
            .zip(EXPECTED)
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Compare two filesystem paths for equality, tolerant of separator and case
/// differences on Windows and a trailing separator.
fn paths_match(a: &str, b: &str) -> bool {
    normalize_path(a) == normalize_path(b)
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

fn truncate_chars(value: &str, max: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max {
        value.to_string()
    } else {
        let mut truncated: String = chars[..max].iter().collect();
        truncated.push('…');
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_known_example() {
        assert_eq!(
            claude_slug("C:\\Projects\\cli-launchpad"),
            "C--Projects-cli-launchpad"
        );
    }

    #[test]
    fn paths_match_ignores_separators_and_case() {
        assert!(paths_match("C:/Projects/Demo", "c:\\projects\\demo\\"));
        assert!(!paths_match("C:\\a", "C:\\b"));
    }

    #[test]
    fn claude_message_text_reads_array_blocks() {
        let entry: Value = serde_json::from_str(
            r#"{"type":"user","message":{"content":[{"type":"text","text":"hello world"}]}}"#,
        )
        .unwrap();
        assert_eq!(message_text(&entry).as_deref(), Some("hello world"));
    }

    #[test]
    fn truncate_appends_ellipsis() {
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        assert_eq!(truncate_chars("ab", 3), "ab");
    }

    #[test]
    fn uuid_extracted_from_rollout_name() {
        let path =
            Path::new("rollout-2025-06-01T12-00-00-7f9f9a2e-1b3c-4c7a-9b0e-abcdef012345.jsonl");
        assert_eq!(
            uuid_from_filename(path).as_deref(),
            Some("7f9f9a2e-1b3c-4c7a-9b0e-abcdef012345")
        );
    }
}
