use std::sync::Mutex;

use serde::Serialize;

use crate::services::clean_exit_marker::PreviousExit;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupNoticeKind {
    AbnormalExitDetected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupNotice {
    pub kind: StartupNoticeKind,
    pub started_at_ms: Option<i64>,
}

pub struct StartupNotices {
    pending: Mutex<Vec<StartupNotice>>,
}

impl StartupNotices {
    pub fn from_previous_exit(previous: &PreviousExit) -> Self {
        let mut pending = Vec::new();
        match previous {
            PreviousExit::Abnormal { started_at_ms } => pending.push(StartupNotice {
                kind: StartupNoticeKind::AbnormalExitDetected,
                started_at_ms: *started_at_ms,
            }),
            PreviousExit::Unreadable => {
                log::warn!("clean-exit marker unreadable; abnormal-exit notice skipped")
            }
            PreviousExit::FirstRun | PreviousExit::Clean => {}
        }
        Self {
            pending: Mutex::new(pending),
        }
    }

    /// Take-and-clear: the second call returns an empty list.
    pub fn take(&self) -> Vec<StartupNotice> {
        match self.pending.lock() {
            Ok(mut pending) => std::mem::take(&mut *pending),
            Err(_) => {
                log::error!("startup notices lock poisoned");
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_notice_is_taken_exactly_once() {
        let abnormal = StartupNotices::from_previous_exit(&PreviousExit::Abnormal {
            started_at_ms: Some(1000),
        });
        assert_eq!(
            abnormal.take(),
            vec![StartupNotice {
                kind: StartupNoticeKind::AbnormalExitDetected,
                started_at_ms: Some(1000),
            }]
        );
        assert!(abnormal.take().is_empty());

        let unknown_start = StartupNotices::from_previous_exit(&PreviousExit::Abnormal {
            started_at_ms: None,
        });
        let taken = unknown_start.take();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].started_at_ms, None);

        for previous in [
            PreviousExit::FirstRun,
            PreviousExit::Clean,
            PreviousExit::Unreadable,
        ] {
            let notices = StartupNotices::from_previous_exit(&previous);
            assert!(
                notices.take().is_empty(),
                "{previous:?} must not produce a notice"
            );
        }
    }

    #[test]
    fn startup_notice_serializes_kind_and_camel_case_started_at() {
        let notice = StartupNotice {
            kind: StartupNoticeKind::AbnormalExitDetected,
            started_at_ms: Some(1000),
        };
        assert_eq!(
            serde_json::to_value(&notice).unwrap(),
            serde_json::json!({"kind": "abnormal_exit_detected", "startedAtMs": 1000})
        );
        let unknown = StartupNotice {
            kind: StartupNoticeKind::AbnormalExitDetected,
            started_at_ms: None,
        };
        let value = serde_json::to_value(&unknown).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind": "abnormal_exit_detected", "startedAtMs": null})
        );
        assert_eq!(value.as_object().unwrap().len(), 2);
        let text = value.to_string();
        assert!(!text.contains("started_at_ms"));
        assert!(!text.contains("AbnormalExitDetected"));
    }
}
