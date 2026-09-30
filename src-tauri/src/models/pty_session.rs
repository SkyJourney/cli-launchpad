use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub session_id: String,
    pub directory_id: i64,
    pub tool_key: ToolKey,
    pub working_directory: String,
    pub state: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_code: Option<i64>,
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
        state: String,
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
