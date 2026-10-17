const VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Resolve a trusted Windows system binary to its full `System32` path so we do
/// not rely on PATH/CWD for system tools. Falls back to the bare name.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn system32(relative: &str) -> String {
    if let Ok(root) = std::env::var("SystemRoot") {
        let path = std::path::Path::new(&root).join("System32").join(relative);
        if path.is_file() {
            return path.display().to_string();
        }
    }
    relative.to_string()
}

/// Run `--version` only after an explicit user refresh. The executable path is
/// already resolved by detection; scripts use their Windows host explicitly so
/// no shell lookup or current-directory execution is involved.
pub async fn probe_version(path: &std::path::Path) -> Result<String, String> {
    probe_version_with_env(path, &[]).await
}

pub(crate) async fn probe_version_with_env(
    path: &std::path::Path,
    environment: &[(String, std::ffi::OsString)],
) -> Result<String, String> {
    let mut process = super::process::cli_command(path, ["--version"]);
    for (key, value) in environment {
        process.env(key.as_str(), value);
    }
    let output = super::process::run_bounded(process, VERSION_TIMEOUT, 32 * 1024)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                "版本命令执行超时".to_string()
            } else {
                format!("无法启动版本命令：{error}")
            }
        })?;

    if !output.status.success() {
        let detail = first_output_line(&output.stderr)
            .or_else(|| first_output_line(&output.stdout))
            .unwrap_or_else(|| format!("退出码 {}", output.status));
        return Err(format!("版本命令失败：{detail}"));
    }

    if output.truncated {
        log::debug!("CLI version output exceeded the bounded read limit");
    }

    first_output_line(&output.stdout)
        .or_else(|| first_output_line(&output.stderr))
        .ok_or_else(|| "版本命令未返回内容".to_string())
}

fn first_output_line(bytes: &[u8]) -> Option<String> {
    let output = String::from_utf8_lossy(bytes);
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::first_output_line;

    #[test]
    fn version_output_uses_first_non_empty_line() {
        assert_eq!(
            first_output_line(b"\r\ncodex-cli 0.147.0\r\nextra\r\n").as_deref(),
            Some("codex-cli 0.147.0")
        );
    }
}
