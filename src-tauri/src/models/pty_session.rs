use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

/// Lifecycle state of a PTY session. The lowercase strings are both the wire and the database values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PtySessionState {
    Running,
    Exited,
    Terminated,
    Failed,
}

impl PtySessionState {
    pub const ALL: [PtySessionState; 4] =
        [Self::Running, Self::Exited, Self::Terminated, Self::Failed];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Terminated => "terminated",
            Self::Failed => "failed",
        }
    }

    pub fn from_db_str(value: &str) -> Option<PtySessionState> {
        Self::ALL.into_iter().find(|state| state.as_str() == value)
    }
}

impl std::fmt::Display for PtySessionState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub session_id: String,
    pub directory_id: i64,
    pub tool_key: ToolKey,
    pub working_directory: String,
    pub state: PtySessionState,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_code: Option<i64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PtySessionWindowStatus {
    Running,
    Ended,
    OwnedByAnotherWindow,
}

/// `get_pty_session_window_status` 的返回值：状态加当前所有者窗口的标签。
/// 会话已结束或不存在时没有所有者，标签序列化为 `null`。只序列化，不反序列化。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionWindowStatusReport {
    pub status: PtySessionWindowStatus,
    pub owner_window_label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum PtyEvent {
    Output {
        session_id: String,
        sequence: u64,
        data_base64: String,
    },
    Snapshot {
        session_id: String,
        sequence: u64,
        data: String,
        cols: u16,
        rows: u16,
    },
    Exited {
        session_id: String,
        state: PtySessionState,
        exit_code: Option<i64>,
    },
    Failed {
        session_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyHandoff {
    pub token: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyTerminalSnapshot {
    pub data: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyFrontendStage {
    StartupInputFlushed,
    OutputReceived,
    OutputDecodeFailed,
    XtermWritePending,
    XtermWriteCompleted,
    XtermWriteFailed,
    RendererPaused,
    RendererResumed,
}

impl PtyFrontendStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StartupInputFlushed => "startupInputFlushed",
            Self::OutputReceived => "outputReceived",
            Self::OutputDecodeFailed => "outputDecodeFailed",
            Self::XtermWritePending => "xtermWritePending",
            Self::XtermWriteCompleted => "xtermWriteCompleted",
            Self::XtermWriteFailed => "xtermWriteFailed",
            Self::RendererPaused => "rendererPaused",
            Self::RendererResumed => "rendererResumed",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySizeUpdate {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pty_session_state_serializes_as_lowercase_strings() {
        assert_eq!(PtySessionState::ALL.len(), 4);
        assert_eq!(
            PtySessionState::ALL.map(|state| state.as_str()),
            ["running", "exited", "terminated", "failed"]
        );
        for state in PtySessionState::ALL {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(state.as_str()));
            assert_eq!(PtySessionState::from_db_str(state.as_str()), Some(state));
        }
        assert_eq!(PtySessionState::from_db_str("paused"), None);
        assert_eq!(PtySessionState::from_db_str("Running"), None);
        assert_eq!(
            serde_json::from_value::<PtySessionState>(json!("terminated")).unwrap(),
            PtySessionState::Terminated
        );
    }

    #[test]
    fn pty_exit_event_keeps_its_wire_shape() {
        let terminated = PtyEvent::Exited {
            session_id: "s1".to_string(),
            state: PtySessionState::Terminated,
            exit_code: Some(1),
        };
        assert_eq!(
            serde_json::to_value(&terminated).unwrap(),
            json!({"type": "exited", "sessionId": "s1", "state": "terminated", "exitCode": 1})
        );

        let without_code = PtyEvent::Exited {
            session_id: "s2".to_string(),
            state: PtySessionState::Exited,
            exit_code: None,
        };
        let value = serde_json::to_value(&without_code).unwrap();
        assert_eq!(value["exitCode"], json!(null));
        // 反向：线上的 state 必须是字符串，不能是数字或对象。
        assert!(value["state"].is_string());
    }
}
