use std::{collections::VecDeque, sync::Arc};

use super::ports::PtyEventSink;

use crate::{
    models::{
        pty_session::{PtyEvent, PtySessionWindowStatus},
        window_kind::main_window_label,
    },
    AppError,
};

pub(super) const MAX_OWNER_LOST_BUFFER_BYTES: usize = 256 * 1024;

pub(super) struct EventRoute {
    pub(super) window_label: String,
    pub(super) channel: Option<Arc<dyn PtyEventSink>>,
    pub(super) mirror: Option<(String, Arc<dyn PtyEventSink>)>,
    pub(super) owner_lost: bool,
    pub(super) buffered_events: VecDeque<PtyEvent>,
    pub(super) buffered_bytes: usize,
    /// Bumped whenever the owner, the channel, the mirror or the owner-lost state changes, so a
    /// delivery that happened outside the lock can tell the route moved on.
    pub(super) epoch: u64,
    /// A reattach is replaying the backlog outside the lock; new events keep being buffered.
    pub(super) reattaching: bool,
}

pub(super) fn pty_event_buffer_size(event: &PtyEvent) -> usize {
    match event {
        PtyEvent::Output { data_base64, .. } => data_base64.len(),
        PtyEvent::Snapshot { data, .. } => data.len(),
        PtyEvent::Failed { message, .. } => message.len(),
        PtyEvent::Exited { .. } => std::mem::size_of::<PtyEvent>(),
    }
}

pub(super) fn pty_event_sequence(event: &PtyEvent) -> Option<u64> {
    match event {
        PtyEvent::Output { sequence, .. } | PtyEvent::Snapshot { sequence, .. } => Some(*sequence),
        PtyEvent::Exited { .. } | PtyEvent::Failed { .. } => None,
    }
}

pub(super) fn ensure_route_owner(route: &EventRoute, window_label: &str) -> Result<(), AppError> {
    if route.window_label != window_label {
        return Err(AppError::msg("该终端当前由另一个窗口控制"));
    }
    Ok(())
}

pub(super) fn buffer_owner_lost_event(
    route: &mut EventRoute,
    event: PtyEvent,
    size: usize,
) -> bool {
    if route.buffered_bytes.saturating_add(size) > MAX_OWNER_LOST_BUFFER_BYTES
        && matches!(event, PtyEvent::Output { .. })
    {
        return false;
    }
    route.buffered_bytes = route.buffered_bytes.saturating_add(size);
    route.buffered_events.push_back(event);
    true
}

pub(super) fn reclaim_event_route(route: &mut EventRoute, window_label: &str) -> bool {
    let had_mirror = route.mirror.is_some();
    route.mirror = route
        .mirror
        .take()
        .filter(|(label, _)| label != window_label);
    if had_mirror && route.mirror.is_none() {
        route.epoch += 1;
    }
    if route.window_label == window_label {
        route.window_label = main_window_label().to_string();
        route.channel = None;
        route.owner_lost = true;
        route.epoch += 1;
        true
    } else {
        false
    }
}

pub(super) fn session_window_status(
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
