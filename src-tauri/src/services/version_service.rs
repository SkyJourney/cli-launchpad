use std::time::Duration;

use crate::models::install::LatestVersion;
use crate::models::tool::ToolKey;

const REGISTRY_TIMEOUT: Duration = Duration::from_secs(8);

/// npm registry package name for tools distributed via npm. Antigravity has no
/// public registry, so its latest version cannot be queried.
fn npm_package(tool_key: ToolKey) -> Option<&'static str> {
    match tool_key {
        ToolKey::Claude => Some("@anthropic-ai/claude-code"),
        ToolKey::Codex => Some("@openai/codex"),
        ToolKey::Antigravity => None,
    }
}

pub fn fetch_all_latest() -> Vec<LatestVersion> {
    [ToolKey::Claude, ToolKey::Codex, ToolKey::Antigravity]
        .into_iter()
        .map(|tool_key| LatestVersion {
            tool_key,
            latest: fetch_latest(tool_key),
        })
        .collect()
}

/// Query the npm registry `latest` dist-tag. Network failures degrade to None
/// so the UI can still show the current version.
pub fn fetch_latest(tool_key: ToolKey) -> Option<String> {
    let package = npm_package(tool_key)?;
    let url = format!("https://registry.npmjs.org/{package}/latest");

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(REGISTRY_TIMEOUT)
        .timeout_read(REGISTRY_TIMEOUT)
        .build();

    let body = agent.get(&url).call().ok()?.into_string().ok()?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}
