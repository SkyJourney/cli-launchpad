pub(crate) fn parse_antigravity_latest(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "Antigravity 官方版本响应格式无效".to_string())?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Antigravity 官方版本响应缺少 version".to_string())?;
    crate::services::version_service::normalize_semver(version)
        .ok_or_else(|| "Antigravity 官方版本号无效".to_string())
}

pub(crate) fn platform() -> Result<&'static str, String> {
    platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub(crate) fn platform_for(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("windows", "x86_64") => Ok("windows_amd64"),
        ("windows", "aarch64") => Ok("windows_arm64"),
        ("macos", "x86_64") => Ok("darwin_amd64"),
        ("macos", "aarch64") => Ok("darwin_arm64"),
        ("linux", "x86_64") => Ok("linux_amd64"),
        ("linux", "aarch64") => Ok("linux_arm64"),
        _ => Err("当前平台尚未配置 Antigravity 官方版本查询".to_string()),
    }
}
