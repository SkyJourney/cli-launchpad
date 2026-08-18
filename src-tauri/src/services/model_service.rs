use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::models::model::{ModelCatalog, ModelOption};
use crate::models::tool::ToolKey;
use crate::platform::detect;
use crate::services::codex_app_server;

const AGY_MODELS_TIMEOUT: Duration = Duration::from_secs(20);
const CODEX_MAX_PAGES: usize = 10;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub async fn fetch(tool_key: ToolKey) -> Result<ModelCatalog> {
    match tool_key {
        ToolKey::Claude => Ok(claude_catalog()),
        ToolKey::Codex => codex_catalog().await,
        ToolKey::Antigravity => antigravity_catalog().await,
    }
}

fn claude_catalog() -> ModelCatalog {
    let options = [
        ("best", "Best（Fable 5 / 最新 Opus）"),
        ("fable", "Fable（Claude Fable 5）"),
        ("opus", "Opus（最新版本）"),
        ("sonnet", "Sonnet（最新版本）"),
        ("haiku", "Haiku（最新版本）"),
        ("opusplan", "Opus Plan（规划 Opus / 执行 Sonnet）"),
        ("sonnet[1m]", "Sonnet（100 万上下文）"),
        ("opus[1m]", "Opus（100 万上下文）"),
    ]
    .into_iter()
    .map(|(value, label)| ModelOption {
        value: value.to_string(),
        label: label.to_string(),
        is_default: false,
    })
    .collect();

    ModelCatalog {
        tool_key: ToolKey::Claude,
        options,
        source: "Claude Code 官方稳定模型别名".to_string(),
        from_cache: false,
        warning: None,
    }
}

async fn codex_catalog() -> Result<ModelCatalog> {
    let mut cursor: Option<String> = None;
    let mut options = Vec::new();
    let mut seen = HashSet::new();

    for _ in 0..CODEX_MAX_PAGES {
        let result = codex_app_server::request(
            "model/list",
            json!({
                "cursor": cursor,
                "limit": 100,
                "includeHidden": false
            }),
        )
        .await?;
        let data = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("Codex model/list 响应缺少 data"))?;

        for item in data {
            if item.get("hidden").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(value) = item
                .get("model")
                .and_then(Value::as_str)
                .or_else(|| item.get("id").and_then(Value::as_str))
                .filter(|value| !value.trim().is_empty())
            else {
                continue;
            };
            if !seen.insert(value.to_string()) {
                continue;
            }
            let label = item
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .unwrap_or(value);
            options.push(ModelOption {
                value: value.to_string(),
                label: label.to_string(),
                is_default: item.get("isDefault").and_then(Value::as_bool) == Some(true),
            });
        }

        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cursor.is_none() {
            return Ok(ModelCatalog {
                tool_key: ToolKey::Codex,
                options,
                source: "Codex App Server model/list".to_string(),
                from_cache: false,
                warning: None,
            });
        }
    }

    Err(anyhow!("Codex 模型目录分页超过安全上限"))
}

async fn antigravity_catalog() -> Result<ModelCatalog> {
    let executable = detect::resolve_executable_path(ToolKey::Antigravity.command_candidates())
        .ok_or_else(|| anyhow!("未找到 Antigravity CLI，无法读取模型目录"))?;
    let mut command = cli_command(&executable, "models");
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = tokio::time::timeout(AGY_MODELS_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow!("Antigravity 模型目录命令执行超时"))?
        .context("无法启动 Antigravity 模型目录命令")?;
    if !output.status.success() {
        let detail = first_non_empty_line(&output.stderr)
            .or_else(|| first_non_empty_line(&output.stdout))
            .unwrap_or_else(|| format!("退出码 {}", output.status));
        return Err(anyhow!("Antigravity 模型目录命令失败：{detail}"));
    }

    let options = parse_antigravity_models(&String::from_utf8_lossy(&output.stdout));
    if options.is_empty() {
        return Err(anyhow!("Antigravity 模型目录命令未返回可识别模型"));
    }
    Ok(ModelCatalog {
        tool_key: ToolKey::Antigravity,
        options,
        source: "Antigravity CLI agy models".to_string(),
        from_cache: false,
        warning: None,
    })
}

fn cli_command(executable: &str, argument: &str) -> Command {
    let extension = Path::new(executable)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "cmd" | "bat" => {
            let mut command = Command::new(detect::system32("cmd.exe"));
            command.arg("/D").arg("/C").arg(executable).arg(argument);
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
                .arg(argument);
            command
        }
        _ => {
            let mut command = Command::new(executable);
            command.arg(argument);
            command
        }
    }
}

fn parse_antigravity_models(stdout: &str) -> Vec<ModelOption> {
    let mut seen = HashSet::new();
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (value, label) = line.split_once('\t')?;
            let value = value.trim();
            let label = label.trim();
            if value.is_empty() || label.is_empty() || !seen.insert(value.to_string()) {
                return None;
            }
            Some(ModelOption {
                value: value.to_string(),
                label: label.to_string(),
                is_default: false,
            })
        })
        .collect()
}

fn first_non_empty_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_uses_stable_aliases_instead_of_pinned_versions() {
        let catalog = claude_catalog();
        let values: Vec<_> = catalog
            .options
            .iter()
            .map(|option| option.value.as_str())
            .collect();
        assert!(values.contains(&"fable"));
        assert!(values.contains(&"sonnet[1m]"));
        assert!(!values.iter().any(|value| value.starts_with("claude-")));
    }

    #[test]
    fn parses_tab_separated_antigravity_models() {
        let output = "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n\
                      claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\
                      Fetching available models...\n";
        let models = parse_antigravity_models(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].value, "gemini-3.7-flash-high");
        assert_eq!(models[1].label, "Claude Opus 4.6 (Thinking)");
    }

    #[test]
    fn antigravity_parser_deduplicates_values() {
        let output = "model-a\tModel A\nmodel-a\tModel A Again\n";
        assert_eq!(parse_antigravity_models(output).len(), 1);
    }
}
