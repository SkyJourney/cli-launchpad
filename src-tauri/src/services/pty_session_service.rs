use std::{
    collections::VecDeque,
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, PtySize};
use tauri::ipc::Channel;
use uuid::Uuid;

mod flow;
mod handoff;
mod input;
mod persistence;
mod ports;
mod process;
mod registry;
mod route;
mod session;
mod window;

use flow::OutputFlow;
use handoff::{deliver_snapshot, HandoffState};
use input::{enqueue_pty_input, pty_input_channel, start_pty_input_writer};
use persistence::{
    register_then_persist, FlushReport, LogObserver, PendingFinishQueue, PersistenceObserver,
    RetryingStore,
};
use ports::{
    DbLaunchHistorySink, DbPtySessionStore, LaunchHistorySink, LaunchRecord, PtyEventSink,
    PtySessionStore,
};
use process::{stop_spawned_child, Terminator, TreeTerminateError};
use registry::SessionRegistry;
use route::EventRoute;
use session::{ManagedSession, RouteAndHandoff, TerminalState};

use crate::models::window_kind::{is_main_label, main_window_label, WindowKind, WindowLabel};
use crate::services::window_lifecycle::{AppEvent, WindowScopedResource};

use crate::{
    db::directory_repo,
    models::{
        launch_history::LaunchAction,
        pty_session::{
            PtyEvent, PtyFrontendStage, PtyHandoff, PtySession, PtySizeUpdate, PtyTerminalSnapshot,
        },
        tool::ToolKey,
    },
    platform::execution_process::{attach_pty_or_terminate, ProcessTree},
    services::{directory_service, launch_service},
    AppError, Db,
};

const READ_CHUNK_BYTES: usize = 16 * 1024;
const MAX_HANDOFF_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct PtySessionManager {
    registry: Arc<SessionRegistry>,
    persist_queue: Arc<PendingFinishQueue>,
    observer: Arc<dyn PersistenceObserver>,
}

impl Default for PtySessionManager {
    fn default() -> Self {
        Self {
            registry: Arc::new(SessionRegistry::new()),
            persist_queue: Arc::new(PendingFinishQueue::new()),
            observer: Arc::new(LogObserver),
        }
    }
}

fn is_supported_workspace_window(window_label: &str) -> bool {
    matches!(
        crate::models::window_kind::window_kind_of(window_label),
        Some(
            crate::models::window_kind::WindowKind::Main
                | crate::models::window_kind::WindowKind::Terminal
        )
    )
}

fn validate_handoff_snapshot(snapshot: &PtyTerminalSnapshot) -> Result<(), AppError> {
    validate_size(PtySizeUpdate {
        cols: snapshot.cols,
        rows: snapshot.rows,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    if snapshot.data.len() > MAX_HANDOFF_SNAPSHOT_BYTES {
        return Err(AppError::msg("终端画面过大，暂时无法移动到独立窗口"));
    }
    Ok(())
}

impl PtySessionManager {
    /// Test constructor: production code only uses `Default` (the log observer).
    #[cfg(test)]
    pub(crate) fn with_observer(observer: Arc<dyn PersistenceObserver>) -> Self {
        Self {
            registry: Arc::new(SessionRegistry::new()),
            persist_queue: Arc::new(PendingFinishQueue::new()),
            observer,
        }
    }

    /// The database store wrapped in the manager's shared retry queue.
    fn retrying_store(&self, db: &Db) -> RetryingStore {
        RetryingStore::new(
            Arc::new(DbPtySessionStore::new(db.clone())),
            Arc::clone(&self.persist_queue),
            Arc::clone(&self.observer),
        )
    }

    /// Retries the `finish` writes that failed earlier so the rows catch up with memory.
    /// Failures are reported to the observer; the caller only needs the counts.
    pub fn flush_pending_persistence(&self, db: &Db) -> FlushReport {
        self.retrying_store(db).flush_pending()
    }

    fn open_sessions(&self) -> Vec<Arc<ManagedSession>> {
        match self.registry.snapshot() {
            Ok(sessions) => sessions
                .into_iter()
                .filter(|session| !session.flow.is_closed())
                .collect(),
            Err(_) => {
                log::error!("PTY session table lock poisoned while listing running sessions");
                Vec::new()
            }
        }
    }

    /// Session ids registered for `directory_id` whose output flow is still open.
    /// Lock note (m6-056 D1): `remove_directory` calls this while holding the database lock;
    /// it takes only the registry lock and each session's flow lock, neither of which is ever
    /// held while acquiring the database lock.
    pub fn running_in(&self, directory_id: i64) -> Vec<String> {
        self.open_sessions()
            .into_iter()
            .filter(|session| session.directory_id == directory_id)
            .map(|session| session.session_id.clone())
            .collect()
    }

    #[cfg(test)]
    pub fn is_running(&self, session_id: &str) -> bool {
        self.registry
            .find(session_id)
            .ok()
            .flatten()
            .is_some_and(|session| !session.flow.is_closed())
    }

    /// A snapshot of the ids of every open session.
    pub fn running_session_ids(&self) -> std::collections::HashSet<String> {
        self.open_sessions()
            .into_iter()
            .map(|session| session.session_id.clone())
            .collect()
    }

    pub fn create(
        &self,
        db: &Db,
        directory_id: i64,
        tool_key: ToolKey,
        payload: &launch_service::CliLaunchPayload,
        resume_session_id: Option<&str>,
        size: PtySizeUpdate,
        window_label: &str,
        on_event: Channel<PtyEvent>,
    ) -> Result<PtySession, AppError> {
        let directory = crate::with_connection(db, |connection| {
            directory_repo::get(connection, directory_id)?
                .ok_or_else(|| AppError::msg(format!("directory {directory_id} not found")))
        })?;
        if !crate::platform::path_identity::paths_equal(&directory.path, &payload.directory) {
            return Err(AppError::coded(
                crate::error_codes::PROJECT_IDENTITY_CHANGED,
                "项目目录在启动准备期间发生变化，请重试",
            ));
        }
        let directory_path = directory.path;
        let store: Arc<dyn PtySessionStore> = Arc::new(self.retrying_store(db));
        let history = DbLaunchHistorySink::new(db.clone());
        let result = self.create_inner(
            &store,
            directory_id,
            tool_key,
            payload,
            size,
            window_label,
            on_event,
        );
        let action = if resume_session_id.is_some() {
            LaunchAction::Resume
        } else {
            LaunchAction::Launch
        };
        let session_id = result
            .as_ref()
            .ok()
            .map(|session| session.session_id.as_str());
        let error_category = result.as_ref().err().map(|_| "launch_failed");
        if let Err(error) = history.record(LaunchRecord {
            directory_id,
            directory_path: Some(&directory_path),
            tool_key,
            action,
            success: result.is_ok(),
            error_category,
            session_id,
        }) {
            log::warn!("unable to record embedded PTY launch history: {error}");
        }
        result
    }

    fn create_inner(
        &self,
        store: &Arc<dyn PtySessionStore>,
        directory_id: i64,
        tool_key: ToolKey,
        payload: &launch_service::CliLaunchPayload,
        size: PtySizeUpdate,
        window_label: &str,
        on_event: Channel<PtyEvent>,
    ) -> Result<PtySession, AppError> {
        validate_size(size)?;
        let payload = payload.clone();
        directory_service::validate_path(&payload.directory)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(to_pty_size(size))
            .context("创建 PTY 失败")?;
        let process_tree = ProcessTree::new().context("创建 PTY 进程树隔离失败")?;
        let mut command = CommandBuilder::new(&payload.tool_executable);
        command.args(&payload.tool_args);
        command.cwd(&payload.directory);
        configure_cli_environment(&mut command);

        let mut child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("启动 {} PTY 失败", tool_key.as_str()))?;
        if let Err(error) = attach_pty_or_terminate(&process_tree, &mut child, &*pair.master) {
            return Err(error)
                .context("将 PTY 子进程加入进程树隔离失败")
                .map_err(Into::into);
        }

        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                stop_spawned_child(&process_tree, &mut child);
                return Err(error)
                    .context("创建 PTY 输出读取器失败")
                    .map_err(Into::into);
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                stop_spawned_child(&process_tree, &mut child);
                return Err(error)
                    .context("创建 PTY 输入写入器失败")
                    .map_err(Into::into);
            }
        };
        let session_id = Uuid::new_v4().to_string();
        let (writer_sender, writer_receiver) = pty_input_channel();
        if let Err(error) = start_pty_input_writer(writer, writer_receiver, session_id.clone()) {
            stop_spawned_child(&process_tree, &mut child);
            return Err(error)
                .context("创建 PTY 输入写入线程失败")
                .map_err(Into::into);
        }
        let now = now_ms();
        let killer = child.clone_killer();
        let session = Arc::new(ManagedSession {
            session_id: session_id.clone(),
            directory_id,
            tool_key,
            working_directory: payload.directory.clone(),
            started_at_ms: now,
            terminal: Mutex::new(TerminalState {
                master: pair.master,
                last_size: (size.cols, size.rows),
            }),
            writer: writer_sender,
            killer: Mutex::new(killer),
            process_tree: Mutex::new(Some(process_tree)),
            flow: Arc::new(OutputFlow::new()),
            route_and_handoff: Mutex::new(RouteAndHandoff {
                route: EventRoute {
                    window_label: window_label.to_string(),
                    channel: Some(Arc::new(on_event) as Arc<dyn PtyEventSink>),
                    mirror: None,
                    owner_lost: false,
                    buffered_events: VecDeque::new(),
                    buffered_bytes: 0,
                    epoch: 0,
                    reattaching: false,
                },
                handoff: HandoffState::Idle,
            }),
            first_output_logged: AtomicBool::new(false),
            output_chunks: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            acknowledgement_calls: AtomicU64::new(0),
            last_acknowledged_sequence: AtomicU64::new(0),
            termination_requested: std::sync::atomic::AtomicBool::new(false),
        });
        // Register first, then write the row: if the row cannot be written the registration is
        // undone, so "the row says running but memory does not know it" can only come from a
        // later failed `finish`.
        if let Err(error) = register_then_persist(&self.registry, store.as_ref(), &session) {
            session.flow.close();
            session.force_terminate();
            let _ = child.wait();
            return Err(error);
        }

        if let Err(error) = spawn_output_reader(Arc::clone(&session), reader) {
            self.fail_session_start(store, &session, error.to_string());
            return Err(AppError::msg(format!("创建 PTY 输出线程失败：{error}")));
        }
        if let Err(error) = spawn_child_monitor(
            Arc::clone(&session),
            child,
            Arc::clone(store),
            self.registry_handle(),
        ) {
            self.fail_session_start(store, &session, error.to_string());
            return Err(AppError::msg(format!("创建 PTY 监控线程失败：{error}")));
        }

        log::info!(
            "PTY session started session_id={} tool={}",
            session_id,
            tool_key.as_str()
        );
        if let Err(error) = spawn_session_diagnostics(Arc::clone(&session)) {
            log::warn!(
                "PTY diagnostics thread failed session_id={} error={error}",
                session_id
            );
        }

        Ok(PtySession {
            session_id,
            directory_id,
            tool_key,
            working_directory: payload.directory,
            state: "running".to_string(),
            started_at_ms: now,
            ended_at_ms: None,
            exit_code: None,
        })
    }

    fn registry_handle(&self) -> Arc<SessionRegistry> {
        Arc::clone(&self.registry)
    }

    fn fail_session_start(
        &self,
        store: &Arc<dyn PtySessionStore>,
        session: &ManagedSession,
        reason: String,
    ) {
        session.flow.close();
        let _ = session.tree_terminate();
        session.force_terminate();
        self.registry.remove(&session.session_id);
        if let Err(error) = store.finish(&session.session_id, "failed", now_ms(), None) {
            log::error!("failed to persist PTY start failure: {error}");
        }
        log::error!("failed to start PTY reader or monitor: {reason}");
    }

    fn get(&self, session_id: &str) -> Result<Arc<ManagedSession>, AppError> {
        self.registry.get(session_id)
    }

    pub fn write(&self, session_id: &str, window_label: &str, data: &[u8]) -> Result<(), AppError> {
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        enqueue_pty_input(&session.writer, data)
    }

    pub fn resize(
        &self,
        session_id: &str,
        window_label: &str,
        size: PtySizeUpdate,
    ) -> Result<(), AppError> {
        validate_size(size)?;
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        if session.apply_size(size)? {
            log::info!(
                "PTY resized session_id={} cols={} rows={}",
                session.session_id,
                size.cols,
                size.rows
            );
        }
        Ok(())
    }

    pub fn acknowledge(
        &self,
        session_id: &str,
        window_label: &str,
        sequence: u64,
    ) -> Result<(), AppError> {
        let session = self.registry.find(session_id)?;
        let Some(session) = session else {
            // The monitor removes completed sessions after delivering their
            // final event. A late frontend acknowledgement then has nothing
            // left to release and is safe to ignore.
            return Ok(());
        };
        if !session.is_output_observer(window_label)? {
            return Err(AppError::msg("该窗口当前不允许确认终端输出"));
        }
        if let Err(error) = session.flow.acknowledge(sequence) {
            log::warn!(
                "PTY output acknowledgement failed session_id={} sequence={} error={error}",
                session.session_id,
                sequence
            );
            return Err(error.into());
        }
        session
            .acknowledgement_calls
            .fetch_add(1, Ordering::Relaxed);
        session
            .last_acknowledged_sequence
            .fetch_max(sequence, Ordering::Relaxed);
        Ok(())
    }

    pub fn report_frontend_stage(
        &self,
        session_id: &str,
        window_label: &str,
        stage: PtyFrontendStage,
    ) -> Result<(), AppError> {
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        log::info!(
            "PTY frontend stage session_id={} stage={}",
            session.session_id,
            stage.as_str()
        );
        Ok(())
    }

    pub fn terminate(&self, session_id: &str, window_label: &str) -> Result<(), AppError> {
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        session
            .termination_requested
            .store(true, std::sync::atomic::Ordering::Release);
        let termination = session.tree_terminate().map_err(|error| match error {
            TreeTerminateError::Poisoned => AppError::msg("PTY 进程树锁中毒"),
            TreeTerminateError::Failed(message) => {
                AppError::msg(format!("终止 PTY 进程树失败：{message}"))
            }
        });
        session.flow.close();
        if let Err(error) = termination {
            session.force_terminate();
            return Err(error);
        }
        if Terminator::USER
            .escalate_later(Arc::clone(&session))
            .is_err()
        {
            session.force_terminate();
        }
        Ok(())
    }

    pub fn begin_handoff(
        &self,
        session_id: &str,
        window_label: &str,
    ) -> Result<PtyHandoff, AppError> {
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        let mut guard = session
            .route_and_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        guard.handoff.begin(&session.flow, window_label)
    }

    pub fn stage_handoff_snapshot(
        &self,
        session_id: &str,
        window_label: &str,
        token: &str,
        sequence: u64,
        snapshot: PtyTerminalSnapshot,
    ) -> Result<(), AppError> {
        validate_handoff_snapshot(&snapshot)?;
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        let mut guard = session
            .route_and_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        guard
            .handoff
            .stage(&session.flow, window_label, token, sequence, snapshot)
    }

    pub fn complete_handoff(
        &self,
        session_id: &str,
        target_window_label: &str,
        token: &str,
        on_event: Channel<PtyEvent>,
    ) -> Result<PtySession, AppError> {
        if !is_supported_workspace_window(target_window_label) {
            return Err(AppError::msg("目标窗口不允许接管终端"));
        }
        let sink: Arc<dyn PtyEventSink> = Arc::new(on_event);
        let session = self.get(session_id)?;
        let plan = {
            let mut guard = session
                .route_and_handoff
                .lock()
                .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
            guard
                .handoff
                .check_complete(&session.flow, session_id, target_window_label, token)?
        };
        // The snapshot goes out with no lock held; `bind` re-validates the token and liveness,
        // so a cancel, an expiry or a reclaim in between is reported as such.
        deliver_snapshot(&plan, sink.as_ref())?;
        {
            let mut guard = session
                .route_and_handoff
                .lock()
                .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
            guard
                .handoff
                .bind(&session.flow, target_window_label, token, sink)?;
        }
        Ok(session.metadata())
    }

    pub fn finalize_handoff(
        &self,
        session_id: &str,
        target_window_label: &str,
        token: &str,
        size: PtySizeUpdate,
    ) -> Result<PtySession, AppError> {
        if !is_supported_workspace_window(target_window_label) {
            return Err(AppError::msg("目标窗口不允许接管终端"));
        }
        validate_size(size)?;
        let session = self.get(session_id)?;
        let mut guard = session
            .route_and_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        guard
            .handoff
            .check_finalize(&session.flow, target_window_label, token)?;
        session.apply_size(size)?;
        let source_window_label = guard
            .handoff
            .bound_source()
            .expect("check_finalize guarantees a bound handoff")
            .to_string();
        // Nothing has been taken yet: a lost control transfer leaves the handoff Bound, so
        // `cancel` or `reclaim_window` can still clean it up.
        if guard.route.window_label != source_window_label {
            return Err(AppError::msg("终端控制权已经转移"));
        }
        let bound = guard
            .handoff
            .commit_finalize()
            .expect("check_finalize guarantees a bound handoff");
        let route = &mut guard.route;
        route.window_label = target_window_label.to_string();
        route.mirror = if is_main_label(target_window_label) {
            None
        } else if is_main_label(&source_window_label) {
            route
                .channel
                .take()
                .map(|source_channel| (main_window_label().to_string(), source_channel))
        } else {
            route
                .mirror
                .take()
                .filter(|(label, _)| is_main_label(label))
        };
        route.channel = Some(bound.sink);
        route.owner_lost = false;
        route.epoch += 1;
        drop(guard);
        session.flow.resume();
        Ok(session.metadata())
    }

    pub fn cancel_handoff(
        &self,
        session_id: &str,
        window_label: &str,
        token: &str,
    ) -> Result<(), AppError> {
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        let mut guard = session
            .route_and_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        guard.handoff.cancel(&session.flow, window_label, token)
    }

    pub fn active_count(&self) -> usize {
        self.registry.len()
    }

    pub fn terminate_all(&self) -> Result<(), AppError> {
        let sessions: Vec<Arc<ManagedSession>> = self.registry.snapshot()?;
        let mut termination_errors = Vec::new();
        for session in &sessions {
            session
                .termination_requested
                .store(true, std::sync::atomic::Ordering::Release);
            match session.tree_terminate() {
                Ok(()) => {}
                Err(TreeTerminateError::Poisoned) => {
                    termination_errors.push("PTY 进程树锁中毒".to_string());
                }
                Err(TreeTerminateError::Failed(message)) => {
                    termination_errors.push(message);
                    session.leader_kill();
                }
            }
            session.flow.close();
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let force_deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
        let mut forced = false;
        while self.active_count() > 0 && std::time::Instant::now() < deadline {
            if !forced && std::time::Instant::now() >= force_deadline {
                forced = true;
                for session in &sessions {
                    session.force_terminate();
                }
            }
            thread::sleep(std::time::Duration::from_millis(25));
        }
        if self.active_count() > 0 {
            return Err(AppError::msg(
                "部分 PTY 会话未能在限定时间内退出，应用继续保持运行",
            ));
        }
        if !termination_errors.is_empty() {
            return Err(AppError::msg(format!(
                "PTY 进程树清理报告错误：{}",
                termination_errors.join("；")
            )));
        }
        Ok(())
    }
}

fn spawn_output_reader(
    session: Arc<ManagedSession>,
    mut reader: Box<dyn Read + Send>,
) -> std::io::Result<()> {
    thread::Builder::new()
        .name(format!("pty-output-{}", session.session_id))
        .spawn(move || {
            let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
            loop {
                if !session.flow.wait_for_capacity() {
                    break;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(bytes_read) => {
                        let Some(sequence) = session.flow.reserve(bytes_read) else {
                            break;
                        };
                        let output_chunks =
                            session.output_chunks.fetch_add(1, Ordering::Relaxed) + 1;
                        let output_bytes = session
                            .output_bytes
                            .fetch_add(bytes_read as u64, Ordering::Relaxed)
                            + bytes_read as u64;
                        let event = PtyEvent::Output {
                            session_id: session.session_id.clone(),
                            sequence,
                            data_base64: BASE64.encode(&buffer[..bytes_read]),
                        };
                        if let Err(error) = session.send_event(event) {
                            log::warn!(
                                "PTY output channel closed session_id={} error={error}",
                                session.session_id,
                            );
                            session.flow.close();
                            let _ = session.tree_terminate();
                            session.leader_kill();
                            break;
                        } else if !session
                            .first_output_logged
                            .swap(true, std::sync::atomic::Ordering::AcqRel)
                        {
                            log::info!(
                                "PTY first output delivered session_id={} sequence={} bytes={bytes_read}",
                                session.session_id,
                                sequence
                            );
                        }
                        if output_chunks.is_multiple_of(32) {
                            log::debug!(
                                "PTY output progress session_id={} chunks={} bytes={} acknowledgement_calls={} last_acknowledged_sequence={}",
                                session.session_id,
                                output_chunks,
                                output_bytes,
                                session.acknowledgement_calls.load(Ordering::Relaxed),
                                session.last_acknowledged_sequence.load(Ordering::Relaxed)
                            );
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .map(|_| ())
}

fn spawn_session_diagnostics(session: Arc<ManagedSession>) -> std::io::Result<()> {
    thread::Builder::new()
        .name(format!("pty-diagnostics-{}", session.session_id))
        .spawn(move || loop {
            thread::sleep(std::time::Duration::from_secs(5));
            let pending_bytes = session.flow.pending_bytes();
            log::info!(
                "PTY output snapshot session_id={} chunks={} bytes={} acknowledgement_calls={} last_acknowledged_sequence={} pending_bytes={}",
                session.session_id,
                session.output_chunks.load(Ordering::Relaxed),
                session.output_bytes.load(Ordering::Relaxed),
                session.acknowledgement_calls.load(Ordering::Relaxed),
                session.last_acknowledged_sequence.load(Ordering::Relaxed),
                pending_bytes
            );
            if session.flow.is_closed() {
                break;
            }
        })
        .map(|_| ())
}

fn spawn_child_monitor(
    session: Arc<ManagedSession>,
    mut child: Box<dyn PtyChild + Send + Sync>,
    store: Arc<dyn PtySessionStore>,
    registry: Arc<SessionRegistry>,
) -> std::io::Result<()> {
    thread::Builder::new()
        .name(format!("pty-monitor-{}", session.session_id))
        .spawn(move || {
            let status = child.wait();
            let (state, exit_code) = match status {
                Ok(status) => {
                    let exit_code = i64::from(status.exit_code());
                    let requested = session
                        .termination_requested
                        .load(std::sync::atomic::Ordering::Acquire);
                    (
                        if requested { "terminated" } else { "exited" },
                        Some(exit_code),
                    )
                }
                Err(error) => {
                    let _ = session.send_event(PtyEvent::Failed {
                        session_id: session.session_id.clone(),
                        message: format!("等待 PTY 退出失败：{error}"),
                    });
                    ("failed", None)
                }
            };

            // A CLI may exit while a child keeps the PTY open. Terminating its
            // process group/job prevents descendants from outliving the owner.
            Terminator::MONITOR.stop_tree(&session, &thread::sleep);
            session.flow.close();

            if let Err(error) = store.finish(&session.session_id, state, now_ms(), exit_code) {
                log::error!(
                    "failed to persist PTY exit session_id={} error={error}",
                    session.session_id
                );
            }
            if let Err(error) = session.send_event(PtyEvent::Exited {
                session_id: session.session_id.clone(),
                state: state.to_string(),
                exit_code,
            }) {
                log::warn!(
                    "failed to deliver PTY exit event session_id={} state={} error={error}",
                    session.session_id,
                    state
                );
            }
            log::info!(
                "PTY session ended session_id={} state={} exit_code={exit_code:?} chunks={} bytes={} acknowledgement_calls={} last_acknowledged_sequence={} pending_bytes={}",
                session.session_id,
                state,
                session.output_chunks.load(Ordering::Relaxed),
                session.output_bytes.load(Ordering::Relaxed),
                session.acknowledgement_calls.load(Ordering::Relaxed),
                session.last_acknowledged_sequence.load(Ordering::Relaxed),
                session.flow.pending_bytes()
            );
            registry.remove(&session.session_id);
            drop(session);
        })
        .map(|_| ())
}

fn configure_cli_environment(command: &mut CommandBuilder) {
    for key in [
        "NO_COLOR",
        "TERM",
        "COLORTERM",
        "CI",
        "CLICOLOR",
        "CLICOLOR_FORCE",
        "FORCE_COLOR",
    ] {
        command.env_remove(key);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    if let Some(path) = crate::platform::windows_environment::merged_registered_path(
        std::env::var_os("PATH").as_deref(),
    ) {
        command.env("PATH", path);
    }
}

fn validate_size(size: PtySizeUpdate) -> Result<(), AppError> {
    if size.cols == 0 || size.rows == 0 {
        return Err(AppError::msg("PTY 尺寸必须至少为 1 列和 1 行"));
    }
    if size.cols > 500 || size.rows > 300 {
        return Err(AppError::msg(format!(
            "PTY 尺寸超出安全范围（当前 {} 列 × {} 行，上限 500 列 × 300 行）",
            size.cols, size.rows
        )));
    }
    Ok(())
}

fn to_pty_size(size: PtySizeUpdate) -> PtySize {
    PtySize {
        cols: size.cols,
        rows: size.rows,
        pixel_width: size.pixel_width,
        pixel_height: size.pixel_height,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
pub(crate) use test_support::{failing_channel, recording_channel, TestRoute, TestSession};

impl WindowScopedResource for PtySessionManager {
    fn release_window(&self, window: &WindowLabel) -> Vec<AppEvent> {
        if window.kind() != WindowKind::Terminal {
            return Vec::new();
        }
        self.reclaim_window(window.as_str())
            .into_iter()
            .map(|session_id| AppEvent::PtySessionOwnerLost { session_id })
            .collect()
    }
}

impl crate::services::exit_cleanup::ExitCleanupTarget for PtySessionManager {
    fn name(&self) -> &'static str {
        "pty_sessions"
    }

    fn terminate_all(&self, _budget: std::time::Duration) -> Result<usize, AppError> {
        // The inherent `PtySessionManager::terminate_all` bounds itself (about three
        // seconds); the budget is enforced by `run_exit_cleanup`'s timeout.
        let count = self.active_count();
        PtySessionManager::terminate_all(self)?;
        Ok(count)
    }
}

#[cfg(test)]
mod tests;
