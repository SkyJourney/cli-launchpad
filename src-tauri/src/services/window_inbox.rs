//! Per-window private inbox for Rust-originated notifications (m6-061, layer L1).
//!
//! Tauri's global event system has no confidentiality: any window can `listen` to what was
//! `emit_to`-ed to another. A `Channel` is the opposite: Rust can only write to the channel object
//! that the calling webview created. The main window therefore subscribes once through
//! `subscribe_window_inbox`, and every Rust notification is written to that channel instead of
//! being emitted.
//!
//! Messages that arrive before the subscription (the main window may still be loading) are kept
//! in a bounded buffer and flushed in order when the window subscribes. Sending never happens
//! while the registry lock is held (R-RS-1): a `flushing` flag keeps messages that arrive during
//! a flush behind the flushed ones.

use crate::error_codes::ErrorCode;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

use serde::Serialize;
use serde_json::Value;
use tauri::{ipc::Channel, Manager};

use crate::models::window_kind::{main_window_label, WindowKind, WindowLabel};
use crate::services::window_lifecycle::{AppEvent, WindowScopedResource};
use crate::AppError;

/// Maximum number of undelivered messages kept per window before the oldest is dropped.
pub const INBOX_BUFFER_LIMIT: usize = 256;

/// The window a message was relayed from (m6-062 fills it; Rust-originated messages have none).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSource {
    pub label: String,
    pub kind: WindowKind,
}

/// One message in a window's inbox. The wire shape is fixed here and consumed by
/// `src/lib/windowInbox.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxMessage {
    pub seq: u64,
    pub event: String,
    pub payload: Value,
    pub source: Option<InboxSource>,
}

/// The result of `subscribe_window_inbox`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInboxSubscription {
    pub replaced: bool,
    pub flushed: u32,
    pub dropped: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliverOutcome {
    /// Written to the window's channel.
    Sent,
    /// Kept in the buffer: the window has not subscribed yet, is being flushed, or the channel
    /// failed.
    Buffered,
    /// The window has no inbox and is not the main window: nothing was kept.
    NoInbox,
}

/// Where a window's messages go. `tauri::ipc::Channel` in production, a fake in tests.
pub trait InboxChannel: Send + Sync {
    fn send(&self, message: &InboxMessage) -> Result<(), String>;
}

impl InboxChannel for Channel<InboxMessage> {
    fn send(&self, message: &InboxMessage) -> Result<(), String> {
        Channel::<InboxMessage>::send(self, message.clone()).map_err(|error| error.to_string())
    }
}

struct WindowInbox {
    channel: Option<Arc<dyn InboxChannel>>,
    flushing: bool,
    buffer: VecDeque<InboxMessage>,
    next_seq: u64,
    dropped: u64,
}

impl WindowInbox {
    fn new() -> Self {
        Self {
            channel: None,
            flushing: false,
            buffer: VecDeque::new(),
            next_seq: 1,
            dropped: 0,
        }
    }

    fn push_buffered(&mut self, message: InboxMessage) {
        if self.buffer.len() >= INBOX_BUFFER_LIMIT {
            self.buffer.pop_front();
            self.dropped += 1;
        }
        self.buffer.push_back(message);
    }
}

#[derive(Default)]
pub struct WindowInboxRegistry {
    inboxes: Mutex<HashMap<String, WindowInbox>>,
    /// Set when the main window was released and cleared by its next subscription. A destroyed
    /// main window must not get a fresh buffer from late notifications (m6-b1920-16); it is only
    /// read and written under the `inboxes` lock.
    main_released: AtomicBool,
}

impl WindowInboxRegistry {
    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, WindowInbox>>, AppError> {
        self.inboxes
            .lock()
            .map_err(|_| AppError::coded(ErrorCode::InternalLockPoisoned, "窗口收件箱状态锁中毒"))
    }

    /// Installs `channel` as the window's inbox channel and flushes the buffered messages to it
    /// in order. A second subscription replaces the first channel.
    pub fn subscribe(
        &self,
        window: &WindowLabel,
        channel: Arc<dyn InboxChannel>,
    ) -> Result<WindowInboxSubscription, AppError> {
        let label = window.as_str().to_string();
        let (replaced, dropped) = {
            let mut inboxes = self.lock()?;
            if window.kind() == WindowKind::Main {
                self.main_released.store(false, Ordering::SeqCst);
            }
            let inbox = inboxes
                .entry(label.clone())
                .or_insert_with(WindowInbox::new);
            let replaced = inbox.channel.take().is_some();
            inbox.flushing = true;
            (replaced, inbox.dropped)
        };
        let mut flushed: u32 = 0;
        loop {
            let batch: Vec<InboxMessage> = {
                let mut inboxes = self.lock()?;
                let Some(inbox) = inboxes.get_mut(&label) else {
                    // The window was released while flushing; nothing is left to deliver.
                    break;
                };
                if inbox.buffer.is_empty() {
                    inbox.channel = Some(Arc::clone(&channel));
                    inbox.flushing = false;
                    break;
                }
                inbox.buffer.drain(..).collect()
            };
            // The registry lock is not held while sending.
            for (index, message) in batch.iter().enumerate() {
                if let Err(error) = channel.send(message) {
                    if let Ok(mut inboxes) = self.inboxes.lock() {
                        if let Some(inbox) = inboxes.get_mut(&label) {
                            for unsent in batch[index..].iter().rev() {
                                inbox.buffer.push_front(unsent.clone());
                            }
                            inbox.flushing = false;
                        }
                    }
                    return Err(AppError::internal(format!("窗口收件箱通道不可用：{error}")));
                }
                flushed += 1;
            }
        }
        Ok(WindowInboxSubscription {
            replaced,
            flushed,
            dropped,
        })
    }

    /// Writes one message to the window's inbox (or its buffer).
    pub fn deliver(
        &self,
        window: &WindowLabel,
        event: &str,
        payload: Value,
        source: Option<InboxSource>,
    ) -> DeliverOutcome {
        let (message, channel) = {
            let Ok(mut inboxes) = self.inboxes.lock() else {
                log::warn!(
                    "window inbox lock poisoned label={} event={event}",
                    window.as_str()
                );
                return DeliverOutcome::NoInbox;
            };
            if !inboxes.contains_key(window.as_str()) {
                if window.kind() != WindowKind::Main || self.main_released.load(Ordering::SeqCst) {
                    return DeliverOutcome::NoInbox;
                }
                inboxes.insert(window.as_str().to_string(), WindowInbox::new());
            }
            let Some(inbox) = inboxes.get_mut(window.as_str()) else {
                return DeliverOutcome::NoInbox;
            };
            let message = InboxMessage {
                seq: inbox.next_seq,
                event: event.to_string(),
                payload,
                source,
            };
            inbox.next_seq += 1;
            match (&inbox.channel, inbox.flushing) {
                (Some(channel), false) => (message, Arc::clone(channel)),
                _ => {
                    inbox.push_buffered(message);
                    return DeliverOutcome::Buffered;
                }
            }
        };
        // The registry lock is released here; sending never happens while it is held.
        match channel.send(&message) {
            Ok(()) => DeliverOutcome::Sent,
            Err(error) => {
                log::warn!(
                    "window inbox send failed label={} event={event} error={error}",
                    window.as_str()
                );
                if let Ok(mut inboxes) = self.inboxes.lock() {
                    if let Some(inbox) = inboxes.get_mut(window.as_str()) {
                        if inbox
                            .channel
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &channel))
                        {
                            inbox.channel = None;
                        }
                        inbox.push_buffered(message);
                    }
                }
                DeliverOutcome::Buffered
            }
        }
    }

    #[cfg(test)]
    pub fn buffered_len(&self, window: &WindowLabel) -> usize {
        self.inboxes
            .lock()
            .unwrap()
            .get(window.as_str())
            .map_or(0, |inbox| inbox.buffer.len())
    }

    #[cfg(test)]
    pub fn is_unlocked(&self) -> bool {
        self.inboxes.try_lock().is_ok()
    }
}

impl WindowScopedResource for WindowInboxRegistry {
    fn release_window(&self, window: &WindowLabel) -> Vec<AppEvent> {
        if let Ok(mut inboxes) = self.inboxes.lock() {
            inboxes.remove(window.as_str());
            if window.kind() == WindowKind::Main {
                self.main_released.store(true, Ordering::SeqCst);
            }
        }
        Vec::new()
    }
}

/// Delivers a Rust-originated notification to the main window's private inbox.
pub fn notify_main(app: &tauri::AppHandle, event: &str, payload: Value) -> DeliverOutcome {
    let Some(registry) = app.try_state::<WindowInboxRegistry>() else {
        log::warn!("window inbox registry is not managed; dropping event={event}");
        return DeliverOutcome::NoInbox;
    };
    match WindowLabel::parse(main_window_label()) {
        Ok(main) => registry.deliver(&main, event, payload, None),
        Err(error) => {
            log::warn!("main window label is invalid event={event} error={error}");
            DeliverOutcome::NoInbox
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    use serde_json::json;

    use super::*;
    use crate::models::window_kind::WindowLabel;
    use crate::services::window_lifecycle::WindowScopedResource;

    const TERMINAL: &str = "terminal-8e783338-f464-4b10-b15e-b534748c6241";

    type Hook = Arc<dyn Fn() + Send + Sync>;

    #[derive(Default)]
    struct FakeChannel {
        sent: Mutex<Vec<InboxMessage>>,
        fail: AtomicBool,
        hook: Mutex<Option<Hook>>,
    }

    impl FakeChannel {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn events(&self) -> Vec<String> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .map(|message| message.event.clone())
                .collect()
        }

        fn seqs(&self) -> Vec<u64> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .map(|message| message.seq)
                .collect()
        }
    }

    impl InboxChannel for FakeChannel {
        fn send(&self, message: &InboxMessage) -> Result<(), String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("closed".to_string());
            }
            let hook = self.hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            self.sent.lock().unwrap().push(message.clone());
            Ok(())
        }
    }

    fn main_label() -> WindowLabel {
        WindowLabel::parse("main").unwrap()
    }

    fn terminal_label() -> WindowLabel {
        WindowLabel::parse(TERMINAL).unwrap()
    }

    #[test]
    fn messages_are_buffered_until_the_window_subscribes_and_flushed_in_order() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        assert_eq!(
            registry.deliver(&main, "a", json!(1), None),
            DeliverOutcome::Buffered
        );
        assert_eq!(
            registry.deliver(&main, "b", json!(2), None),
            DeliverOutcome::Buffered
        );
        assert_eq!(registry.buffered_len(&main), 2);

        let channel = FakeChannel::new();
        let subscription = registry.subscribe(&main, channel.clone()).unwrap();

        assert_eq!(
            subscription,
            WindowInboxSubscription {
                replaced: false,
                flushed: 2,
                dropped: 0
            }
        );
        assert_eq!(channel.events(), ["a", "b"]);
        assert_eq!(registry.buffered_len(&main), 0);
        assert_eq!(
            registry.deliver(&main, "c", json!(3), None),
            DeliverOutcome::Sent
        );
        assert_eq!(channel.events(), ["a", "b", "c"]);
        assert_eq!(channel.sent.lock().unwrap().len(), 3);
    }

    #[test]
    fn buffer_is_bounded_and_drops_the_oldest_messages() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        for index in 0..(INBOX_BUFFER_LIMIT + 44) {
            registry.deliver(&main, "n", json!(index), None);
        }
        assert_eq!(registry.buffered_len(&main), INBOX_BUFFER_LIMIT);

        let channel = FakeChannel::new();
        let subscription = registry.subscribe(&main, channel.clone()).unwrap();

        assert_eq!(subscription.dropped, 44);
        assert_eq!(subscription.flushed, INBOX_BUFFER_LIMIT as u32);
        let seqs = channel.seqs();
        assert_eq!(seqs.first(), Some(&45));
        assert_eq!(seqs.last(), Some(&((INBOX_BUFFER_LIMIT + 44) as u64)));
        assert_eq!(channel.sent.lock().unwrap()[0].payload, json!(44));
        assert!(seqs.iter().all(|seq| *seq > 44));
    }

    #[test]
    fn a_second_subscription_replaces_the_first_channel() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        let first = FakeChannel::new();
        let second = FakeChannel::new();
        registry.subscribe(&main, first.clone()).unwrap();
        registry.deliver(&main, "x", json!(null), None);

        let subscription = registry.subscribe(&main, second.clone()).unwrap();

        assert!(subscription.replaced);
        assert_eq!(
            registry.deliver(&main, "y", json!(null), None),
            DeliverOutcome::Sent
        );
        assert_eq!(first.events(), ["x"]);
        assert_eq!(second.events(), ["y"]);
    }

    #[test]
    fn a_failed_send_drops_the_channel_and_keeps_the_message_buffered() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        let channel = FakeChannel::new();
        registry.subscribe(&main, channel.clone()).unwrap();
        channel.fail.store(true, Ordering::SeqCst);

        assert_eq!(
            registry.deliver(&main, "a", json!(null), None),
            DeliverOutcome::Buffered
        );
        assert_eq!(registry.buffered_len(&main), 1);
        // The channel was dropped: the next message is buffered without another attempt.
        assert_eq!(
            registry.deliver(&main, "b", json!(null), None),
            DeliverOutcome::Buffered
        );
        assert_eq!(registry.buffered_len(&main), 2);
        assert_eq!(channel.sent.lock().unwrap().len(), 0);

        channel.fail.store(false, Ordering::SeqCst);
        let subscription = registry.subscribe(&main, channel.clone()).unwrap();

        assert_eq!(subscription.flushed, 2);
        assert!(!subscription.replaced);
        assert_eq!(channel.events(), ["a", "b"]);
    }

    #[test]
    fn delivery_does_not_hold_the_registry_lock_while_sending() {
        let registry = Arc::new(WindowInboxRegistry::default());
        let main = main_label();
        let observed = Arc::new(Mutex::new(Vec::<bool>::new()));
        let channel = FakeChannel::new();
        let hook_registry = Arc::clone(&registry);
        let hook_observed = Arc::clone(&observed);
        *channel.hook.lock().unwrap() = Some(Arc::new(move || {
            hook_observed
                .lock()
                .unwrap()
                .push(hook_registry.is_unlocked());
        }));
        registry.deliver(&main, "pre", json!(null), None);

        registry.subscribe(&main, channel.clone()).unwrap();
        registry.deliver(&main, "live", json!(null), None);

        assert_eq!(*observed.lock().unwrap(), vec![true, true]);
        assert_eq!(channel.events(), ["pre", "live"]);
    }

    #[test]
    fn messages_to_a_window_without_an_inbox_are_not_buffered_except_for_main() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        let terminal = terminal_label();

        assert_eq!(
            registry.deliver(&terminal, "a", json!(null), None),
            DeliverOutcome::NoInbox
        );
        assert_eq!(registry.buffered_len(&terminal), 0);
        assert_eq!(
            registry.deliver(&main, "a", json!(null), None),
            DeliverOutcome::Buffered
        );

        let channel = FakeChannel::new();
        registry.subscribe(&terminal, channel.clone()).unwrap();
        assert_eq!(
            registry.deliver(&terminal, "b", json!(null), None),
            DeliverOutcome::Sent
        );
        assert_eq!(channel.events(), ["b"]);
    }

    #[test]
    fn release_window_removes_the_inbox_and_its_buffer() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        let terminal = terminal_label();
        registry.deliver(&main, "m", json!(null), None);
        registry.subscribe(&terminal, FakeChannel::new()).unwrap();

        // Releasing another window leaves the main buffer alone.
        assert!(registry.release_window(&terminal).is_empty());
        assert_eq!(
            registry.deliver(&terminal, "x", json!(null), None),
            DeliverOutcome::NoInbox
        );
        assert_eq!(registry.buffered_len(&main), 1);

        assert!(registry.release_window(&main).is_empty());
        assert_eq!(registry.buffered_len(&main), 0);
    }

    #[test]
    fn a_released_main_window_gets_no_new_buffer_until_it_subscribes_again() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        registry.deliver(&main, "before", json!(null), None);
        registry.release_window(&main);

        // Late notifications after the main window is gone are dropped, not re-buffered.
        assert_eq!(
            registry.deliver(&main, "late", json!(null), None),
            DeliverOutcome::NoInbox
        );
        assert_eq!(registry.buffered_len(&main), 0);

        // A new subscription clears the mark and the inbox works again.
        let channel = FakeChannel::new();
        registry.subscribe(&main, channel.clone()).unwrap();
        assert_eq!(
            registry.deliver(&main, "after", json!(null), None),
            DeliverOutcome::Sent
        );
        assert_eq!(channel.events(), ["after"]);
    }

    #[test]
    fn inbox_messages_serialize_with_camel_case_fields_and_a_stamped_source() {
        let plain = InboxMessage {
            seq: 7,
            event: "e".to_string(),
            payload: json!({ "a": 1 }),
            source: None,
        };
        let stamped = InboxMessage {
            source: Some(InboxSource {
                label: TERMINAL.to_string(),
                kind: WindowKind::Terminal,
            }),
            ..plain.clone()
        };
        let content = InboxMessage {
            source: Some(InboxSource {
                label: "workspace-content-8e783338-f464-4b10-b15e-b534748c6241".to_string(),
                kind: WindowKind::WorkspaceContent,
            }),
            ..plain.clone()
        };

        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            json!({"seq":7,"event":"e","payload":{"a":1},"source":null})
        );
        assert_eq!(
            serde_json::to_value(&stamped).unwrap(),
            json!({"seq":7,"event":"e","payload":{"a":1},"source":{"label":TERMINAL,"kind":"terminal"}})
        );
        assert_eq!(
            serde_json::to_value(&content).unwrap()["source"]["kind"],
            json!("workspaceContent")
        );
        assert_eq!(
            serde_json::to_value(WindowInboxSubscription {
                replaced: true,
                flushed: 2,
                dropped: 3
            })
            .unwrap(),
            json!({"replaced":true,"flushed":2,"dropped":3})
        );
        let keys: std::collections::BTreeSet<String> = serde_json::to_value(&plain)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(
            keys,
            ["event", "payload", "seq", "source"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
    }

    #[test]
    fn sequence_numbers_are_per_window_and_strictly_increasing() {
        let registry = WindowInboxRegistry::default();
        let main = main_label();
        let terminal = terminal_label();
        let main_channel = FakeChannel::new();
        let terminal_channel = FakeChannel::new();
        registry.subscribe(&main, main_channel.clone()).unwrap();
        registry
            .subscribe(&terminal, terminal_channel.clone())
            .unwrap();

        registry.deliver(&main, "a", json!(null), None);
        registry.deliver(&terminal, "a", json!(null), None);
        registry.deliver(&main, "b", json!(null), None);
        registry.deliver(&main, "c", json!(null), None);

        assert_eq!(main_channel.seqs(), [1, 2, 3]);
        assert_eq!(terminal_channel.seqs(), [1]);
    }

    #[test]
    fn messages_delivered_during_a_flush_stay_behind_the_flushed_ones() {
        let registry = Arc::new(WindowInboxRegistry::default());
        let main = main_label();
        registry.deliver(&main, "a", json!(null), None);
        registry.deliver(&main, "b", json!(null), None);
        let channel = FakeChannel::new();
        let late_outcome = Arc::new(Mutex::new(None::<DeliverOutcome>));
        let fired = Arc::new(AtomicBool::new(false));
        let hook_registry = Arc::clone(&registry);
        let hook_outcome = Arc::clone(&late_outcome);
        let hook_fired = Arc::clone(&fired);
        let hook_main = main.clone();
        *channel.hook.lock().unwrap() = Some(Arc::new(move || {
            if !hook_fired.swap(true, Ordering::SeqCst) {
                let outcome = hook_registry.deliver(&hook_main, "late", json!(null), None);
                *hook_outcome.lock().unwrap() = Some(outcome);
            }
        }));

        let subscription = registry.subscribe(&main, channel.clone()).unwrap();

        assert_eq!(subscription.flushed, 3);
        assert_eq!(channel.events(), ["a", "b", "late"]);
        assert_eq!(
            *late_outcome.lock().unwrap(),
            Some(DeliverOutcome::Buffered)
        );
    }

    #[test]
    fn messages_carry_the_stamped_source() {
        let registry = WindowInboxRegistry::default();
        let terminal = terminal_label();
        let channel = FakeChannel::new();
        registry.subscribe(&terminal, channel.clone()).unwrap();
        let source = InboxSource {
            label: "main".to_string(),
            kind: WindowKind::Main,
        };

        registry.deliver(&terminal, "x", json!(1), Some(source.clone()));
        registry.deliver(&terminal, "x", json!(2), None);

        let sent = channel.sent.lock().unwrap();
        assert_eq!(sent[0].source, Some(source));
        assert_eq!(sent[1].source, None);
    }
}
