use std::future::Future;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use rusqlite::Connection;

use crate::db::{directory_repo, tool_repo};
use crate::models::tool::ToolKey;
use crate::services::cli_adapters::{self, CliAdapter};

#[derive(Debug, Clone)]
pub(crate) struct CliLaunchPayload {
    pub directory: String,
    pub tool_executable: String,
    pub tool_args: Vec<String>,
}

/// Database stage only. The caller validates the path outside the database lock
/// (directory_service::validate_path).
pub(crate) fn lookup_launch_directory(
    connection: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<String> {
    let directory = directory_repo::get(connection, directory_id)?
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))?;
    if !tool_repo::exists(connection, tool_key)? {
        return Err(anyhow!("tool {} is not configured", tool_key.as_str()));
    }
    Ok(directory.path)
}

/// Synchronous composition of the database stage and the path check, kept for
/// the existing tests that exercise both.
#[cfg(test)]
pub(crate) fn resolve_launch_directory(
    connection: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<String> {
    let directory = lookup_launch_directory(connection, directory_id, tool_key)?;
    crate::services::directory_service::validate_path(&directory)?;
    Ok(directory)
}

pub(crate) async fn resolve_payload_with_resolver<F, Fut>(
    directory: String,
    tool_key: ToolKey,
    resume_session_id: Option<&str>,
    resolve: F,
) -> Result<CliLaunchPayload>
where
    F: FnOnce(&'static dyn CliAdapter) -> Fut,
    Fut: Future<Output = Option<PathBuf>>,
{
    // 先校验恢复参数（快速失败），再解析可执行文件：参数无效时不做任何机器探测。
    let tool_args = match resume_session_id {
        Some(session_id) => cli_adapters::resume_args(tool_key, session_id)?,
        None => Vec::new(),
    };
    let adapter = cli_adapters::get(tool_key);
    let executable = resolve(adapter)
        .await
        .ok_or_else(|| anyhow!("未检测到 {}，请先在设置中安装后再启动", tool_key.as_str()))?;
    Ok(CliLaunchPayload {
        directory,
        tool_executable: executable.display().to_string(),
        tool_args,
    })
}

pub(crate) async fn resolve_payload_at_directory(
    directory: String,
    tool_key: ToolKey,
    resume_session_id: Option<&str>,
) -> Result<CliLaunchPayload> {
    resolve_payload_with_resolver(
        directory,
        tool_key,
        resume_session_id,
        cli_adapters::installed_path_async,
    )
    .await
}

#[cfg(test)]
fn apply_resume(payload: &mut CliLaunchPayload, tool_key: ToolKey, session_id: &str) -> Result<()> {
    payload.tool_args = cli_adapters::resume_args(tool_key, session_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_resume, resolve_launch_directory, resolve_payload_with_resolver, CliLaunchPayload,
    };

    #[tokio::test]
    async fn normal_payload_ignores_legacy_project_arguments() {
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
        // directory_tool_args 在目标 078 的迁移 0015 中删除；届时 078 负责去掉这段插入并断言该表已不存在（RS-T26）。
        connection
            .execute(
                "insert into directory_tool_args (directory_id, tool_key, args) values (?1, 'claude', '--ignored-project')",
                [record.id],
            )
            .unwrap();

        let directory_path =
            resolve_launch_directory(&connection, record.id, ToolKey::Claude).unwrap();
        let payload = resolve_payload_with_resolver(
            directory_path.clone(),
            ToolKey::Claude,
            None,
            |_adapter| async { Some(std::path::PathBuf::from("claude")) },
        )
        .await
        .unwrap();

        assert!(payload.tool_args.is_empty());
        assert_eq!(payload.tool_executable, "claude");
        assert_eq!(payload.directory, directory_path);
    }

    #[tokio::test]
    async fn resume_validation_failure_produces_no_launch_payload() {
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        use crate::models::tool::ToolKey;

        const VALID_UUID: &str = "123e4567-e89b-42d3-a456-426614174000";

        for invalid in ["../evil", "-x"] {
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&calls);
            let error = resolve_payload_with_resolver(
                "project".to_string(),
                ToolKey::Claude,
                Some(invalid),
                move |_adapter| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async { Some(PathBuf::from("/opt/cli")) }
                },
            )
            .await
            .unwrap_err();
            assert!(
                error.to_string().contains("会话 ID 格式无效"),
                "{invalid}: {error}"
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "{invalid}: 解析器不应被调用"
            );
        }

        let missing = resolve_payload_with_resolver(
            "project".to_string(),
            ToolKey::Claude,
            Some(VALID_UUID),
            |_adapter| async { None },
        )
        .await
        .unwrap_err();
        assert!(missing.to_string().contains("未检测到"), "{missing}");

        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let payload = resolve_payload_with_resolver(
            "project".to_string(),
            ToolKey::Claude,
            Some(VALID_UUID),
            move |_adapter| {
                counter.fetch_add(1, Ordering::SeqCst);
                async { Some(PathBuf::from("/opt/cli")) }
            },
        )
        .await
        .unwrap();
        assert_eq!(
            payload.tool_args,
            vec!["--resume".to_string(), VALID_UUID.to_string()]
        );
        assert_eq!(
            payload.tool_executable,
            PathBuf::from("/opt/cli").display().to_string()
        );
        assert_eq!(payload.directory, "project");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
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

    #[test]
    fn lookup_launch_directory_reads_the_row_without_validating_the_path() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_str().unwrap().to_string();
        drop(directory);
        let record = crate::db::directory_repo::add(&connection, "ghost", &path, None).unwrap();

        let looked_up = super::lookup_launch_directory(
            &connection,
            record.id,
            crate::models::tool::ToolKey::Claude,
        )
        .unwrap();

        assert_eq!(looked_up, path);
        assert!(
            crate::services::directory_service::validate_path(&path).is_err(),
            "the directory was removed, so only validate_path (not the lookup) may reject it"
        );
    }

    #[test]
    fn lookup_launch_directory_rejects_an_unconfigured_tool() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let record = crate::db::directory_repo::add(
            &connection,
            "demo",
            directory.path().to_str().unwrap(),
            None,
        )
        .unwrap();
        connection
            .execute("delete from tools where key = 'claude'", [])
            .unwrap();

        let error = super::lookup_launch_directory(
            &connection,
            record.id,
            crate::models::tool::ToolKey::Claude,
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("is not configured"),
            "unexpected error: {error}"
        );
    }
}
