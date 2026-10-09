use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdout, Command};

use crate::platform::execution_process::ProcessTree;

const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_RESPONSE_LINES: usize = 2_000;

/// Send one stable request to a short-lived Codex App Server connection.
/// A fresh process keeps lifecycle and failure isolation simple for infrequent
/// history/model picker reads.
pub(crate) async fn request(
    executable: Option<&Path>,
    method: &str,
    params: Value,
    budget: Duration,
) -> Result<Value> {
    let executable =
        executable.ok_or_else(|| anyhow!("未找到 Codex CLI，无法读取 App Server 数据"))?;
    let executable = executable.display().to_string();
    let method = method.to_string();

    tokio::time::timeout(
        budget.min(APP_SERVER_TIMEOUT),
        request_inner(&executable, &method, params),
    )
    .await
    .map_err(|_| anyhow!("Codex App Server 响应超时"))?
}

async fn request_inner(executable: &str, method: &str, params: Value) -> Result<Value> {
    let tree = ProcessTree::new().context("无法创建 Codex App Server 进程树")?;
    let mut command = app_server_command(executable);
    tree.configure(&mut command)
        .context("无法配置 Codex App Server 进程树")?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().context("无法启动 Codex App Server")?;
    let guard = AppServerTreeGuard::new(tree);
    if let Err(error) = guard.attach(&child) {
        guard.shutdown();
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(error).context("无法把 Codex App Server 加入进程树");
    }
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("无法连接 Codex App Server stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("无法连接 Codex App Server stdout"))?;
    let mut reader = BufReader::new(stdout);

    write_message(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "cli_launchpad",
                    "title": "CLI Launchpad",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )
    .await?;
    read_response(&mut reader, 0).await?;

    write_message(
        &mut stdin,
        &json!({ "method": "initialized", "params": {} }),
    )
    .await?;
    write_message(
        &mut stdin,
        &json!({ "method": method, "id": 1, "params": params }),
    )
    .await?;

    let result = read_response(&mut reader, 1).await;
    drop(stdin);
    guard.shutdown();
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

fn app_server_command(executable: &str) -> Command {
    crate::platform::process::cli_command(Path::new(executable), ["app-server", "--stdio"])
}

/// Owns the process tree of one short-lived App Server connection. Dropping
/// it (normal completion, an early error, or the outer timeout dropping the
/// whole future) terminates every descendant, which `kill_on_drop` alone does
/// not: it only kills the direct child, e.g. the `cmd.exe` in front of a
/// `.cmd` shim.
struct AppServerTreeGuard {
    tree: ProcessTree,
}

impl AppServerTreeGuard {
    fn new(tree: ProcessTree) -> Self {
        Self { tree }
    }

    fn attach(&self, child: &tokio::process::Child) -> std::io::Result<()> {
        self.tree.attach(child)
    }

    fn shutdown(&self) {
        let _ = self.tree.terminate();
        let _ = self.tree.force_kill();
    }
}

impl Drop for AppServerTreeGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn write_message(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await?;
    Ok(())
}

async fn read_response(reader: &mut BufReader<ChildStdout>, id: i64) -> Result<Value> {
    let mut line = String::new();
    for _ in 0..MAX_RESPONSE_LINES {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return Err(anyhow!("Codex App Server 在返回响应前退出"));
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(anyhow!("Codex App Server 请求失败：{error}"));
        }
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("Codex App Server 响应缺少 result"));
    }
    Err(anyhow!("Codex App Server 响应行数超过限制"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_requires_a_resolved_path_from_the_adapter_context() {
        let error = request(None, "thread/list", json!({}), Duration::from_secs(1))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("未找到 Codex CLI"));
    }

    #[tokio::test]
    async fn response_reader_skips_notifications() {
        let data =
            b"{\"method\":\"thread/started\",\"params\":{}}\n{\"id\":1,\"result\":{\"data\":[]}}\n";
        let (mut writer, reader) = tokio::io::duplex(256);
        writer.write_all(data).await.unwrap();
        drop(writer);
        let mut reader = BufReader::new(reader);

        // Keep the parser test transport-independent by duplicating the small
        // response loop against an AsyncBufRead source.
        let mut line = String::new();
        let mut result = None;
        while reader.read_line(&mut line).await.unwrap() > 0 {
            let value: Value = serde_json::from_str(&line).unwrap();
            if value.get("id").and_then(Value::as_i64) == Some(1) {
                result = value.get("result").cloned();
                break;
            }
            line.clear();
        }
        assert_eq!(result.unwrap()["data"], json!([]));
    }

    fn write_script(directory: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    async fn wait_for_pid_file(path: &std::path::Path, within: Duration) -> Option<u32> {
        let started = std::time::Instant::now();
        loop {
            if let Some(pid) = std::fs::read_to_string(path)
                .ok()
                .and_then(|text| text.trim().parse::<u32>().ok())
            {
                return Some(pid);
            }
            if started.elapsed() >= within {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    #[cfg(unix)]
    fn unix_process_is_alive(pid: u32) -> bool {
        let pid_i32 = pid as i32;
        if unsafe { libc::kill(pid_i32, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return false;
        }
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let stat = String::from_utf8_lossy(&output.stdout).trim().to_string();
        !(stat.is_empty() || stat.starts_with('Z'))
    }

    #[cfg(unix)]
    async fn assert_unix_process_terminates(pid: u32, within: Duration) {
        let started = std::time::Instant::now();
        while started.elapsed() < within {
            if !unix_process_is_alive(pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        panic!("孙进程 {pid} 在 {within:?} 后仍然存活");
    }

    #[test]
    fn tree_guard_drop_without_an_attached_process_is_harmless() {
        let tree = ProcessTree::new().unwrap();
        let guard = AppServerTreeGuard::new(tree);
        drop(guard);

        let tree = ProcessTree::new().unwrap();
        let guard = AppServerTreeGuard::new(tree);
        guard.shutdown();
        guard.shutdown();
        drop(guard);
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn timed_out_request_terminates_the_whole_server_process_tree() {
        let directory = tempfile::tempdir().unwrap();
        let pidfile = directory.path().join("pidfile");
        let pidfile_text = pidfile.display().to_string();
        assert!(
            !pidfile_text.contains('\''),
            "pid 文件路径不能含单引号：{pidfile_text}"
        );
        #[cfg(unix)]
        let (script, timeout) = (
            write_script(
                directory.path(),
                "fake-codex",
                &format!(
                    "#!/bin/sh\nsh -c 'echo $$ > \"{pidfile_text}\"; exec sleep 60' &\nwait\n"
                ),
            ),
            Duration::from_millis(1500),
        );
        #[cfg(windows)]
        let (script, timeout) = (
            write_script(
                directory.path(),
                "fake-codex.cmd",
                &format!(
                    "@echo off\r\npowershell -NoProfile -Command \"$p = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '{pidfile_text}' $p.Id; Start-Sleep 60\"\r\n"
                ),
            ),
            Duration::from_millis(6000),
        );

        let error = request(Some(&script), "thread/list", json!({}), timeout)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("响应超时"), "{error}");
        let pid = wait_for_pid_file(&pidfile, Duration::from_secs(1))
            .await
            .unwrap_or_else(|| panic!("孙进程未在超时前启动，提高超时值"));
        #[cfg(unix)]
        assert_unix_process_terminates(pid, Duration::from_secs(3)).await;
        #[cfg(windows)]
        crate::platform::execution_process::assert_windows_process_terminates(
            pid,
            Duration::from_secs(3),
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_request_terminates_the_server_process_tree() {
        let directory = tempfile::tempdir().unwrap();
        let pidfile = directory.path().join("pidfile");
        let pidfile_text = pidfile.display().to_string();
        assert!(
            !pidfile_text.contains('\''),
            "pid 文件路径不能含单引号：{pidfile_text}"
        );
        // 脚本必须先等后台进程把 pid 写进文件，再回应协议消息：否则请求一结束进程组就被
        // 终止，后台进程可能还没来得及写文件（macOS CI 上出现过“后台进程未启动”）。
        let script = write_script(
            directory.path(),
            "fake-codex",
            &format!(
                "#!/bin/sh\nsh -c 'echo $$ > \"{pidfile_text}\"; exec sleep 60' &\nwhile [ ! -s \"{pidfile_text}\" ]; do sleep 0.1; done\nwhile IFS= read -r line; do\n  case \"$line\" in\n    *'\"id\":0'*) echo '{{\"id\":0,\"result\":{{}}}}' ;;\n    *'\"id\":1'*) echo '{{\"id\":1,\"result\":{{\"data\":[]}}}}' ;;\n  esac\ndone\n"
            ),
        );

        let value = request(
            Some(&script),
            "thread/list",
            json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();

        assert_eq!(value["data"], json!([]));
        let pid = wait_for_pid_file(&pidfile, Duration::from_secs(1))
            .await
            .unwrap_or_else(|| panic!("后台进程未启动"));
        assert_unix_process_terminates(pid, Duration::from_secs(3)).await;
    }
}
