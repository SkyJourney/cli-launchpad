use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context, Result};

use super::terminal_launch::LaunchPayload;

const ARTIFACT_PREFIX: &str = "cli_launchpad_";
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug)]
pub struct MacosLaunchArtifacts {
    pub helper_path: PathBuf,
}

impl MacosLaunchArtifacts {
    pub fn cleanup(&self) {
        remove_regular_file(&self.helper_path);
    }
}

pub fn prepare(cache_dir: &Path, payload: &LaunchPayload) -> Result<MacosLaunchArtifacts> {
    let launch_dir = cache_dir.join("launch");
    ensure_private_directory(&launch_dir)?;

    let identifier = uuid::Uuid::new_v4().simple().to_string();
    let helper_path = launch_dir.join(format!("{ARTIFACT_PREFIX}{identifier}.command"));
    let shell = login_shell();
    let script = helper_script(&helper_path, payload, &shell);
    write_new_file(&helper_path, script.as_bytes(), 0o700)
        .context("无法创建 macOS 一次性启动载荷")?;

    Ok(MacosLaunchArtifacts { helper_path })
}

pub fn cleanup_stale(cache_dir: &Path) -> Result<usize> {
    cleanup_stale_in_directory(&cache_dir.join("launch"), "command")
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .with_context(|| format!("无法创建 macOS 启动载荷目录 {}", path.display()))?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() {
        return Err(anyhow!(
            "macOS 启动载荷目录不是普通目录：{}",
            path.display()
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn write_new_file(path: &Path, content: &[u8], mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .with_context(|| format!("无法创建文件 {}", path.display()))?;
    file.write_all(content)?;
    file.sync_all()?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

fn helper_script(helper_path: &Path, payload: &LaunchPayload, shell: &Path) -> String {
    let invocation = std::iter::once(payload.tool_executable.as_str())
        .chain(payload.tool_args.iter().map(String::as_str))
        .map(quote_posix)
        .collect::<Vec<_>>()
        .join(" ");
    let shell = quote_posix(&shell.display().to_string());
    format!(
        "#!/bin/zsh\n/bin/rm -f -- {}\nunset NO_COLOR CI FORCE_COLOR CLICOLOR_FORCE\nif [[ -z \"${{COLORTERM:-}}\" ]]; then\n  unset COLORTERM\nfi\nif ! builtin cd -- {}; then\n  print -u2 -- 'CLI Launchpad：无法进入项目目录'\n  exec {} -l\nfi\n{}\ncli_launchpad_status=$?\nprintf '\\nCLI 已退出（状态码 %d）。\\n' \"$cli_launchpad_status\"\nexec {} -l\n",
        quote_posix(&helper_path.display().to_string()),
        quote_posix(&payload.directory),
        shell,
        invocation,
        shell,
    )
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute()
                && path.is_file()
                && fs::metadata(path)
                    .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
        })
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

fn cleanup_stale_in_directory(directory: &Path, extension: &str) -> Result<usize> {
    if !directory.is_dir() {
        return Ok(0);
    }
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(ARTIFACT_PREFIX)
            || path.extension().and_then(|value| value.to_str()) != Some(extension)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_AFTER);
        if stale {
            fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn remove_regular_file(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file()) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(directory: &str) -> LaunchPayload {
        LaunchPayload {
            directory: directory.to_string(),
            tool_executable: "/tmp/tool's bin".to_string(),
            tool_args: vec!["--model".to_string(), "value; touch /tmp/no".to_string()],
        }
    }

    #[test]
    fn helper_quotes_all_payload_values_and_uses_no_eval() {
        let script = helper_script(
            Path::new("/tmp/helper.command"),
            &payload("/tmp/project's dir"),
            Path::new("/bin/zsh"),
        );
        assert!(script.contains("'/tmp/project'\\''s dir'"));
        assert!(script.contains("'/tmp/tool'\\''s bin'"));
        assert!(script.contains("'value; touch /tmp/no'"));
        assert!(script.contains("unset NO_COLOR CI FORCE_COLOR CLICOLOR_FORCE"));
        assert!(script.contains("unset COLORTERM"));
        assert!(!script.contains("eval"));
        assert!(script.starts_with("#!/bin/zsh\n/bin/rm -f --"));
    }

    #[test]
    fn prepare_creates_private_helper() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let artifacts = prepare(&cache, &payload("/tmp/project")).unwrap();
        assert!(artifacts.helper_path.is_file());
        assert_eq!(
            fs::metadata(&artifacts.helper_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let syntax = std::process::Command::new("/bin/zsh")
            .arg("-n")
            .arg(&artifacts.helper_path)
            .status()
            .unwrap();
        assert!(syntax.success());
        artifacts.cleanup();
        assert!(!artifacts.helper_path.exists());
    }
}
