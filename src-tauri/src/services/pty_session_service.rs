use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use rusqlite::Connection;
use tauri::{ipc::Channel, AppHandle, Manager};
use uuid::Uuid;

use crate::{
    db::{directory_repo, launch_history_repo, pty_session_repo},
    models::{
        launch_history::LaunchAction,
        pty_session::{
            PtyEvent, PtyFrontendStage, PtyHandoff, PtySession, PtySessionWindowStatus,
            PtySizeUpdate, PtyTerminalSnapshot,
        },
        tool::ToolKey,
    },
    platform::execution_process::{attach_pty_or_terminate, ProcessTree},
    services::{directory_service, launch_service},
    AppError, Db,
};

const READ_CHUNK_BYTES: usize = 16 * 1024;
const OUTPUT_HIGH_WATERMARK: usize = 192 * 1024;
const OUTPUT_LOW_WATERMARK: usize = 64 * 1024;
const HANDOFF_PAUSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_HANDOFF_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

pub struct PtySessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
    exit_authorized: std::sync::atomic::AtomicBool,
}

impl Default for PtySessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            exit_authorized: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

struct ManagedSession {
    session_id: String,
    directory_id: i64,
    tool_key: ToolKey,
    working_directory: String,
    started_at_ms: i64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    last_size: Mutex<(u16, u16)>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    process_tree: Mutex<Option<ProcessTree>>,
    flow: Arc<OutputFlow>,
    event_route: Mutex<EventRoute>,
    pending_handoff: Mutex<Option<PendingHandoff>>,
    first_output_logged: AtomicBool,
    output_chunks: AtomicU64,
    output_bytes: AtomicU64,
    acknowledgement_calls: AtomicU64,
    last_acknowledged_sequence: AtomicU64,
    termination_requested: std::sync::atomic::AtomicBool,
}

struct EventRoute {
    window_label: String,
    channel: Channel<PtyEvent>,
}

struct PendingHandoff {
    token: String,
    source_window_label: String,
    sequence: u64,
    snapshot: Option<PtyTerminalSnapshot>,
    target_window_label: Option<String>,
    target_channel: Option<Channel<PtyEvent>>,
}

struct OutputFlow {
    state: Mutex<OutputFlowState>,
    changed: Condvar,
}

#[derive(Default)]
struct OutputFlowState {
    pending_bytes: usize,
    sent: BTreeMap<u64, usize>,
    next_sequence: u64,
    paused: bool,
    pause_deadline: Option<std::time::Instant>,
    closed: bool,
}

impl OutputFlow {
    fn new() -> Self {
        Self {
            state: Mutex::new(OutputFlowState::default()),
            changed: Condvar::new(),
        }
    }

    fn reserve(&self, bytes: usize) -> Option<u64> {
        let mut state = self.state.lock().ok()?;
        while state.paused && !state.closed {
            state = self.wait_for_resume(state).ok()?;
        }
        if state.closed {
            return None;
        }
        state.next_sequence = state.next_sequence.checked_add(1)?;
        let sequence = state.next_sequence;
        state.pending_bytes = state.pending_bytes.saturating_add(bytes);
        state.sent.insert(sequence, bytes);
        Some(sequence)
    }

    fn wait_for_capacity(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        loop {
            if state.closed {
                return false;
            }
            if state.paused {
                state = match self.wait_for_resume(state) {
                    Ok(state) => state,
                    Err(_) => return false,
                };
                continue;
            }
            if state.pending_bytes < OUTPUT_HIGH_WATERMARK {
                return true;
            }
            let Ok(next) = self.changed.wait(state) else {
                return false;
            };
            state = next;
            if state.pending_bytes > OUTPUT_LOW_WATERMARK {
                continue;
            }
        }
    }

    fn pause(&self) -> Result<u64> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("PTY 输出回压状态锁中毒"))?;
        if state.closed {
            return Err(anyhow!("PTY 会话已经结束"));
        }
        if state.paused {
            return Err(anyhow!("PTY 会话正在进行其他窗口交接"));
        }
        state.paused = true;
        state.pause_deadline = Some(std::time::Instant::now() + HANDOFF_PAUSE_TIMEOUT);
        Ok(state.next_sequence)
    }

    fn is_paused_at(&self, sequence: u64) -> bool {
        self.state
            .lock()
            .map(|state| {
                state.paused
                    && !state.closed
                    && state.next_sequence == sequence
                    && state
                        .pause_deadline
                        .is_some_and(|deadline| std::time::Instant::now() < deadline)
            })
            .unwrap_or(false)
    }

    fn resume(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.paused = false;
            state.pause_deadline = None;
            self.changed.notify_all();
        }
    }

    fn wait_for_resume<'a>(
        &self,
        mut state: std::sync::MutexGuard<'a, OutputFlowState>,
    ) -> Result<std::sync::MutexGuard<'a, OutputFlowState>> {
        while state.paused && !state.closed {
            let Some(deadline) = state.pause_deadline else {
                state = self
                    .changed
                    .wait(state)
                    .map_err(|_| anyhow!("PTY 输出回压状态锁中毒"))?;
                continue;
            };
            let now = std::time::Instant::now();
            if now >= deadline {
                state.paused = false;
                state.pause_deadline = None;
                self.changed.notify_all();
                break;
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, deadline - now)
                .map_err(|_| anyhow!("PTY 输出回压状态锁中毒"))?;
            state = next;
        }
        Ok(state)
    }

    fn acknowledge(&self, sequence: u64) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("PTY 输出回压状态锁中毒"))?;
        if sequence > state.next_sequence {
            return Err(anyhow!("PTY 输出确认序号超出已发送范围"));
        }
        let acknowledged: Vec<u64> = state.sent.range(..=sequence).map(|(key, _)| *key).collect();
        for key in acknowledged {
            if let Some(bytes) = state.sent.remove(&key) {
                state.pending_bytes = state.pending_bytes.saturating_sub(bytes);
            }
        }
        if state.pending_bytes <= OUTPUT_LOW_WATERMARK {
            self.changed.notify_all();
        }
        Ok(())
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.changed.notify_all();
        }
    }

    fn pending_bytes(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.pending_bytes)
            .unwrap_or(0)
    }

    fn is_closed(&self) -> bool {
        self.state.lock().map(|state| state.closed).unwrap_or(true)
    }
}

impl ManagedSession {
    fn send_event(&self, event: PtyEvent) -> Result<(), String> {
        let route = self
            .event_route
            .lock()
            .map_err(|_| "PTY 事件路由锁中毒".to_string())?;
        route
            .channel
            .send(event)
            .map_err(|error| format!("PTY 输出通道不可用：{error}"))
    }

    fn ensure_owner(&self, window_label: &str) -> Result<(), AppError> {
        let route = self
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        if route.window_label != window_label {
            return Err(AppError::msg("该终端当前由另一个窗口控制"));
        }
        Ok(())
    }

    fn metadata(&self) -> PtySession {
        PtySession {
            session_id: self.session_id.clone(),
            directory_id: self.directory_id,
            tool_key: self.tool_key,
            working_directory: self.working_directory.clone(),
            state: "running".to_string(),
            started_at_ms: self.started_at_ms,
            ended_at_ms: None,
            exit_code: None,
        }
    }
}

fn is_supported_workspace_window(window_label: &str) -> bool {
    window_label == "main"
        || window_label
            .strip_prefix("terminal-")
            .is_some_and(|suffix| !suffix.is_empty())
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
    pub fn create(
        &self,
        connection: &Connection,
        app: &AppHandle,
        directory_id: i64,
        tool_key: ToolKey,
        resume_session_id: Option<&str>,
        size: PtySizeUpdate,
        window_label: &str,
        on_event: Channel<PtyEvent>,
    ) -> Result<PtySession, AppError> {
        let directory_path = directory_repo::get(connection, directory_id)
            .ok()
            .flatten()
            .map(|directory| directory.path);
        let result = self.create_inner(
            connection,
            app,
            directory_id,
            tool_key,
            resume_session_id,
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
        if let Err(error) = launch_history_repo::record(
            connection,
            directory_id,
            directory_path.as_deref(),
            tool_key,
            action,
            result.is_ok(),
            error_category,
            session_id,
        ) {
            log::warn!("unable to record embedded PTY launch history: {error}");
        }
        result
    }

    fn create_inner(
        &self,
        connection: &Connection,
        app: &AppHandle,
        directory_id: i64,
        tool_key: ToolKey,
        resume_session_id: Option<&str>,
        size: PtySizeUpdate,
        window_label: &str,
        on_event: Channel<PtyEvent>,
    ) -> Result<PtySession, AppError> {
        validate_size(size)?;
        let payload = if let Some(session_id) = resume_session_id {
            launch_service::resolve_resume_payload(connection, directory_id, tool_key, session_id)?
        } else {
            launch_service::resolve_payload(connection, directory_id, tool_key)?
        };
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
        let now = now_ms();
        if let Err(error) = pty_session_repo::insert_running(
            connection,
            &session_id,
            directory_id,
            tool_key,
            &payload.directory,
            now,
        ) {
            stop_spawned_child(&process_tree, &mut child);
            return Err(error.into());
        }
        let killer = child.clone_killer();
        let session = Arc::new(ManagedSession {
            session_id: session_id.clone(),
            directory_id,
            tool_key,
            working_directory: payload.directory.clone(),
            started_at_ms: now,
            master: Mutex::new(pair.master),
            last_size: Mutex::new((size.cols, size.rows)),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            process_tree: Mutex::new(Some(process_tree)),
            flow: Arc::new(OutputFlow::new()),
            event_route: Mutex::new(EventRoute {
                window_label: window_label.to_string(),
                channel: on_event,
            }),
            pending_handoff: Mutex::new(None),
            first_output_logged: AtomicBool::new(false),
            output_chunks: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            acknowledgement_calls: AtomicU64::new(0),
            last_acknowledged_sequence: AtomicU64::new(0),
            termination_requested: std::sync::atomic::AtomicBool::new(false),
        });
        match self.sessions.lock() {
            Ok(mut sessions) => {
                sessions.insert(session_id.clone(), Arc::clone(&session));
            }
            Err(_) => {
                self.fail_session_start(connection, &session, "PTY 会话表锁中毒".to_string());
                return Err(AppError::msg("PTY 会话表锁中毒"));
            }
        }

        if let Err(error) = spawn_output_reader(Arc::clone(&session), reader) {
            self.fail_session_start(connection, &session, error.to_string());
            return Err(AppError::msg(format!("创建 PTY 输出线程失败：{error}")));
        }
        if let Err(error) = spawn_child_monitor(
            Arc::clone(&session),
            child,
            app.clone(),
            self.session_map_handle(),
        ) {
            self.fail_session_start(connection, &session, error.to_string());
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

    fn session_map_handle(&self) -> Arc<Mutex<HashMap<String, Arc<ManagedSession>>>> {
        Arc::clone(&self.sessions)
    }

    fn fail_session_start(
        &self,
        connection: &Connection,
        session: &ManagedSession,
        reason: String,
    ) {
        session.flow.close();
        if let Ok(tree) = session.process_tree.lock() {
            if let Some(tree) = tree.as_ref() {
                let _ = tree.terminate();
                let _ = tree.force_kill();
            }
        }
        if let Ok(mut killer) = session.killer.lock() {
            let _ = killer.kill();
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&session.session_id);
        }
        if let Err(error) =
            pty_session_repo::finish(connection, &session.session_id, "failed", now_ms(), None)
        {
            log::error!("failed to persist PTY start failure: {error}");
        }
        log::error!("failed to start PTY reader or monitor: {reason}");
    }

    fn get(&self, session_id: &str) -> Result<Arc<ManagedSession>, AppError> {
        self.sessions
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::msg("PTY 会话不存在或已结束"))
    }

    pub fn window_status(
        &self,
        session_id: &str,
        window_label: &str,
    ) -> Result<PtySessionWindowStatus, AppError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(session_window_status(None, window_label, true));
        };
        if session.flow.is_closed() {
            return Ok(PtySessionWindowStatus::Ended);
        }
        let route = session
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        Ok(session_window_status(
            Some(&route.window_label),
            window_label,
            false,
        ))
    }

    pub fn write(&self, session_id: &str, window_label: &str, data: &[u8]) -> Result<(), AppError> {
        let session = self.get(session_id)?;
        session.ensure_owner(window_label)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| AppError::msg("PTY 输入流锁中毒"))?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
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
        let mut last_size = session
            .last_size
            .lock()
            .map_err(|_| AppError::msg("PTY 尺寸状态锁中毒"))?;
        if *last_size == (size.cols, size.rows) {
            return Ok(());
        }
        session
            .master
            .lock()
            .map_err(|_| AppError::msg("PTY 终端锁中毒"))?
            .resize(to_pty_size(size))
            .map_err(|error| AppError::msg(format!("调整 PTY 尺寸失败：{error}")))?;
        *last_size = (size.cols, size.rows);
        log::info!(
            "PTY resized session_id={} cols={} rows={}",
            session.session_id,
            size.cols,
            size.rows
        );
        Ok(())
    }

    pub fn acknowledge(
        &self,
        session_id: &str,
        window_label: &str,
        sequence: u64,
    ) -> Result<(), AppError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .get(session_id)
            .cloned();
        let Some(session) = session else {
            // The monitor removes completed sessions after delivering their
            // final event. A late frontend acknowledgement then has nothing
            // left to release and is safe to ignore.
            return Ok(());
        };
        session.ensure_owner(window_label)?;
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
        let termination = match session.process_tree.lock() {
            Ok(tree) => tree
                .as_ref()
                .map(ProcessTree::terminate)
                .transpose()
                .map_err(|error| AppError::msg(format!("终止 PTY 进程树失败：{error}"))),
            Err(_) => Err(AppError::msg("PTY 进程树锁中毒")),
        };
        session.flow.close();
        if let Err(error) = termination {
            if let Ok(tree) = session.process_tree.lock() {
                if let Some(tree) = tree.as_ref() {
                    let _ = tree.force_kill();
                }
            }
            if let Ok(mut killer) = session.killer.lock() {
                let _ = killer.kill();
            }
            return Err(error);
        }
        let force_session = Arc::clone(&session);
        let force_after = thread::Builder::new()
            .name(format!("pty-force-{}", session.session_id))
            .spawn(move || {
                thread::sleep(std::time::Duration::from_millis(750));
                if let Ok(tree) = force_session.process_tree.lock() {
                    if let Some(tree) = tree.as_ref() {
                        let _ = tree.force_kill();
                    }
                }
                if let Ok(mut killer) = force_session.killer.lock() {
                    let _ = killer.kill();
                }
            });
        if force_after.is_err() {
            if let Ok(tree) = session.process_tree.lock() {
                if let Some(tree) = tree.as_ref() {
                    let _ = tree.force_kill();
                }
            }
            if let Ok(mut killer) = session.killer.lock() {
                let _ = killer.kill();
            }
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
        let mut pending = session
            .pending_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        if let Some(transfer) = pending.as_ref() {
            if session.flow.is_paused_at(transfer.sequence) {
                return Err(AppError::msg("该终端正在进行窗口交接"));
            }
            *pending = None;
            session.flow.resume();
        }
        let sequence = session.flow.pause()?;
        let token = Uuid::new_v4().to_string();
        *pending = Some(PendingHandoff {
            token: token.clone(),
            source_window_label: window_label.to_string(),
            sequence,
            snapshot: None,
            target_window_label: None,
            target_channel: None,
        });
        Ok(PtyHandoff { token, sequence })
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
        let mut pending = session
            .pending_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        let transfer = pending
            .as_mut()
            .filter(|transfer| {
                transfer.token == token
                    && transfer.source_window_label == window_label
                    && transfer.sequence == sequence
            })
            .ok_or_else(|| AppError::msg("终端窗口交接已过期"))?;
        if !session.flow.is_paused_at(sequence) {
            return Err(AppError::msg("终端输出已恢复，请重新发起窗口交接"));
        }
        transfer.snapshot = Some(snapshot);
        Ok(())
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
        let session = self.get(session_id)?;
        let mut pending = session
            .pending_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        let transfer = pending
            .as_mut()
            .filter(|transfer| transfer.token == token)
            .ok_or_else(|| AppError::msg("终端窗口交接已过期"))?;
        if !session.flow.is_paused_at(transfer.sequence) {
            return Err(AppError::msg("终端窗口交接超时，请重试"));
        }
        let snapshot = transfer
            .snapshot
            .clone()
            .ok_or_else(|| AppError::msg("终端画面尚未准备好"))?;
        if transfer.target_channel.is_some() {
            return Err(AppError::msg("目标窗口已经准备接管此终端"));
        }
        let sequence = transfer.sequence;
        let event = PtyEvent::Snapshot {
            session_id: session_id.to_string(),
            sequence,
            data: snapshot.data,
            cols: snapshot.cols,
            rows: snapshot.rows,
        };
        on_event
            .send(event)
            .map_err(|error| AppError::msg(format!("新窗口终端尚未就绪：{error}")))?;
        transfer.target_window_label = Some(target_window_label.to_string());
        transfer.target_channel = Some(on_event);
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
        let mut pending = session
            .pending_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        let transfer = pending
            .as_mut()
            .filter(|transfer| {
                transfer.token == token
                    && transfer.target_window_label.as_deref() == Some(target_window_label)
            })
            .ok_or_else(|| AppError::msg("目标窗口交接状态已失效"))?;
        if !session.flow.is_paused_at(transfer.sequence) {
            return Err(AppError::msg("终端窗口交接超时，请重试"));
        }
        if transfer.target_channel.is_none() {
            return Err(AppError::msg("目标窗口尚未准备好"));
        }
        let mut last_size = session
            .last_size
            .lock()
            .map_err(|_| AppError::msg("PTY 尺寸状态锁中毒"))?;
        if *last_size != (size.cols, size.rows) {
            session
                .master
                .lock()
                .map_err(|_| AppError::msg("PTY 终端锁中毒"))?
                .resize(to_pty_size(size))
                .map_err(|error| AppError::msg(format!("调整 PTY 尺寸失败：{error}")))?;
            *last_size = (size.cols, size.rows);
        }
        drop(last_size);
        let channel = transfer
            .target_channel
            .take()
            .ok_or_else(|| AppError::msg("目标窗口尚未准备好"))?;
        let mut route = session
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        if route.window_label != transfer.source_window_label {
            return Err(AppError::msg("终端控制权已经转移"));
        }
        route.window_label = target_window_label.to_string();
        route.channel = channel;
        drop(route);
        *pending = None;
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
        let mut pending = session
            .pending_handoff
            .lock()
            .map_err(|_| AppError::msg("PTY 窗口交接状态锁中毒"))?;
        let Some(transfer) = pending.as_ref() else {
            return Ok(());
        };
        if transfer.token != token || transfer.source_window_label != window_label {
            return Err(AppError::msg("终端窗口交接令牌无效"));
        }
        *pending = None;
        session.flow.resume();
        Ok(())
    }

    pub fn active_count(&self) -> usize {
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    pub fn authorize_exit(&self) {
        self.exit_authorized
            .store(true, std::sync::atomic::Ordering::Release);
    }

    pub fn consume_exit_authorization(&self) -> bool {
        self.exit_authorized
            .swap(false, std::sync::atomic::Ordering::AcqRel)
    }

    pub fn terminate_all(&self) -> Result<(), AppError> {
        let sessions: Vec<Arc<ManagedSession>> = self
            .sessions
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .values()
            .cloned()
            .collect();
        let mut termination_errors = Vec::new();
        for session in &sessions {
            session
                .termination_requested
                .store(true, std::sync::atomic::Ordering::Release);
            if let Ok(tree) = session.process_tree.lock() {
                if let Some(tree) = tree.as_ref() {
                    if let Err(error) = tree.terminate() {
                        termination_errors.push(error.to_string());
                        if let Ok(mut killer) = session.killer.lock() {
                            let _ = killer.kill();
                        }
                    }
                }
            } else {
                termination_errors.push("PTY 进程树锁中毒".to_string());
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
                    if let Ok(tree) = session.process_tree.lock() {
                        if let Some(tree) = tree.as_ref() {
                            let _ = tree.force_kill();
                        }
                    }
                    if let Ok(mut killer) = session.killer.lock() {
                        let _ = killer.kill();
                    }
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

fn stop_spawned_child(process_tree: &ProcessTree, child: &mut Box<dyn PtyChild + Send + Sync>) {
    let _ = process_tree.terminate();
    let _ = process_tree.force_kill();
    let _ = child.kill();
    let _ = child.wait();
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
                            if let Ok(tree) = session.process_tree.lock() {
                                if let Some(tree) = tree.as_ref() {
                                    let _ = tree.terminate();
                                }
                            }
                            if let Ok(mut killer) = session.killer.lock() {
                                let _ = killer.kill();
                            }
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
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
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
            if let Ok(tree) = session.process_tree.lock() {
                if let Some(tree) = tree.as_ref() {
                    let _ = tree.terminate();
                    thread::sleep(std::time::Duration::from_millis(100));
                    let _ = tree.force_kill();
                }
            }
            session.flow.close();

            if let Some(db) = app.try_state::<Db>() {
                if let Ok(connection) = db.0.lock() {
                    if let Err(error) = pty_session_repo::finish(
                        &connection,
                        &session.session_id,
                        state,
                        now_ms(),
                        exit_code,
                    ) {
                        log::error!(
                            "failed to persist PTY exit session_id={} error={error}",
                            session.session_id
                        );
                    }
                }
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
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&session.session_id);
            }
            drop(session);
        })
        .map(|_| ())
}

fn session_window_status(
    owner_window_label: Option<&str>,
    queried_window_label: &str,
    ended: bool,
) -> PtySessionWindowStatus {
    if ended {
        return PtySessionWindowStatus::Ended;
    }
    match owner_window_label {
        None => PtySessionWindowStatus::Ended,
        Some(owner) if owner == queried_window_label => PtySessionWindowStatus::Running,
        Some(_) => PtySessionWindowStatus::OwnedByAnotherWindow,
    }
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
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn window_status_distinguishes_ended_owned_and_transferred_sessions() {
        assert_eq!(
            session_window_status(None, "terminal-a", false),
            PtySessionWindowStatus::Ended
        );
        assert_eq!(
            session_window_status(Some("terminal-a"), "terminal-a", false),
            PtySessionWindowStatus::Running
        );
        assert_eq!(
            session_window_status(Some("main"), "terminal-a", false),
            PtySessionWindowStatus::OwnedByAnotherWindow
        );
        assert_eq!(
            session_window_status(Some("terminal-a"), "terminal-a", true),
            PtySessionWindowStatus::Ended
        );
    }

    #[test]
    fn output_acknowledgement_releases_pending_capacity() {
        let flow = OutputFlow::new();
        let first = flow.reserve(64 * 1024).unwrap();
        let second = flow.reserve(64 * 1024).unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 2);
        assert!(flow.acknowledge(2).is_ok());
        assert_eq!(flow.state.lock().unwrap().pending_bytes, 0);
    }

    #[test]
    fn output_acknowledgement_rejects_future_sequence() {
        let flow = OutputFlow::new();
        flow.reserve(10).unwrap();
        assert!(flow.acknowledge(2).is_err());
    }

    #[test]
    fn handoff_pauses_new_output_after_a_stable_sequence_watermark() {
        let flow = Arc::new(OutputFlow::new());
        assert_eq!(flow.reserve(10), Some(1));
        let watermark = flow.pause().unwrap();
        assert_eq!(watermark, 1);

        let (sender, receiver) = mpsc::channel();
        let reader_flow = Arc::clone(&flow);
        let reader = thread::spawn(move || sender.send(reader_flow.reserve(20)).unwrap());
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(25))
            .is_err());

        flow.resume();
        assert_eq!(
            receiver.recv_timeout(std::time::Duration::from_secs(1)),
            Ok(Some(2))
        );
        reader.join().unwrap();
    }

    #[test]
    fn handoff_pause_expires_to_prevent_a_stalled_terminal() {
        let flow = OutputFlow::new();
        let watermark = flow.pause().unwrap();
        {
            let mut state = flow.state.lock().unwrap();
            state.pause_deadline = Some(std::time::Instant::now());
        }
        assert!(!flow.is_paused_at(watermark));
        assert_eq!(flow.reserve(5), Some(1));
    }

    #[test]
    fn handoff_window_labels_are_restricted_to_workspace_windows() {
        assert!(is_supported_workspace_window("main"));
        assert!(is_supported_workspace_window("terminal-abcd-1234"));
        assert!(!is_supported_workspace_window("settings"));
        assert!(!is_supported_workspace_window("terminal-"));
    }

    #[test]
    fn handoff_snapshot_is_bounded_and_requires_safe_dimensions() {
        let valid = PtyTerminalSnapshot {
            data: "screen".to_string(),
            cols: 120,
            rows: 40,
        };
        assert!(validate_handoff_snapshot(&valid).is_ok());

        let oversized = PtyTerminalSnapshot {
            data: "x".repeat(MAX_HANDOFF_SNAPSHOT_BYTES + 1),
            ..valid.clone()
        };
        assert!(validate_handoff_snapshot(&oversized).is_err());

        let invalid_dimensions = PtyTerminalSnapshot { cols: 0, ..valid };
        assert!(validate_handoff_snapshot(&invalid_dimensions).is_err());
    }

    #[test]
    fn pty_size_is_bounded() {
        assert!(validate_size(PtySizeUpdate {
            cols: 500,
            rows: 300,
            pixel_width: 0,
            pixel_height: 0,
        })
        .is_ok());
        assert!(validate_size(PtySizeUpdate {
            cols: 0,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
        })
        .is_err());
        assert!(validate_size(PtySizeUpdate {
            cols: 80,
            rows: 301,
            pixel_width: 0,
            pixel_height: 0,
        })
        .is_err());
        assert!(validate_size(PtySizeUpdate {
            cols: 501,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
        })
        .is_err());
    }
}
