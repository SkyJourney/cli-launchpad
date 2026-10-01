use std::process::Command;

use anyhow::{anyhow, Result};
use rusqlite::Connection;

use crate::db::{app_setting_repo, directory_repo, launch_history_repo, tool_repo};
use crate::models::launch_history::LaunchAction;
use crate::models::terminal::TerminalEnvironment;
use crate::models::tool::ToolKey;
#[cfg(target_os = "macos")]
use crate::platform::terminal_launch::MACOS_COMMAND_DOCUMENT_PLACEHOLDER;
use crate::platform::terminal_launch::{
    build_launch_plan, preview_plan, ComposedCommand, LaunchCandidate, LaunchPayload, LaunchPlan,
};
use crate::services::cli_adapters;
use crate::services::storage_service::StoragePaths;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

const NON_INTERACTIVE_COLOR_ENVIRONMENT_REMOVALS: [&str; 7] = [
    "NO_COLOR",
    "TERM",
    "COLORTERM",
    "CI",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "FORCE_COLOR",
];

pub fn preview(
    conn: &Connection,
    environment: &TerminalEnvironment,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<String> {
    let payload = resolve_payload(conn, directory_id, tool_key)?;
    let preference = app_setting_repo::get_launch_target(conn)?;
    let plan = build_launch_plan(payload, environment, &preference)?;
    Ok(preview_plan(&plan))
}

pub fn launch(
    conn: &Connection,
    environment: &TerminalEnvironment,
    storage: &StoragePaths,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<()> {
    let result = (|| {
        let payload = resolve_payload(conn, directory_id, tool_key)?;
        let preference = app_setting_repo::get_launch_target(conn)?;
        let launched = build_and_spawn(payload, environment, &preference, storage)?;
        directory_repo::touch_last_used(conn, directory_id)?;
        Ok(launched)
    })();
    record_and_log_result(conn, result, LaunchAction::Launch, directory_id, tool_key)
}

pub fn resume(
    conn: &Connection,
    environment: &TerminalEnvironment,
    storage: &StoragePaths,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: &str,
) -> Result<()> {
    let result = (|| {
        let mut payload = resolve_payload(conn, directory_id, tool_key)?;
        apply_resume(&mut payload, tool_key, session_id)?;
        let preference = app_setting_repo::get_launch_target(conn)?;
        let launched = build_and_spawn(payload, environment, &preference, storage)?;
        directory_repo::touch_last_used(conn, directory_id)?;
        Ok(launched)
    })();
    record_and_log_result(conn, result, LaunchAction::Resume, directory_id, tool_key)
}

fn build_and_spawn(
    payload: LaunchPayload,
    environment: &TerminalEnvironment,
    preference: &str,
    storage: &StoragePaths,
) -> Result<String> {
    let plan = build_launch_plan(payload, environment, preference)?;
    spawn_plan(&plan, storage)
}

fn spawn_plan(plan: &LaunchPlan, storage: &StoragePaths) -> Result<String> {
    let mut errors = Vec::new();
    for (index, candidate) in plan.candidates.iter().enumerate() {
        match spawn_candidate(candidate, &plan.payload, storage) {
            Ok(()) => {
                if index > 0 {
                    log::warn!(
                        "terminal launch used fallback index={index} target={} label={}",
                        candidate.target_id,
                        candidate.label
                    );
                }
                return Ok(candidate.label.clone());
            }
            Err(error) => {
                log::warn!(
                    "terminal launch candidate failed index={index} target={} error={error}",
                    candidate.target_id
                );
                errors.push(format!("{}：{error}", candidate.label));
            }
        }
    }
    Err(anyhow!("所有终端启动方式均失败：{}", errors.join("；")))
}

#[cfg(target_os = "macos")]
fn spawn_candidate(
    candidate: &LaunchCandidate,
    payload: &LaunchPayload,
    storage: &StoragePaths,
) -> Result<()> {
    if !candidate.requires_macos_command_document {
        return spawn_command(&candidate.command);
    }

    let artifacts = crate::platform::macos_launch_artifacts::prepare(&storage.cache_dir, payload)?;
    let helper_path = artifacts
        .helper_path
        .to_str()
        .ok_or_else(|| anyhow!("macOS 启动载荷路径不是有效 UTF-8"))?;
    let mut command = candidate.command.clone();
    let mut replaced = false;
    for arg in &mut command.args {
        if arg == MACOS_COMMAND_DOCUMENT_PLACEHOLDER {
            *arg = helper_path.to_string();
            replaced = true;
        }
    }
    if !replaced {
        artifacts.cleanup();
        return Err(anyhow!("macOS Terminal.app 启动计划缺少命令文档占位符"));
    }
    match spawn_command(&command) {
        Ok(()) => Ok(()),
        Err(error) => {
            artifacts.cleanup();
            Err(error)
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn spawn_candidate(
    candidate: &LaunchCandidate,
    _payload: &LaunchPayload,
    _storage: &StoragePaths,
) -> Result<()> {
    spawn_command(&candidate.command)
}

fn spawn_command(command: &ComposedCommand) -> Result<()> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    remove_non_interactive_color_environment(&mut process);
    #[cfg(windows)]
    if let Some(path) = crate::platform::windows_environment::merged_registered_path(
        std::env::var_os("PATH").as_deref(),
    ) {
        process.env("PATH", path);
    }
    if let Some(directory) = &command.working_dir {
        process.current_dir(directory);
    }
    #[cfg(windows)]
    if command.new_console {
        use std::os::windows::process::CommandExt;
        process.creation_flags(CREATE_NEW_CONSOLE);
    }
    process.spawn()?;
    Ok(())
}

fn remove_non_interactive_color_environment(process: &mut Command) {
    for key in NON_INTERACTIVE_COLOR_ENVIRONMENT_REMOVALS {
        process.env_remove(key);
    }
}

fn record_and_log_result(
    connection: &Connection,
    result: Result<String>,
    action: LaunchAction,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<()> {
    let error_category = result.as_ref().err().map(|_| "launch_failed");
    if launch_history_repo::record(
        connection,
        directory_id,
        tool_key,
        action,
        result.is_ok(),
        error_category,
    )
    .is_err()
    {
        log::warn!("unable to record launch history");
    }
    match result {
        Ok(terminal_label) => {
            log::info!(
                "cli action launched action={} directory_id={directory_id} tool={} terminal={terminal_label}",
                action.as_str(),
                tool_key.as_str()
            );
            Ok(())
        }
        Err(error) => {
            log::error!(
                "cli action failed action={} directory_id={directory_id} tool={}",
                action.as_str(),
                tool_key.as_str()
            );
            Err(error)
        }
    }
}

fn apply_resume(payload: &mut LaunchPayload, tool_key: ToolKey, session_id: &str) -> Result<()> {
    payload.tool_args =
        cli_adapters::resume_args(tool_key, session_id, std::mem::take(&mut payload.tool_args))?;
    Ok(())
}

pub(crate) fn resolve_resume_payload(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: &str,
) -> Result<LaunchPayload> {
    let mut payload = resolve_payload(conn, directory_id, tool_key)?;
    apply_resume(&mut payload, tool_key, session_id)?;
    Ok(payload)
}

pub(crate) fn resolve_payload(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<LaunchPayload> {
    resolve_payload_with(conn, directory_id, tool_key, resolve_tool_executable)
}

fn resolve_payload_with(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
    resolve_executable: impl FnOnce(ToolKey) -> Result<String>,
) -> Result<LaunchPayload> {
    let directory = directory_repo::get(conn, directory_id)?
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))?;
    crate::services::directory_service::validate_path(&directory.path)?;
    if !tool_repo::exists(conn, tool_key)? {
        return Err(anyhow!("tool {} is not configured", tool_key.as_str()));
    }

    Ok(LaunchPayload {
        directory: directory.path,
        tool_executable: resolve_executable(tool_key)?,
        tool_args: Vec::new(),
    })
}

fn resolve_tool_executable(tool_key: ToolKey) -> Result<String> {
    cli_adapters::installed_path(cli_adapters::get(tool_key))
        .map(|path| path.display().to_string())
        .ok_or_else(|| anyhow!("未检测到 {}，请先在设置中安装后再启动", tool_key.as_str()))
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::{
        apply_resume, remove_non_interactive_color_environment, resolve_payload_with,
        NON_INTERACTIVE_COLOR_ENVIRONMENT_REMOVALS,
    };

    #[test]
    fn normal_payload_ignores_saved_global_and_project_arguments() {
        use rusqlite::Connection;

        use crate::db::{connection, directory_repo};
        use crate::models::tool::ToolKey;

        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection::apply_migrations(&conn).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let record =
            directory_repo::add(&conn, "demo", directory.path().to_str().unwrap(), None).unwrap();
        conn.execute(
            "update tools set global_args = '--ignored-global' where key = 'claude'",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into directory_tool_args (directory_id, tool_key, args) values (?1, 'claude', '--ignored-project')",
            [record.id],
        )
        .unwrap();

        let payload = resolve_payload_with(&conn, record.id, ToolKey::Claude, |_| {
            Ok("claude".to_string())
        })
        .unwrap();

        assert!(payload.tool_args.is_empty());
    }

    #[test]
    fn resume_keeps_only_the_selected_cli_internal_arguments() {
        use crate::models::tool::ToolKey;
        use crate::platform::terminal_launch::LaunchPayload;

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
            let mut payload = LaunchPayload {
                directory: "project".to_string(),
                tool_executable: "cli".to_string(),
                tool_args: Vec::new(),
            };
            apply_resume(&mut payload, tool_key, "session-1").unwrap();
            assert_eq!(payload.tool_args, expected);
        }
    }

    #[test]
    fn terminal_launches_remove_non_interactive_color_environment() {
        use std::ffi::OsStr;

        let mut command = Command::new("unused");
        for key in NON_INTERACTIVE_COLOR_ENVIRONMENT_REMOVALS {
            command.env(key, "inherited");
        }

        remove_non_interactive_color_environment(&mut command);

        for key in NON_INTERACTIVE_COLOR_ENVIRONMENT_REMOVALS {
            assert!(command
                .get_envs()
                .any(|(name, value)| name == OsStr::new(key) && value.is_none()));
        }
    }
}
