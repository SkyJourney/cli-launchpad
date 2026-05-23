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
    let mut parts = vec![
        request.init_script.clone(),
        format!(
            "Set-Location -LiteralPath '{}'",
            escape_single_quoted_powershell(&request.directory)
        ),
        format!("& {}", request.tool_executable),
    ];

    parts.extend(request.tool_args.iter().cloned());
    parts.join("; ")
}

fn escape_single_quoted_powershell(value: &str) -> String {
    value.replace('\'', "''")
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

