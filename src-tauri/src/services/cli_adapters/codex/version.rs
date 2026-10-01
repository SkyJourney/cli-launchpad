pub(crate) fn parse_codex_latest(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "Codex 官方版本响应格式无效".to_string())?;
    let tag = value
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Codex 官方版本响应缺少 tag_name".to_string())?;
    let normalized = tag
        .strip_prefix("rust-v")
        .or_else(|| tag.strip_prefix('v'))
        .unwrap_or(tag);
    crate::services::version_service::normalize_semver(normalized)
        .ok_or_else(|| "Codex 官方版本号无效".to_string())
}
