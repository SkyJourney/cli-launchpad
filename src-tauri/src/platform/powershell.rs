#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub directory: String,
    pub terminal_exe: String,
    pub shell_exe: String,
    pub shell_args: Vec<String>,
    pub init_script: String,
    pub tool_executable: String,
    pub tool_args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ComposedCommand {
    pub program: String,
    pub args: Vec<String>,
    pub preview: String,
}

pub fn compose_windows_terminal_command(request: &LaunchRequest) -> ComposedCommand {
    let mut args = vec![
        "new-tab".to_string(),
        "-d".to_string(),
        request.directory.clone(),
        request.shell_exe.clone(),
    ];

    args.extend(request.shell_args.clone());
    args.push("-Command".to_string());
    args.push(compose_powershell_script(request));

    let preview = format!("{} {}", request.terminal_exe, preview_args(&args));

    ComposedCommand {
        program: request.terminal_exe.clone(),
        args,
        preview,
    }
}

fn compose_powershell_script(request: &LaunchRequest) -> String {
    let mut invocation = format!("& {}", quote_powershell_arg(&request.tool_executable));
    for arg in &request.tool_args {
        invocation.push(' ');
        invocation.push_str(&quote_powershell_arg(arg));
    }

    let mut parts = Vec::new();
    // `init_script` is trusted shell-profile configuration (e.g. the UTF-8
    // encoding setup), not free user input, so it is injected verbatim. The UI
    // must keep it out of ordinary per-directory user editing paths.
    if !request.init_script.trim().is_empty() {
        parts.push(request.init_script.clone());
    }
    parts.push(format!(
        "Set-Location -LiteralPath '{}'",
        escape_single_quoted_powershell(&request.directory)
    ));
    parts.push(invocation);
    parts.join("; ")
}

fn escape_single_quoted_powershell(value: &str) -> String {
    value.replace('\'', "''")
}

/// Wrap an argument in single quotes when it contains characters that the shell
/// would otherwise interpret. Tokens like `--model` or `claude-opus-4-7` pass
/// through unquoted.
fn quote_powershell_arg(value: &str) -> String {
    let needs_quote = value.is_empty()
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, ';' | '&' | '|' | '\'' | '"' | '`'));
    if needs_quote {
        format!("'{}'", escape_single_quoted_powershell(value))
    } else {
        value.to_string()
    }
}

fn preview_args(args: &[String]) -> String {
    args.iter()
        .map(|arg| {
            if arg.contains(' ') || arg.contains(';') {
                format!("\"{}\"", arg.replace('"', "\\\""))
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with_args(tool_args: Vec<&str>) -> LaunchRequest {
        LaunchRequest {
            directory: "C:\\Projects\\demo".to_string(),
            terminal_exe: "wt.exe".to_string(),
            shell_exe: "pwsh.exe".to_string(),
            shell_args: vec!["-NoLogo".to_string(), "-NoExit".to_string()],
            init_script: "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()".to_string(),
            tool_executable: "claude".to_string(),
            tool_args: tool_args.into_iter().map(str::to_string).collect(),
        }
    }

    #[test]
    fn args_join_into_single_invocation() {
        let script = compose_powershell_script(&request_with_args(vec!["--model", "opus"]));
        assert!(script.contains("& claude --model opus"));
        // The tool invocation is a single statement, not split across `;`.
        assert!(!script.contains("& claude; --model"));
    }

    #[test]
    fn directory_uses_literal_path() {
        let script = compose_powershell_script(&request_with_args(vec![]));
        assert!(script.contains("Set-Location -LiteralPath 'C:\\Projects\\demo'"));
    }

    #[test]
    fn empty_init_script_is_skipped() {
        let mut request = request_with_args(vec![]);
        request.init_script = "   ".to_string();
        let script = compose_powershell_script(&request);
        assert!(script.starts_with("Set-Location"));
    }

    #[test]
    fn arg_with_space_is_quoted() {
        assert_eq!(quote_powershell_arg("plain"), "plain");
        assert_eq!(quote_powershell_arg("two words"), "'two words'");
    }

    #[test]
    fn composed_command_targets_terminal() {
        let composed = compose_windows_terminal_command(&request_with_args(vec!["-r"]));
        assert_eq!(composed.program, "wt.exe");
        assert_eq!(composed.args[0], "new-tab");
        assert!(composed.preview.starts_with("wt.exe new-tab"));
    }
}
