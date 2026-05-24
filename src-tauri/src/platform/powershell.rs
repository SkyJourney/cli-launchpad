use base64::Engine;

#[derive(Debug, Clone)]
pub struct LaunchRequest {
    /// Launch mode: "wt-pwsh" | "pwsh" | "cmd".
    pub kind: String,
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
    /// Human-readable command for the UI preview (not necessarily the exact
    /// argv; the wt path actually runs an encoded command).
    pub preview: String,
    /// Working directory for direct (non-wt) launches.
    pub working_dir: Option<String>,
    /// Whether to spawn in a fresh console window (direct shell launches).
    pub new_console: bool,
}

pub fn compose_launch(request: &LaunchRequest) -> ComposedCommand {
    match request.kind.as_str() {
        "pwsh" => compose_direct_powershell(request),
        "cmd" => compose_direct_cmd(request),
        // Default: Windows Terminal + PowerShell.
        _ => compose_wt_powershell(request),
    }
}

/// Windows Terminal + PowerShell. The PowerShell statements are Base64-encoded
/// and passed via `-EncodedCommand`, so the `;` separators never reach
/// `wt.exe`'s own command-line parser (which would otherwise split them into
/// multiple tabs).
fn compose_wt_powershell(request: &LaunchRequest) -> ComposedCommand {
    let script = compose_powershell_script(request);
    let encoded = encode_powershell_command(&script);

    let mut args = vec![
        "new-tab".to_string(),
        "-d".to_string(),
        request.directory.clone(),
        request.shell_exe.clone(),
    ];
    args.extend(request.shell_args.clone());
    args.push("-EncodedCommand".to_string());
    args.push(encoded);

    let preview = format!(
        "{} new-tab -d \"{}\" {} {} -Command \"{}\"",
        request.terminal_exe,
        request.directory,
        request.shell_exe,
        request.shell_args.join(" "),
        script
    );

    ComposedCommand {
        program: request.terminal_exe.clone(),
        args,
        preview,
        working_dir: None,
        new_console: false,
    }
}

/// A standalone PowerShell window. Launched directly (no wt), so its `-Command`
/// receives the script as a single argument and PowerShell parses the `;`
/// itself. The working directory is set on the process.
fn compose_direct_powershell(request: &LaunchRequest) -> ComposedCommand {
    let script = compose_powershell_script(request);

    let mut args = request.shell_args.clone();
    args.push("-Command".to_string());
    args.push(script.clone());

    let preview = format!(
        "{} {} -Command \"{}\"  (cwd: {})",
        request.shell_exe,
        request.shell_args.join(" "),
        script,
        request.directory
    );

    ComposedCommand {
        program: request.shell_exe.clone(),
        args,
        preview,
        working_dir: Some(request.directory.clone()),
        new_console: true,
    }
}

/// A standalone Command Prompt window via `cmd /K` (runs and stays open).
fn compose_direct_cmd(request: &LaunchRequest) -> ComposedCommand {
    let command_line = compose_cmd_command_line(request);
    let preview = format!(
        "cmd.exe /K \"{}\"  (cwd: {})",
        command_line, request.directory
    );

    ComposedCommand {
        program: "cmd.exe".to_string(),
        args: vec!["/K".to_string(), command_line],
        preview,
        working_dir: Some(request.directory.clone()),
        new_console: true,
    }
}

fn compose_powershell_script(request: &LaunchRequest) -> String {
    let mut invocation = format!("& {}", quote_powershell_arg(&request.tool_executable));
    for arg in &request.tool_args {
        invocation.push(' ');
        invocation.push_str(&quote_powershell_arg(arg));
    }

    let mut parts = Vec::new();
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

fn compose_cmd_command_line(request: &LaunchRequest) -> String {
    // `chcp 65001` switches the code page to UTF-8 for the session.
    let mut line = String::from("chcp 65001>nul & ");
    line.push_str(&quote_cmd_arg(&request.tool_executable));
    for arg in &request.tool_args {
        line.push(' ');
        line.push_str(&quote_cmd_arg(arg));
    }
    line
}

/// Encode a PowerShell script for `-EncodedCommand`: UTF-16LE then Base64.
fn encode_powershell_command(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn escape_single_quoted_powershell(value: &str) -> String {
    value.replace('\'', "''")
}

/// Wrap an argument in single quotes when it contains characters the shell
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

fn quote_cmd_arg(value: &str) -> String {
    if value.is_empty() || value.contains(' ') {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: &str, tool_args: Vec<&str>) -> LaunchRequest {
        LaunchRequest {
            kind: kind.to_string(),
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
    fn wt_uses_encoded_command_no_semicolons_in_args() {
        let composed = compose_launch(&request("wt-pwsh", vec!["--model", "opus"]));
        assert_eq!(composed.program, "wt.exe");
        assert!(composed.args.contains(&"-EncodedCommand".to_string()));
        // No argument passed to wt may contain a semicolon (that would split tabs).
        assert!(composed.args.iter().all(|arg| !arg.contains(';')));
        assert!(!composed.new_console);
    }

    #[test]
    fn encoded_command_round_trips_to_script() {
        let composed = compose_launch(&request("wt-pwsh", vec![]));
        let index = composed
            .args
            .iter()
            .position(|a| a == "-EncodedCommand")
            .unwrap();
        let encoded = &composed.args[index + 1];
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let decoded = String::from_utf16(&units).unwrap();
        assert!(decoded.contains("& claude"));
        assert!(decoded.contains("Set-Location -LiteralPath 'C:\\Projects\\demo'"));
    }

    #[test]
    fn direct_powershell_sets_cwd_and_new_console() {
        let composed = compose_launch(&request("pwsh", vec!["--model", "opus"]));
        assert_eq!(composed.program, "pwsh.exe");
        assert_eq!(composed.working_dir.as_deref(), Some("C:\\Projects\\demo"));
        assert!(composed.new_console);
        assert!(composed.args.contains(&"-Command".to_string()));
    }

    #[test]
    fn direct_cmd_uses_slash_k_and_chcp() {
        let composed = compose_launch(&request("cmd", vec![]));
        assert_eq!(composed.program, "cmd.exe");
        assert_eq!(composed.args[0], "/K");
        assert!(composed.args[1].contains("chcp 65001"));
        assert!(composed.args[1].contains("claude"));
        assert!(composed.new_console);
    }

    #[test]
    fn args_join_into_single_invocation() {
        let script = compose_powershell_script(&request("wt-pwsh", vec!["--model", "opus"]));
        assert!(script.contains("& claude --model opus"));
        assert!(!script.contains("& claude; --model"));
    }
}
