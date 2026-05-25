use serde::{Serialize, Serializer};

/// Error type returned across the Tauri IPC boundary. Serializes to a plain
/// string so the frontend receives a readable message. `From` impls let command
/// bodies use `?` on the common error sources instead of repeating `to_string`.
#[derive(Debug)]
pub struct AppError(pub String);

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        AppError(message.into())
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        AppError(error.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        AppError(error.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError(error.to_string())
    }
}
