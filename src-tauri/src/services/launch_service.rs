use std::process::Command;

use anyhow::{anyhow, Result};
use rusqlite::Connection;

use crate::db::{directory_repo, directory_tool_args_repo, shell_profile_repo, tool_repo};
use crate::models::tool::ToolKey;
use crate::platform::powershell::{compose_windows_terminal_command, LaunchRequest};

pub fn preview(conn: &Connection, directory_id: i64, tool_key: ToolKey) -> Result<String> {
    let request = resolve_request(conn, directory_id, tool_key)?;
    Ok(compose_windows_terminal_command(&request).preview)
}

pub fn launch(conn: &Connection, directory_id: i64, tool_key: ToolKey) -> Result<()> {
    let request = resolve_request(conn, directory_id, tool_key)?;
    let command = compose_windows_terminal_command(&request);

    Command::new(&command.program).args(&command.args).spawn()?;
    directory_repo::touch_last_used(conn, directory_id)?;
    Ok(())
}

fn resolve_request(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
) -> Result<LaunchRequest> {
    let directory = directory_repo::get(conn, directory_id)?
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))?;
    let tool = tool_repo::get_by_key(conn, tool_key)?
        .ok_or_else(|| anyhow!("tool {} is not configured", tool_key.as_str()))?;
    let profile = shell_profile_repo::get_default(conn)?
        .ok_or_else(|| anyhow!("no shell profile configured"))?;
    let directory_args =
        directory_tool_args_repo::get(conn, directory_id, tool_key)?.unwrap_or_default();

    let mut tool_args = split_args(&tool.global_args);
    tool_args.extend(split_args(&directory_args));

    Ok(LaunchRequest {
        directory: directory.path,
        terminal_exe: profile.terminal_exe,
        shell_exe: profile.shell_exe,
        shell_args: split_args(&profile.shell_args),
        init_script: profile.init_script,
        tool_executable: tool.executable,
        tool_args,
    })
}

/// Split a stored argument string into tokens, honouring single and double
/// quotes so values with embedded spaces (e.g. `--note "hello world"`) stay a
/// single argument. Quote characters are consumed; each resulting token is later
/// re-quoted for the shell by `quote_powershell_arg`.
fn split_args(value: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_token = false;

    for ch in value.chars() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
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
    use super::split_args;

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(split_args("--model opus"), vec!["--model", "opus"]);
    }

    #[test]
    fn keeps_quoted_value_together() {
        assert_eq!(
            split_args("--note \"hello world\""),
            vec!["--note", "hello world"]
        );
    }

    #[test]
    fn handles_single_quotes() {
        assert_eq!(split_args("'a b' c"), vec!["a b", "c"]);
    }

    #[test]
    fn empty_string_yields_no_args() {
        assert!(split_args("   ").is_empty());
    }
}
