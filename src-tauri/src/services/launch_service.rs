use std::process::Command;

use anyhow::{anyhow, Result};
use rusqlite::Connection;

use crate::db::{directory_repo, directory_tool_args_repo, shell_profile_repo, tool_repo};
use crate::models::tool::ToolKey;
use crate::platform::detect;
use crate::platform::powershell::{compose_launch, ComposedCommand, LaunchRequest};

/// Spawn a fresh console window for direct (non-wt) shell launches.
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

pub fn preview(conn: &Connection, directory_id: i64, tool_key: ToolKey) -> Result<String> {
    let request = resolve_request(conn, directory_id, tool_key)?;
    Ok(compose_launch(&request).preview)
}

pub fn launch(conn: &Connection, directory_id: i64, tool_key: ToolKey) -> Result<()> {
    let request = resolve_request(conn, directory_id, tool_key)?;
    spawn(compose_launch(&request))?;
    directory_repo::touch_last_used(conn, directory_id)?;
    Ok(())
}

pub fn resume(
    conn: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
    session_id: &str,
) -> Result<()> {
    let mut request = resolve_request(conn, directory_id, tool_key)?;
    apply_resume(&mut request, tool_key, session_id);
    spawn(compose_launch(&request))?;
    directory_repo::touch_last_used(conn, directory_id)?;
    Ok(())
}

fn spawn(command: ComposedCommand) -> Result<()> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    if let Some(dir) = &command.working_dir {
        process.current_dir(dir);
    }
    #[cfg(windows)]
    if command.new_console {
        use std::os::windows::process::CommandExt;
        process.creation_flags(CREATE_NEW_CONSOLE);
    }
    process.spawn()?;
    Ok(())
}

/// Rewrite tool arguments to resume an existing session. Each CLI uses a
/// different shape; for Codex `resume` is a subcommand and must lead.
fn apply_resume(request: &mut LaunchRequest, tool_key: ToolKey, session_id: &str) {
    match tool_key {
        ToolKey::Claude => {
            request.tool_args.push("--resume".to_string());
            request.tool_args.push(session_id.to_string());
        }
        ToolKey::Codex => {
            // `resume <id>` must lead, but keep configured options after it.
            let mut args = vec!["resume".to_string(), session_id.to_string()];
            args.extend(std::mem::take(&mut request.tool_args));
            request.tool_args = args;
        }
        ToolKey::Antigravity => {
            request
                .tool_args
                .push(format!("--conversation={session_id}"));
        }
    }
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

    let tool_args = merge_args(split_args(&tool.global_args), split_args(&directory_args));

    Ok(LaunchRequest {
        kind: profile.kind,
        directory: directory.path,
        terminal_exe: full_path_or(&profile.terminal_exe),
        shell_exe: resolve_shell_exe(&profile.shell_exe),
        shell_args: split_args(&profile.shell_args),
        init_script: profile.init_script,
        tool_executable: resolve_tool_executable(tool_key)?,
        tool_args,
    })
}

/// Resolve the tool to a full executable path via its command candidates
/// (e.g. Antigravity prefers `agy`, falling back to `antigravity`). Uses the
/// same PATH + known-dir resolution as detection so an "available" tool is
/// always launchable. Launching by full path avoids depending on the spawned
/// shell's PATH.
fn resolve_tool_executable(tool_key: ToolKey) -> Result<String> {
    detect::resolve_executable_path(tool_key.command_candidates())
        .ok_or_else(|| anyhow!("未检测到 {}，请先在设置中安装后再启动", tool_key.as_str()))
}

/// Resolve the shell to a full path. PowerShell 7 (`pwsh.exe`) is optional, so
/// fall back to the always-present Windows PowerShell when it is missing.
fn resolve_shell_exe(requested: &str) -> String {
    if requested.eq_ignore_ascii_case("pwsh.exe") {
        if let Some(path) = detect::which_path_sync("pwsh.exe") {
            return path;
        }
        if let Some(path) = detect::which_path_sync("powershell.exe") {
            return path;
        }
        return "powershell.exe".to_string();
    }
    full_path_or(requested)
}

/// Resolve a program to its full path, falling back to the bare name.
fn full_path_or(name: &str) -> String {
    detect::which_path_sync(name).unwrap_or_else(|| name.to_string())
}

/// Merge global and project-level args so a flag set at both levels is not
/// duplicated (which would break the CLI). Project-level wins: any global flag
/// also present in the project args is dropped (with its value), then the
/// project args are appended.
fn merge_args(global: Vec<String>, project: Vec<String>) -> Vec<String> {
    use std::collections::HashSet;
    // Compare by flag base name so `--model x` and `--model=x` are treated as
    // the same flag.
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
            // Skip the overridden flag. A space-separated flag also owns the
            // following value token; a `--flag=value` token is self-contained.
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

/// The flag name without any `=value` suffix (`--model=x` -> `--model`).
fn flag_base(token: &str) -> &str {
    match token.find('=') {
        Some(idx) => &token[..idx],
        None => token,
    }
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
    use super::{merge_args, split_args};

    fn vs(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn project_flag_overrides_global() {
        let merged = merge_args(
            vs(&["--model", "sonnet", "--verbose"]),
            vs(&["--model", "opus"]),
        );
        // Global --model dropped (value too); --verbose kept; project --model wins.
        assert_eq!(merged, vs(&["--verbose", "--model", "opus"]));
    }

    #[test]
    fn boolean_flag_override_does_not_eat_next() {
        let merged = merge_args(vs(&["--verbose", "--model", "x"]), vs(&["--verbose"]));
        assert_eq!(merged, vs(&["--model", "x", "--verbose"]));
    }

    #[test]
    fn disjoint_args_concatenate() {
        let merged = merge_args(vs(&["--global"]), vs(&["--proj"]));
        assert_eq!(merged, vs(&["--global", "--proj"]));
    }

    #[test]
    fn equals_form_overrides_space_form() {
        // Project uses --model=opus, global uses space form: no duplicate.
        let merged = merge_args(vs(&["--model", "sonnet"]), vs(&["--model=opus"]));
        assert_eq!(merged, vs(&["--model=opus"]));
    }

    #[test]
    fn space_form_overrides_equals_form() {
        let merged = merge_args(vs(&["--model=sonnet"]), vs(&["--model", "opus"]));
        assert_eq!(merged, vs(&["--model", "opus"]));
    }

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
