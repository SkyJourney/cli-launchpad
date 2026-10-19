use crate::domain_errors::PtyError;
use crate::error_codes::ErrorCode;
use std::sync::Arc;

use tauri::ipc::Channel;

use super::{
    ports::PtyEventSink,
    route::{pty_event_sequence, reclaim_event_route, session_window_status},
    validate_handoff_snapshot, validate_size, PtySessionManager,
};
use crate::{
    models::{
        pty_session::{
            PtyEvent, PtySession, PtySessionWindowStatus, PtySessionWindowStatusReport,
            PtySizeUpdate, PtyTerminalSnapshot,
        },
        window_kind::is_main_label,
    },
    AppError,
};

impl PtySessionManager {
    pub fn window_status_report(
        &self,
        session_id: &str,
        window_label: &str,
    ) -> Result<PtySessionWindowStatusReport, AppError> {
        // The table lock is released as soon as the session is found; only the session's own
        // lock is taken below.
        let Some(session) = self.registry.find(session_id)? else {
            return Ok(PtySessionWindowStatusReport {
                status: session_window_status(None, window_label, true),
                owner_window_label: None,
            });
        };
        if session.flow.is_closed() {
            return Ok(PtySessionWindowStatusReport {
                status: PtySessionWindowStatus::Ended,
                owner_window_label: None,
            });
        }
        let guard = session
            .route_and_handoff
            .lock()
            .map_err(|_| AppError::from(PtyError::LockPoisoned("PTY 事件路由")))?;
        let route = &guard.route;
        Ok(PtySessionWindowStatusReport {
            status: session_window_status(Some(&route.window_label), window_label, false),
            owner_window_label: Some(route.window_label.clone()),
        })
    }

    pub fn reclaim_window(&self, window_label: &str) -> Vec<String> {
        if is_main_label(window_label) {
            return Vec::new();
        }
        let sessions = match self.registry.snapshot() {
            Ok(sessions) => sessions,
            Err(_) => {
                log::error!(
                    "PTY session table lock poisoned while reclaiming window={window_label}"
                );
                return Vec::new();
            }
        };
        let mut reclaimed = Vec::new();
        for session in &sessions {
            let Ok(mut guard) = session.route_and_handoff.lock() else {
                log::error!(
                    "PTY event route lock poisoned while reclaiming session_id={}",
                    session.session_id
                );
                continue;
            };
            // Two statements on purpose: both clean-ups must run (no short-circuit).
            let referenced = guard.handoff.clear_for_window(window_label);
            let reserved = guard.handoff.clear_for_reserved_target(window_label);
            let pending_cleared = referenced || reserved;
            if reclaim_event_route(&mut guard.route, window_label) {
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

    /// Takes terminal control back into the main window after the previous owner was lost.
    ///
    /// Three phases keep every delivery out of the lock: (A) validate and mark the route as
    /// `reattaching` under the lock, (B) replay the snapshot and the backlog without it, and
    /// (C) catch up with the events that were buffered meanwhile and commit under the lock.
    pub fn reattach(
        &self,
        session_id: &str,
        window_label: &str,
        channel: Channel<PtyEvent>,
        snapshot: PtyTerminalSnapshot,
        sequence: u64,
        size: PtySizeUpdate,
    ) -> Result<PtySession, AppError> {
        if !is_main_label(window_label) {
            return Err(AppError::coded(
                ErrorCode::WindowNotAllowed,
                "只有主窗口可以重新接管终端",
            ));
        }
        validate_handoff_snapshot(&snapshot)?;
        validate_size(size)?;
        let sink: Arc<dyn PtyEventSink> = Arc::new(channel);
        let session = self.get(session_id)?;
        let after_snapshot = |events: &std::collections::VecDeque<PtyEvent>, skip: usize| {
            events
                .iter()
                .skip(skip)
                .filter(|event| {
                    pty_event_sequence(event)
                        .map_or(true, |event_sequence| event_sequence > sequence)
                })
                .cloned()
                .collect::<Vec<PtyEvent>>()
        };
        // A rejected replay leaves the buffer as it was; the route accepts a new reattach.
        let abort = |error: AppError| {
            if let Ok(mut guard) = session.route_and_handoff.lock() {
                guard.route.reattaching = false;
            }
            error
        };

        // Phase A (locked, no IPC).
        let (backlog, mut delivered) = {
            let mut guard = session
                .route_and_handoff
                .lock()
                .map_err(|_| AppError::from(PtyError::LockPoisoned("PTY 事件路由")))?;
            let route = &mut guard.route;
            if !route.owner_lost
                || !is_main_label(&route.window_label)
                || route.channel.is_some()
                || route.reattaching
            {
                return Err(AppError::from(PtyError::OwnerMismatch));
            }
            session.apply_size(size)?;
            session.flow.acknowledge(sequence)?;
            route.reattaching = true;
            (
                after_snapshot(&route.buffered_events, 0),
                route.buffered_events.len(),
            )
        };

        // Phase B (no lock): the snapshot first, then the buffered events in order.
        sink.send(PtyEvent::Snapshot {
            session_id: session_id.to_string(),
            sequence,
            data: snapshot.data,
            cols: snapshot.cols,
            rows: snapshot.rows,
        })
        .map_err(|error| abort(AppError::msg(format!("发送终端画面快照失败：{error}"))))?;
        for event in backlog {
            sink.send(event)
                .map_err(|error| abort(AppError::msg(format!("恢复终端输出失败：{error}"))))?;
        }

        // Phase C: events that arrived during the replay are buffered; send them in order
        // and commit under the lock once nothing new is waiting.
        loop {
            let tail = {
                let mut guard = session
                    .route_and_handoff
                    .lock()
                    .map_err(|_| AppError::from(PtyError::LockPoisoned("PTY 事件路由")))?;
                let route = &mut guard.route;
                if route.buffered_events.len() == delivered {
                    route.buffered_events.clear();
                    route.buffered_bytes = 0;
                    route.channel = Some(sink);
                    route.mirror = None;
                    route.owner_lost = false;
                    route.reattaching = false;
                    route.epoch += 1;
                    break;
                }
                let tail = after_snapshot(&route.buffered_events, delivered);
                delivered = route.buffered_events.len();
                tail
            };
            for event in tail {
                sink.send(event)
                    .map_err(|error| abort(AppError::msg(format!("恢复终端输出失败：{error}"))))?;
            }
        }
        session.flow.resume();
        Ok(session.metadata())
    }
}
