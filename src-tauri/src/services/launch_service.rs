use std::process::Command;

use anyhow::{anyhow, Result};
use rusqlite::Connection;

use crate::db::{
    app_setting_repo, directory_repo, directory_tool_args_repo, launch_history_repo, tool_repo,
};
use crate::models::launch_history::LaunchAction;
use crate::models::terminal::TerminalEnvironment;
use crate::models::tool::ToolKey;
use crate::platform::detect;
use crate::platform::terminal_launch::{
    build_launch_plan, preview_plan, ComposedCommand, LaunchPayload, LaunchPlan,
};

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

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
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<()> {
    let result = (|| {
        let payload = resolve_payload(conn, directory_id, tool_key)?;
        let preference = app_setting_repo::get_launch_target(conn)?;
        let plan = build_launch_plan(payload, environment, &preference)?;
        let launched = spawn_plan(&plan)?;
        directory_repo::touch_last_used(conn, directory_id)?;
        Ok(launched)
    })();
    record_and_log_result(conn, result, LaunchAction::Launch, directory_id, tool_key)
}

pub fn resume(
    conn: &Connection,
    environment: &TerminalEnvironment,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: &str,
) -> Result<()> {
    let result = (|| {
        let mut payload = resolve_payload(conn, directory_id, tool_key)?;
        apply_resume(&mut payload, tool_key, session_id);
        let preference = app_setting_repo::get_launch_target(conn)?;
        let plan = build_launch_plan(payload, environment, &preference)?;
        let launched = spawn_plan(&plan)?;
        directory_repo::touch_last_used(conn, directory_id)?;
        Ok(launched)
    })();
    record_and_log_result(conn, result, LaunchAction::Resume, directory_id, tool_key)
}

fn spawn_plan(plan: &LaunchPlan) -> Result<String> {
    let mut errors = Vec::new();
    for (index, candidate) in plan.candidates.iter().enumerate() {
        match spawn_command(&candidate.command) {
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

fn spawn_command(command: &ComposedCommand) -> Result<()> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
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

fn apply_resume(payload: &mut LaunchPayload, tool_key: ToolKey, session_id: &str) {
    match tool_key {
        ToolKey::Claude => {
            payload.tool_args.push("--resume".to_string());
            payload.tool_args.push(session_id.to_string());
        }
        ToolKey::Codex => {
            let mut args = vec!["resume".to_string(), session_id.to_string()];
            args.extend(std::mem::take(&mut payload.tool_args));
            payload.tool_args = args;
        }
        ToolKey::Antigravity => {
            payload
                .tool_args
                .push(format!("--conversation={session_id}"));
        }
    }
}

fn resolve_payload(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<LaunchPayload> {
    let directory = directory_repo::get(conn, directory_id)?
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))?;
    crate::services::directory_service::validate_path(&directory.path)?;
    let tool = tool_repo::get_by_key(conn, tool_key)?
        .ok_or_else(|| anyhow!("tool {} is not configured", tool_key.as_str()))?;
    let directory_args =
        directory_tool_args_repo::get(conn, directory_id, tool_key)?.unwrap_or_default();

    Ok(LaunchPayload {
        directory: directory.path,
        tool_executable: resolve_tool_executable(tool_key)?,
        tool_args: merge_args(split_args(&tool.global_args), split_args(&directory_args)),
    })
}

fn resolve_tool_executable(tool_key: ToolKey) -> Result<String> {
    detect::resolve_executable_path(tool_key.command_candidates())
        .ok_or_else(|| anyhow!("未检测到 {}，请先在设置中安装后再启动", tool_key.as_str()))
}

fn merge_args(global: Vec<String>, project: Vec<String>) -> Vec<String> {
    use std::collections::HashSet;
    let project_flag_bases: HashSet<&str> = project
        .iter()
        .filter(|token| token.starts_with('-'))
        .map(|token| flag_base(token))
        .collect();

    let mut merged = Vec::new();
    let mut index = 0;
    while index < global.len() {
        let token = &global[index];
        if token.starts_with('-') && project_flag_bases.contains(flag_base(token)) {
            let has_value = !token.contains('=')
                && index + 1 < global.len()
                && !global[index + 1].starts_with('-');
            index += if has_value { 2 } else { 1 };
            continue;
        }
        merged.push(token.clone());
        index += 1;
    }
    merged.extend(project);
    merged
}

fn flag_base(token: &str) -> &str {
    match token.find('=') {
        Some(index) => &token[..index],
        None => token,
    }
}

fn split_args(value: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_token = false;

    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\\' if in_double => {
                if characters
                    .peek()
                    .is_some_and(|next| matches!(*next, '"' | '\\'))
                {
                    current.push(characters.next().expect("peeked character must exist"));
                } else {
                    current.push('\\');
                }
                has_token = true;
            }
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            value if value.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            value => {
                current.push(value);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::{merge_args, split_args};

    fn vs(items: &[&str]) -> Vec<String> {
        items.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn project_flag_overrides_global() {
        assert_eq!(
            merge_args(
                vs(&["--model", "sonnet", "--verbose"]),
                vs(&["--model", "opus"]),
            ),
            vs(&["--verbose", "--model", "opus"])
        );
    }

    #[test]
    fn boolean_flag_override_does_not_eat_next() {
        assert_eq!(
            merge_args(vs(&["--verbose", "--model", "x"]), vs(&["--verbose"])),
            vs(&["--model", "x", "--verbose"])
        );
    }

    #[test]
    fn disjoint_args_concatenate() {
        assert_eq!(
            merge_args(vs(&["--global"]), vs(&["--proj"])),
            vs(&["--global", "--proj"])
        );
    }

    #[test]
    fn equals_form_overrides_space_form() {
        assert_eq!(
            merge_args(vs(&["--model", "sonnet"]), vs(&["--model=opus"])),
            vs(&["--model=opus"])
        );
    }

    #[test]
    fn space_form_overrides_equals_form() {
        assert_eq!(
            merge_args(vs(&["--model=sonnet"]), vs(&["--model", "opus"])),
            vs(&["--model", "opus"])
        );
    }

    #[test]
    fn splits_quoted_values() {
        assert_eq!(
            split_args("--note \"hello world\" 'a b'"),
            vec!["--note", "hello world", "a b"]
        );
    }

    #[test]
    fn split_args_unescapes_serialized_double_quotes() {
        assert_eq!(
            split_args(r#"--label "a \"quoted\" value" --path C:\Tools\cli"#),
            vec!["--label", "a \"quoted\" value", "--path", "C:\\Tools\\cli"]
        );
    }

    #[test]
    fn split_args_preserves_windows_backslashes_inside_quotes() {
        assert_eq!(
            split_args(r#"--path "C:\Program Files\CLI""#),
            vec!["--path", "C:\\Program Files\\CLI"]
        );
    }

    #[test]
    fn empty_string_yields_no_args() {
        assert!(split_args("   ").is_empty());
    }
}
