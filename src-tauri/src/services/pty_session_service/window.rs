use std::sync::Arc;

use tauri::ipc::Channel;

use super::{
    ports::PtyEventSink,
    route::{pty_event_sequence, reclaim_event_route, session_window_status},
    to_pty_size, validate_handoff_snapshot, validate_size, PendingHandoff, PtySessionManager,
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
        self.registry.with_map(|sessions| {
            let Some(session) = sessions.get(session_id) else {
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
            let route = session
                .event_route
                .lock()
                .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
            Ok(PtySessionWindowStatusReport {
                status: session_window_status(Some(&route.window_label), window_label, false),
                owner_window_label: Some(route.window_label.clone()),
            })
        })?
    }

    pub fn reclaim_window(&self, window_label: &str) -> Vec<String> {
        if is_main_label(window_label) {
            return Vec::new();
        }
        let result = self.registry.with_map(|sessions| {
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
        });
        match result {
            Ok(reclaimed) => reclaimed,
            Err(_) => {
                log::error!(
                    "PTY session table lock poisoned while reclaiming window={window_label}"
                );
                Vec::new()
            }
        }
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
        if !is_main_label(window_label) {
            return Err(AppError::msg("只有主窗口可以重新接管终端"));
        }
        validate_handoff_snapshot(&snapshot)?;
        validate_size(size)?;
        let channel: Arc<dyn PtyEventSink> = Arc::new(channel);
        let session = self.get(session_id)?;
        let mut route = session
            .event_route
            .lock()
            .map_err(|_| AppError::msg("PTY 事件路由锁中毒"))?;
        if !route.owner_lost || !is_main_label(&route.window_label) || route.channel.is_some() {
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
}

pub(super) fn handoff_references_window(transfer: &PendingHandoff, window_label: &str) -> bool {
    transfer.source_window_label == window_label
        || transfer.target_window_label.as_deref() == Some(window_label)
}
