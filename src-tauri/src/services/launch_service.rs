use anyhow::{anyhow, Result};
use rusqlite::Connection;

use crate::db::{directory_repo, tool_repo};
use crate::models::tool::ToolKey;
use crate::services::cli_adapters;

#[derive(Debug, Clone)]
pub(crate) struct CliLaunchPayload {
    pub directory: String,
    pub tool_executable: String,
    pub tool_args: Vec<String>,
}

pub(crate) fn resolve_launch_directory(
    connection: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<String> {
    let directory = directory_repo::get(connection, directory_id)?
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))?;
    crate::services::directory_service::validate_path(&directory.path)?;
    if !tool_repo::exists(connection, tool_key)? {
        return Err(anyhow!("tool {} is not configured", tool_key.as_str()));
    }
    Ok(directory.path)
}

pub(crate) async fn resolve_payload_at_directory(
    directory: String,
    tool_key: ToolKey,
    resume_session_id: Option<&str>,
) -> Result<CliLaunchPayload> {
    let adapter = cli_adapters::get(tool_key);
    let executable = cli_adapters::installed_path_async(adapter)
        .await
        .ok_or_else(|| anyhow!("未检测到 {}，请先在设置中安装后再启动", tool_key.as_str()))?;
    let tool_args = match resume_session_id {
        Some(session_id) => cli_adapters::resume_args(tool_key, session_id)?,
        None => Vec::new(),
    };
    Ok(CliLaunchPayload {
        directory,
        tool_executable: executable.display().to_string(),
        tool_args,
    })
}

#[cfg(test)]
fn apply_resume(payload: &mut CliLaunchPayload, tool_key: ToolKey, session_id: &str) -> Result<()> {
    payload.tool_args = cli_adapters::resume_args(tool_key, session_id)?;
    Ok(())
}

#[cfg(test)]
fn resolve_payload_with(
    connection: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
    resolve_executable: impl FnOnce(ToolKey) -> Result<String>,
) -> Result<CliLaunchPayload> {
    let directory = directory_repo::get(connection, directory_id)?
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))?;
    crate::services::directory_service::validate_path(&directory.path)?;
    if !tool_repo::exists(connection, tool_key)? {
        return Err(anyhow!("tool {} is not configured", tool_key.as_str()));
    }

    Ok(CliLaunchPayload {
        directory: directory.path,
        tool_executable: resolve_executable(tool_key)?,
        tool_args: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::{apply_resume, resolve_payload_with, CliLaunchPayload};

    #[test]
    fn normal_payload_ignores_legacy_project_arguments() {
        use rusqlite::Connection;

        use crate::db::{connection, directory_repo};
        use crate::models::tool::ToolKey;

        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection::apply_migrations(&connection).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let record = directory_repo::add(
            &connection,
            "demo",
            directory.path().to_str().unwrap(),
            None,
        )
        .unwrap();
        connection
            .execute(
                "insert into directory_tool_args (directory_id, tool_key, args) values (?1, 'claude', '--ignored-project')",
                [record.id],
            )
            .unwrap();

        let payload = resolve_payload_with(&connection, record.id, ToolKey::Claude, |_| {
            Ok("claude".to_string())
        })
        .unwrap();

        assert!(payload.tool_args.is_empty());
    }

    #[test]
    fn resume_keeps_only_the_selected_cli_internal_arguments() {
        use crate::models::tool::ToolKey;

        let cases = [
            (
                ToolKey::Claude,
                vec!["--resume".to_string(), "session-1".to_string()],
            ),
            (
                ToolKey::Codex,
                vec!["resume".to_string(), "session-1".to_string()],
            ),
            (
                ToolKey::Antigravity,
                vec!["--conversation=session-1".to_string()],
            ),
            (
                ToolKey::Grok,
                vec!["--resume".to_string(), "session-1".to_string()],
            ),
            (
                ToolKey::Hermes,
                vec![
                    "--resume".to_string(),
                    "session-1".to_string(),
                    "--no-restore-cwd".to_string(),
                ],
            ),
        ];

        for (tool_key, expected) in cases {
            let mut payload = CliLaunchPayload {
                directory: "project".to_string(),
                tool_executable: "cli".to_string(),
                tool_args: Vec::new(),
            };
            apply_resume(&mut payload, tool_key, "session-1").unwrap();
            assert_eq!(payload.tool_args, expected);
        }
    }
}
