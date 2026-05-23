use std::process::Command;

use anyhow::Result;

use crate::models::tool::ToolKey;
use crate::platform::powershell::{compose_windows_terminal_command, LaunchRequest};

#[derive(Default)]
pub struct LaunchService;

impl LaunchService {
    pub fn preview(&self, directory_id: i64, tool_key: ToolKey) -> Result<String> {
        let request = self.resolve_request(directory_id, tool_key)?;
        Ok(compose_windows_terminal_command(&request).preview)
    }

    pub fn launch(&self, directory_id: i64, tool_key: ToolKey) -> Result<()> {
        let request = self.resolve_request(directory_id, tool_key)?;
        let command = compose_windows_terminal_command(&request);

        Command::new(command.program).args(command.args).spawn()?;
        Ok(())
    }

    fn resolve_request(&self, _directory_id: i64, tool_key: ToolKey) -> Result<LaunchRequest> {
        let executable = match tool_key {
            ToolKey::Antigravity => "antigravity",
            ToolKey::Codex => "codex",
            ToolKey::Claude => "claude",
        };

        Ok(LaunchRequest {
            directory: "C:\\Projects\\cli-launchpad".to_string(),
            terminal_exe: "wt.exe".to_string(),
            shell_exe: "pwsh.exe".to_string(),
            shell_args: vec!["-NoLogo".to_string(), "-NoExit".to_string()],
            init_script: default_utf8_script(),
            tool_executable: executable.to_string(),
            tool_args: Vec::new(),
        })
    }
}

fn default_utf8_script() -> String {
    [
        "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new()",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()",
        "$OutputEncoding=[System.Text.UTF8Encoding]::new()",
    ]
    .join("; ")
}

