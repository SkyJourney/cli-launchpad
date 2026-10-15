use tauri::ipc::Channel;

use crate::{
    db::{launch_history_repo, pty_session_repo},
    models::{launch_history::LaunchAction, pty_session::PtyEvent, tool::ToolKey},
    AppError, Db,
};

/// Where PTY events go. The production implementation is a Tauri `Channel`.
pub(crate) trait PtyEventSink: Send + Sync {
    fn send(&self, event: PtyEvent) -> Result<(), String>;
}

impl PtyEventSink for Channel<PtyEvent> {
    fn send(&self, event: PtyEvent) -> Result<(), String> {
        Channel::send(self, event).map_err(|error| error.to_string())
    }
}

/// Persistence of PTY session rows.
pub(crate) trait PtySessionStore: Send + Sync {
    fn insert_running(
        &self,
        session_id: &str,
        directory_id: i64,
        tool_key: ToolKey,
        working_directory: &str,
        started_at_ms: i64,
    ) -> Result<(), AppError>;

    fn finish(
        &self,
        session_id: &str,
        state: &str,
        ended_at_ms: i64,
        exit_code: Option<i64>,
    ) -> Result<(), AppError>;
}

pub(crate) struct DbPtySessionStore {
    db: Db,
}

impl DbPtySessionStore {
    pub(crate) fn new(db: Db) -> Self {
        Self { db }
    }
}

impl PtySessionStore for DbPtySessionStore {
    fn insert_running(
        &self,
        session_id: &str,
        directory_id: i64,
        tool_key: ToolKey,
        working_directory: &str,
        started_at_ms: i64,
    ) -> Result<(), AppError> {
        self.db
            .with_sync("pty.session.insert_running", |connection| {
                pty_session_repo::insert_running(
                    connection,
                    session_id,
                    directory_id,
                    tool_key,
                    working_directory,
                    started_at_ms,
                )?;
                Ok(())
            })
    }

    fn finish(
        &self,
        session_id: &str,
        state: &str,
        ended_at_ms: i64,
        exit_code: Option<i64>,
    ) -> Result<(), AppError> {
        self.db.with_sync("pty.session.finish", |connection| {
            pty_session_repo::finish(connection, session_id, state, ended_at_ms, exit_code)?;
            Ok(())
        })
    }
}

pub(crate) struct LaunchRecord<'a> {
    pub directory_id: i64,
    pub directory_path: Option<&'a str>,
    pub tool_key: ToolKey,
    pub action: LaunchAction,
    pub success: bool,
    pub error_category: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

/// Where launch history entries go.
pub(crate) trait LaunchHistorySink: Send + Sync {
    fn record(&self, entry: LaunchRecord<'_>) -> Result<(), AppError>;
}

pub(crate) struct DbLaunchHistorySink {
    db: Db,
}

impl DbLaunchHistorySink {
    pub(crate) fn new(db: Db) -> Self {
        Self { db }
    }
}

impl LaunchHistorySink for DbLaunchHistorySink {
    fn record(&self, entry: LaunchRecord<'_>) -> Result<(), AppError> {
        self.db.with_sync("launch_history.record", |connection| {
            launch_history_repo::record(
                connection,
                entry.directory_id,
                entry.directory_path,
                entry.tool_key,
                entry.action,
                entry.success,
                entry.error_category,
                entry.session_id,
            )?;
            Ok(())
        })
    }
}
