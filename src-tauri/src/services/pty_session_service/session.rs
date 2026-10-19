//! Lock rules for a PTY session (m6-055)
//! Order:   registry (lookup only; clone the Arc out and release) -> route_and_handoff -> terminal -> flow.state
//! Leaves:  process_tree and killer are held for a single call and never nested with another lock
//! Never while holding any of these locks: Channel/PtyEventSink::send, thread::sleep,
//!          database access, filesystem access, waiting for a child process
//! Allowed: MasterPty::resize under the terminal lock (it is the resource that lock protects)

use crate::domain_errors::PtyError;
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    mpsc::SyncSender,
    Arc, Mutex,
};

use portable_pty::{ChildKiller, MasterPty};

use super::{
    flow::OutputFlow,
    handoff::HandoffState,
    ports::PtyEventSink,
    route::{buffer_owner_lost_event, ensure_route_owner, pty_event_buffer_size, EventRoute},
    to_pty_size,
};
use crate::{
    models::{
        pty_session::{PtyEvent, PtySession, PtySizeUpdate},
        tool::ToolKey,
        window_kind::{is_main_label, is_terminal_label},
    },
    platform::execution_process::ProcessTree,
    AppError,
};

/// The PTY master together with the size last applied to it. One lock guards both so that
/// "compare, resize, remember" is a single critical section.
pub(super) struct TerminalState {
    /// `None` once `release_terminal` dropped it (the session has ended).
    pub(super) master: Option<Box<dyn MasterPty + Send>>,
    pub(super) last_size: (u16, u16),
}

const MAX_SEND_ATTEMPTS: usize = 3;

/// What `send_event` decided under the lock and executes outside of it.
struct SendPlan {
    epoch: u64,
    /// The owner channel and whether the owner is a terminal window.
    owner: Option<(Arc<dyn PtyEventSink>, bool)>,
    mirror: Option<Arc<dyn PtyEventSink>>,
}

/// The mirror that must receive the event: any mirror once the owner is lost, otherwise only
/// the main window's mirror.
fn mirror_sink(route: &EventRoute, owner_lost_mode: bool) -> Option<Arc<dyn PtyEventSink>> {
    route
        .mirror
        .as_ref()
        .filter(|(label, _)| owner_lost_mode || is_main_label(label))
        .map(|(_, mirror)| Arc::clone(mirror))
}

/// The event route and the handoff state are decided together (finalize reads and writes
/// both, reclaim clears both), so one lock guards them.
pub(super) struct RouteAndHandoff {
    pub(super) route: EventRoute,
    pub(super) handoff: HandoffState,
}

pub(super) struct ManagedSession {
    pub(super) session_id: String,
    pub(super) directory_id: i64,
    pub(super) tool_key: ToolKey,
    pub(super) working_directory: String,
    pub(super) started_at_ms: i64,
    pub(super) terminal: Mutex<TerminalState>,
    pub(super) writer: SyncSender<Vec<u8>>,
    pub(super) killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub(super) process_tree: Mutex<Option<ProcessTree>>,
    pub(super) flow: Arc<OutputFlow>,
    pub(super) route_and_handoff: Mutex<RouteAndHandoff>,
    pub(super) first_output_logged: AtomicBool,
    pub(super) output_chunks: AtomicU64,
    pub(super) output_bytes: AtomicU64,
    pub(super) acknowledgement_calls: AtomicU64,
    pub(super) last_acknowledged_sequence: AtomicU64,
    pub(super) termination_requested: std::sync::atomic::AtomicBool,
    /// Set by the output reader thread when it leaves (EOF, error, closed flow).
    pub(super) reader_done: AtomicBool,
}

impl ManagedSession {
    /// Delivers one event to the owner (and the main-window mirror). The route is read and
    /// updated under the lock, but the delivery itself never happens under it: a failure is
    /// applied afterwards only if the route did not change meanwhile (`epoch`).
    pub(super) fn send_event(&self, event: PtyEvent) -> Result<(), String> {
        let buffer_size = pty_event_buffer_size(&event);
        for _ in 0..MAX_SEND_ATTEMPTS {
            // Phase 1: decide under the lock, no IPC.
            let mut plan = {
                let mut guard = self
                    .route_and_handoff
                    .lock()
                    .map_err(|_| "PTY 事件路由锁中毒".to_string())?;
                let route = &mut guard.route;
                let epoch = route.epoch;
                let owner = route.channel.as_ref().map(Arc::clone);
                match owner {
                    Some(channel) => SendPlan {
                        epoch,
                        owner: Some((channel, is_terminal_label(&route.window_label))),
                        mirror: mirror_sink(route, false),
                    },
                    None if route.owner_lost => {
                        if !buffer_owner_lost_event(route, event.clone(), buffer_size) {
                            return Err("PTY 所有者窗口销毁后输出缓冲区已满".to_string());
                        }
                        SendPlan {
                            epoch,
                            owner: None,
                            mirror: mirror_sink(route, true),
                        }
                    }
                    None => return Err("PTY 输出通道不可用：当前没有所有者通道".to_string()),
                }
            };

            // Phase 2: IPC without any lock.
            if let Some((owner, owner_is_terminal)) = plan.owner.take() {
                if let Err(error) = owner.send(event.clone()) {
                    // Phase 3: apply the failure under the lock, only if the route did not change.
                    let mut guard = self
                        .route_and_handoff
                        .lock()
                        .map_err(|_| "PTY 事件路由锁中毒".to_string())?;
                    let route = &mut guard.route;
                    if route.epoch != plan.epoch {
                        // The route changed while sending: plan again against the new route.
                        continue;
                    }
                    if owner_is_terminal {
                        route.channel = None;
                        route.owner_lost = true;
                        route.epoch += 1;
                        plan.epoch = route.epoch;
                        if !buffer_owner_lost_event(route, event.clone(), buffer_size) {
                            return Err("PTY 所有者窗口销毁后输出缓冲区已满".to_string());
                        }
                        plan.mirror = mirror_sink(route, true);
                        self.flow.pause_indefinitely();
                    } else {
                        return Err(format!("PTY 输出通道不可用：{error}"));
                    }
                }
            }

            // Mirror delivery, still without a lock.
            if let Some(mirror) = plan.mirror.take() {
                if mirror.send(event).is_err() {
                    if let Ok(mut guard) = self.route_and_handoff.lock() {
                        if guard.route.epoch == plan.epoch {
                            guard.route.mirror = None;
                            guard.route.epoch += 1;
                        }
                    }
                }
            }
            return Ok(());
        }
        Err("PTY 输出通道不可用：路由在发送期间多次变化".to_string())
    }

    pub(super) fn is_output_observer(&self, window_label: &str) -> Result<bool, AppError> {
        let guard = self
            .route_and_handoff
            .lock()
            .map_err(|_| AppError::from(PtyError::LockPoisoned("PTY 事件路由")))?;
        let route = &guard.route;
        Ok(route.window_label == window_label
            || route
                .mirror
                .as_ref()
                .is_some_and(|(label, _)| label == window_label)
            || (route.owner_lost && is_main_label(window_label)))
    }

    pub(super) fn ensure_owner(&self, window_label: &str) -> Result<(), AppError> {
        let guard = self
            .route_and_handoff
            .lock()
            .map_err(|_| AppError::from(PtyError::LockPoisoned("PTY 事件路由")))?;
        ensure_route_owner(&guard.route, window_label)
    }

    /// Applies `size` through the terminal lock. Returns Ok(true) if the PTY was resized,
    /// Ok(false) if the size was already current.
    pub(super) fn apply_size(&self, size: PtySizeUpdate) -> Result<bool, AppError> {
        let mut terminal = self
            .terminal
            .lock()
            .map_err(|_| AppError::from(PtyError::LockPoisoned("PTY 终端")))?;
        if terminal.last_size == (size.cols, size.rows) {
            return Ok(false);
        }
        let master = terminal
            .master
            .as_ref()
            .ok_or_else(|| AppError::msg("PTY 终端已释放"))?;
        master
            .resize(to_pty_size(size))
            .map_err(|error| AppError::msg(format!("调整 PTY 尺寸失败：{error}")))?;
        terminal.last_size = (size.cols, size.rows);
        Ok(true)
    }

    /// Drops the PTY master after the child has exited. Windows ConPTY only closes the output
    /// pipe when the pseudoconsole is closed, so a reader thread that still blocks in `read`
    /// (and holds this session) would otherwise live forever.
    ///
    /// The master is taken under the lock and dropped outside of it, on a detached thread:
    /// before Windows 11 24H2 `ClosePseudoConsole` waits until the output pipe is drained, and
    /// neither the terminal lock nor the monitor thread may be held up by that.
    pub(super) fn release_terminal(&self) {
        let master = match self.terminal.lock() {
            Ok(mut terminal) => terminal.master.take(),
            Err(_) => {
                log::error!(
                    "PTY terminal lock poisoned, master not released session_id={}",
                    self.session_id
                );
                None
            }
        };
        let Some(master) = master else {
            return;
        };
        let session_id = self.session_id.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("pty-release-{session_id}"))
            .spawn(move || drop(master));
        if let Err(error) = spawned {
            // The master moved into the failed closure is dropped by `spawn`'s error path.
            log::warn!("unable to release the PTY master on a thread session_id={session_id} error={error}");
        }
    }

    pub(super) fn metadata(&self) -> PtySession {
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

#[cfg(test)]
impl ManagedSession {
    pub(super) fn route_and_handoff_lock_is_free(&self) -> bool {
        self.route_and_handoff.try_lock().is_ok()
    }
}
