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
    db::pty_session_repo,
    models::{
        pty_session::{PtyEvent, PtyFrontendStage, PtySession, PtySizeUpdate},
        tool::ToolKey,
    },
    platform::execution_process::{attach_pty_or_terminate, ProcessTree},
    services::{directory_service, launch_service},
    AppError, Db,
};

const READ_CHUNK_BYTES: usize = 16 * 1024;
const OUTPUT_HIGH_WATERMARK: usize = 192 * 1024;
const OUTPUT_LOW_WATERMARK: usize = 64 * 1024;

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
    master: Mutex<Box<dyn MasterPty + Send>>,
    last_size: Mutex<(u16, u16)>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    process_tree: Mutex<Option<ProcessTree>>,
    flow: Arc<OutputFlow>,
    first_output_logged: AtomicBool,
    output_chunks: AtomicU64,
    output_bytes: AtomicU64,
    acknowledgement_calls: AtomicU64,
    last_acknowledged_sequence: AtomicU64,
    termination_requested: std::sync::atomic::AtomicBool,
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
        while state.pending_bytes >= OUTPUT_HIGH_WATERMARK && !state.closed {
            let Ok(next) = self.changed.wait(state) else {
                return false;
            };
            state = next;
            if state.pending_bytes <= OUTPUT_LOW_WATERMARK {
                break;
            }
        }
        !state.closed
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

impl PtySessionManager {
    pub fn create(
        &self,
        connection: &Connection,
        app: &AppHandle,
        directory_id: i64,
        tool_key: ToolKey,
        resume_session_id: Option<&str>,
        size: PtySizeUpdate,
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
            master: Mutex::new(pair.master),
            last_size: Mutex::new((size.cols, size.rows)),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            process_tree: Mutex::new(Some(process_tree)),
            flow: Arc::new(OutputFlow::new()),
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

        if let Err(error) = spawn_output_reader(Arc::clone(&session), reader, on_event.clone()) {
            self.fail_session_start(connection, &session, error.to_string());
            return Err(AppError::msg(format!("创建 PTY 输出线程失败：{error}")));
        }
        if let Err(error) = spawn_child_monitor(
            Arc::clone(&session),
            child,
            app.clone(),
            on_event,
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

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), AppError> {
        let session = self.get(session_id)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| AppError::msg("PTY 输入流锁中毒"))?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, size: PtySizeUpdate) -> Result<(), AppError> {
        validate_size(size)?;
        let session = self.get(session_id)?;
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

    pub fn acknowledge(&self, session_id: &str, sequence: u64) -> Result<(), AppError> {
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
        stage: PtyFrontendStage,
    ) -> Result<(), AppError> {
        let session = self.get(session_id)?;
        log::info!(
            "PTY frontend stage session_id={} stage={}",
            session.session_id,
            stage.as_str()
        );
        Ok(())
    }

    pub fn terminate(&self, session_id: &str) -> Result<(), AppError> {
        let session = self.get(session_id)?;
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
    on_event: Channel<PtyEvent>,
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
                        if on_event.send(event).is_err() {
                            log::warn!(
                                "PTY output channel closed session_id={}",
                                session.session_id
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
                        if output_chunks % 32 == 0 {
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
    on_event: Channel<PtyEvent>,
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
                    let _ = on_event.send(PtyEvent::Failed {
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
            let _ = on_event.send(PtyEvent::Exited {
                session_id: session.session_id.clone(),
                state: state.to_string(),
                exit_code,
            });
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
