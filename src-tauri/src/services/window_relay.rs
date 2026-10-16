//! Rust relay for messages between windows (m6-062, layer L2).
//!
//! Tauri events carry no verified sender, and a child window that may `emit_to` can address any
//! window. Messages between windows therefore go through `send_window_message`: Rust checks the
//! message type against `contracts/window-messages.json` (which window kinds may send it, which
//! may receive it), checks the envelope shape, and writes it to the target window's private inbox
//! with the sender stamped from the calling webview, never from the payload.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error_codes::{WINDOW_MESSAGE_TOO_LARGE, WINDOW_NOT_ALLOWED};
use crate::events::WINDOW_MESSAGE;
use crate::models::window_kind::{CallerWindow, WindowKind, WindowLabel};
use crate::services::window_inbox::{DeliverOutcome, InboxSource, WindowInboxRegistry};
use crate::AppError;

const WINDOW_MESSAGES_JSON: &str = include_str!("../../../contracts/window-messages.json");

/// Largest serialized envelope the relay accepts. A file buffer message carries at most two
/// copies of a text file (`MAX_TEXT_FILE_BYTES`, 2 MiB each) plus JSON escaping; anything
/// beyond this is a flood or a bug, not a legitimate message (m6-b1920-19).
pub const MAX_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct MessageManifest {
    messages: Vec<MessageRule>,
}

#[derive(Deserialize)]
pub struct MessageRule {
    #[serde(rename = "type")]
    pub message_type: String,
    pub from: Vec<WindowKind>,
    pub to: Vec<WindowKind>,
    #[serde(rename = "contentKind")]
    #[allow(dead_code)] // Reserved for the generic handoff events (m6-062 non-goal 3).
    pub content_kind: String,
    #[serde(rename = "payloadVersion")]
    pub payload_version: u64,
}

fn rules() -> &'static [MessageRule] {
    static RULES: OnceLock<Vec<MessageRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str::<MessageManifest>(WINDOW_MESSAGES_JSON)
            .expect("window-messages.json must be valid")
            .messages
    })
}

pub fn rule_for(message_type: &str) -> Option<&'static MessageRule> {
    rules()
        .iter()
        .find(|rule| rule.message_type == message_type)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendWindowMessageResult {
    pub delivered: bool,
}

/// Validates and delivers one window message. Every rejection returns before `deliver`.
pub fn relay(
    registry: &WindowInboxRegistry,
    caller: &CallerWindow,
    target: &str,
    message_type: &str,
    envelope: Value,
) -> Result<SendWindowMessageResult, AppError> {
    relay_within(
        registry,
        caller,
        target,
        message_type,
        envelope,
        MAX_ENVELOPE_BYTES,
    )
}

fn relay_within(
    registry: &WindowInboxRegistry,
    caller: &CallerWindow,
    target: &str,
    message_type: &str,
    envelope: Value,
    max_envelope_bytes: usize,
) -> Result<SendWindowMessageResult, AppError> {
    let rule = rule_for(message_type)
        .ok_or_else(|| AppError::coded(WINDOW_NOT_ALLOWED, "未登记的窗口消息类型"))?;
    caller.require(&rule.from)?;
    let target = WindowLabel::parse(target)?;
    if !rule.to.contains(&target.kind()) {
        return Err(AppError::coded(
            WINDOW_NOT_ALLOWED,
            "目标窗口类别不允许接收该消息",
        ));
    }
    let envelope_matches = envelope.as_object().is_some_and(|object| {
        object.get("type").and_then(Value::as_str) == Some(message_type)
            && object.get("apiVersion").and_then(Value::as_u64) == Some(rule.payload_version)
    });
    if !envelope_matches {
        return Err(AppError::coded(WINDOW_NOT_ALLOWED, "消息信封不合法"));
    }
    // Checked after the cheap rejections above; an envelope that cannot be measured is refused.
    let size = serde_json::to_vec(&envelope).map_or(usize::MAX, |bytes| bytes.len());
    if size > max_envelope_bytes {
        log::warn!(
            "window message rejected as too large type={message_type} target={} bytes={size}",
            target.as_str()
        );
        return Err(AppError::coded(
            WINDOW_MESSAGE_TOO_LARGE,
            "窗口消息超过大小上限",
        ));
    }
    let source = InboxSource {
        label: caller.label().as_str().to_string(),
        kind: caller.label().kind(),
    };
    match registry.deliver(&target, WINDOW_MESSAGE, envelope, Some(source)) {
        DeliverOutcome::Sent | DeliverOutcome::Buffered => {
            Ok(SendWindowMessageResult { delivered: true })
        }
        DeliverOutcome::NoInbox => Ok(SendWindowMessageResult { delivered: false }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use super::*;
    use crate::models::window_kind::{CallerWindow, WindowKind, WindowLabel};
    use crate::services::window_inbox::{InboxChannel, InboxMessage};

    const TERMINAL: &str = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    const OTHER_TERMINAL: &str = "terminal-3b9f2c1e-6d4a-4f7b-8a21-5c0e9d7a1b34";
    const CONTENT: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";

    #[derive(Default)]
    struct FakeChannel {
        sent: Mutex<Vec<InboxMessage>>,
    }

    impl InboxChannel for FakeChannel {
        fn send(&self, message: &InboxMessage) -> Result<(), String> {
            self.sent.lock().unwrap().push(message.clone());
            Ok(())
        }
    }

    fn envelope(message_type: &str) -> Value {
        json!({ "apiVersion": 1, "type": message_type, "payload": {} })
    }

    fn caller(label: &str) -> CallerWindow {
        CallerWindow::from_label(label).unwrap()
    }

    fn subscribed(registry: &WindowInboxRegistry, label: &str) -> Arc<FakeChannel> {
        let channel = Arc::new(FakeChannel::default());
        registry
            .subscribe(&WindowLabel::parse(label).unwrap(), channel.clone())
            .unwrap();
        channel
    }

    fn code_of(result: Result<SendWindowMessageResult, AppError>) -> String {
        let error = result.expect_err("the relay must reject this message");
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn kinds(rule: &MessageRule) -> (Vec<WindowKind>, Vec<WindowKind>) {
        (rule.from.clone(), rule.to.clone())
    }

    #[test]
    fn an_envelope_over_the_size_limit_is_rejected_and_never_delivered() {
        let registry = WindowInboxRegistry::default();
        let main_channel = subscribed(&registry, "main");
        let sender = caller(TERMINAL);
        let build = |filler: usize| {
            json!({
                "apiVersion": 1,
                "type": "pty-detached-ready",
                "payload": { "filler": "x".repeat(filler) },
            })
        };
        let exact = serde_json::to_vec(&build(500)).unwrap().len();

        // One byte over the limit is refused with its own code and nothing is delivered.
        let over = relay_within(
            &registry,
            &sender,
            "main",
            "pty-detached-ready",
            build(501),
            exact,
        );
        assert_eq!(code_of(over), "window.message_too_large");
        assert!(main_channel.sent.lock().unwrap().is_empty());

        // Exactly at the limit is accepted.
        let at_limit = relay_within(
            &registry,
            &sender,
            "main",
            "pty-detached-ready",
            build(500),
            exact,
        )
        .unwrap();
        assert!(at_limit.delivered);
        assert_eq!(main_channel.sent.lock().unwrap().len(), 1);

        // The public entry point applies the shipped limit, and a normal message passes it.
        assert_eq!(MAX_ENVELOPE_BYTES, 16 * 1024 * 1024);
        let normal = relay(
            &registry,
            &sender,
            "main",
            "pty-detached-ready",
            envelope("pty-detached-ready"),
        )
        .unwrap();
        assert!(normal.delivered);
    }

    #[test]
    fn the_window_message_table_matches_the_protocol_directions() {
        use WindowKind::{Main, Terminal, WorkspaceContent};
        let expected: [(&str, &[WindowKind], &[WindowKind]); 20] = [
            (
                "app-preferences-reply",
                &[Main],
                &[Terminal, WorkspaceContent],
            ),
            (
                "app-preferences-requested",
                &[Terminal, WorkspaceContent],
                &[Main],
            ),
            ("pty-detached-exited", &[Terminal], &[Main]),
            ("pty-detached-failed", &[Terminal], &[Main]),
            ("pty-detached-ready", &[Terminal], &[Main]),
            ("pty-return-requested", &[Terminal], &[Main]),
            ("pty-return-complete", &[Main], &[Terminal]),
            ("pty-return-drop-requested", &[Main], &[Terminal]),
            ("pty-return-failed", &[Main], &[Terminal]),
            (
                "workspace-file-window-attach-failed",
                &[WorkspaceContent],
                &[Main],
            ),
            (
                "workspace-file-window-attached",
                &[WorkspaceContent],
                &[Main],
            ),
            (
                "workspace-file-window-buffer-changed",
                &[WorkspaceContent],
                &[Main],
            ),
            (
                "workspace-file-window-flush-complete",
                &[WorkspaceContent],
                &[Main],
            ),
            ("workspace-file-window-ready", &[WorkspaceContent], &[Main]),
            (
                "workspace-file-window-return-requested",
                &[WorkspaceContent],
                &[Main],
            ),
            (
                "workspace-file-window-flush-requested",
                &[Main],
                &[WorkspaceContent],
            ),
            ("workspace-file-window-init", &[Main], &[WorkspaceContent]),
            (
                "workspace-file-window-return-complete",
                &[Main],
                &[WorkspaceContent],
            ),
            (
                "workspace-file-window-return-drop-requested",
                &[Main],
                &[WorkspaceContent],
            ),
            (
                "workspace-file-window-return-failed",
                &[Main],
                &[WorkspaceContent],
            ),
        ];
        for (message_type, from, to) in expected {
            let rule = rule_for(message_type)
                .unwrap_or_else(|| panic!("{message_type} is not in the contract"));
            assert_eq!(
                kinds(rule),
                (from.to_vec(), to.to_vec()),
                "{message_type} directions"
            );
        }
        assert_eq!(rules().len(), 20);
        assert!(rule_for("not-a-type").is_none());
    }

    #[test]
    fn relay_stamps_the_caller_as_the_source_and_delivers_to_the_target_inbox() {
        let registry = WindowInboxRegistry::default();
        let main_channel = subscribed(&registry, "main");
        let other = subscribed(&registry, OTHER_TERMINAL);

        let result = relay(
            &registry,
            &caller(TERMINAL),
            "main",
            "pty-detached-ready",
            envelope("pty-detached-ready"),
        )
        .unwrap();

        assert_eq!(result, SendWindowMessageResult { delivered: true });
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"delivered": true})
        );
        let sent = main_channel.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].event, "window-message");
        assert_eq!(sent[0].payload, envelope("pty-detached-ready"));
        assert_eq!(
            sent[0].source,
            Some(InboxSource {
                label: TERMINAL.to_string(),
                kind: WindowKind::Terminal
            })
        );
        assert_eq!(sent[0].seq, 1);
        assert!(other.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn relay_rejects_a_sender_kind_that_the_message_type_does_not_allow() {
        let registry = WindowInboxRegistry::default();
        let main_channel = subscribed(&registry, "main");
        let main = WindowLabel::parse("main").unwrap();

        for (sender, message_type) in [
            (TERMINAL, "workspace-file-window-ready"),
            ("main", "pty-detached-ready"),
            (TERMINAL, "app-preferences-reply"),
            (CONTENT, "pty-detached-ready"),
        ] {
            let result = relay(
                &registry,
                &caller(sender),
                "main",
                message_type,
                envelope(message_type),
            );
            assert_eq!(
                code_of(result),
                "window.not_allowed",
                "{sender} {message_type}"
            );
        }

        assert!(main_channel.sent.lock().unwrap().is_empty());
        assert_eq!(registry.buffered_len(&main), 0);
    }

    #[test]
    fn relay_rejects_a_target_kind_that_the_message_type_does_not_allow() {
        let registry = WindowInboxRegistry::default();
        let channels = [
            subscribed(&registry, OTHER_TERMINAL),
            subscribed(&registry, CONTENT),
            subscribed(&registry, "main"),
        ];

        for (sender, target, message_type) in [
            (TERMINAL, OTHER_TERMINAL, "pty-detached-ready"),
            ("main", CONTENT, "pty-return-complete"),
            ("main", "main", "pty-return-complete"),
        ] {
            let result = relay(
                &registry,
                &caller(sender),
                target,
                message_type,
                envelope(message_type),
            );
            assert_eq!(
                code_of(result),
                "window.not_allowed",
                "{sender} -> {target}"
            );
        }

        for channel in channels {
            assert!(channel.sent.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn relay_rejects_invalid_target_labels() {
        let registry = WindowInboxRegistry::default();
        let main_channel = subscribed(&registry, "main");

        for target in [
            "terminal-invalid",
            "",
            "main ",
            "workspace-content-not-a-uuid",
            "TERMINAL-8e783338-f464-4b10-b15e-b534748c6241",
        ] {
            let result = relay(
                &registry,
                &caller("main"),
                target,
                "pty-return-complete",
                envelope("pty-return-complete"),
            );
            assert_eq!(code_of(result), "window.label_invalid", "{target:?}");
        }

        assert!(main_channel.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn relay_rejects_unknown_message_types_and_malformed_envelopes() {
        let registry = WindowInboxRegistry::default();
        let main_channel = subscribed(&registry, "main");
        let sender = caller(TERMINAL);

        let unknown = relay(
            &registry,
            &sender,
            "main",
            "pty-made-up",
            envelope("pty-made-up"),
        );
        assert_eq!(code_of(unknown), "window.not_allowed");
        for malformed in [json!(null), json!([1]), json!("x")] {
            let result = relay(&registry, &sender, "main", "pty-detached-ready", malformed);
            assert_eq!(code_of(result), "window.not_allowed");
        }
        let mismatched = relay(
            &registry,
            &sender,
            "main",
            "pty-detached-ready",
            envelope("pty-detached-failed"),
        );
        assert_eq!(code_of(mismatched), "window.not_allowed");
        for version in [
            json!({ "apiVersion": 2, "type": "pty-detached-ready", "payload": {} }),
            json!({ "apiVersion": "1", "type": "pty-detached-ready", "payload": {} }),
            json!({ "type": "pty-detached-ready", "payload": {} }),
            json!({ "apiVersion": 1.5, "type": "pty-detached-ready", "payload": {} }),
        ] {
            let result = relay(&registry, &sender, "main", "pty-detached-ready", version);
            assert_eq!(code_of(result), "window.not_allowed");
        }
        assert!(main_channel.sent.lock().unwrap().is_empty());

        // A valid message still goes through: the rejections left no state behind.
        relay(
            &registry,
            &sender,
            "main",
            "pty-detached-ready",
            envelope("pty-detached-ready"),
        )
        .unwrap();
        assert_eq!(main_channel.sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn relay_reports_an_unavailable_target_without_buffering() {
        let registry = WindowInboxRegistry::default();
        let terminal = WindowLabel::parse(TERMINAL).unwrap();

        let result = relay(
            &registry,
            &caller("main"),
            TERMINAL,
            "pty-return-complete",
            envelope("pty-return-complete"),
        )
        .unwrap();

        assert_eq!(result, SendWindowMessageResult { delivered: false });
        assert_eq!(registry.buffered_len(&terminal), 0);
        let channel = Arc::new(FakeChannel::default());
        let subscription = registry.subscribe(&terminal, channel).unwrap();
        assert_eq!(subscription.flushed, 0);
    }

    #[test]
    fn relay_buffers_for_the_main_window_before_it_subscribes() {
        let registry = WindowInboxRegistry::default();
        let main = WindowLabel::parse("main").unwrap();

        let result = relay(
            &registry,
            &caller(TERMINAL),
            "main",
            "pty-detached-ready",
            envelope("pty-detached-ready"),
        )
        .unwrap();

        assert_eq!(result, SendWindowMessageResult { delivered: true });
        assert_eq!(registry.buffered_len(&main), 1);
        let channel = Arc::new(FakeChannel::default());
        let subscription = registry.subscribe(&main, channel.clone()).unwrap();
        assert_eq!(subscription.flushed, 1);
        let sent = channel.sent.lock().unwrap();
        assert_eq!(sent[0].source.as_ref().unwrap().label, TERMINAL);
    }

    #[test]
    fn a_forged_source_in_the_envelope_cannot_override_the_stamp() {
        let registry = WindowInboxRegistry::default();
        let main_channel = subscribed(&registry, "main");
        let forged = json!({
            "apiVersion": 1,
            "type": "pty-detached-ready",
            "payload": {
                "windowLabel": OTHER_TERMINAL,
                "source": { "label": "main", "kind": "main" }
            },
            "source": { "label": "main", "kind": "main" }
        });

        relay(
            &registry,
            &caller(TERMINAL),
            "main",
            "pty-detached-ready",
            forged.clone(),
        )
        .unwrap();

        let sent = main_channel.sent.lock().unwrap();
        let source = sent[0].source.clone().unwrap();
        assert_eq!(
            source,
            InboxSource {
                label: TERMINAL.to_string(),
                kind: WindowKind::Terminal
            }
        );
        assert_eq!(
            sent[0].payload, forged,
            "the payload is passed through untouched"
        );
        assert_ne!(source.label, "main");
        assert_ne!(source.label, OTHER_TERMINAL);
    }
}
