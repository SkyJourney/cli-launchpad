use std::{
    collections::BTreeMap,
    sync::{Condvar, Mutex},
};

use anyhow::{anyhow, Result};

pub(super) const OUTPUT_HIGH_WATERMARK: usize = 192 * 1024;
pub(super) const OUTPUT_LOW_WATERMARK: usize = 64 * 1024;
pub(super) const HANDOFF_PAUSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) struct OutputFlow {
    pub(super) state: Mutex<OutputFlowState>,
    pub(super) changed: Condvar,
}

#[derive(Default)]
pub(super) struct OutputFlowState {
    pub(super) pending_bytes: usize,
    pub(super) sent: BTreeMap<u64, usize>,
    pub(super) next_sequence: u64,
    pub(super) paused: bool,
    pub(super) pause_deadline: Option<std::time::Instant>,
    pub(super) closed: bool,
}

impl OutputFlow {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(OutputFlowState::default()),
            changed: Condvar::new(),
        }
    }

    pub(super) fn reserve(&self, bytes: usize) -> Option<u64> {
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

    pub(super) fn wait_for_capacity(&self) -> bool {
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

    pub(super) fn pause(&self) -> Result<u64> {
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

    pub(super) fn pause_indefinitely(&self) {
        if let Ok(mut state) = self.state.lock() {
            if state.closed {
                return;
            }
            state.paused = true;
            state.pause_deadline = None;
            self.changed.notify_all();
        }
    }

    pub(super) fn is_paused_at(&self, sequence: u64) -> bool {
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

    pub(super) fn resume(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.paused = false;
            state.pause_deadline = None;
            self.changed.notify_all();
        }
    }

    pub(super) fn wait_for_resume<'a>(
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

    pub(super) fn acknowledge(&self, sequence: u64) -> Result<()> {
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

    pub(super) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.changed.notify_all();
        }
    }

    pub(super) fn pending_bytes(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.pending_bytes)
            .unwrap_or(0)
    }

    pub(super) fn is_closed(&self) -> bool {
        self.state.lock().map(|state| state.closed).unwrap_or(true)
    }
}
