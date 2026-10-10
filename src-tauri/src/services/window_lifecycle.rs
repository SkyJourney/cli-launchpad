//! Single orchestration of what happens when a window is destroyed. Every
//! resource that scopes state to a window implements `WindowScopedResource`;
//! `on_window_destroyed` releases them in order and forwards the resulting
//! events to the main window through an `EventSink`.

use crate::models::window_kind::WindowLabel;

pub const PTY_SESSION_OWNER_LOST_EVENT: &str = "pty-session-owner-lost";
pub const WORKSPACE_CONTENT_WINDOW_LOST_EVENT: &str = "workspace-content-window-lost";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    PtySessionOwnerLost { session_id: String },
    WorkspaceContentWindowLost { window_label: String },
}

impl AppEvent {
    pub fn name(&self) -> &'static str {
        match self {
            AppEvent::PtySessionOwnerLost { .. } => PTY_SESSION_OWNER_LOST_EVENT,
            AppEvent::WorkspaceContentWindowLost { .. } => WORKSPACE_CONTENT_WINDOW_LOST_EVENT,
        }
    }

    pub fn payload(&self) -> serde_json::Value {
        match self {
            AppEvent::PtySessionOwnerLost { session_id } => {
                serde_json::json!({ "sessionId": session_id })
            }
            AppEvent::WorkspaceContentWindowLost { window_label } => {
                serde_json::json!({ "windowLabel": window_label })
            }
        }
    }
}

/// Delivers events to the main window.
pub trait EventSink {
    fn emit_to_main(&self, event: &AppEvent) -> Result<(), String>;
}

/// A resource that scopes state to a window and must release it on destruction.
pub trait WindowScopedResource {
    /// Releases whatever `window` holds and returns the events the frontend must hear about.
    fn release_window(&self, window: &WindowLabel) -> Vec<AppEvent>;
}

/// Releases every resource in order, then sends all resulting events to the
/// main window. A failing send is logged and never stops the remaining
/// events. Returns every event that was attempted (including failed sends).
pub fn on_window_destroyed(
    window: &WindowLabel,
    resources: &[&dyn WindowScopedResource],
    sink: &dyn EventSink,
) -> Vec<AppEvent> {
    let mut attempted = Vec::new();
    for resource in resources {
        for event in resource.release_window(window) {
            if let Err(error) = sink.emit_to_main(&event) {
                log::warn!(
                    "unable to send {} for destroyed window label={window}: {error}",
                    event.name()
                );
            }
            attempted.push(event);
        }
    }
    attempted
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::{
        on_window_destroyed, AppEvent, EventSink, WindowScopedResource,
        PTY_SESSION_OWNER_LOST_EVENT, WORKSPACE_CONTENT_WINDOW_LOST_EVENT,
    };
    use crate::models::window_kind::WindowLabel;
    use crate::services::content_window_grants::{
        ContentWindowFileGrant, ContentWindowGrantRegistry,
    };
    use crate::services::pty_session_service::{recording_channel, PtySessionManager};

    const FILE_L1: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    const FILE_L2: &str = "workspace-content-9f1b6a52-3c47-4d5e-8a1b-2c3d4e5f6a7b";
    const TERM_T1: &str = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
    const TERM_T2: &str = "terminal-9f1b6a52-3c47-4d5e-8a1b-2c3d4e5f6a7b";

    #[derive(Default)]
    struct RecordingSink {
        sent: Mutex<Vec<AppEvent>>,
        fail_first: bool,
    }

    impl EventSink for RecordingSink {
        fn emit_to_main(&self, event: &AppEvent) -> Result<(), String> {
            let mut sent = self.sent.lock().unwrap();
            let first = sent.is_empty();
            sent.push(event.clone());
            if self.fail_first && first {
                Err("sink failure on purpose".to_string())
            } else {
                Ok(())
            }
        }
    }

    fn grant(relative_path: &str) -> ContentWindowFileGrant {
        ContentWindowFileGrant {
            directory_id: 1,
            directory_path: "C:/project".to_string(),
            relative_path: relative_path.to_string(),
        }
    }

    fn label(raw: &str) -> WindowLabel {
        WindowLabel::parse(raw).unwrap()
    }

    #[test]
    fn destroyed_file_window_revokes_only_its_grant() {
        let registry = ContentWindowGrantRegistry::default();
        registry.grant(FILE_L1, grant("a.txt")).unwrap();
        registry.grant(FILE_L2, grant("b.txt")).unwrap();
        let sessions = PtySessionManager::default();
        let sink = RecordingSink::default();
        let resources: [&dyn WindowScopedResource; 2] = [&registry, &sessions];

        let events = on_window_destroyed(&label(FILE_L1), &resources, &sink);
        assert_eq!(
            events,
            vec![AppEvent::WorkspaceContentWindowLost {
                window_label: FILE_L1.to_string()
            }]
        );
        assert!(registry.get(FILE_L1).is_err());
        assert!(registry.get(FILE_L2).is_ok());

        // repeating the destruction revokes nothing else
        let repeated = on_window_destroyed(&label(FILE_L1), &resources, &sink);
        assert_eq!(repeated.len(), 1);
        assert!(registry.get(FILE_L1).is_err());
        assert!(registry.get(FILE_L2).is_ok());

        // main and terminal windows never touch file grants
        assert!(on_window_destroyed(&label("main"), &resources, &sink).is_empty());
        assert!(on_window_destroyed(&label(TERM_T1), &resources, &sink).is_empty());
        assert!(registry.get(FILE_L2).is_ok());

        // a destroyed label can be granted again (window reuse)
        assert!(registry.grant(FILE_L1, grant("a.txt")).is_ok());
    }

    #[test]
    fn destroyed_non_terminal_or_invalid_windows_return_no_lost_sessions() {
        let registry = ContentWindowGrantRegistry::default();
        let sessions = PtySessionManager::default();
        let sink = RecordingSink::default();
        let resources: [&dyn WindowScopedResource; 2] = [&registry, &sessions];

        for valid in [TERM_T1, TERM_T2, "main"] {
            assert!(
                on_window_destroyed(&label(valid), &resources, &sink).is_empty(),
                "{valid}"
            );
        }
        for invalid in ["terminal-invalid", "", "workspace-content-not-a-uuid"] {
            let error = match WindowLabel::parse(invalid) {
                Ok(_) => panic!("{invalid:?} must not parse"),
                Err(error) => error,
            };
            assert_eq!(
                serde_json::to_value(&error).unwrap()["code"],
                "window.label_invalid"
            );
        }
        assert_eq!(sessions.active_count(), 0);
        assert!(sink.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn destroyed_terminal_owner_window_returns_owner_lost_sessions() {
        let registry = ContentWindowGrantRegistry::default();
        let sessions = PtySessionManager::default();
        let (channel_1, _events_1) = recording_channel();
        let (channel_2, _events_2) = recording_channel();
        let (channel_3, _events_3) = recording_channel();
        let s1 = sessions.insert_test_session(TERM_T1, Some(channel_1));
        let s2 = sessions.insert_test_session(TERM_T2, Some(channel_2));
        let s3 = sessions.insert_test_session("main", Some(channel_3));
        let sink = RecordingSink::default();
        let resources: [&dyn WindowScopedResource; 2] = [&registry, &sessions];

        let events = on_window_destroyed(&label(TERM_T1), &resources, &sink);
        assert_eq!(
            events,
            vec![AppEvent::PtySessionOwnerLost { session_id: s1.session_id.clone() }],
            "only the session owned by the destroyed window is lost, and no content-window event is produced"
        );
        let route_1 = sessions.test_route(&s1.session_id);
        assert_eq!(route_1.window_label, "main");
        assert!(route_1.owner_lost);
        assert!(!route_1.has_channel);
        let route_2 = sessions.test_route(&s2.session_id);
        assert_eq!(route_2.window_label, TERM_T2);
        assert!(!route_2.owner_lost);
        assert!(route_2.has_channel);
        let route_3 = sessions.test_route(&s3.session_id);
        assert_eq!(route_3.window_label, "main");
        assert!(!route_3.owner_lost);

        assert!(on_window_destroyed(&label("main"), &resources, &sink).is_empty());
        assert!(WindowLabel::parse("terminal-invalid").is_err());
    }

    #[test]
    fn lost_event_is_emitted_only_for_workspace_content_windows() {
        let registry = ContentWindowGrantRegistry::default();
        let sessions = PtySessionManager::default();
        let sink = RecordingSink::default();
        let resources: [&dyn WindowScopedResource; 2] = [&registry, &sessions];

        // no grant exists for FILE_L1: the notification is still sent
        let events = on_window_destroyed(&label(FILE_L1), &resources, &sink);
        assert_eq!(
            events,
            vec![AppEvent::WorkspaceContentWindowLost {
                window_label: FILE_L1.to_string()
            }]
        );
        for other in ["main", TERM_T1] {
            assert!(
                on_window_destroyed(&label(other), &resources, &sink)
                    .iter()
                    .all(|event| !matches!(event, AppEvent::WorkspaceContentWindowLost { .. })),
                "{other}"
            );
        }
    }

    #[test]
    fn app_event_names_and_payloads_are_the_wire_strings() {
        let lost = AppEvent::WorkspaceContentWindowLost {
            window_label: FILE_L1.to_string(),
        };
        assert_eq!(lost.name(), WORKSPACE_CONTENT_WINDOW_LOST_EVENT);
        assert_eq!(lost.name(), "workspace-content-window-lost");
        assert_eq!(
            lost.payload(),
            serde_json::json!({ "windowLabel": FILE_L1 })
        );
        let owner_lost = AppEvent::PtySessionOwnerLost {
            session_id: "s-1".to_string(),
        };
        assert_eq!(owner_lost.name(), PTY_SESSION_OWNER_LOST_EVENT);
        assert_eq!(owner_lost.name(), "pty-session-owner-lost");
        assert_eq!(
            owner_lost.payload(),
            serde_json::json!({ "sessionId": "s-1" })
        );
    }

    #[test]
    fn a_failing_sink_does_not_stop_the_remaining_events() {
        struct TwoEvents;
        impl WindowScopedResource for TwoEvents {
            fn release_window(&self, _window: &WindowLabel) -> Vec<AppEvent> {
                vec![
                    AppEvent::PtySessionOwnerLost {
                        session_id: "first".to_string(),
                    },
                    AppEvent::PtySessionOwnerLost {
                        session_id: "second".to_string(),
                    },
                ]
            }
        }
        let sink = RecordingSink {
            sent: Mutex::new(Vec::new()),
            fail_first: true,
        };
        let resources: [&dyn WindowScopedResource; 1] = [&TwoEvents];

        let events = on_window_destroyed(&label(TERM_T1), &resources, &sink);

        assert_eq!(events.len(), 2, "both events are reported as attempted");
        assert_eq!(
            sink.sent.lock().unwrap().len(),
            2,
            "the second event is still sent"
        );
    }

    #[test]
    fn a_destroyed_window_releases_every_resource_exactly_once_in_order() {
        struct Counting<'a> {
            name: &'a str,
            calls: &'a Mutex<Vec<String>>,
        }
        impl WindowScopedResource for Counting<'_> {
            fn release_window(&self, window: &WindowLabel) -> Vec<AppEvent> {
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("{}:{}", self.name, window.as_str()));
                Vec::new()
            }
        }
        let calls = Mutex::new(Vec::new());
        let first = Counting {
            name: "first",
            calls: &calls,
        };
        let second = Counting {
            name: "second",
            calls: &calls,
        };
        let resources: [&dyn WindowScopedResource; 2] = [&first, &second];

        let events = on_window_destroyed(&label(FILE_L1), &resources, &RecordingSink::default());

        assert!(events.is_empty());
        assert_eq!(
            *calls.lock().unwrap(),
            vec![format!("first:{FILE_L1}"), format!("second:{FILE_L1}")]
        );
    }
}
