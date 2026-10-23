//! Domain errors whose code and parameters are fixed by the type (077b).
//!
//! Each enum maps one-to-one onto registered codes in `error_codes::ErrorCode`. Call sites
//! construct the variant; the wire form (`code`, `message`, `params`) comes from here.

use serde_json::{json, Value};
use thiserror::Error;

use crate::error::AppError;
use crate::error_codes::ErrorCode;

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("PTY 会话不存在或已结束")]
    SessionNotFound,
    #[error("该终端当前由另一个窗口控制")]
    OwnerMismatch,
    #[error("终端窗口交接已过期，请重试")]
    HandoffExpired,
    #[error("终端正在进行窗口交接，请稍后重试")]
    HandoffInProgress,
    #[error("{0}锁中毒")]
    LockPoisoned(&'static str),
    #[error("{0}")]
    Internal(String),
}

impl PtyError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::SessionNotFound => ErrorCode::PtySessionNotFound,
            Self::OwnerMismatch => ErrorCode::PtyOwnerMismatch,
            Self::HandoffExpired => ErrorCode::PtyHandoffExpired,
            Self::HandoffInProgress => ErrorCode::PtyHandoffInProgress,
            Self::LockPoisoned(_) => ErrorCode::InternalLockPoisoned,
            Self::Internal(_) => ErrorCode::AppInternal,
        }
    }

    pub fn params(&self) -> Option<Value> {
        None
    }
}

#[derive(Debug, Error)]
pub enum FileError {
    #[error("文件超过 {max_bytes} 字节的限制")]
    TooLarge { max_bytes: u64 },
    #[error("只能保存 UTF-8 文本文件")]
    NotUtf8,
    #[error("只能打开或保存普通文件")]
    NotRegularFile,
    #[error("项目文件不存在或无法访问")]
    NotFound,
}

impl FileError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::TooLarge { .. } => ErrorCode::FileTooLarge,
            Self::NotUtf8 => ErrorCode::FileNotUtf8,
            Self::NotRegularFile => ErrorCode::FileNotRegular,
            Self::NotFound => ErrorCode::FileNotFound,
        }
    }

    pub fn params(&self) -> Option<Value> {
        match self {
            Self::TooLarge { max_bytes } => Some(json!({ "maxBytes": max_bytes })),
            _ => None,
        }
    }
}

/// Activity behind a blocked data replace or a refused start, carried to the front end as
/// `ptyCount`, `execCount` and `inflightStarts` beside `count`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ActivityBreakdown {
    pub pty_count: usize,
    pub exec_count: usize,
    pub inflight_starts: usize,
}

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("应用正在退出")]
    Exiting,
    #[error("应用退出已被推迟")]
    ExitDeferred,
    #[error("数据替换被 {count} 个运行中的任务阻止")]
    DataReplaceBlocked {
        count: usize,
        activity: ActivityBreakdown,
    },
    #[error("数据替换正在进行")]
    DataReplaceInProgress,
    #[error("配置导入正在进行")]
    ConfigImportInProgress,
    #[error("备份恢复正在进行")]
    RestoreInProgress,
    #[error("{count} 个终端会话仍在运行")]
    PtySessionsActive {
        count: usize,
        activity: ActivityBreakdown,
    },
    #[error("{count} 个终端会话正在启动")]
    PtySessionStarting {
        count: usize,
        activity: ActivityBreakdown,
    },
}

impl LifecycleError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Exiting => ErrorCode::AppExiting,
            Self::ExitDeferred => ErrorCode::AppExitDeferred,
            Self::DataReplaceBlocked { .. } => ErrorCode::AppDataReplaceBlocked,
            Self::DataReplaceInProgress => ErrorCode::AppDataReplaceInProgress,
            Self::ConfigImportInProgress => ErrorCode::ConfigImportInProgress,
            Self::RestoreInProgress => ErrorCode::BackupRestoreInProgress,
            Self::PtySessionsActive { .. } => ErrorCode::PtySessionsActive,
            Self::PtySessionStarting { .. } => ErrorCode::PtySessionStarting,
        }
    }

    pub fn params(&self) -> Option<Value> {
        match self {
            Self::DataReplaceBlocked { count, activity }
            | Self::PtySessionsActive { count, activity }
            | Self::PtySessionStarting { count, activity } => Some(json!({
                "count": count,
                "ptyCount": activity.pty_count,
                "execCount": activity.exec_count,
                "inflightStarts": activity.inflight_starts,
            })),
            _ => None,
        }
    }

    /// The same code and parameters with a call-site message, for sites whose text names the
    /// action being refused (for example "恢复备份" or "导入配置").
    pub fn with_message(self, message: impl Into<String>) -> AppError {
        to_app_error(self.code(), message.into(), self.params())
    }
}

/// Every domain error converts the same way: code from the type, message from `Display`,
/// parameters only when the variant has some.
fn to_app_error(code: ErrorCode, message: String, params: Option<Value>) -> AppError {
    match params {
        Some(params) => AppError::coded_with_params(code, message, params),
        None => AppError::coded(code, message),
    }
}

impl From<PtyError> for AppError {
    fn from(error: PtyError) -> Self {
        to_app_error(error.code(), error.to_string(), error.params())
    }
}

impl From<FileError> for AppError {
    fn from(error: FileError) -> Self {
        to_app_error(error.code(), error.to_string(), error.params())
    }
}

impl From<LifecycleError> for AppError {
    fn from(error: LifecycleError) -> Self {
        to_app_error(error.code(), error.to_string(), error.params())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pty_error_codes_match_the_table() {
        assert_eq!(
            PtyError::SessionNotFound.code(),
            ErrorCode::PtySessionNotFound
        );
        assert_eq!(PtyError::OwnerMismatch.code(), ErrorCode::PtyOwnerMismatch);
        assert_eq!(
            PtyError::HandoffExpired.code(),
            ErrorCode::PtyHandoffExpired
        );
        assert_eq!(
            PtyError::HandoffInProgress.code(),
            ErrorCode::PtyHandoffInProgress
        );
        assert_eq!(
            PtyError::LockPoisoned("PTY 会话表").code(),
            ErrorCode::InternalLockPoisoned
        );
        assert_eq!(
            PtyError::Internal("boom".to_string()).code(),
            ErrorCode::AppInternal
        );
        assert_eq!(
            PtyError::LockPoisoned("PTY 会话表").to_string(),
            "PTY 会话表锁中毒"
        );
    }

    #[test]
    fn file_error_codes_match_the_table() {
        assert_eq!(
            FileError::TooLarge {
                max_bytes: 2_097_152
            }
            .code(),
            ErrorCode::FileTooLarge
        );
        assert_eq!(FileError::NotUtf8.code(), ErrorCode::FileNotUtf8);
        assert_eq!(FileError::NotRegularFile.code(), ErrorCode::FileNotRegular);
        assert_eq!(FileError::NotFound.code(), ErrorCode::FileNotFound);
        assert_eq!(
            FileError::TooLarge {
                max_bytes: 2_097_152
            }
            .params(),
            Some(json!({ "maxBytes": 2_097_152 }))
        );
        // Reverse: variants without a parameter carry none.
        assert_eq!(FileError::NotUtf8.params(), None);
        assert_eq!(FileError::NotRegularFile.params(), None);
        assert_eq!(FileError::NotFound.params(), None);
    }

    #[test]
    fn lifecycle_error_codes_match_the_table() {
        let cases = [
            (LifecycleError::Exiting, ErrorCode::AppExiting),
            (LifecycleError::ExitDeferred, ErrorCode::AppExitDeferred),
            (
                LifecycleError::DataReplaceBlocked {
                    count: 3,
                    activity: ActivityBreakdown::default(),
                },
                ErrorCode::AppDataReplaceBlocked,
            ),
            (
                LifecycleError::DataReplaceInProgress,
                ErrorCode::AppDataReplaceInProgress,
            ),
            (
                LifecycleError::ConfigImportInProgress,
                ErrorCode::ConfigImportInProgress,
            ),
            (
                LifecycleError::RestoreInProgress,
                ErrorCode::BackupRestoreInProgress,
            ),
            (
                LifecycleError::PtySessionsActive {
                    count: 3,
                    activity: ActivityBreakdown::default(),
                },
                ErrorCode::PtySessionsActive,
            ),
            (
                LifecycleError::PtySessionStarting {
                    count: 3,
                    activity: ActivityBreakdown::default(),
                },
                ErrorCode::PtySessionStarting,
            ),
        ];
        for (error, code) in cases {
            assert_eq!(error.code(), code, "{error}");
        }
        // Counted variants carry their count; the others carry none.
        assert_eq!(
            LifecycleError::DataReplaceBlocked {
                count: 3,
                activity: ActivityBreakdown::default()
            }
            .params(),
            Some(json!({ "count": 3, "ptyCount": 0, "execCount": 0, "inflightStarts": 0 }))
        );
        assert_eq!(
            LifecycleError::PtySessionsActive {
                count: 3,
                activity: ActivityBreakdown::default()
            }
            .params(),
            Some(json!({ "count": 3, "ptyCount": 0, "execCount": 0, "inflightStarts": 0 }))
        );
        assert_eq!(
            LifecycleError::PtySessionStarting {
                count: 3,
                activity: ActivityBreakdown::default()
            }
            .params(),
            Some(json!({ "count": 3, "ptyCount": 0, "execCount": 0, "inflightStarts": 0 }))
        );
        assert_eq!(LifecycleError::Exiting.params(), None);
        assert_eq!(LifecycleError::RestoreInProgress.params(), None);
    }

    #[test]
    fn domain_errors_convert_to_app_error_with_code_message_and_params() {
        let counted = LifecycleError::PtySessionsActive {
            count: 2,
            activity: ActivityBreakdown::default(),
        };
        let value = serde_json::to_value(AppError::from(LifecycleError::PtySessionsActive {
            count: 2,
            activity: ActivityBreakdown::default(),
        }))
        .unwrap();
        assert_eq!(value["code"], counted.code().as_str());
        assert_eq!(value["message"], counted.to_string());
        assert_eq!(value["params"], counted.params().unwrap());

        // Reverse: a variant without parameters serializes without a params key.
        let plain = serde_json::to_value(AppError::from(LifecycleError::Exiting)).unwrap();
        assert_eq!(plain["code"], "app.exiting");
        assert!(plain.get("params").is_none());
    }
}
