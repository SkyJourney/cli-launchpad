use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};

pub fn open_directory(path: &str) -> Result<()> {
    let directory = Path::new(path);
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(directory);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(directory);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(directory);
        command
    };

    command
        .spawn()
        .with_context(|| format!("无法打开项目目录 {}", directory.display()))?;
    Ok(())
}
