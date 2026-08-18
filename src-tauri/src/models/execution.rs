use serde::{Deserialize, Serialize};

use super::{install::InstallKind, tool::ToolKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Preparing,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Interrupted,
}

impl ExecutionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Running => "running",
            Self::Cancelling => "cancelling",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "preparing" => Some(Self::Preparing),
            "running" => Some(Self::Running),
            "cancelling" => Some(Self::Cancelling),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "timed_out" => Some(Self::TimedOut),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::TimedOut | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStream {
    Stdout,
    Stderr,
    System,
}

impl ExecutionStream {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
            Self::System => "system",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "stdout" => Some(Self::Stdout),
            "stderr" => Some(Self::Stderr),
            "system" => Some(Self::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTask {
    pub id: String,
    pub tool_key: ToolKey,
    pub kind: InstallKind,
    pub source: String,
    pub preview: String,
    pub status: ExecutionStatus,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub exit_code: Option<i32>,
    pub error_message: Option<String>,
    pub log_truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLogChunk {
    pub task_id: String,
    pub sequence: i64,
    pub stream: ExecutionStream,
    pub content: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTaskDetail {
    pub task: ExecutionTask,
    pub logs: Vec<ExecutionLogChunk>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_status_round_trips_and_marks_terminal_states() {
        let statuses = [
            ExecutionStatus::Preparing,
            ExecutionStatus::Running,
            ExecutionStatus::Cancelling,
            ExecutionStatus::Succeeded,
            ExecutionStatus::Failed,
            ExecutionStatus::Cancelled,
            ExecutionStatus::TimedOut,
            ExecutionStatus::Interrupted,
        ];

        for status in statuses {
            assert_eq!(ExecutionStatus::from_str(status.as_str()), Some(status));
        }

        assert!(!ExecutionStatus::Preparing.is_terminal());
        assert!(!ExecutionStatus::Running.is_terminal());
        assert!(!ExecutionStatus::Cancelling.is_terminal());
        assert!(ExecutionStatus::Succeeded.is_terminal());
        assert!(ExecutionStatus::Failed.is_terminal());
        assert!(ExecutionStatus::Cancelled.is_terminal());
        assert!(ExecutionStatus::TimedOut.is_terminal());
        assert!(ExecutionStatus::Interrupted.is_terminal());
    }

    #[test]
    fn execution_stream_round_trips() {
        for stream in [
            ExecutionStream::Stdout,
            ExecutionStream::Stderr,
            ExecutionStream::System,
        ] {
            assert_eq!(ExecutionStream::from_str(stream.as_str()), Some(stream));
        }
    }
}
