use serde::Serialize;
use serde_json::Value;

/// Structured error returned across the Tauri IPC boundary. `message` remains
/// available as a compatibility fallback while clients migrate to `code`.
#[derive(Debug, Serialize)]
pub struct AppError {
    message: String,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "app.error".to_string(),
            params: None,
        }
    }

    pub fn coded(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
            params: None,
        }
    }

    pub fn coded_with_params(
        code: impl Into<String>,
        message: impl Into<String>,
        params: Value,
    ) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
            params: Some(params),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        AppError::msg(error.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        AppError::msg(error.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::msg(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coded_errors_serialize_machine_readable_codes() {
        let value = serde_json::to_value(AppError::coded(
            "project_identity_changed",
            "项目目录身份已变化",
        ))
        .unwrap();
        assert_eq!(value["code"], "project_identity_changed");
        assert_eq!(value["message"], "项目目录身份已变化");
    }

    #[test]
    fn ordinary_errors_keep_a_structured_message_fallback() {
        let value = serde_json::to_value(AppError::msg("错误")).unwrap();
        assert_eq!(value["code"], "app.error");
        assert_eq!(value["message"], "错误");
        assert!(value.get("params").is_none());
    }

    #[test]
    fn coded_errors_can_serialize_localization_parameters() {
        let value = serde_json::to_value(AppError::coded_with_params(
            "file.too_large",
            "文件超过限制",
            serde_json::json!({ "maxBytes": 1024 }),
        ))
        .unwrap();
        assert_eq!(value["code"], "file.too_large");
        assert_eq!(value["message"], "文件超过限制");
        assert_eq!(value["params"]["maxBytes"], 1024);
    }
}
