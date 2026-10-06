use serde::{Serialize, Serializer};

/// Error type returned across the Tauri IPC boundary. Serializes to a plain
/// string so the frontend receives a readable message. `From` impls let command
/// bodies use `?` on the common error sources instead of repeating `to_string`.
#[derive(Debug)]
pub struct AppError {
    message: String,
    code: Option<String>,
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub fn coded(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(code) = self.code.as_deref() {
            #[derive(Serialize)]
            struct CodedError<'a> {
                code: &'a str,
                message: &'a str,
            }
            CodedError {
                code,
                message: &self.message,
            }
            .serialize(serializer)
        } else {
            serializer.serialize_str(&self.message)
        }
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
    fn ordinary_errors_keep_the_string_ipc_shape() {
        assert_eq!(
            serde_json::to_value(AppError::msg("错误")).unwrap(),
            serde_json::json!("错误")
        );
    }
}
