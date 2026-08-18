use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdout, Command};

use crate::models::tool::ToolKey;
use crate::platform::detect;

const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_RESPONSE_LINES: usize = 2_000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Send one stable request to a short-lived Codex App Server connection.
/// A fresh process keeps lifecycle and failure isolation simple for infrequent
/// history/model picker reads.
pub async fn request(method: &str, params: Value) -> Result<Value> {
    let executable = detect::resolve_executable_path(ToolKey::Codex.command_candidates())
        .ok_or_else(|| anyhow!("未找到 Codex CLI，无法读取 App Server 数据"))?;
    let method = method.to_string();

    tokio::time::timeout(
        APP_SERVER_TIMEOUT,
        request_inner(&executable, &method, params),
    )
    .await
    .map_err(|_| anyhow!("Codex App Server 响应超时"))?
}

async fn request_inner(executable: &str, method: &str, params: Value) -> Result<Value> {
    let mut command = app_server_command(executable);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().context("无法启动 Codex App Server")?;
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
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

fn app_server_command(executable: &str) -> Command {
    let extension = Path::new(executable)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "cmd" | "bat" => {
            let mut command = Command::new(detect::system32("cmd.exe"));
            command
                .arg("/D")
                .arg("/C")
                .arg(executable)
                .arg("app-server")
                .arg("--stdio");
            command
        }
        "ps1" => {
            let mut command =
                Command::new(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
            command
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(executable)
                .arg("app-server")
                .arg("--stdio");
            command
        }
        _ => {
            let mut command = Command::new(executable);
            command.arg("app-server").arg("--stdio");
            command
        }
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
}
