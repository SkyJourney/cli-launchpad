use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex,
    },
    thread,
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
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
const MAX_OWNER_LOST_BUFFER_BYTES: usize = 256 * 1024;
const PTY_INPUT_QUEUE_CAPACITY: usize = 32;
const MAX_PTY_INPUT_BYTES: usize = 64 * 1024;

fn enqueue_pty_input(sender: &SyncSender<Vec<u8>>, data: &[u8]) -> Result<(), AppError> {
    if data.len() > MAX_PTY_INPUT_BYTES {
        return Err(AppError::coded(
            "pty_input_backpressure",
            "终端输入片段超过安全上限，请分段粘贴",
        ));
    }
    match sender.try_send(data.to_vec()) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) => Err(AppError::coded(
            "pty_input_backpressure",
            "终端输入队列已满，请稍后重试",
        )),
        Err(TrySendError::Disconnected(_)) => Err(AppError::coded(
            "pty_input_unavailable",
            "终端输入通道已关闭，请重新连接会话",
        )),
    }
}

fn pty_input_channel() -> (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) {
    mpsc::sync_channel(PTY_INPUT_QUEUE_CAPACITY)
}

fn start_pty_input_writer(
    mut writer: Box<dyn Write + Send>,
    receiver: Receiver<Vec<u8>>,
    session_id: String,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("pty-input-{session_id}"))
        .spawn(move || {
            while let Ok(data) = receiver.recv() {
                if let Err(error) = writer.write_all(&data).and_then(|()| writer.flush()) {
                    log::error!("PTY input write failed session_id={session_id} error={error}");
                    break;
                }
            }
        })
}

fn ensure_no_active_sessions(active_count: usize) -> Result<(), AppError> {
    if active_count > 0 {
        return Err(AppError::coded_with_params(
            "pty_sessions_active",
            format!("请先关闭所有运行中的终端会话（当前 {active_count} 个）再恢复备份"),
            serde_json::json!({ "count": active_count }),
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub struct PtySessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<ManagedSession>>>>,
    lifecycle_gate: Arc<Mutex<PtyLifecycleGate>>,
}

#[derive(Default)]
struct PtyLifecycleGate {
    restore_in_progress: bool,
    session_starts: usize,
}

pub struct PtySessionStartGuard {
    gate: Arc<Mutex<PtyLifecycleGate>>,
}

impl Drop for PtySessionStartGuard {
    fn drop(&mut self) {
        match self.gate.lock() {
            Ok(mut gate) => gate.session_starts = gate.session_starts.saturating_sub(1),
            Err(_) => log::error!("PTY lifecycle gate poisoned while releasing session start"),
        }
    }
}

pub struct PtyBackupRestoreGuard {
    gate: Arc<Mutex<PtyLifecycleGate>>,
}

impl Drop for PtyBackupRestoreGuard {
    fn drop(&mut self) {
        match self.gate.lock() {
            Ok(mut gate) => gate.restore_in_progress = false,
            Err(_) => log::error!("PTY lifecycle gate poisoned while releasing backup restore"),
        }
    }
}

impl Default for PtySessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            lifecycle_gate: Arc::new(Mutex::new(PtyLifecycleGate::default())),
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
    writer: SyncSender<Vec<u8>>,
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
    channel: Option<Channel<PtyEvent>>,
    mirror: Option<(String, Channel<PtyEvent>)>,
    owner_lost: bool,
    buffered_events: VecDeque<PtyEvent>,
    buffered_bytes: usize,
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

    fn pause_indefinitely(&self) {
        if let Ok(mut state) = self.state.lock() {
            if state.closed {
                return;
            }
            state.paused = true;
            state.pause_deadline = None;
            self.changed.notify_all();
        }
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
        let buffer_size = pty_event_buffer_size(&event);
        let mut mirror_after_owner_loss = false;
        let mirror_to_main;
        {
            let mut route = self
                .event_route
                .lock()
                .map_err(|_| "PTY 事件路由锁中毒".to_string())?;
            if let Some(channel) = route.channel.as_ref() {
                if let Err(error) = channel.send(event.clone()) {
                    if route.window_label.starts_with("terminal-") {
                        route.channel = None;
                        route.owner_lost = true;
                        if !buffer_owner_lost_event(&mut route, event.clone(), buffer_size) {
                            return Err("PTY 所有者窗口销毁后输出缓冲区已满".to_string());
                        }
                        mirror_after_owner_loss = true;
                        self.flow.pause_indefinitely();
                    } else {
                        return Err(format!("PTY 输出通道不可用：{error}"));
                    }
                }
            } else if route.owner_lost {
                if !buffer_owner_lost_event(&mut route, event.clone(), buffer_size) {
                    return Err("PTY 所有者窗口销毁后输出缓冲区已满".to_string());
                }
                mirror_after_owner_loss = true;
            } else {
                return Err("PTY 输出通道不可用：当前没有所有者通道".to_string());
            }
            mirror_to_main = mirror_after_owner_loss
                || route
                    .mirror
                    .as_ref()
                    .is_some_and(|(label, _)| label == "main");
        }

        if mirror_to_main {
            let mut route = self
                .event_route
                .lock()
                .map_err(|_| "PTY 事件路由锁中毒".to_string())?;
            let mirror_allowed = mirror_after_owner_loss
                || route
                    .mirror
                    .as_ref()
                    .is_some_and(|(label, _)| label == "main");
            if mirror_allowed {
                if let Some((_, mirror)) = route.mirror.as_ref() {
                    if mirror.send(event).is_err() {
                        route.mirror = None;
                    }
                }
            }
        }
        Ok(())
    }

    fn is_output_observer(&self, window_label: &str) -> Result<bool, AppError> {
        let route = self
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        Ok(route.window_label == window_label
            || route
                .mirror
                .as_ref()
                .is_some_and(|(label, _)| label == window_label)
            || (route.owner_lost && window_label == "main"))
    }

    fn ensure_owner(&self, window_label: &str) -> Result<(), AppError> {
        let route = self
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        ensure_route_owner(&route, window_label)
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

fn pty_event_buffer_size(event: &PtyEvent) -> usize {
    match event {
        PtyEvent::Output { data_base64, .. } => data_base64.len(),
        PtyEvent::Snapshot { data, .. } => data.len(),
        PtyEvent::Failed { message, .. } => message.len(),
        PtyEvent::Exited { .. } => std::mem::size_of::<PtyEvent>(),
    }
}

fn pty_event_sequence(event: &PtyEvent) -> Option<u64> {
    match event {
        PtyEvent::Output { sequence, .. } | PtyEvent::Snapshot { sequence, .. } => Some(*sequence),
        PtyEvent::Exited { .. } | PtyEvent::Failed { .. } => None,
    }
}

fn ensure_route_owner(route: &EventRoute, window_label: &str) -> Result<(), AppError> {
    if route.window_label != window_label {
        return Err(AppError::msg("该终端当前由另一个窗口控制"));
    }
    Ok(())
}

fn buffer_owner_lost_event(route: &mut EventRoute, event: PtyEvent, size: usize) -> bool {
    if route.buffered_bytes.saturating_add(size) > MAX_OWNER_LOST_BUFFER_BYTES
        && matches!(event, PtyEvent::Output { .. })
    {
        return false;
    }
    route.buffered_bytes = route.buffered_bytes.saturating_add(size);
    route.buffered_events.push_back(event);
    true
}

fn reclaim_event_route(route: &mut EventRoute, window_label: &str) -> bool {
    route.mirror = route
        .mirror
        .take()
        .filter(|(label, _)| label != window_label);
    if route.window_label == window_label {
        route.window_label = "main".to_string();
        route.channel = None;
        route.owner_lost = true;
        true
    } else {
        false
    }
}

fn handoff_references_window(transfer: &PendingHandoff, window_label: &str) -> bool {
    transfer.source_window_label == window_label
        || transfer.target_window_label.as_deref() == Some(window_label)
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
    pub fn create(
        &self,
        db: &Db,
        app: &AppHandle,
        directory_id: i64,
        tool_key: ToolKey,
        payload: &launch_service::CliLaunchPayload,
        resume_session_id: Option<&str>,
        size: PtySizeUpdate,
        window_label: &str,
        on_event: Channel<PtyEvent>,
    ) -> Result<PtySession, AppError> {
        let _start_guard = self.begin_session_start()?;
        let directory = crate::with_connection(db, |connection| {
            directory_repo::get(connection, directory_id)?
                .ok_or_else(|| AppError::msg(format!("directory {directory_id} not found")))
        })?;
        if !crate::platform::path_identity::paths_equal(&directory.path, &payload.directory) {
            return Err(AppError::coded(
                "project_identity_changed",
                "项目目录在启动准备期间发生变化，请重试",
            ));
        }
        let directory_path = directory.path;
        let result = self.create_inner(
            db,
            app,
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
        if let Err(error) = crate::with_connection(db, |connection| {
            launch_history_repo::record(
                connection,
                directory_id,
                Some(&directory_path),
                tool_key,
                action,
                result.is_ok(),
                error_category,
                session_id,
            )?;
            Ok(())
        }) {
            log::warn!("unable to record embedded PTY launch history: {error}");
        }
        result
    }

    fn create_inner(
        &self,
        db: &Db,
        app: &AppHandle,
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
        if let Err(error) = crate::with_connection(db, |connection| {
            pty_session_repo::insert_running(
                connection,
                &session_id,
                directory_id,
                tool_key,
                &payload.directory,
                now,
            )?;
            Ok(())
        }) {
            stop_spawned_child(&process_tree, &mut child);
            return Err(error);
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
            writer: writer_sender,
            killer: Mutex::new(killer),
            process_tree: Mutex::new(Some(process_tree)),
            flow: Arc::new(OutputFlow::new()),
            event_route: Mutex::new(EventRoute {
                window_label: window_label.to_string(),
                channel: Some(on_event),
                mirror: None,
                owner_lost: false,
                buffered_events: VecDeque::new(),
                buffered_bytes: 0,
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
                self.fail_session_start(db, &session, "PTY 会话表锁中毒".to_string());
                return Err(AppError::msg("PTY 会话表锁中毒"));
            }
        }

        if let Err(error) = spawn_output_reader(Arc::clone(&session), reader) {
            self.fail_session_start(db, &session, error.to_string());
            return Err(AppError::msg(format!("创建 PTY 输出线程失败：{error}")));
        }
        if let Err(error) = spawn_child_monitor(
            Arc::clone(&session),
            child,
            app.clone(),
            self.session_map_handle(),
        ) {
            self.fail_session_start(db, &session, error.to_string());
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

    fn fail_session_start(&self, db: &Db, session: &ManagedSession, reason: String) {
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
        if let Err(error) = crate::with_connection(db, |connection| {
            pty_session_repo::finish(connection, &session.session_id, "failed", now_ms(), None)?;
            Ok(())
        }) {
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

    pub fn reclaim_window(&self, window_label: &str) -> Vec<String> {
        if window_label == "main" {
            return Vec::new();
        }
        let Ok(sessions) = self.sessions.lock() else {
            log::error!("PTY session table lock poisoned while reclaiming window={window_label}");
            return Vec::new();
        };
        let mut reclaimed = Vec::new();
        for session in sessions.values() {
            let mut pending_cleared = false;
            if let Ok(mut pending) = session.pending_handoff.lock() {
                if pending
                    .as_ref()
                    .is_some_and(|transfer| handoff_references_window(transfer, window_label))
                {
                    *pending = None;
                    pending_cleared = true;
                }
            }

            let Ok(mut route) = session.event_route.lock() else {
                log::error!(
                    "PTY event route lock poisoned while reclaiming session_id={}",
                    session.session_id
                );
                continue;
            };
            if reclaim_event_route(&mut route, window_label) {
                if !session.flow.is_closed() {
                    session.flow.pause_indefinitely();
                }
                reclaimed.push(session.session_id.clone());
            } else if pending_cleared {
                session.flow.resume();
            }
        }
        reclaimed
    }

    pub fn reattach(
        &self,
        session_id: &str,
        window_label: &str,
        channel: Channel<PtyEvent>,
        snapshot: PtyTerminalSnapshot,
        sequence: u64,
        size: PtySizeUpdate,
    ) -> Result<PtySession, AppError> {
        if window_label != "main" {
            return Err(AppError::msg("只有主窗口可以重新接管终端"));
        }
        validate_handoff_snapshot(&snapshot)?;
        validate_size(size)?;
        let session = self.get(session_id)?;
        let mut route = session
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        if !route.owner_lost || route.window_label != "main" || route.channel.is_some() {
            return Err(AppError::msg("终端当前不处于可重新接管状态"));
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
        session.flow.acknowledge(sequence)?;
        channel
            .send(PtyEvent::Snapshot {
                session_id: session_id.to_string(),
                sequence,
                data: snapshot.data,
                cols: snapshot.cols,
                rows: snapshot.rows,
            })
            .map_err(|error| AppError::msg(format!("发送终端画面快照失败：{error}")))?;
        for event in route.buffered_events.iter().filter(|event| {
            pty_event_sequence(event).map_or(true, |event_sequence| event_sequence > sequence)
        }) {
            channel
                .send(event.clone())
                .map_err(|error| AppError::msg(format!("恢复终端输出失败：{error}")))?;
        }
        route.buffered_events.clear();
        route.buffered_bytes = 0;
        route.channel = Some(channel);
        route.mirror = None;
        route.owner_lost = false;
        drop(route);
        session.flow.resume();
        Ok(session.metadata())
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
        route.mirror = if target_window_label == "main" {
            None
        } else if transfer.source_window_label == "main" {
            route
                .channel
                .take()
                .map(|source_channel| ("main".to_string(), source_channel))
        } else {
            route.mirror.take().filter(|(label, _)| label == "main")
        };
        route.channel = Some(channel);
        route.owner_lost = false;
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

    pub fn begin_session_start(&self) -> Result<PtySessionStartGuard, AppError> {
        let mut gate = self
            .lifecycle_gate
            .lock()
            .map_err(|_| AppError::msg("PTY 生命周期门禁锁中毒"))?;
        if gate.restore_in_progress {
            return Err(AppError::coded(
                "backup_restore_in_progress",
                "备份恢复正在进行，暂时不能启动终端会话",
            ));
        }
        gate.session_starts = gate.session_starts.saturating_add(1);
        drop(gate);
        Ok(PtySessionStartGuard {
            gate: Arc::clone(&self.lifecycle_gate),
        })
    }

    pub fn begin_backup_restore(&self) -> Result<PtyBackupRestoreGuard, AppError> {
        let mut gate = self
            .lifecycle_gate
            .lock()
            .map_err(|_| AppError::msg("PTY 生命周期门禁锁中毒"))?;
        if gate.restore_in_progress {
            return Err(AppError::coded(
                "backup_restore_in_progress",
                "另一个备份恢复操作正在进行",
            ));
        }
        if gate.session_starts > 0 {
            return Err(AppError::coded_with_params(
                "pty_session_starting",
                format!(
                    "有 {} 个终端会话正在启动，请稍后重试恢复备份",
                    gate.session_starts
                ),
                serde_json::json!({ "count": gate.session_starts }),
            ));
        }
        let active_count = self
            .sessions
            .lock()
            .map_err(|_| AppError::msg("PTY 会话表锁中毒"))?
            .len();
        ensure_no_active_sessions(active_count)?;
        gate.restore_in_progress = true;
        drop(gate);
        Ok(PtyBackupRestoreGuard {
            gate: Arc::clone(&self.lifecycle_gate),
        })
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

/// 测试用的 `ChildKiller`：只记录 `kill` 被调用的次数，不触碰任何进程。
#[cfg(test)]
#[derive(Debug)]
struct FakeKiller(Arc<std::sync::atomic::AtomicUsize>);

#[cfg(test)]
impl ChildKiller for FakeKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(FakeKiller(Arc::clone(&self.0)))
    }
}

/// 把发往通道的 JSON 事件记录下来的通道替身。
#[cfg(test)]
pub(crate) fn recording_channel() -> (Channel<PtyEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
    let sink: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let writer = Arc::clone(&sink);
    let channel = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            writer
                .lock()
                .unwrap()
                .push(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, sink)
}

/// 每次发送都失败的通道替身，用来模拟所有者窗口已销毁。
#[cfg(test)]
pub(crate) fn failing_channel() -> Channel<PtyEvent> {
    Channel::new(|_| Err(tauri::Error::Anyhow(anyhow!("closed"))))
}

/// `insert_test_session` 的返回值。不暴露私有的 `ManagedSession`（会触发
/// `private_interfaces` 警告）：同模块的测试用 `PtySessionManager::get` 取会话。
#[cfg(test)]
pub(crate) struct TestSession {
    pub session_id: String,
    pub input: Receiver<Vec<u8>>,
    pub kills: Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TestRoute {
    pub window_label: String,
    pub owner_lost: bool,
    pub has_channel: bool,
    pub buffered_events: usize,
}

#[cfg(test)]
impl PtySessionManager {
    /// 不启动子进程、不启动输入写线程，直接把一个带通道的会话放进会话表。
    pub(crate) fn insert_test_session(
        &self,
        owner_label: &str,
        channel: Option<Channel<PtyEvent>>,
    ) -> TestSession {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty must succeed for PTY manager tests");
        drop(pair.slave);
        let kills = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (writer, input) = pty_input_channel();
        let session_id = Uuid::new_v4().to_string();
        let session = Arc::new(ManagedSession {
            session_id: session_id.clone(),
            directory_id: 1,
            tool_key: ToolKey::Claude,
            working_directory: "C:/project".to_string(),
            started_at_ms: 0,
            master: Mutex::new(pair.master),
            last_size: Mutex::new((80, 24)),
            writer,
            killer: Mutex::new(Box::new(FakeKiller(Arc::clone(&kills)))),
            process_tree: Mutex::new(None),
            flow: Arc::new(OutputFlow::new()),
            event_route: Mutex::new(EventRoute {
                window_label: owner_label.to_string(),
                channel,
                mirror: None,
                owner_lost: false,
                buffered_events: VecDeque::new(),
                buffered_bytes: 0,
            }),
            pending_handoff: Mutex::new(None),
            first_output_logged: AtomicBool::new(false),
            output_chunks: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            acknowledgement_calls: AtomicU64::new(0),
            last_acknowledged_sequence: AtomicU64::new(0),
            termination_requested: AtomicBool::new(false),
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), session);
        TestSession {
            session_id,
            input,
            kills,
        }
    }

    pub(crate) fn test_route(&self, session_id: &str) -> TestRoute {
        let session = self.get(session_id).expect("test session must exist");
        let route = session.event_route.lock().unwrap();
        TestRoute {
            window_label: route.window_label.clone(),
            owner_lost: route.owner_lost,
            has_channel: route.channel.is_some(),
            buffered_events: route.buffered_events.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_restore_is_blocked_while_pty_sessions_are_registered() {
        assert!(ensure_no_active_sessions(0).is_ok());
        let error = ensure_no_active_sessions(1).unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["code"],
            "pty_sessions_active"
        );
        assert!(error.to_string().contains("1 个"));
    }

    #[test]
    fn backup_restore_serializes_against_session_startup() {
        let manager = PtySessionManager::default();
        let starting = manager.begin_session_start().unwrap();
        let starting_error = match manager.begin_backup_restore() {
            Ok(_) => panic!("restore must wait for a session startup"),
            Err(error) => error,
        };
        assert_eq!(
            serde_json::to_value(&starting_error).unwrap()["code"],
            "pty_session_starting"
        );

        drop(starting);
        let restoring = manager.begin_backup_restore().unwrap();
        let start_error = match manager.begin_session_start() {
            Ok(_) => panic!("session startup must be blocked during restore"),
            Err(error) => error,
        };
        assert_eq!(
            serde_json::to_value(&start_error).unwrap()["code"],
            "backup_restore_in_progress"
        );

        drop(restoring);
        assert!(manager.begin_session_start().is_ok());
    }
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
    fn finalized_handoff_rejects_source_cancel_and_reports_child_owner() {
        let route = EventRoute {
            window_label: "terminal-child".to_string(),
            channel: None,
            mirror: None,
            owner_lost: false,
            buffered_events: VecDeque::new(),
            buffered_bytes: 0,
        };

        assert!(ensure_route_owner(&route, "main").is_err());
        assert_eq!(
            session_window_status(Some(&route.window_label), "main", false),
            PtySessionWindowStatus::OwnedByAnotherWindow
        );
    }

    #[test]
    fn destroying_the_current_owner_reclaims_an_open_session_for_main() {
        let mut route = EventRoute {
            window_label: "terminal-child".to_string(),
            channel: None,
            mirror: None,
            owner_lost: false,
            buffered_events: VecDeque::new(),
            buffered_bytes: 0,
        };

        assert!(reclaim_event_route(&mut route, "terminal-child"));
        assert_eq!(route.window_label, "main");
        assert!(route.owner_lost);
        assert!(route.channel.is_none());
    }

    #[test]
    fn destroying_a_non_owner_does_not_reclaim_the_session() {
        let mut route = EventRoute {
            window_label: "terminal-owner".to_string(),
            channel: None,
            mirror: None,
            owner_lost: false,
            buffered_events: VecDeque::new(),
            buffered_bytes: 0,
        };

        assert!(!reclaim_event_route(&mut route, "terminal-mirror"));
        assert_eq!(route.window_label, "terminal-owner");
        assert!(!route.owner_lost);
    }

    #[test]
    fn owner_lost_output_buffer_rejects_data_over_the_limit() {
        let mut route = EventRoute {
            window_label: "main".to_string(),
            channel: None,
            mirror: None,
            owner_lost: true,
            buffered_events: VecDeque::new(),
            buffered_bytes: 0,
        };
        let event = PtyEvent::Output {
            session_id: "session-1".to_string(),
            sequence: 1,
            data_base64: "x".repeat(MAX_OWNER_LOST_BUFFER_BYTES + 1),
        };

        assert!(!buffer_owner_lost_event(
            &mut route,
            event,
            MAX_OWNER_LOST_BUFFER_BYTES + 1
        ));
        assert!(route.buffered_events.is_empty());
        assert_eq!(route.buffered_bytes, 0);
    }

    #[test]
    fn destroying_a_window_clears_handoffs_that_use_it_as_source_or_target() {
        let transfer = PendingHandoff {
            token: "token".to_string(),
            source_window_label: "main".to_string(),
            sequence: 1,
            snapshot: None,
            target_window_label: Some("terminal-child".to_string()),
            target_channel: None,
        };

        assert!(handoff_references_window(&transfer, "main"));
        assert!(handoff_references_window(&transfer, "terminal-child"));
        assert!(!handoff_references_window(&transfer, "terminal-other"));
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
        assert!(is_supported_workspace_window(
            "terminal-8e783338-f464-4b10-b15e-b534748c6241"
        ));
        assert!(!is_supported_workspace_window("settings"));
        assert!(!is_supported_workspace_window("terminal-invalid"));
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

    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn queued_pty_input_is_written_in_submission_order() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let (sender, receiver) = mpsc::sync_channel(3);
        let worker = start_pty_input_writer(
            Box::new(RecordingWriter(Arc::clone(&written))),
            receiver,
            "test-session".to_string(),
        )
        .unwrap();

        enqueue_pty_input(&sender, b"first").unwrap();
        enqueue_pty_input(&sender, b"second").unwrap();
        enqueue_pty_input(&sender, b"third").unwrap();
        drop(sender);
        worker.join().unwrap();

        assert_eq!(*written.lock().unwrap(), b"firstsecondthird");
    }

    #[test]
    fn full_pty_input_queue_returns_a_typed_backpressure_error() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        enqueue_pty_input(&sender, b"first").unwrap();

        let error = enqueue_pty_input(&sender, b"second").unwrap_err();
        let value = serde_json::to_value(error).unwrap();

        assert_eq!(value["code"], "pty_input_backpressure");
    }

    #[test]
    fn oversized_pty_input_is_rejected_before_queueing() {
        let (sender, _receiver) = mpsc::sync_channel(1);

        let error = enqueue_pty_input(&sender, &vec![b'x'; MAX_PTY_INPUT_BYTES + 1]).unwrap_err();
        let value = serde_json::to_value(error).unwrap();

        assert_eq!(value["code"], "pty_input_backpressure");
    }

    // ---- manager 级测试（m6-024）：全部通过 insert_test_session 构造真实会话，
    // 不启动子进程、不启动输入写线程、不使用 sleep。

    const T1: &str = "terminal-11111111-1111-4111-8111-111111111111";
    const T2: &str = "terminal-22222222-2222-4222-8222-222222222222";
    const T3: &str = "terminal-33333333-3333-4333-8333-333333333333";
    const T4: &str = "terminal-44444444-4444-4444-8444-444444444444";
    const T5: &str = "terminal-55555555-5555-4555-8555-555555555555";
    const T6: &str = "terminal-66666666-6666-4666-8666-666666666666";

    fn output(session_id: &str, sequence: u64, data: &str) -> PtyEvent {
        PtyEvent::Output {
            session_id: session_id.to_string(),
            sequence,
            data_base64: data.to_string(),
        }
    }

    fn snapshot() -> PtyTerminalSnapshot {
        PtyTerminalSnapshot {
            data: "screen".to_string(),
            cols: 80,
            rows: 24,
        }
    }

    fn size() -> PtySizeUpdate {
        PtySizeUpdate {
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    fn error_text(error: &AppError) -> String {
        error.to_string()
    }

    type Records = Arc<Mutex<Vec<serde_json::Value>>>;

    fn records(sink: &Records) -> Vec<serde_json::Value> {
        sink.lock().unwrap().clone()
    }

    fn count_of(records: &[serde_json::Value], event_type: &str) -> usize {
        records
            .iter()
            .filter(|record| record["type"] == event_type)
            .count()
    }

    /// 所有者 T1 的会话：预留 4 个输出序号，T1 被销毁后（失主）缓冲三条输出和一条失败事件。
    /// 返回会话 id、会话对象和旧所有者通道 A 的记录。
    fn owner_lost_session_with_buffer(
        manager: &PtySessionManager,
    ) -> (String, Arc<ManagedSession>, Records) {
        let (channel_a, sink_a) = recording_channel();
        let ts = manager.insert_test_session(T1, Some(channel_a));
        let session = manager.get(&ts.session_id).unwrap();
        for expected in 1..=4u64 {
            assert_eq!(session.flow.reserve(1), Some(expected));
        }
        assert_eq!(manager.reclaim_window(T1), vec![ts.session_id.clone()]);
        for event in [
            output(&ts.session_id, 2, "b2"),
            output(&ts.session_id, 3, "b3"),
            output(&ts.session_id, 4, "b4"),
            PtyEvent::Failed {
                session_id: ts.session_id.clone(),
                message: "x".to_string(),
            },
        ] {
            session.send_event(event).unwrap();
        }
        (ts.session_id, session, sink_a)
    }

    fn is_paused(session: &ManagedSession) -> bool {
        session.flow.state.lock().unwrap().paused
    }

    #[test]
    fn reclaim_window_pauses_output_and_clears_pending_handoffs() {
        let manager = PtySessionManager::default();

        // S1：所有者 T1，有未确认的输出。
        let (channel_1, sink_1) = recording_channel();
        let ts1 = manager.insert_test_session(T1, Some(channel_1));
        let s1 = ts1.session_id.clone();
        let session_1 = manager.get(&s1).unwrap();
        session_1.flow.reserve(10).unwrap();

        // S2：所有者 main，交接目标是 T2，已经 complete 但尚未 finalize。
        let (channel_2, _sink_2) = recording_channel();
        let ts2 = manager.insert_test_session("main", Some(channel_2));
        let s2 = ts2.session_id.clone();
        let session_2 = manager.get(&s2).unwrap();
        let handoff = manager.begin_handoff(&s2, "main").unwrap();
        manager
            .stage_handoff_snapshot(&s2, "main", &handoff.token, handoff.sequence, snapshot())
            .unwrap();
        let (target_channel, _target_sink) = recording_channel();
        manager
            .complete_handoff(&s2, T2, &handoff.token, target_channel)
            .unwrap();
        assert!(session_2.flow.is_paused_at(handoff.sequence));

        // S3：所有者 T3，镜像窗口是 main。
        let (channel_3, _sink_3) = recording_channel();
        let ts3 = manager.insert_test_session(T3, Some(channel_3));
        let s3 = ts3.session_id.clone();
        let session_3 = manager.get(&s3).unwrap();
        let (mirror_3, _mirror_sink_3) = recording_channel();
        session_3.event_route.lock().unwrap().mirror = Some(("main".to_string(), mirror_3));

        // S4：所有者 T4，镜像窗口是 T5。
        let (channel_4, _sink_4) = recording_channel();
        let ts4 = manager.insert_test_session(T4, Some(channel_4));
        let s4 = ts4.session_id.clone();
        let session_4 = manager.get(&s4).unwrap();
        let (mirror_4, _mirror_sink_4) = recording_channel();
        session_4.event_route.lock().unwrap().mirror = Some((T5.to_string(), mirror_4));

        // 失主路径：所有者窗口被销毁，会话被回收给 main 并无限期暂停输出。
        assert_eq!(manager.reclaim_window(T1), vec![s1.clone()]);
        {
            let state = session_1.flow.state.lock().unwrap();
            assert!(state.paused);
            assert!(state.pause_deadline.is_none());
        }
        assert_eq!(
            manager.test_route(&s1),
            TestRoute {
                window_label: "main".into(),
                owner_lost: true,
                has_channel: false,
                buffered_events: 0,
            }
        );
        // 反向断言：回收只是改路由，不会终止进程，也不会向旧通道补发事件。
        assert_eq!(ts1.kills.load(Ordering::SeqCst), 0);
        assert!(records(&sink_1).is_empty());

        // 交接目标窗被销毁：待决交接被清除，输出恢复，所有者仍是 main。
        assert_eq!(manager.reclaim_window(T2), Vec::<String>::new());
        assert!(session_2.pending_handoff.lock().unwrap().is_none());
        assert!(!session_2.flow.is_paused_at(handoff.sequence));
        assert!(!is_paused(&session_2));
        assert_eq!(manager.test_route(&s2).window_label, "main");

        // 镜像窗是 main：main 永远不会被回收，镜像保持。
        assert_eq!(manager.reclaim_window("main"), Vec::<String>::new());
        assert!(session_3.event_route.lock().unwrap().mirror.is_some());

        // 镜像窗 T5 被销毁：只清掉镜像，所有者 T4 不变。
        assert_eq!(manager.reclaim_window(T5), Vec::<String>::new());
        assert!(session_4.event_route.lock().unwrap().mirror.is_none());
        assert_eq!(manager.test_route(&s4).window_label, T4);

        // 无关标签：任何路由都不变。
        let before: Vec<TestRoute> = [&s1, &s2, &s3, &s4]
            .iter()
            .map(|id| manager.test_route(id))
            .collect();
        assert_eq!(manager.reclaim_window(T6), Vec::<String>::new());
        let after: Vec<TestRoute> = [&s1, &s2, &s3, &s4]
            .iter()
            .map(|id| manager.test_route(id))
            .collect();
        assert_eq!(before, after);
        assert!(session_3.event_route.lock().unwrap().mirror.is_some());
        assert!(session_4.event_route.lock().unwrap().mirror.is_none());
    }

    #[test]
    fn reattach_replays_only_buffered_events_after_snapshot_sequence() {
        let manager = PtySessionManager::default();
        let (s1, session, sink_a) = owner_lost_session_with_buffer(&manager);
        let (channel_b, sink_b) = recording_channel();

        let metadata = manager
            .reattach(&s1, "main", channel_b, snapshot(), 3, size())
            .unwrap();

        let received = records(&sink_b);
        assert_eq!(received.len(), 3);
        assert_eq!(received[0]["type"], "snapshot");
        assert_eq!(received[0]["sequence"], 3);
        assert_eq!(received[1]["type"], "output");
        assert_eq!(received[1]["sequence"], 4);
        assert_eq!(received[2]["type"], "failed");
        // 反向断言：快照序号及之前的输出不会被重放。
        assert!(!received.iter().any(|record| {
            record["type"] == "output" && (record["sequence"] == 2 || record["sequence"] == 3)
        }));
        assert_eq!(
            manager.test_route(&s1),
            TestRoute {
                window_label: "main".into(),
                owner_lost: false,
                has_channel: true,
                buffered_events: 0,
            }
        );
        {
            let route = session.event_route.lock().unwrap();
            assert_eq!(route.buffered_bytes, 0);
            assert!(route.mirror.is_none());
        }
        assert!(!is_paused(&session));
        assert_eq!(metadata.session_id, s1);
        // 反向断言：失主之后的事件没有发往旧通道。
        assert!(records(&sink_a).is_empty());
    }

    #[test]
    fn repeated_reattach_is_rejected_without_replacing_the_live_channel() {
        let manager = PtySessionManager::default();
        let (s1, session, _sink_a) = owner_lost_session_with_buffer(&manager);
        let (channel_b, sink_b) = recording_channel();
        manager
            .reattach(&s1, "main", channel_b, snapshot(), 3, size())
            .unwrap();
        let (channel_c, sink_c) = recording_channel();

        let error = manager
            .reattach(&s1, "main", channel_c, snapshot(), 4, size())
            .unwrap_err();

        assert!(
            error_text(&error).contains("不处于可重新接管状态"),
            "{}",
            error_text(&error)
        );
        assert!(records(&sink_c).is_empty());
        session.send_event(output(&s1, 5, "b5")).unwrap();
        let received = records(&sink_b);
        let last = received.last().unwrap();
        assert_eq!(last["type"], "output");
        assert_eq!(last["sequence"], 5);
        assert!(records(&sink_c).is_empty());
        assert!(!is_paused(&session));
        // 反向断言：第二次 reattach 没有给 B 补发新的快照。
        assert_eq!(count_of(&received, "snapshot"), 1);
    }

    #[test]
    fn reattach_requires_main_window_and_owner_lost_state() {
        // 每个子场景用独立的 manager：reclaim_window(T1) 会回收该 manager 里
        // 所有以 T1 为所有者的会话，共用 manager 会让子场景互相影响。

        // 子场景 1：非 main 窗口不能接管。
        let manager_1 = PtySessionManager::default();
        let (channel_1, _sink_1) = recording_channel();
        let ts1 = manager_1.insert_test_session(T1, Some(channel_1));
        let s1 = ts1.session_id.clone();
        manager_1.get(&s1).unwrap().flow.reserve(1).unwrap();
        assert_eq!(manager_1.reclaim_window(T1), vec![s1.clone()]);
        let (new_1, new_sink_1) = recording_channel();
        let error = manager_1
            .reattach(&s1, T1, new_1, snapshot(), 1, size())
            .unwrap_err();
        assert!(
            error_text(&error).contains("只有主窗口可以重新接管终端"),
            "{}",
            error_text(&error)
        );
        assert!(manager_1.test_route(&s1).owner_lost);

        // 子场景 2：所有者没有失主，不能接管。
        let manager_2 = PtySessionManager::default();
        let (channel_2, _sink_2) = recording_channel();
        let ts2 = manager_2.insert_test_session(T1, Some(channel_2));
        let s2 = ts2.session_id.clone();
        let (new_2, new_sink_2) = recording_channel();
        let error = manager_2
            .reattach(&s2, "main", new_2, snapshot(), 0, size())
            .unwrap_err();
        assert!(
            error_text(&error).contains("不处于可重新接管状态"),
            "{}",
            error_text(&error)
        );
        assert_eq!(manager_2.test_route(&s2).window_label, T1);

        // 子场景 3：快照尺寸非法，失主状态与缓冲保持不变。
        let manager_3 = PtySessionManager::default();
        let (channel_3, _sink_3) = recording_channel();
        let ts3 = manager_3.insert_test_session(T1, Some(channel_3));
        let s3 = ts3.session_id.clone();
        let session_3 = manager_3.get(&s3).unwrap();
        session_3.flow.reserve(1).unwrap();
        assert_eq!(manager_3.reclaim_window(T1), vec![s3.clone()]);
        session_3.send_event(output(&s3, 1, "z")).unwrap();
        let (new_3, new_sink_3) = recording_channel();
        let invalid_snapshot = PtyTerminalSnapshot {
            cols: 0,
            ..snapshot()
        };
        let error = manager_3
            .reattach(&s3, "main", new_3, invalid_snapshot, 1, size())
            .unwrap_err();
        assert!(
            error_text(&error).contains("PTY 尺寸必须至少为 1 列和 1 行"),
            "{}",
            error_text(&error)
        );
        let route_3 = manager_3.test_route(&s3);
        assert!(route_3.owner_lost);
        assert_eq!(route_3.buffered_events, 1);

        // 子场景 4：序号超过已预留的最大序号，路由未变，缓冲没有被清空。
        let manager_4 = PtySessionManager::default();
        let (channel_4, _sink_4) = recording_channel();
        let ts4 = manager_4.insert_test_session(T1, Some(channel_4));
        let s4 = ts4.session_id.clone();
        let session_4 = manager_4.get(&s4).unwrap();
        session_4.flow.reserve(1).unwrap();
        assert_eq!(manager_4.reclaim_window(T1), vec![s4.clone()]);
        session_4.send_event(output(&s4, 1, "z")).unwrap();
        let (new_4, new_sink_4) = recording_channel();
        let error = manager_4
            .reattach(&s4, "main", new_4, snapshot(), 99, size())
            .unwrap_err();
        assert!(
            error_text(&error).contains("输出确认序号超出已发送范围"),
            "{}",
            error_text(&error)
        );
        assert_eq!(
            manager_4.test_route(&s4),
            TestRoute {
                window_label: "main".into(),
                owner_lost: true,
                has_channel: false,
                buffered_events: 1,
            }
        );

        // 反向断言：失败的 reattach 不得向新通道发送任何事件。
        for sink in [&new_sink_1, &new_sink_2, &new_sink_3, &new_sink_4] {
            assert!(records(sink).is_empty());
        }
    }

    #[test]
    fn owner_channel_failure_buffers_until_reattach_and_bounds_memory() {
        let manager = PtySessionManager::default();

        // 子场景 1：所有者通道失效，输出被缓冲并无限期暂停；标签保持 T1。
        let ts1 = manager.insert_test_session(T1, Some(failing_channel()));
        let s1 = ts1.session_id.clone();
        let session_1 = manager.get(&s1).unwrap();
        session_1
            .send_event(output(&s1, 1, &"a".repeat(10)))
            .unwrap();
        assert_eq!(
            manager.test_route(&s1),
            TestRoute {
                window_label: T1.into(),
                owner_lost: true,
                has_channel: false,
                buffered_events: 1,
            }
        );
        {
            let state = session_1.flow.state.lock().unwrap();
            assert!(state.paused);
            assert!(state.pause_deadline.is_none());
        }

        // 子场景 2：缓冲超过上限的输出被拒绝，已缓冲字节数不超过上限。
        let error = session_1
            .send_event(output(&s1, 2, &"x".repeat(MAX_OWNER_LOST_BUFFER_BYTES)))
            .unwrap_err();
        assert!(error.contains("输出缓冲区已满"), "{error}");
        assert!(
            session_1.event_route.lock().unwrap().buffered_bytes <= MAX_OWNER_LOST_BUFFER_BYTES
        );

        // 子场景 3：退出事件不受输出上限限制，仍被缓冲。
        session_1
            .send_event(PtyEvent::Exited {
                session_id: s1.clone(),
                state: "exited".to_string(),
                exit_code: Some(0),
            })
            .unwrap();
        assert!(matches!(
            session_1.event_route.lock().unwrap().buffered_events.back(),
            Some(PtyEvent::Exited { .. })
        ));

        // 子场景 4：所有者是 main 时通道失效直接报错，不触发失主暂停。
        let ts4 = manager.insert_test_session("main", Some(failing_channel()));
        let s4 = ts4.session_id.clone();
        let session_4 = manager.get(&s4).unwrap();
        let error = session_4.send_event(output(&s4, 1, "a")).unwrap_err();
        assert!(error.contains("输出通道不可用"), "{error}");
        assert!(!manager.test_route(&s4).owner_lost);
        assert!(!is_paused(&session_4));

        // 子场景 5：通道正常时事件同时发往所有者通道和 main 镜像。
        let (channel_a, sink_a) = recording_channel();
        let ts5 = manager.insert_test_session(T1, Some(channel_a));
        let s5 = ts5.session_id.clone();
        let session_5 = manager.get(&s5).unwrap();
        let (mirror, sink_m) = recording_channel();
        session_5.event_route.lock().unwrap().mirror = Some(("main".to_string(), mirror));
        session_5.send_event(output(&s5, 1, "a")).unwrap();
        assert_eq!(records(&sink_a).len(), 1);
        assert_eq!(records(&sink_m).len(), 1);
    }

    #[test]
    fn pty_input_ownership_size_and_backpressure_boundaries() {
        let manager = PtySessionManager::default();
        let (channel, _sink) = recording_channel();
        let TestSession {
            session_id: s,
            input,
            ..
        } = manager.insert_test_session(T1, Some(channel));
        let code = |error: &AppError| serde_json::to_value(error).unwrap()["code"].clone();

        // 1. 非所有者不能写入，队列保持为空。
        let error = manager.write(&s, "main", b"x").unwrap_err();
        assert!(
            error_text(&error).contains("另一个窗口控制"),
            "{}",
            error_text(&error)
        );
        assert_eq!(input.try_recv(), Err(mpsc::TryRecvError::Empty));

        // 2. 恰好等于上限的输入被接受。
        manager
            .write(&s, T1, &vec![0u8; MAX_PTY_INPUT_BYTES])
            .unwrap();
        assert_eq!(input.try_recv().unwrap().len(), MAX_PTY_INPUT_BYTES);

        // 3. 超过上限一个字节就被背压拒绝，且没有入队。
        let error = manager
            .write(&s, T1, &vec![0u8; MAX_PTY_INPUT_BYTES + 1])
            .unwrap_err();
        assert_eq!(code(&error), "pty_input_backpressure");
        assert_eq!(input.try_recv(), Err(mpsc::TryRecvError::Empty));

        // 4. 后端按字节计数而不是按字符：21846 个汉字 = 65538 字节，被拒绝。
        //    前端因此必须按字节分片（m6-036）。
        let wide = "你".repeat(21846);
        assert_eq!(wide.len(), 65538);
        let error = manager.write(&s, T1, wide.as_bytes()).unwrap_err();
        assert_eq!(code(&error), "pty_input_backpressure");
        assert_eq!(input.try_recv(), Err(mpsc::TryRecvError::Empty));

        // 5. 队列容量为 32：第 33 次写入被背压拒绝，读空后恰为 32 条。
        for _ in 0..PTY_INPUT_QUEUE_CAPACITY {
            manager.write(&s, T1, b"y").unwrap();
        }
        let error = manager.write(&s, T1, b"y").unwrap_err();
        assert_eq!(code(&error), "pty_input_backpressure");
        let mut drained = 0;
        while input.try_recv().is_ok() {
            drained += 1;
        }
        assert_eq!(drained, PTY_INPUT_QUEUE_CAPACITY);

        // 6. 写线程退出（接收端被丢弃）之后返回 unavailable。
        drop(input);
        let error = manager.write(&s, T1, b"z").unwrap_err();
        assert_eq!(code(&error), "pty_input_unavailable");
    }
}
