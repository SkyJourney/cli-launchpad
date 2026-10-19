//! Explicit state machine of a PTY window handoff (m6-054).
//!
//! A handoff moves terminal control from a source window to a target window. It used to be
//! encoded in three places at once (an optional handoff record, the `paused` flag of the output
//! flow and the window label of the event route). `HandoffState` keeps the part that belongs to
//! the handoff; the pause deadline stays owned by `OutputFlow` because the output thread uses it
//! to resume on its own.
//!
//! Transitions never hold a session or a lock themselves: the caller passes `&OutputFlow` and
//! decides when to take the surrounding lock.

use crate::domain_errors::PtyError;
use std::sync::Arc;

use uuid::Uuid;

use super::{flow::OutputFlow, ports::PtyEventSink};
use crate::{
    error_codes::ErrorCode,
    models::{
        pty_session::{PtyEvent, PtyHandoff, PtyTerminalSnapshot},
        window_kind::{window_kind_of, WindowLabel},
    },
    AppError,
};

pub(super) struct Paused {
    pub(super) token: String,
    pub(super) source: String,
    pub(super) sequence: u64,
    /// The window registered at `begin` as the only one that may complete this handoff.
    pub(super) reserved_target: String,
}

pub(super) struct Staged {
    pub(super) token: String,
    pub(super) source: String,
    pub(super) sequence: u64,
    pub(super) snapshot: PtyTerminalSnapshot,
    pub(super) reserved_target: String,
}

pub(super) struct Bound {
    pub(super) token: String,
    pub(super) source: String,
    pub(super) sequence: u64,
    pub(super) snapshot: PtyTerminalSnapshot,
    pub(super) target: String,
    pub(super) sink: Arc<dyn PtyEventSink>,
}

#[derive(Default)]
pub(super) enum HandoffState {
    #[default]
    Idle,
    Paused(Paused),
    Staged(Staged),
    Bound(Bound),
}

/// What `complete` must deliver to the target window before it can be bound.
pub(super) struct CompletePlan {
    pub(super) event: PtyEvent,
}

/// Sends the plan's snapshot to the target sink. A failure is formatted exactly like the old
/// inline code.
pub(super) fn deliver_snapshot(
    plan: &CompletePlan,
    sink: &dyn PtyEventSink,
) -> Result<(), AppError> {
    sink.send(plan.event.clone())
        .map_err(|error| AppError::internal(format!("新窗口终端尚未就绪：{error}")))
}

/// Validates the target window registered by `begin_handoff`: the label must be a known window
/// and the direction must be main -> terminal window or terminal window -> main. Terminal to
/// terminal handoffs are not offered by the UI and are refused.
pub(super) fn validate_handoff_target(
    source_label: &str,
    target_label: &str,
) -> Result<(), AppError> {
    let target = WindowLabel::parse(target_label)?;
    // Exactly one side is the primary window and both sides can host a terminal view.
    let allowed = window_kind_of(source_label).is_some_and(|source| {
        source.is_pty_host()
            && target.kind().is_pty_host()
            && source.is_primary() != target.kind().is_primary()
    });
    if allowed {
        Ok(())
    } else {
        Err(AppError::coded(
            ErrorCode::WindowNotAllowed,
            "终端交接的目标窗口类别不允许",
        ))
    }
}

fn expired() -> AppError {
    AppError::from(PtyError::HandoffExpired)
}

/// A timed-out handoff is reported with the same code as an expired one (077 section 4.1).
fn timed_out() -> AppError {
    expired()
}

impl HandoffState {
    #[cfg(test)]
    pub(super) fn is_idle(&self) -> bool {
        matches!(self, Self::Idle)
    }

    /// The source window of a bound handoff; `None` in every other state.
    pub(super) fn bound_source(&self) -> Option<&str> {
        match self {
            Self::Bound(bound) => Some(bound.source.as_str()),
            _ => None,
        }
    }

    /// The source window, or the target of a bound handoff.
    pub(super) fn references_window(&self, window_label: &str) -> bool {
        match self {
            Self::Idle => false,
            Self::Paused(paused) => paused.source == window_label,
            Self::Staged(staged) => staged.source == window_label,
            Self::Bound(bound) => bound.source == window_label || bound.target == window_label,
        }
    }

    /// The window that may complete this handoff: the one registered at `begin`, or the target a
    /// bound handoff already carries (the same window).
    fn reserved_target(&self) -> Option<&str> {
        match self {
            Self::Idle => None,
            Self::Paused(paused) => Some(paused.reserved_target.as_str()),
            Self::Staged(staged) => Some(staged.reserved_target.as_str()),
            Self::Bound(bound) => Some(bound.target.as_str()),
        }
    }

    /// `(token, source, sequence)` of a handoff that is not Idle.
    fn identity(&self) -> Option<(String, String, u64)> {
        match self {
            Self::Idle => None,
            Self::Paused(paused) => {
                Some((paused.token.clone(), paused.source.clone(), paused.sequence))
            }
            Self::Staged(staged) => {
                Some((staged.token.clone(), staged.source.clone(), staged.sequence))
            }
            Self::Bound(bound) => Some((bound.token.clone(), bound.source.clone(), bound.sequence)),
        }
    }

    /// The pause lapsed (deadline passed, resumed by the output thread, or the session closed):
    /// return to Idle and make sure the output flows again.
    fn lapse(&mut self, flow: &OutputFlow) {
        *self = Self::Idle;
        flow.resume();
    }

    pub(super) fn begin(
        &mut self,
        flow: &OutputFlow,
        source: &str,
        reserved_target: &str,
    ) -> Result<PtyHandoff, AppError> {
        if let Some((_, _, sequence)) = self.identity() {
            if flow.is_paused_at(sequence) {
                return Err(AppError::from(PtyError::HandoffInProgress));
            }
            self.lapse(flow);
        }
        let sequence = flow.pause()?;
        let token = Uuid::new_v4().to_string();
        *self = Self::Paused(Paused {
            token: token.clone(),
            source: source.to_string(),
            sequence,
            reserved_target: reserved_target.to_string(),
        });
        Ok(PtyHandoff { token, sequence })
    }

    pub(super) fn stage(
        &mut self,
        flow: &OutputFlow,
        source: &str,
        token: &str,
        sequence: u64,
        snapshot: PtyTerminalSnapshot,
    ) -> Result<(), AppError> {
        let matches = self
            .identity()
            .is_some_and(|(state_token, state_source, state_sequence)| {
                state_token == token && state_source == source && state_sequence == sequence
            });
        if !matches {
            return Err(expired());
        }
        if !flow.is_paused_at(sequence) {
            self.lapse(flow);
            return Err(AppError::from(PtyError::HandoffExpired));
        }
        *self = match std::mem::take(self) {
            Self::Paused(paused) => Self::Staged(Staged {
                token: paused.token,
                source: paused.source,
                sequence: paused.sequence,
                snapshot,
                reserved_target: paused.reserved_target,
            }),
            Self::Staged(mut staged) => {
                staged.snapshot = snapshot;
                Self::Staged(staged)
            }
            Self::Bound(mut bound) => {
                bound.snapshot = snapshot;
                Self::Bound(bound)
            }
            Self::Idle => Self::Idle,
        };
        Ok(())
    }

    /// Phase 1 of complete: checks only, never changes the state (except lapse -> Idle).
    pub(super) fn check_complete(
        &mut self,
        flow: &OutputFlow,
        session_id: &str,
        target: &str,
        token: &str,
    ) -> Result<CompletePlan, AppError> {
        let Some((state_token, state_source, sequence)) = self.identity() else {
            return Err(expired());
        };
        if state_token != token {
            return Err(expired());
        }
        if state_source == target {
            return Err(AppError::coded(
                ErrorCode::PtyHandoffTargetIsSource,
                "目标窗口与源窗口相同，无法交接终端",
            ));
        }
        // Only the window registered at `begin` may complete (after the source check above, so
        // that a target equal to the source keeps its own error code).
        if self.reserved_target() != Some(target) {
            return Err(AppError::coded(
                ErrorCode::WindowNotAllowed,
                "该窗口不是此次终端交接登记的目标窗口",
            ));
        }
        if !flow.is_paused_at(sequence) {
            self.lapse(flow);
            return Err(timed_out());
        }
        match self {
            Self::Paused(_) => Err(AppError::from(PtyError::HandoffInProgress)),
            Self::Bound(_) => Err(AppError::from(PtyError::HandoffInProgress)),
            Self::Staged(staged) => Ok(CompletePlan {
                event: PtyEvent::Snapshot {
                    session_id: session_id.to_string(),
                    sequence,
                    data: staged.snapshot.data.clone(),
                    cols: staged.snapshot.cols,
                    rows: staged.snapshot.rows,
                },
            }),
            Self::Idle => Err(expired()),
        }
    }

    /// Phase 2 of complete: re-validates and moves Staged -> Bound.
    pub(super) fn bind(
        &mut self,
        flow: &OutputFlow,
        target: &str,
        token: &str,
        sink: Arc<dyn PtyEventSink>,
    ) -> Result<(), AppError> {
        let Some((state_token, _, sequence)) = self.identity() else {
            return Err(expired());
        };
        if state_token != token {
            return Err(expired());
        }
        if !flow.is_paused_at(sequence) {
            self.lapse(flow);
            return Err(timed_out());
        }
        match std::mem::take(self) {
            Self::Staged(staged) => {
                *self = Self::Bound(Bound {
                    token: staged.token,
                    source: staged.source,
                    sequence: staged.sequence,
                    snapshot: staged.snapshot,
                    target: target.to_string(),
                    sink,
                });
                Ok(())
            }
            Self::Paused(paused) => {
                *self = Self::Paused(paused);
                Err(AppError::from(PtyError::HandoffInProgress))
            }
            Self::Bound(bound) => {
                *self = Self::Bound(bound);
                Err(AppError::from(PtyError::HandoffInProgress))
            }
            Self::Idle => Err(expired()),
        }
    }

    pub(super) fn check_finalize(
        &mut self,
        flow: &OutputFlow,
        target: &str,
        token: &str,
    ) -> Result<(), AppError> {
        let sequence = match self {
            Self::Bound(bound) if bound.token == token && bound.target == target => bound.sequence,
            _ => return Err(AppError::from(PtyError::HandoffExpired)),
        };
        if !flow.is_paused_at(sequence) {
            self.lapse(flow);
            return Err(timed_out());
        }
        Ok(())
    }

    /// Takes the bound payload and returns to Idle; any other state is left untouched.
    pub(super) fn commit_finalize(&mut self) -> Option<Bound> {
        match std::mem::take(self) {
            Self::Bound(bound) => Some(bound),
            other => {
                *self = other;
                None
            }
        }
    }

    pub(super) fn cancel(
        &mut self,
        flow: &OutputFlow,
        source: &str,
        token: &str,
    ) -> Result<(), AppError> {
        let Some((state_token, state_source, _)) = self.identity() else {
            return Ok(());
        };
        if state_token != token || state_source != source {
            return Err(AppError::from(PtyError::HandoffExpired));
        }
        self.lapse(flow);
        Ok(())
    }

    /// Returns to Idle when the window is the registered target of a handoff that has not been
    /// completed yet (a completed one is covered by `clear_for_window`). The caller resumes the
    /// output like for any other cleared handoff.
    pub(super) fn clear_for_reserved_target(&mut self, window_label: &str) -> bool {
        let reserved = match self {
            Self::Paused(paused) => paused.reserved_target == window_label,
            Self::Staged(staged) => staged.reserved_target == window_label,
            Self::Idle | Self::Bound(_) => false,
        };
        if reserved {
            *self = Self::Idle;
        }
        reserved
    }

    /// Returns to Idle when the handoff references the window. It does not touch the flow; the
    /// caller decides based on the route.
    pub(super) fn clear_for_window(&mut self, window_label: &str) -> bool {
        if self.references_window(window_label) {
            *self = Self::Idle;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::services::pty_session_service::test_support::FakeSink;

    const SRC: &str = "main";
    const TGT: &str = "terminal-11111111-1111-4111-8111-111111111111";
    const OTHER: &str = "terminal-22222222-2222-4222-8222-222222222222";
    const THIRD: &str = "terminal-33333333-3333-4333-8333-333333333333";
    const SESSION: &str = "session-under-test";

    fn snap(label: &str) -> PtyTerminalSnapshot {
        PtyTerminalSnapshot {
            data: label.to_string(),
            cols: 80,
            rows: 24,
        }
    }

    /// Makes the pause deadline pass, the same way RS-T16 case 10 does.
    fn lapse(flow: &OutputFlow) {
        flow.state.lock().unwrap().pause_deadline = Some(Instant::now() - Duration::from_millis(1));
    }

    fn flow_paused(flow: &OutputFlow) -> bool {
        flow.state.lock().unwrap().paused
    }

    /// `code` and `message` of an error, for substring checks.
    fn describe(error: &AppError) -> String {
        let value = serde_json::to_value(error).unwrap();
        format!(
            "{} {}",
            value["code"].as_str().unwrap_or(""),
            value["message"].as_str().unwrap_or("")
        )
    }

    /// `complete_handoff` at state-machine level: both checks, the delivery, then the binding.
    fn complete_all(
        state: &mut HandoffState,
        flow: &OutputFlow,
        target: &str,
        token: &str,
        sink: &Arc<FakeSink>,
    ) -> Result<(), AppError> {
        let plan = state.check_complete(flow, SESSION, target, token)?;
        deliver_snapshot(&plan, sink.as_ref())?;
        state.bind(flow, target, token, sink.clone())
    }

    fn begun(flow: &OutputFlow) -> (HandoffState, PtyHandoff) {
        let mut state = HandoffState::default();
        let handoff = state.begin(flow, SRC, TGT).unwrap();
        (state, handoff)
    }

    fn staged(flow: &OutputFlow) -> (HandoffState, PtyHandoff) {
        let (mut state, handoff) = begun(flow);
        state
            .stage(flow, SRC, &handoff.token, handoff.sequence, snap("A"))
            .unwrap();
        (state, handoff)
    }

    fn bound(flow: &OutputFlow, sink: &Arc<FakeSink>) -> (HandoffState, PtyHandoff) {
        let (mut state, handoff) = staged(flow);
        complete_all(&mut state, flow, TGT, &handoff.token, sink).unwrap();
        (state, handoff)
    }

    #[test]
    fn begin_from_idle_pauses_the_flow_and_returns_a_fresh_token() {
        let flow = OutputFlow::new();
        flow.reserve(1).unwrap();
        flow.reserve(1).unwrap();
        let mut state = HandoffState::default();

        let handoff = state.begin(&flow, SRC, TGT).unwrap();

        assert_eq!(handoff.sequence, 2);
        Uuid::parse_str(&handoff.token).expect("the token is a UUID");
        assert!(!state.is_idle());
        assert!(flow_paused(&flow));

        // Reverse: a flow that is already paused indefinitely, or closed, rejects `begin`.
        let busy = OutputFlow::new();
        busy.pause_indefinitely();
        let mut idle = HandoffState::default();
        let error = idle.begin(&busy, SRC, TGT).unwrap_err();
        assert!(describe(&error).contains("正在进行其他窗口交接"));
        assert!(idle.is_idle());

        let closed = OutputFlow::new();
        closed.close();
        let mut idle = HandoffState::default();
        let error = idle.begin(&closed, SRC, TGT).unwrap_err();
        assert!(describe(&error).contains("已经结束"));
        assert!(idle.is_idle());
    }

    #[test]
    fn begin_while_a_live_handoff_exists_is_rejected_and_keeps_the_state() {
        let sink = Arc::new(FakeSink::new());
        for stage in ["paused", "staged", "bound"] {
            let flow = OutputFlow::new();
            let (mut state, _handoff) = match stage {
                "paused" => begun(&flow),
                "staged" => staged(&flow),
                _ => bound(&flow, &sink),
            };

            let error = state.begin(&flow, SRC, TGT).unwrap_err();

            assert!(
                describe(&error)
                    .contains("pty.handoff_in_progress 终端正在进行窗口交接，请稍后重试"),
                "{stage}"
            );
            assert!(state.references_window(SRC), "{stage}");
            assert!(flow_paused(&flow), "{stage}");
            assert!(!state.is_idle(), "{stage}");
            assert_eq!(state.bound_source().is_some(), stage == "bound", "{stage}");
            if stage == "bound" {
                assert_eq!(state.bound_source(), Some(SRC));
            }
        }
        // Reverse: from Idle the same call succeeds.
        let flow = OutputFlow::new();
        assert!(HandoffState::default().begin(&flow, SRC, TGT).is_ok());
    }

    #[test]
    fn begin_after_the_pause_lapsed_replaces_the_stale_handoff() {
        let flow = OutputFlow::new();
        let (mut state, first) = begun(&flow);
        lapse(&flow);

        let second = state.begin(&flow, SRC, TGT).unwrap();

        assert_ne!(second.token, first.token);
        let error = state
            .stage(&flow, SRC, &first.token, first.sequence, snap("x"))
            .unwrap_err();
        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期"));
        state
            .stage(&flow, SRC, &second.token, second.sequence, snap("x"))
            .unwrap();
        let guard = flow.state.lock().unwrap();
        assert!(guard.paused);
        assert!(guard.pause_deadline.unwrap() > Instant::now());
    }

    #[test]
    fn stage_requires_matching_token_source_and_sequence() {
        let flow = OutputFlow::new();
        let (mut state, handoff) = begun(&flow);

        for (token, source, sequence) in [
            ("wrong-token", SRC, handoff.sequence),
            (handoff.token.as_str(), OTHER, handoff.sequence),
            (handoff.token.as_str(), SRC, handoff.sequence + 1),
        ] {
            let error = state
                .stage(&flow, source, token, sequence, snap("x"))
                .unwrap_err();
            assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期"));
        }
        // The state is still Paused: the correct call succeeds.
        state
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("x"))
            .unwrap();

        // T03: Idle.
        let mut idle = HandoffState::default();
        let error = idle
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("x"))
            .unwrap_err();
        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期"));
    }

    #[test]
    fn stage_after_expiry_returns_to_idle_and_resumes_the_flow() {
        let flow = OutputFlow::new();
        let (mut state, handoff) = begun(&flow);
        lapse(&flow);

        let error = state
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("x"))
            .unwrap_err();

        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期，请重试"));
        assert!(state.is_idle());
        assert!(!flow_paused(&flow));

        // Reverse: without the lapse the same call succeeds.
        let live = OutputFlow::new();
        let (mut state, handoff) = begun(&live);
        assert!(state
            .stage(&live, SRC, &handoff.token, handoff.sequence, snap("x"))
            .is_ok());
    }

    #[test]
    fn restaging_overwrites_the_snapshot_while_staged_or_bound() {
        let flow = OutputFlow::new();
        let sink = Arc::new(FakeSink::new());
        let (mut state, handoff) = begun(&flow);
        state
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("A"))
            .unwrap();
        state
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("B"))
            .unwrap();

        complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap();

        let events = sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            PtyEvent::Snapshot { data, .. } => assert_eq!(data, "B"),
            other => panic!("expected a snapshot, got {other:?}"),
        }

        // Bound: staging again keeps the binding and replaces the snapshot only.
        state
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("C"))
            .unwrap();
        assert_eq!(state.bound_source(), Some(SRC));
        let committed = state.commit_finalize().expect("still bound");
        assert_eq!(committed.snapshot.data, "C");
        assert_eq!(committed.target, TGT);
    }

    #[test]
    fn complete_checks_run_in_the_documented_order() {
        // S1: Idle.
        let flow = OutputFlow::new();
        let sink = Arc::new(FakeSink::new());
        let mut state = HandoffState::default();
        let error = complete_all(&mut state, &flow, TGT, "any", &sink).unwrap_err();
        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期"));

        // S2: wrong token.
        let flow = OutputFlow::new();
        let (mut state, _handoff) = begun(&flow);
        let error = complete_all(&mut state, &flow, TGT, "wrong", &sink).unwrap_err();
        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期"));

        // S3: the target equals the source; checked before the expiry.
        let flow = OutputFlow::new();
        let (mut state, handoff) = begun(&flow);
        let error = complete_all(&mut state, &flow, SRC, &handoff.token, &sink).unwrap_err();
        let text = describe(&error);
        assert!(text.contains("pty.handoff_target_is_source"), "{text}");
        assert!(text.contains("目标窗口与源窗口相同"), "{text}");
        assert!(flow_paused(&flow));
        state
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("x"))
            .expect("the state is still Paused");

        // S4: lapsed.
        let flow = OutputFlow::new();
        let (mut state, handoff) = begun(&flow);
        lapse(&flow);
        let error = complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap_err();
        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期，请重试"));
        assert!(state.is_idle());
        assert!(!flow_paused(&flow));

        // S5: Paused, live: the snapshot is not ready.
        let flow = OutputFlow::new();
        let (mut state, handoff) = begun(&flow);
        let error = complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap_err();
        assert!(
            describe(&error).contains("pty.handoff_in_progress 终端正在进行窗口交接，请稍后重试")
        );
        state
            .stage(&flow, SRC, &handoff.token, handoff.sequence, snap("x"))
            .expect("the state is still Paused");

        // S6: Staged, the delivery fails; S7: then it succeeds.
        let flow = OutputFlow::new();
        let sink = Arc::new(FakeSink::new());
        let (mut state, handoff) = staged(&flow);
        sink.fail_next_with("closed");
        let error = complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap_err();
        assert!(describe(&error).contains("新窗口终端尚未就绪：closed"));
        assert!(sink.events().is_empty());
        assert_eq!(state.bound_source(), None, "still Staged");
        complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap();
        let events = sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            PtyEvent::Snapshot {
                session_id,
                sequence,
                data,
                cols,
                rows,
            } => {
                assert_eq!(session_id, SESSION);
                assert_eq!(*sequence, handoff.sequence);
                assert_eq!(data, "A");
                assert_eq!((*cols, *rows), (80, 24));
            }
            other => panic!("expected a snapshot, got {other:?}"),
        }

        // S8: Bound: a second complete is rejected and sends nothing.
        let error = complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap_err();
        assert!(
            describe(&error).contains("pty.handoff_in_progress 终端正在进行窗口交接，请稍后重试")
        );
        assert_eq!(state.bound_source(), Some(SRC));
        assert_eq!(sink.events().len(), 1);
    }

    #[test]
    fn complete_after_expiry_returns_to_idle_and_resumes_the_flow() {
        let flow = OutputFlow::new();
        let sink = Arc::new(FakeSink::new());
        let (mut state, handoff) = staged(&flow);
        lapse(&flow);

        let error = complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap_err();

        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期，请重试"));
        assert!(state.is_idle());
        assert!(!flow_paused(&flow));
        assert!(sink.events().is_empty());
        // Cleaned: a second call reports the handoff as gone (it used to time out again).
        let error = complete_all(&mut state, &flow, TGT, &handoff.token, &sink).unwrap_err();
        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期"));
    }

    #[test]
    fn check_finalize_requires_a_bound_target_matching_the_token() {
        let sink = Arc::new(FakeSink::new());
        // Idle, Paused and Staged cannot be finalized.
        let mut idle = HandoffState::default();
        let paused_flow = OutputFlow::new();
        let (mut paused, paused_handoff) = begun(&paused_flow);
        let staged_flow = OutputFlow::new();
        let (mut staged_state, staged_handoff) = staged(&staged_flow);
        let idle_flow = OutputFlow::new();
        for (state, flow, token) in [
            (&mut idle, &idle_flow, "any"),
            (&mut paused, &paused_flow, paused_handoff.token.as_str()),
            (
                &mut staged_state,
                &staged_flow,
                staged_handoff.token.as_str(),
            ),
        ] {
            let paused_before = flow_paused(flow);
            let error = state.check_finalize(flow, TGT, token).unwrap_err();
            assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期，请重试"));
            assert_eq!(flow_paused(flow), paused_before, "the flow is left alone");
        }

        let flow = OutputFlow::new();
        let (mut state, handoff) = bound(&flow, &sink);
        for (target, token) in [(TGT, "wrong"), (SRC, handoff.token.as_str())] {
            let error = state.check_finalize(&flow, target, token).unwrap_err();
            assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期，请重试"));
            assert_eq!(state.bound_source(), Some(SRC));
        }
        state.check_finalize(&flow, TGT, &handoff.token).unwrap();
        assert_eq!(state.bound_source(), Some(SRC));
        assert!(flow_paused(&flow));
    }

    #[test]
    fn finalize_after_expiry_returns_to_idle_and_resumes_the_flow() {
        let sink = Arc::new(FakeSink::new());
        let flow = OutputFlow::new();
        let (mut state, handoff) = bound(&flow, &sink);
        lapse(&flow);

        let error = state
            .check_finalize(&flow, TGT, &handoff.token)
            .unwrap_err();

        assert!(describe(&error).contains("pty.handoff_expired 终端窗口交接已过期，请重试"));
        assert!(state.is_idle());
        assert!(!flow_paused(&flow));
        assert!(state.commit_finalize().is_none());
    }

    #[test]
    fn cancel_matrix_matches_the_design() {
        let sink = Arc::new(FakeSink::new());
        // Idle: every call is Ok and leaves the flow alone.
        for (source, token) in [(SRC, "any"), (OTHER, "other")] {
            let flow = OutputFlow::new();
            let mut state = HandoffState::default();
            assert!(state.cancel(&flow, source, token).is_ok());
            assert!(state.is_idle());
            assert!(!flow_paused(&flow));
        }
        for stage in ["paused", "staged", "bound"] {
            for lapsed in [false, true] {
                for variant in ["correct", "bad-token", "bad-source"] {
                    let flow = OutputFlow::new();
                    let (mut state, handoff) = match stage {
                        "paused" => begun(&flow),
                        "staged" => staged(&flow),
                        _ => bound(&flow, &sink),
                    };
                    if lapsed {
                        lapse(&flow);
                    }
                    let (source, token) = match variant {
                        "correct" => (SRC, handoff.token.clone()),
                        "bad-token" => (SRC, "wrong".to_string()),
                        _ => (OTHER, handoff.token.clone()),
                    };
                    let label = format!("{stage} lapsed={lapsed} {variant}");

                    let result = state.cancel(&flow, source, &token);

                    if variant == "correct" {
                        assert!(result.is_ok(), "{label}");
                        assert!(state.is_idle(), "{label}");
                        assert!(!flow_paused(&flow), "{label}");
                    } else {
                        let error = result.unwrap_err();
                        assert!(
                            describe(&error)
                                .contains("pty.handoff_expired 终端窗口交接已过期，请重试"),
                            "{label}"
                        );
                        // No expiry pre-processing: the state and the flow are unchanged.
                        assert!(!state.is_idle(), "{label}");
                        assert!(flow_paused(&flow), "{label}");
                    }
                }
            }
        }
    }

    #[test]
    fn clear_for_window_matches_source_or_bound_target_only() {
        let sink = Arc::new(FakeSink::new());
        let make = |stage: &str| -> HandoffState {
            let flow = OutputFlow::new();
            match stage {
                "paused" => begun(&flow).0,
                "staged" => staged(&flow).0,
                _ => bound(&flow, &sink).0,
            }
        };

        for stage in ["paused", "staged", "bound"] {
            let mut state = make(stage);
            assert!(state.references_window(SRC), "{stage}");
            assert!(
                !state.is_idle(),
                "references_window must not change the state"
            );
            assert!(state.clear_for_window(SRC), "{stage}");
            assert!(state.is_idle(), "{stage}");
        }
        // The target only counts once bound.
        for (stage, expected) in [("paused", false), ("staged", false), ("bound", true)] {
            let mut state = make(stage);
            assert_eq!(state.references_window(TGT), expected, "{stage}");
            assert_eq!(state.clear_for_window(TGT), expected, "{stage}");
            assert_eq!(state.is_idle(), expected, "{stage}");
        }
        for stage in ["paused", "staged", "bound"] {
            let mut state = make(stage);
            assert!(!state.references_window(THIRD), "{stage}");
            assert!(!state.clear_for_window(THIRD), "{stage}");
            assert!(!state.is_idle(), "{stage}");
            assert_eq!(state.bound_source().is_some(), stage == "bound", "{stage}");
        }
        let mut idle = HandoffState::default();
        assert!(!idle.references_window(SRC));
        assert!(!idle.clear_for_window(SRC));
        assert!(idle.bound_source().is_none());
    }

    // ---- H13: every cell of the design's transition table.

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Kind {
        Idle,
        Paused,
        Staged,
        Bound,
    }

    fn kind(state: &HandoffState) -> Kind {
        match state {
            HandoffState::Idle => Kind::Idle,
            HandoffState::Paused(_) => Kind::Paused,
            HandoffState::Staged(_) => Kind::Staged,
            HandoffState::Bound(_) => Kind::Bound,
        }
    }

    type Start = fn(&OutputFlow, &Arc<FakeSink>) -> (HandoffState, PtyHandoff);
    type Event =
        fn(&mut HandoffState, &OutputFlow, &Arc<FakeSink>, &PtyHandoff) -> Result<(), AppError>;

    struct Case {
        id: &'static str,
        start: Start,
        lapse: bool,
        event: Event,
        /// `Ok(())`, or a fragment of "<code> <message>".
        expect: Result<(), &'static str>,
        kind: Kind,
        paused: bool,
    }

    fn dummy() -> PtyHandoff {
        PtyHandoff {
            token: "no-token".to_string(),
            sequence: 0,
        }
    }

    fn s_idle(_: &OutputFlow, _: &Arc<FakeSink>) -> (HandoffState, PtyHandoff) {
        (HandoffState::default(), dummy())
    }
    fn s_idle_busy(flow: &OutputFlow, _: &Arc<FakeSink>) -> (HandoffState, PtyHandoff) {
        flow.pause_indefinitely();
        (HandoffState::default(), dummy())
    }
    fn s_idle_closed(flow: &OutputFlow, _: &Arc<FakeSink>) -> (HandoffState, PtyHandoff) {
        flow.close();
        (HandoffState::default(), dummy())
    }
    fn s_paused(flow: &OutputFlow, _: &Arc<FakeSink>) -> (HandoffState, PtyHandoff) {
        begun(flow)
    }
    fn s_staged(flow: &OutputFlow, _: &Arc<FakeSink>) -> (HandoffState, PtyHandoff) {
        staged(flow)
    }
    fn s_bound(flow: &OutputFlow, sink: &Arc<FakeSink>) -> (HandoffState, PtyHandoff) {
        bound(flow, sink)
    }

    fn e_begin(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        _: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.begin(f, SRC, TGT).map(|_| ())
    }
    fn e_stage_ok(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.stage(f, SRC, &h.token, h.sequence, snap("N"))
    }
    fn e_stage_bad_token(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.stage(f, SRC, "wrong", h.sequence, snap("N"))
    }
    fn e_stage_bad_source(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.stage(f, OTHER, &h.token, h.sequence, snap("N"))
    }
    fn e_stage_bad_sequence(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.stage(f, SRC, &h.token, h.sequence + 1, snap("N"))
    }
    fn e_check_complete_ok(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.check_complete(f, SESSION, TGT, &h.token).map(|_| ())
    }
    fn e_check_complete_bad_token(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        _: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.check_complete(f, SESSION, TGT, "wrong").map(|_| ())
    }
    fn e_check_complete_same(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.check_complete(f, SESSION, SRC, &h.token).map(|_| ())
    }
    fn e_check_complete_bad_token_same(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        _: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.check_complete(f, SESSION, SRC, "wrong").map(|_| ())
    }
    fn e_deliver_fails(
        s: &mut HandoffState,
        f: &OutputFlow,
        sink: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        let plan = s.check_complete(f, SESSION, TGT, &h.token)?;
        sink.fail_next_with("closed");
        deliver_snapshot(&plan, sink.as_ref())
    }
    fn e_bind_ok(
        s: &mut HandoffState,
        f: &OutputFlow,
        sink: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.bind(f, TGT, &h.token, sink.clone())
    }
    fn e_bind_bad_token(
        s: &mut HandoffState,
        f: &OutputFlow,
        sink: &Arc<FakeSink>,
        _: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.bind(f, TGT, "wrong", sink.clone())
    }
    fn e_check_finalize_ok(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.check_finalize(f, TGT, &h.token)
    }
    fn e_check_finalize_bad_token(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        _: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.check_finalize(f, TGT, "wrong")
    }
    fn e_check_finalize_bad_target(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.check_finalize(f, OTHER, &h.token)
    }
    fn e_commit_finalize(
        s: &mut HandoffState,
        _: &OutputFlow,
        _: &Arc<FakeSink>,
        _: &PtyHandoff,
    ) -> Result<(), AppError> {
        match s.commit_finalize() {
            Some(_) => Ok(()),
            None => Err(AppError::internal("none")),
        }
    }
    fn e_cancel_ok(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.cancel(f, SRC, &h.token)
    }
    fn e_cancel_bad_token(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        _: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.cancel(f, SRC, "wrong")
    }
    fn e_cancel_bad_source(
        s: &mut HandoffState,
        f: &OutputFlow,
        _: &Arc<FakeSink>,
        h: &PtyHandoff,
    ) -> Result<(), AppError> {
        s.cancel(f, OTHER, &h.token)
    }

    const EXPIRED: &str = "pty.handoff_expired 终端窗口交接已过期";
    const TIMED_OUT: &str = "pty.handoff_expired 终端窗口交接已过期，请重试";
    const RESUMED: &str = "pty.handoff_expired 终端窗口交接已过期，请重试";
    const IN_PROGRESS: &str = "pty.handoff_in_progress 终端正在进行窗口交接，请稍后重试";
    const NOT_READY: &str = "pty.handoff_in_progress 终端正在进行窗口交接，请稍后重试";
    const ALREADY_BOUND: &str = "pty.handoff_in_progress 终端正在进行窗口交接，请稍后重试";
    const FINALIZE_INVALID: &str = "pty.handoff_expired 终端窗口交接已过期，请重试";
    const BAD_TOKEN: &str = "pty.handoff_expired 终端窗口交接已过期，请重试";

    macro_rules! case {
        ($id:literal, $start:expr, $lapse:expr, $event:expr, $expect:expr, $kind:expr, $paused:expr) => {
            Case {
                id: $id,
                start: $start,
                lapse: $lapse,
                event: $event,
                expect: $expect,
                kind: $kind,
                paused: $paused,
            }
        };
    }

    use Kind::{Bound as KBound, Idle as KIdle, Paused as KPaused, Staged as KStaged};

    static CASES: &[Case] = &[
        // T01, T02
        case!("T01", s_idle, false, e_begin, Ok(()), KPaused, true),
        case!(
            "T02-busy",
            s_idle_busy,
            false,
            e_begin,
            Err("正在进行其他窗口交接"),
            KIdle,
            true
        ),
        case!(
            "T02-closed",
            s_idle_closed,
            false,
            e_begin,
            Err("已经结束"),
            KIdle,
            false
        ),
        // T03 - T06: Idle
        case!("T03", s_idle, false, e_stage_ok, Err(EXPIRED), KIdle, false),
        case!(
            "T04",
            s_idle,
            false,
            e_check_complete_ok,
            Err(EXPIRED),
            KIdle,
            false
        ),
        case!(
            "T05",
            s_idle,
            false,
            e_check_finalize_ok,
            Err(FINALIZE_INVALID),
            KIdle,
            false
        ),
        case!("T06", s_idle, false, e_cancel_ok, Ok(()), KIdle, false),
        // T07: begin while live
        case!(
            "T07-paused",
            s_paused,
            false,
            e_begin,
            Err(IN_PROGRESS),
            KPaused,
            true
        ),
        case!(
            "T07-staged",
            s_staged,
            false,
            e_begin,
            Err(IN_PROGRESS),
            KStaged,
            true
        ),
        case!(
            "T07-bound",
            s_bound,
            false,
            e_begin,
            Err(IN_PROGRESS),
            KBound,
            true
        ),
        // T08: begin after the lapse replaces the stale handoff
        case!("T08-paused", s_paused, true, e_begin, Ok(()), KPaused, true),
        case!("T08-staged", s_staged, true, e_begin, Ok(()), KPaused, true),
        case!("T08-bound", s_bound, true, e_begin, Ok(()), KPaused, true),
        // T09
        case!("T09", s_paused, false, e_stage_ok, Ok(()), KStaged, true),
        // T10: stage mismatch
        case!(
            "T10-paused-token",
            s_paused,
            false,
            e_stage_bad_token,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T10-paused-source",
            s_paused,
            false,
            e_stage_bad_source,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T10-paused-sequence",
            s_paused,
            false,
            e_stage_bad_sequence,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T10-staged-token",
            s_staged,
            false,
            e_stage_bad_token,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T10-staged-source",
            s_staged,
            false,
            e_stage_bad_source,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T10-staged-sequence",
            s_staged,
            false,
            e_stage_bad_sequence,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T10-bound-token",
            s_bound,
            false,
            e_stage_bad_token,
            Err(EXPIRED),
            KBound,
            true
        ),
        case!(
            "T10-bound-source",
            s_bound,
            false,
            e_stage_bad_source,
            Err(EXPIRED),
            KBound,
            true
        ),
        case!(
            "T10-bound-sequence",
            s_bound,
            false,
            e_stage_bad_sequence,
            Err(EXPIRED),
            KBound,
            true
        ),
        // T11: stage after the lapse
        case!(
            "T11-paused",
            s_paused,
            true,
            e_stage_ok,
            Err(RESUMED),
            KIdle,
            false
        ),
        case!(
            "T11-staged",
            s_staged,
            true,
            e_stage_ok,
            Err(RESUMED),
            KIdle,
            false
        ),
        case!(
            "T11-bound",
            s_bound,
            true,
            e_stage_ok,
            Err(RESUMED),
            KIdle,
            false
        ),
        // T12, T13
        case!("T12", s_staged, false, e_stage_ok, Ok(()), KStaged, true),
        case!("T13", s_bound, false, e_stage_ok, Ok(()), KBound, true),
        // T14: check_complete with a wrong token
        case!(
            "T14-paused",
            s_paused,
            false,
            e_check_complete_bad_token,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T14-staged",
            s_staged,
            false,
            e_check_complete_bad_token,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T14-bound",
            s_bound,
            false,
            e_check_complete_bad_token,
            Err(EXPIRED),
            KBound,
            true
        ),
        // T15: the target equals the source, live and lapsed (checked before the expiry)
        case!(
            "T15-paused",
            s_paused,
            false,
            e_check_complete_same,
            Err("pty.handoff_target_is_source"),
            KPaused,
            true
        ),
        case!(
            "T15-staged",
            s_staged,
            false,
            e_check_complete_same,
            Err("pty.handoff_target_is_source"),
            KStaged,
            true
        ),
        case!(
            "T15-bound",
            s_bound,
            false,
            e_check_complete_same,
            Err("pty.handoff_target_is_source"),
            KBound,
            true
        ),
        case!(
            "T15-paused-lapsed",
            s_paused,
            true,
            e_check_complete_same,
            Err("pty.handoff_target_is_source"),
            KPaused,
            true
        ),
        case!(
            "T15-staged-lapsed",
            s_staged,
            true,
            e_check_complete_same,
            Err("pty.handoff_target_is_source"),
            KStaged,
            true
        ),
        case!(
            "T15-bound-lapsed",
            s_bound,
            true,
            e_check_complete_same,
            Err("pty.handoff_target_is_source"),
            KBound,
            true
        ),
        // T16: lapsed
        case!(
            "T16-paused",
            s_paused,
            true,
            e_check_complete_ok,
            Err(TIMED_OUT),
            KIdle,
            false
        ),
        case!(
            "T16-staged",
            s_staged,
            true,
            e_check_complete_ok,
            Err(TIMED_OUT),
            KIdle,
            false
        ),
        case!(
            "T16-bound",
            s_bound,
            true,
            e_check_complete_ok,
            Err(TIMED_OUT),
            KIdle,
            false
        ),
        // T17 - T20
        case!(
            "T17",
            s_paused,
            false,
            e_check_complete_ok,
            Err(NOT_READY),
            KPaused,
            true
        ),
        case!(
            "T18",
            s_bound,
            false,
            e_check_complete_ok,
            Err(ALREADY_BOUND),
            KBound,
            true
        ),
        case!(
            "T19",
            s_staged,
            false,
            e_check_complete_ok,
            Ok(()),
            KStaged,
            true
        ),
        case!(
            "T20",
            s_staged,
            false,
            e_deliver_fails,
            Err("新窗口终端尚未就绪：closed"),
            KStaged,
            true
        ),
        // T20a - T20e: bind
        case!("T20a", s_staged, false, e_bind_ok, Ok(()), KBound, true),
        case!(
            "T20b",
            s_bound,
            false,
            e_bind_ok,
            Err(ALREADY_BOUND),
            KBound,
            true
        ),
        case!(
            "T20c-idle",
            s_idle,
            false,
            e_bind_ok,
            Err(EXPIRED),
            KIdle,
            false
        ),
        case!(
            "T20c-paused",
            s_paused,
            false,
            e_bind_bad_token,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T20c-staged",
            s_staged,
            false,
            e_bind_bad_token,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T20c-bound",
            s_bound,
            false,
            e_bind_bad_token,
            Err(EXPIRED),
            KBound,
            true
        ),
        case!(
            "T20d-paused",
            s_paused,
            true,
            e_bind_ok,
            Err(TIMED_OUT),
            KIdle,
            false
        ),
        case!(
            "T20d-staged",
            s_staged,
            true,
            e_bind_ok,
            Err(TIMED_OUT),
            KIdle,
            false
        ),
        case!(
            "T20d-bound",
            s_bound,
            true,
            e_bind_ok,
            Err(TIMED_OUT),
            KIdle,
            false
        ),
        case!(
            "T20e",
            s_paused,
            false,
            e_bind_ok,
            Err(NOT_READY),
            KPaused,
            true
        ),
        // T21 - T24: check_finalize
        case!(
            "T21-paused",
            s_paused,
            false,
            e_check_finalize_ok,
            Err(FINALIZE_INVALID),
            KPaused,
            true
        ),
        case!(
            "T21-staged",
            s_staged,
            false,
            e_check_finalize_ok,
            Err(FINALIZE_INVALID),
            KStaged,
            true
        ),
        case!(
            "T22-token",
            s_bound,
            false,
            e_check_finalize_bad_token,
            Err(FINALIZE_INVALID),
            KBound,
            true
        ),
        case!(
            "T22-target",
            s_bound,
            false,
            e_check_finalize_bad_target,
            Err(FINALIZE_INVALID),
            KBound,
            true
        ),
        case!(
            "T23",
            s_bound,
            true,
            e_check_finalize_ok,
            Err(TIMED_OUT),
            KIdle,
            false
        ),
        case!(
            "T24",
            s_bound,
            false,
            e_check_finalize_ok,
            Ok(()),
            KBound,
            true
        ),
        // T25, T26: commit_finalize
        case!(
            "T25",
            s_bound,
            false,
            e_commit_finalize,
            Ok(()),
            KIdle,
            true
        ),
        case!(
            "T26-idle",
            s_idle,
            false,
            e_commit_finalize,
            Err("none"),
            KIdle,
            false
        ),
        case!(
            "T26-paused",
            s_paused,
            false,
            e_commit_finalize,
            Err("none"),
            KPaused,
            true
        ),
        case!(
            "T26-staged",
            s_staged,
            false,
            e_commit_finalize,
            Err("none"),
            KStaged,
            true
        ),
        // T27: cancel matches, live and lapsed
        case!(
            "T27-paused-live",
            s_paused,
            false,
            e_cancel_ok,
            Ok(()),
            KIdle,
            false
        ),
        case!(
            "T27-staged-live",
            s_staged,
            false,
            e_cancel_ok,
            Ok(()),
            KIdle,
            false
        ),
        case!(
            "T27-bound-live",
            s_bound,
            false,
            e_cancel_ok,
            Ok(()),
            KIdle,
            false
        ),
        case!(
            "T27-paused-lapsed",
            s_paused,
            true,
            e_cancel_ok,
            Ok(()),
            KIdle,
            false
        ),
        case!(
            "T27-staged-lapsed",
            s_staged,
            true,
            e_cancel_ok,
            Ok(()),
            KIdle,
            false
        ),
        case!(
            "T27-bound-lapsed",
            s_bound,
            true,
            e_cancel_ok,
            Ok(()),
            KIdle,
            false
        ),
        // T28: cancel mismatch, live and lapsed (no expiry pre-processing)
        case!(
            "T28-paused-token-live",
            s_paused,
            false,
            e_cancel_bad_token,
            Err(BAD_TOKEN),
            KPaused,
            true
        ),
        case!(
            "T28-staged-token-live",
            s_staged,
            false,
            e_cancel_bad_token,
            Err(BAD_TOKEN),
            KStaged,
            true
        ),
        case!(
            "T28-bound-token-live",
            s_bound,
            false,
            e_cancel_bad_token,
            Err(BAD_TOKEN),
            KBound,
            true
        ),
        case!(
            "T28-paused-source-live",
            s_paused,
            false,
            e_cancel_bad_source,
            Err(BAD_TOKEN),
            KPaused,
            true
        ),
        case!(
            "T28-staged-source-live",
            s_staged,
            false,
            e_cancel_bad_source,
            Err(BAD_TOKEN),
            KStaged,
            true
        ),
        case!(
            "T28-bound-source-live",
            s_bound,
            false,
            e_cancel_bad_source,
            Err(BAD_TOKEN),
            KBound,
            true
        ),
        case!(
            "T28-paused-token-lapsed",
            s_paused,
            true,
            e_cancel_bad_token,
            Err(BAD_TOKEN),
            KPaused,
            true
        ),
        case!(
            "T28-staged-token-lapsed",
            s_staged,
            true,
            e_cancel_bad_token,
            Err(BAD_TOKEN),
            KStaged,
            true
        ),
        case!(
            "T28-bound-token-lapsed",
            s_bound,
            true,
            e_cancel_bad_token,
            Err(BAD_TOKEN),
            KBound,
            true
        ),
        case!(
            "T28-paused-source-lapsed",
            s_paused,
            true,
            e_cancel_bad_source,
            Err(BAD_TOKEN),
            KPaused,
            true
        ),
        case!(
            "T28-staged-source-lapsed",
            s_staged,
            true,
            e_cancel_bad_source,
            Err(BAD_TOKEN),
            KStaged,
            true
        ),
        case!(
            "T28-bound-source-lapsed",
            s_bound,
            true,
            e_cancel_bad_source,
            Err(BAD_TOKEN),
            KBound,
            true
        ),
        // Review additions: the token check precedes the expiry check, and an idle cancel
        // must not resume a flow that is paused for another reason (owner lost).
        case!(
            "T06-busy",
            s_idle_busy,
            false,
            e_cancel_ok,
            Ok(()),
            KIdle,
            true
        ),
        case!(
            "T10-paused-token-lapsed",
            s_paused,
            true,
            e_stage_bad_token,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T10-staged-token-lapsed",
            s_staged,
            true,
            e_stage_bad_token,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T10-bound-token-lapsed",
            s_bound,
            true,
            e_stage_bad_token,
            Err(EXPIRED),
            KBound,
            true
        ),
        case!(
            "T14-paused-lapsed",
            s_paused,
            true,
            e_check_complete_bad_token,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T14-staged-lapsed",
            s_staged,
            true,
            e_check_complete_bad_token,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T14-bound-lapsed",
            s_bound,
            true,
            e_check_complete_bad_token,
            Err(EXPIRED),
            KBound,
            true
        ),
        case!(
            "T14-paused-same-target",
            s_paused,
            false,
            e_check_complete_bad_token_same,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T20c-paused-lapsed",
            s_paused,
            true,
            e_bind_bad_token,
            Err(EXPIRED),
            KPaused,
            true
        ),
        case!(
            "T20c-staged-lapsed",
            s_staged,
            true,
            e_bind_bad_token,
            Err(EXPIRED),
            KStaged,
            true
        ),
        case!(
            "T20c-bound-lapsed",
            s_bound,
            true,
            e_bind_bad_token,
            Err(EXPIRED),
            KBound,
            true
        ),
    ];

    #[test]
    fn transition_table_matches_the_design() {
        assert_eq!(CASES.len(), 93);
        for case in CASES {
            let flow = OutputFlow::new();
            let sink = Arc::new(FakeSink::new());
            let (mut state, handoff) = (case.start)(&flow, &sink);
            if case.lapse {
                lapse(&flow);
            }

            let result = (case.event)(&mut state, &flow, &sink, &handoff);

            match (&result, &case.expect) {
                (Ok(()), Ok(())) => {}
                (Err(error), Err(fragment)) => {
                    let text = describe(error);
                    assert!(
                        text.contains(fragment),
                        "{}: expected {fragment:?} in {text:?}",
                        case.id
                    );
                }
                (got, want) => panic!("{}: expected {want:?}, got {got:?}", case.id),
            }
            assert_eq!(kind(&state), case.kind, "{}: new state", case.id);
            assert_eq!(flow_paused(&flow), case.paused, "{}: flow paused", case.id);
        }
    }
}
