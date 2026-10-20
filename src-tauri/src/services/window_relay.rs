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

use crate::error_codes::ErrorCode;
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
    items: Vec<MessageRule>,
}

#[derive(Deserialize)]
pub struct MessageRule {
    #[serde(rename = "type")]
    pub message_type: String,
    pub from: Vec<WindowKind>,
    pub to: Vec<WindowKind>,
    #[serde(rename = "contentKind")]
    #[allow(dead_code)]
    // Read only by the contract tests; the relay routes on payload.content.kind.
    pub content_kind: String,
    #[serde(rename = "payloadVersion")]
    pub payload_version: u64,
    /// Content kind to the child window kind it belongs to, for the generic handoff types.
    #[serde(default, rename = "contentKinds")]
    pub content_kinds: Option<std::collections::HashMap<String, WindowKind>>,
}

fn rules() -> &'static [MessageRule] {
    static RULES: OnceLock<Vec<MessageRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str::<MessageManifest>(WINDOW_MESSAGES_JSON)
            .expect("window-messages.json must be valid")
            .items
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

/// Validates and delivers one window message. Every rejection returns before `deliver`. The checks
/// run in this order: the message type is registered; the caller's window kind may send it; the
/// target's window kind may receive it; the envelope has the registered `type` and `apiVersion`; the
/// envelope is within the size limit; for a generic handoff type, the content kind in
/// `payload.content.kind` is allowed for the type and matches the child window kind on the child side;
/// a PTY return request also carries a non-empty `handoffToken` in its inner payload.
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
        .ok_or_else(|| AppError::coded(ErrorCode::WindowNotAllowed, "未登记的窗口消息类型"))?;
    caller.require(&rule.from)?;
    let target = WindowLabel::parse(target)?;
    if !rule.to.contains(&target.kind()) {
        return Err(AppError::coded(
            ErrorCode::WindowNotAllowed,
            "目标窗口类别不允许接收该消息",
        ));
    }
    let envelope_matches = envelope.as_object().is_some_and(|object| {
        object.get("type").and_then(Value::as_str) == Some(message_type)
            && object.get("apiVersion").and_then(Value::as_u64) == Some(rule.payload_version)
    });
    if !envelope_matches {
        return Err(AppError::coded(
            ErrorCode::WindowNotAllowed,
            "消息信封不合法",
        ));
    }
    // Checked after the cheap rejections above; an envelope that cannot be measured is refused.
    let size = serde_json::to_vec(&envelope).map_or(usize::MAX, |bytes| bytes.len());
    if size > max_envelope_bytes {
        log::warn!(
            "window message rejected as too large type={message_type} target={} bytes={size}",
            target.as_str()
        );
        return Err(AppError::coded(
            ErrorCode::WindowMessageTooLarge,
            "窗口消息超过大小上限",
        ));
    }
    if let Some(kinds) = &rule.content_kinds {
        let content_kind = envelope
            .pointer("/payload/content/kind")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::coded(ErrorCode::WindowNotAllowed, "消息缺少内容类型"))?;
        let child_kind = kinds.get(content_kind).ok_or_else(|| {
            AppError::coded(ErrorCode::WindowNotAllowed, "该消息类型不支持此内容类型")
        })?;
        let child_side = if caller.label().kind() == WindowKind::Main {
            target.kind()
        } else {
            caller.label().kind()
        };
        if child_side != *child_kind {
            return Err(AppError::coded(
                ErrorCode::WindowNotAllowed,
                "内容类型与子窗口类别不匹配",
            ));
        }
        if message_type == "content-handoff-return-requested" && content_kind == "pty" {
            // A PTY return carries the Rust handoff token the main window attaches with.
            let has_handoff_token = envelope
                .pointer("/payload/payload/handoffToken")
                .and_then(Value::as_str)
                .is_some_and(|token| !token.is_empty());
            if !has_handoff_token {
                return Err(AppError::coded(
                    ErrorCode::WindowNotAllowed,
                    "PTY 返回请求缺少交接令牌",
                ));
            }
        }
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

    #[test]
    fn an_envelope_over_the_size_limit_is_rejected_and_never_delivered() {
        let registry = WindowInboxRegistry::default();
        let main_channel = subscribed(&registry, "main");
        let sender = caller(TERMINAL);
        let build = |filler: usize| {
            json!({
                "apiVersion": 1,
                "type": "content-handoff-ready",
                "payload": {
                    "content": { "kind": "pty", "id": "content-1" },
                    "transferId": null,
                    "payload": { "filler": "x".repeat(filler) },
                },
            })
        };
        let exact = serde_json::to_vec(&build(500)).unwrap().len();

        // One byte over the limit is refused with its own code and nothing is delivered.
        let over = relay_within(
            &registry,
            &sender,
            "main",
            "content-handoff-ready",
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
            "content-handoff-ready",
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
            "content-handoff-ready",
            content_envelope("content-handoff-ready", "pty"),
        )
        .unwrap();
        assert!(normal.delivered);
    }

    #[test]
    fn the_window_message_table_matches_the_protocol_directions() {
        use std::collections::HashMap;
        use WindowKind::{Main, Terminal, WorkspaceContent};
        const CHILD: &[WindowKind] = &[Terminal, WorkspaceContent];
        const BOTH: &[(&str, WindowKind)] = &[("pty", Terminal), ("file", WorkspaceContent)];
        const FILE: &[(&str, WindowKind)] = &[("file", WorkspaceContent)];
        const PTY: &[(&str, WindowKind)] = &[("pty", Terminal)];
        // (type, from, to, contentKinds): the 14 rows of the m6-091 table.
        let expected: [(
            &str,
            &[WindowKind],
            &[WindowKind],
            Option<&[(&str, WindowKind)]>,
        ); 14] = [
            ("app-preferences-reply", &[Main], CHILD, None),
            ("app-preferences-requested", CHILD, &[Main], None),
            (
                "content-handoff-attached",
                &[WorkspaceContent],
                &[Main],
                Some(FILE),
            ),
            ("content-handoff-exited", &[Terminal], &[Main], Some(PTY)),
            ("content-handoff-failed", CHILD, &[Main], Some(BOTH)),
            (
                "content-handoff-flush-complete",
                &[WorkspaceContent],
                &[Main],
                Some(FILE),
            ),
            (
                "content-handoff-flush-requested",
                &[Main],
                &[WorkspaceContent],
                Some(FILE),
            ),
            (
                "content-handoff-init",
                &[Main],
                &[WorkspaceContent],
                Some(FILE),
            ),
            ("content-handoff-ready", CHILD, &[Main], Some(BOTH)),
            (
                "content-handoff-return-complete",
                &[Main],
                CHILD,
                Some(BOTH),
            ),
            (
                "content-handoff-return-drop-requested",
                &[Main],
                CHILD,
                Some(BOTH),
            ),
            ("content-handoff-return-failed", &[Main], CHILD, Some(BOTH)),
            (
                "content-handoff-return-requested",
                CHILD,
                &[Main],
                Some(BOTH),
            ),
            (
                "content-handoff-state-changed",
                &[WorkspaceContent],
                &[Main],
                Some(FILE),
            ),
        ];
        for (message_type, from, to, kinds) in expected {
            let rule = rule_for(message_type)
                .unwrap_or_else(|| panic!("{message_type} is not in the contract"));
            assert_eq!(rule.from, from.to_vec(), "{message_type} from");
            assert_eq!(rule.to, to.to_vec(), "{message_type} to");
            match kinds {
                Some(pairs) => {
                    let wanted: HashMap<String, WindowKind> = pairs
                        .iter()
                        .map(|&(kind, child)| (kind.to_string(), child))
                        .collect();
                    assert_eq!(
                        rule.content_kinds.as_ref(),
                        Some(&wanted),
                        "{message_type} contentKinds"
                    );
                }
                None => assert!(
                    rule.content_kinds.is_none(),
                    "{message_type} must not declare contentKinds"
                ),
            }
        }
        assert_eq!(rules().len(), 14);
        assert!(rule_for("not-a-type").is_none());
        // The 18 per-kind types of m6-062 are gone from the contract.
        for retired in [
            "pty-detached-ready",
            "pty-detached-failed",
            "pty-detached-exited",
            "pty-return-requested",
            "pty-return-complete",
            "pty-return-failed",
            "pty-return-drop-requested",
            "workspace-file-window-ready",
            "workspace-file-window-init",
            "workspace-file-window-attached",
            "workspace-file-window-attach-failed",
            "workspace-file-window-buffer-changed",
            "workspace-file-window-flush-requested",
            "workspace-file-window-flush-complete",
            "workspace-file-window-return-requested",
            "workspace-file-window-return-complete",
            "workspace-file-window-return-failed",
            "workspace-file-window-return-drop-requested",
        ] {
            assert!(rule_for(retired).is_none(), "{retired} is retired");
        }
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
            "content-handoff-ready",
            content_envelope("content-handoff-ready", "pty"),
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
        assert_eq!(
            sent[0].payload,
            content_envelope("content-handoff-ready", "pty")
        );
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

        // (sender, target, type, content kind): none of these is allowed from that sender.
        for (sender, target, message_type, kind) in [
            (TERMINAL, CONTENT, "content-handoff-init", Some("file")),
            ("main", "main", "content-handoff-ready", Some("pty")),
            (TERMINAL, "main", "app-preferences-reply", None),
            (CONTENT, TERMINAL, "content-handoff-init", Some("file")),
        ] {
            let envelope = match kind {
                Some(kind) => content_envelope(message_type, kind),
                None => envelope(message_type),
            };
            let result = relay(&registry, &caller(sender), target, message_type, envelope);
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

        // (sender, target, type, content kind): the target kind is not in the type's `to` list.
        for (sender, target, message_type, kind) in [
            (TERMINAL, OTHER_TERMINAL, "content-handoff-ready", "pty"),
            ("main", TERMINAL, "content-handoff-init", "file"),
            ("main", "main", "content-handoff-return-complete", "pty"),
        ] {
            let result = relay(
                &registry,
                &caller(sender),
                target,
                message_type,
                content_envelope(message_type, kind),
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
                "content-handoff-return-complete",
                content_envelope("content-handoff-return-complete", "pty"),
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
            let result = relay(
                &registry,
                &sender,
                "main",
                "content-handoff-ready",
                malformed,
            );
            assert_eq!(code_of(result), "window.not_allowed");
        }
        let mismatched = relay(
            &registry,
            &sender,
            "main",
            "content-handoff-ready",
            content_envelope("content-handoff-failed", "pty"),
        );
        assert_eq!(code_of(mismatched), "window.not_allowed");

        let base = content_envelope("content-handoff-ready", "pty");
        let mut version_two = base.clone();
        version_two["apiVersion"] = json!(2);
        let mut version_text = base.clone();
        version_text["apiVersion"] = json!("1");
        let mut version_missing = base.clone();
        version_missing
            .as_object_mut()
            .unwrap()
            .remove("apiVersion");
        let mut version_float = base.clone();
        version_float["apiVersion"] = json!(1.5);
        for version in [version_two, version_text, version_missing, version_float] {
            let result = relay(&registry, &sender, "main", "content-handoff-ready", version);
            assert_eq!(code_of(result), "window.not_allowed");
        }
        assert!(main_channel.sent.lock().unwrap().is_empty());

        // A valid message still goes through: the rejections left no state behind.
        relay(
            &registry,
            &sender,
            "main",
            "content-handoff-ready",
            content_envelope("content-handoff-ready", "pty"),
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
            "content-handoff-return-complete",
            content_envelope("content-handoff-return-complete", "pty"),
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
            "content-handoff-ready",
            content_envelope("content-handoff-ready", "pty"),
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
            "type": "content-handoff-ready",
            "payload": {
                "content": { "kind": "pty", "id": "content-1" },
                "transferId": null,
                "payload": {
                    "windowLabel": OTHER_TERMINAL,
                    "source": { "label": "main", "kind": "main" }
                }
            },
            "source": { "label": "main", "kind": "main" }
        });

        relay(
            &registry,
            &caller(TERMINAL),
            "main",
            "content-handoff-ready",
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

    fn content_envelope(message_type: &str, kind: &str) -> Value {
        json!({
            "apiVersion": 1,
            "type": message_type,
            "payload": {
                "content": { "kind": kind, "id": "content-1" },
                "transferId": null,
                "payload": {}
            }
        })
    }

    #[test]
    fn relay_requires_the_handoff_token_on_pty_return_requests() {
        let registry = WindowInboxRegistry::default();
        let main = subscribed(&registry, "main");
        subscribed(&registry, TERMINAL);
        subscribed(&registry, CONTENT);
        let return_request = |kind: &str, inner: Value| {
            json!({
                "apiVersion": 1,
                "type": "content-handoff-return-requested",
                "payload": {
                    "content": { "kind": kind, "id": "content-1" },
                    "transferId": "return-1",
                    "payload": inner
                }
            })
        };

        // Rejected: the PTY return has no handoff token, or an empty one.
        for inner in [
            json!({ "sessionId": "s1", "windowLabel": TERMINAL }),
            json!({ "sessionId": "s1", "windowLabel": TERMINAL, "handoffToken": "" }),
        ] {
            assert!(relay(
                &registry,
                &caller(TERMINAL),
                "main",
                "content-handoff-return-requested",
                return_request("pty", inner),
            )
            .is_err());
        }
        // Accepted: the PTY return carries the token.
        relay(
            &registry,
            &caller(TERMINAL),
            "main",
            "content-handoff-return-requested",
            return_request(
                "pty",
                json!({ "sessionId": "s1", "windowLabel": TERMINAL, "handoffToken": "rust-1" }),
            ),
        )
        .unwrap();
        // Unaffected: a file return has no handoff token and is still accepted.
        relay(
            &registry,
            &caller(CONTENT),
            "main",
            "content-handoff-return-requested",
            return_request("file", json!({ "windowLabel": CONTENT })),
        )
        .unwrap();
        // Only the two accepted messages reached the main window.
        assert_eq!(main.sent.lock().unwrap().len(), 2);
    }

    #[test]
    fn relay_binds_the_content_kind_to_the_child_window_kind() {
        let registry = WindowInboxRegistry::default();
        let main = subscribed(&registry, "main");
        let terminal = subscribed(&registry, TERMINAL);
        let content = subscribed(&registry, CONTENT);

        // Accepted: the content kind matches the child window kind on the child side of the exchange.
        relay(
            &registry,
            &caller(TERMINAL),
            "main",
            "content-handoff-ready",
            content_envelope("content-handoff-ready", "pty"),
        )
        .unwrap();
        relay(
            &registry,
            &caller(CONTENT),
            "main",
            "content-handoff-ready",
            content_envelope("content-handoff-ready", "file"),
        )
        .unwrap();
        relay(
            &registry,
            &caller("main"),
            CONTENT,
            "content-handoff-init",
            content_envelope("content-handoff-init", "file"),
        )
        .unwrap();
        relay(
            &registry,
            &caller("main"),
            TERMINAL,
            "content-handoff-return-complete",
            content_envelope("content-handoff-return-complete", "pty"),
        )
        .unwrap();
        relay(
            &registry,
            &caller("main"),
            CONTENT,
            "content-handoff-return-drop-requested",
            content_envelope("content-handoff-return-drop-requested", "file"),
        )
        .unwrap();
        assert_eq!(main.sent.lock().unwrap().len(), 2);
        assert_eq!(content.sent.lock().unwrap().len(), 2);
        assert_eq!(terminal.sent.lock().unwrap().len(), 1);

        // Rejected: the content kind does not match the child side, or the kind is not allowed for the phase.
        let rejected = [
            (TERMINAL, "main", "content-handoff-ready", "file"),
            (CONTENT, "main", "content-handoff-ready", "pty"),
            ("main", CONTENT, "content-handoff-return-complete", "pty"),
            ("main", TERMINAL, "content-handoff-return-complete", "file"),
            (TERMINAL, "main", "content-handoff-attached", "pty"),
            (CONTENT, "main", "content-handoff-exited", "file"),
            (TERMINAL, "main", "content-handoff-state-changed", "pty"),
            ("main", TERMINAL, "content-handoff-init", "pty"),
            (TERMINAL, "main", "content-handoff-ready", "markdown"),
        ];
        for (from, target, message_type, kind) in rejected {
            let result = relay(
                &registry,
                &caller(from),
                target,
                message_type,
                content_envelope(message_type, kind),
            );
            assert_eq!(
                code_of(result),
                "window.not_allowed",
                "{from} -> {target} {message_type} {kind}"
            );
        }
        // Rejections deliver nothing and buffer nothing.
        assert_eq!(main.sent.lock().unwrap().len(), 2);
        assert_eq!(content.sent.lock().unwrap().len(), 2);
        assert_eq!(terminal.sent.lock().unwrap().len(), 1);
        assert_eq!(
            registry.buffered_len(&WindowLabel::parse("main").unwrap()),
            0
        );
        assert_eq!(
            registry.buffered_len(&WindowLabel::parse(TERMINAL).unwrap()),
            0
        );
        assert_eq!(
            registry.buffered_len(&WindowLabel::parse(CONTENT).unwrap()),
            0
        );
    }

    #[test]
    fn relay_rejects_generic_messages_with_a_malformed_content_field() {
        let registry = WindowInboxRegistry::default();
        let main = subscribed(&registry, "main");
        let sender = caller(TERMINAL);
        // The inner `payload` of the envelope: no content key, a string, an empty object, and a non-string kind.
        let variants = [
            json!({ "transferId": null, "payload": {} }),
            json!({ "content": "pty", "transferId": null, "payload": {} }),
            json!({ "content": {}, "transferId": null, "payload": {} }),
            json!({ "content": { "kind": 1 }, "transferId": null, "payload": {} }),
        ];
        for variant in variants {
            let envelope = json!({
                "apiVersion": 1,
                "type": "content-handoff-ready",
                "payload": variant
            });
            let result = relay(
                &registry,
                &sender,
                "main",
                "content-handoff-ready",
                envelope,
            );
            assert_eq!(code_of(result), "window.not_allowed");
        }
        for payload in [json!(null), json!([])] {
            let envelope =
                json!({ "apiVersion": 1, "type": "content-handoff-ready", "payload": payload });
            let result = relay(
                &registry,
                &sender,
                "main",
                "content-handoff-ready",
                envelope,
            );
            assert_eq!(code_of(result), "window.not_allowed");
        }
        // Rejections never reach the inbox.
        assert_eq!(main.sent.lock().unwrap().len(), 0);
        // The rejections left no state behind: a well-formed message is still delivered.
        let delivered = relay(
            &registry,
            &sender,
            "main",
            "content-handoff-ready",
            content_envelope("content-handoff-ready", "pty"),
        )
        .unwrap();
        assert!(delivered.delivered);
        assert_eq!(main.sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn relay_rejects_the_retired_per_kind_message_types_and_still_accepts_preferences() {
        // (type, sender, target) for each of the 18 per-kind types, with the direction it had in m6-062.
        const RETIRED: [(&str, &str, &str); 18] = [
            ("pty-detached-ready", TERMINAL, "main"),
            ("pty-detached-failed", TERMINAL, "main"),
            ("pty-detached-exited", TERMINAL, "main"),
            ("pty-return-requested", TERMINAL, "main"),
            ("pty-return-complete", "main", TERMINAL),
            ("pty-return-failed", "main", TERMINAL),
            ("pty-return-drop-requested", "main", TERMINAL),
            ("workspace-file-window-ready", CONTENT, "main"),
            ("workspace-file-window-attached", CONTENT, "main"),
            ("workspace-file-window-attach-failed", CONTENT, "main"),
            ("workspace-file-window-buffer-changed", CONTENT, "main"),
            ("workspace-file-window-flush-complete", CONTENT, "main"),
            ("workspace-file-window-return-requested", CONTENT, "main"),
            ("workspace-file-window-init", "main", CONTENT),
            ("workspace-file-window-flush-requested", "main", CONTENT),
            ("workspace-file-window-return-complete", "main", CONTENT),
            ("workspace-file-window-return-failed", "main", CONTENT),
            (
                "workspace-file-window-return-drop-requested",
                "main",
                CONTENT,
            ),
        ];
        let registry = WindowInboxRegistry::default();
        let main = subscribed(&registry, "main");
        let terminal = subscribed(&registry, TERMINAL);
        let content = subscribed(&registry, CONTENT);
        for (message_type, sender, target) in RETIRED {
            assert!(
                rule_for(message_type).is_none(),
                "{message_type} must not be registered"
            );
            let result = relay(
                &registry,
                &caller(sender),
                target,
                message_type,
                envelope(message_type),
            );
            assert_eq!(code_of(result), "window.not_allowed", "{message_type}");
        }
        assert_eq!(main.sent.lock().unwrap().len(), 0);
        assert_eq!(terminal.sent.lock().unwrap().len(), 0);
        assert_eq!(content.sent.lock().unwrap().len(), 0);

        // Preference types carry no content field and are unaffected by the content check.
        let request = relay(
            &registry,
            &caller(TERMINAL),
            "main",
            "app-preferences-requested",
            envelope("app-preferences-requested"),
        )
        .unwrap();
        assert!(request.delivered);
        let reply = relay(
            &registry,
            &caller("main"),
            TERMINAL,
            "app-preferences-reply",
            envelope("app-preferences-reply"),
        )
        .unwrap();
        assert!(reply.delivered);
        assert_eq!(main.sent.lock().unwrap().len(), 1);
        assert_eq!(terminal.sent.lock().unwrap().len(), 1);
    }
}
