use serde::Serialize;
use serde_json::Value;

use crate::domain_errors::{FileError, LifecycleError, PtyError};
use crate::error_codes::ErrorCode;

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
    /// Legacy constructor for sites not yet converted (077c removes it).
    pub fn msg(message: impl Into<String>) -> Self {
        Self::coded(ErrorCode::AppError, message)
    }

    /// An unexpected failure: the front end shows generic text and the detail stays in logs.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::coded(ErrorCode::AppInternal, message)
    }

    pub fn coded(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: code.as_str().to_string(),
            params: None,
        }
    }

    pub fn coded_with_params(code: ErrorCode, message: impl Into<String>, params: Value) -> Self {
        Self {
            message: message.into(),
            code: code.as_str().to_string(),
            params: Some(params),
        }
    }

    /// The wire form of the code, for tests and logs.
    pub fn code(&self) -> &str {
        &self.code
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        AppError::internal(error.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    /// A chain that carries an `AppError` or a domain error keeps that code; anything else is
    /// internal. The chain is opaque: an io error inside it is not mapped by its kind.
    fn from(error: anyhow::Error) -> Self {
        let error = match error.downcast::<AppError>() {
            Ok(app) => return app,
            Err(other) => other,
        };
        let error = match error.downcast::<FileError>() {
            Ok(file) => return AppError::from(file),
            Err(other) => other,
        };
        let error = match error.downcast::<PtyError>() {
            Ok(pty) => return AppError::from(pty),
            Err(other) => other,
        };
        match error.downcast::<LifecycleError>() {
            Ok(lifecycle) => AppError::from(lifecycle),
            Err(other) => AppError::internal(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        let message = error.to_string();
        match error.kind() {
            std::io::ErrorKind::NotFound => AppError::coded(ErrorCode::FileNotFound, message),
            std::io::ErrorKind::PermissionDenied => {
                AppError::coded(ErrorCode::FilePermissionDenied, message)
            }
            std::io::ErrorKind::TimedOut => AppError::coded(ErrorCode::BlockingTimeout, message),
            _ => AppError::internal(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coded_errors_serialize_machine_readable_codes() {
        let value = serde_json::to_value(AppError::coded(
            ErrorCode::ProjectIdentityChanged,
            "项目目录身份已变化",
        ))
        .unwrap();
        assert_eq!(value["code"], "project.identity_changed");
        assert_eq!(value["message"], "项目目录身份已变化");
    }

    #[test]
    fn coded_errors_serialize_the_enum_code_string() {
        let identity = serde_json::to_value(AppError::coded(
            ErrorCode::ProjectIdentityChanged,
            "项目目录身份已变化",
        ))
        .unwrap();
        assert_eq!(identity["code"], "project.identity_changed");
        assert_eq!(identity["message"], "项目目录身份已变化");

        let large = serde_json::to_value(AppError::coded_with_params(
            ErrorCode::FileTooLarge,
            "文件超限",
            serde_json::json!({ "maxBytes": 1024 }),
        ))
        .unwrap();
        assert_eq!(large["code"], "file.too_large");
        assert_eq!(large["params"]["maxBytes"], 1024);
        // Reverse: the pre-enum underscore spelling never reaches the wire.
        assert_ne!(identity["code"], "project_identity_changed");
    }

    #[test]
    fn internal_errors_serialize_as_app_internal() {
        let value = serde_json::to_value(AppError::internal("错误")).unwrap();
        assert_eq!(value["code"], "app.internal");
        assert_eq!(value["message"], "错误");
        assert!(value.get("params").is_none());
        // Reverse: the generic code is not the legacy app.error fallback.
        assert_ne!(value["code"], "app.error");
    }

    #[test]
    fn anyhow_errors_without_a_code_become_app_internal() {
        let plain = AppError::from(anyhow::anyhow!("普通错误"));
        assert_eq!(plain.code(), "app.internal");
        assert!(plain.to_string().contains("普通错误"));

        // Reverse: an io kind inside an anyhow chain is not mapped by kind (the chain is opaque).
        let chained = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::NotFound))
            .context("读取失败");
        assert_eq!(AppError::from(chained).code(), "app.internal");
    }

    #[test]
    fn anyhow_errors_downcast_to_domain_codes() {
        use crate::domain_errors::{FileError, PtyError};

        let too_large =
            anyhow::Error::new(FileError::TooLarge { max_bytes: 10 }).context("保存失败");
        let value = serde_json::to_value(AppError::from(too_large)).unwrap();
        assert_eq!(value["code"], "file.too_large");
        assert_eq!(value["params"]["maxBytes"], 10);

        let expired = anyhow::Error::new(PtyError::HandoffExpired);
        assert_eq!(AppError::from(expired).code(), "pty.handoff_expired");

        // Reverse: an io error inside an anyhow chain is not mapped by its kind.
        let chained = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::NotFound))
            .context("读取失败");
        assert_ne!(AppError::from(chained).code(), "file.not_found");
    }

    #[test]
    fn io_errors_map_by_kind() {
        use std::io::{Error, ErrorKind};
        let cases = [
            (ErrorKind::NotFound, "file.not_found"),
            (ErrorKind::PermissionDenied, "file.permission_denied"),
            (ErrorKind::TimedOut, "blocking.timeout"),
            (ErrorKind::InvalidData, "app.internal"),
        ];
        for (kind, expected) in cases {
            let error = Error::from(kind);
            let message = error.to_string();
            let app = AppError::from(error);
            assert_eq!(app.code(), expected, "{kind:?}");
            assert_eq!(app.to_string(), message, "{kind:?}");
        }
        // Reverse: a missing file is never reported as the generic internal error.
        let missing = AppError::from(Error::from(ErrorKind::NotFound));
        assert_ne!(missing.code(), "app.internal");
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
            ErrorCode::FileTooLarge,
            "文件超过限制",
            serde_json::json!({ "maxBytes": 1024 }),
        ))
        .unwrap();
        assert_eq!(value["code"], "file.too_large");
        assert_eq!(value["message"], "文件超过限制");
        assert_eq!(value["params"]["maxBytes"], 1024);
    }
}
