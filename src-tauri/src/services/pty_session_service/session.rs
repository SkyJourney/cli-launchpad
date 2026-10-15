use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    mpsc::SyncSender,
    Arc, Mutex,
};

use portable_pty::{ChildKiller, MasterPty};

use super::{
    flow::OutputFlow,
    route::{buffer_owner_lost_event, ensure_route_owner, pty_event_buffer_size, EventRoute},
    PendingHandoff,
};
use crate::{
    models::{
        pty_session::{PtyEvent, PtySession},
        tool::ToolKey,
        window_kind::{is_main_label, is_terminal_label},
    },
    platform::execution_process::ProcessTree,
    AppError,
};

pub(super) struct ManagedSession {
    pub(super) session_id: String,
    pub(super) directory_id: i64,
    pub(super) tool_key: ToolKey,
    pub(super) working_directory: String,
    pub(super) started_at_ms: i64,
    pub(super) master: Mutex<Box<dyn MasterPty + Send>>,
    pub(super) last_size: Mutex<(u16, u16)>,
    pub(super) writer: SyncSender<Vec<u8>>,
    pub(super) killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub(super) process_tree: Mutex<Option<ProcessTree>>,
    pub(super) flow: Arc<OutputFlow>,
    pub(super) event_route: Mutex<EventRoute>,
    pub(super) pending_handoff: Mutex<Option<PendingHandoff>>,
    pub(super) first_output_logged: AtomicBool,
    pub(super) output_chunks: AtomicU64,
    pub(super) output_bytes: AtomicU64,
    pub(super) acknowledgement_calls: AtomicU64,
    pub(super) last_acknowledged_sequence: AtomicU64,
    pub(super) termination_requested: std::sync::atomic::AtomicBool,
}

impl ManagedSession {
    pub(super) fn send_event(&self, event: PtyEvent) -> Result<(), String> {
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
                    if is_terminal_label(&route.window_label) {
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
                    .is_some_and(|(label, _)| is_main_label(label));
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
                    .is_some_and(|(label, _)| is_main_label(label));
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

    pub(super) fn is_output_observer(&self, window_label: &str) -> Result<bool, AppError> {
        let route = self
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        Ok(route.window_label == window_label
            || route
                .mirror
                .as_ref()
                .is_some_and(|(label, _)| label == window_label)
            || (route.owner_lost && is_main_label(window_label)))
    }

    pub(super) fn ensure_owner(&self, window_label: &str) -> Result<(), AppError> {
        let route = self
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        ensure_route_owner(&route, window_label)
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
