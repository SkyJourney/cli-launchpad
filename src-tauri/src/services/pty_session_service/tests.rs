use super::input::*;
use super::route::*;
use super::test_support::{
    long_running_test_command, quick_exit_test_command, spawn_test_child, wait_until, FakeStore,
};
use super::window::*;
use super::*;
use crate::models::pty_session::{PtySessionWindowStatus, PtySessionWindowStatusReport};
use std::io::Write;

use std::sync::mpsc;

#[test]
fn window_status_distinguishes_ended_owned_and_transferred_sessions() {
    assert_eq!(
        session_window_status(None, "terminal-a", false),
        PtySessionWindowStatus::Ended
    );
    assert_eq!(
        session_window_status(Some("terminal-a"), "terminal-a", false),
        PtySessionWindowStatus::Running
    );
    assert_eq!(
        session_window_status(Some("main"), "terminal-a", false),
        PtySessionWindowStatus::OwnedByAnotherWindow
    );
    assert_eq!(
        session_window_status(Some("terminal-a"), "terminal-a", true),
        PtySessionWindowStatus::Ended
    );
}

#[test]
fn ensure_route_owner_rejects_non_owner() {
    let route = EventRoute {
        window_label: "terminal-child".to_string(),
        channel: None,
        mirror: None,
        owner_lost: false,
        buffered_events: VecDeque::new(),
        buffered_bytes: 0,
    };

    assert!(ensure_route_owner(&route, "main").is_err());
    assert_eq!(
        session_window_status(Some(&route.window_label), "main", false),
        PtySessionWindowStatus::OwnedByAnotherWindow
    );
}

#[test]
fn destroying_the_current_owner_reclaims_an_open_session_for_main() {
    let mut route = EventRoute {
        window_label: "terminal-child".to_string(),
        channel: None,
        mirror: None,
        owner_lost: false,
        buffered_events: VecDeque::new(),
        buffered_bytes: 0,
    };

    assert!(reclaim_event_route(&mut route, "terminal-child"));
    assert_eq!(route.window_label, "main");
    assert!(route.owner_lost);
    assert!(route.channel.is_none());
}

#[test]
fn destroying_a_non_owner_does_not_reclaim_the_session() {
    let mut route = EventRoute {
        window_label: "terminal-owner".to_string(),
        channel: None,
        mirror: None,
        owner_lost: false,
        buffered_events: VecDeque::new(),
        buffered_bytes: 0,
    };

    assert!(!reclaim_event_route(&mut route, "terminal-mirror"));
    assert_eq!(route.window_label, "terminal-owner");
    assert!(!route.owner_lost);
}

#[test]
fn owner_lost_output_buffer_rejects_data_over_the_limit() {
    let mut route = EventRoute {
        window_label: "main".to_string(),
        channel: None,
        mirror: None,
        owner_lost: true,
        buffered_events: VecDeque::new(),
        buffered_bytes: 0,
    };
    let event = PtyEvent::Output {
        session_id: "session-1".to_string(),
        sequence: 1,
        data_base64: "x".repeat(MAX_OWNER_LOST_BUFFER_BYTES + 1),
    };

    assert!(!buffer_owner_lost_event(
        &mut route,
        event,
        MAX_OWNER_LOST_BUFFER_BYTES + 1
    ));
    assert!(route.buffered_events.is_empty());
    assert_eq!(route.buffered_bytes, 0);
}

#[test]
fn destroying_a_window_clears_handoffs_that_use_it_as_source_or_target() {
    let transfer = PendingHandoff {
        token: "token".to_string(),
        source_window_label: "main".to_string(),
        sequence: 1,
        snapshot: None,
        target_window_label: Some("terminal-child".to_string()),
        target_channel: None,
    };

    assert!(handoff_references_window(&transfer, "main"));
    assert!(handoff_references_window(&transfer, "terminal-child"));
    assert!(!handoff_references_window(&transfer, "terminal-other"));
}

#[test]
fn output_acknowledgement_releases_pending_capacity() {
    let flow = OutputFlow::new();
    let first = flow.reserve(64 * 1024).unwrap();
    let second = flow.reserve(64 * 1024).unwrap();
    assert_eq!(first, 1);
    assert_eq!(second, 2);
    assert!(flow.acknowledge(2).is_ok());
    assert_eq!(flow.state.lock().unwrap().pending_bytes, 0);
}

#[test]
fn output_acknowledgement_rejects_future_sequence() {
    let flow = OutputFlow::new();
    flow.reserve(10).unwrap();
    assert!(flow.acknowledge(2).is_err());
}

#[test]
fn handoff_pauses_new_output_after_a_stable_sequence_watermark() {
    let flow = Arc::new(OutputFlow::new());
    assert_eq!(flow.reserve(10), Some(1));
    let watermark = flow.pause().unwrap();
    assert_eq!(watermark, 1);

    let (sender, receiver) = mpsc::channel();
    let reader_flow = Arc::clone(&flow);
    let reader = thread::spawn(move || sender.send(reader_flow.reserve(20)).unwrap());
    assert!(receiver
        .recv_timeout(std::time::Duration::from_millis(25))
        .is_err());

    flow.resume();
    assert_eq!(
        receiver.recv_timeout(std::time::Duration::from_secs(1)),
        Ok(Some(2))
    );
    reader.join().unwrap();
}

#[test]
fn handoff_pause_expires_to_prevent_a_stalled_terminal() {
    let flow = OutputFlow::new();
    let watermark = flow.pause().unwrap();
    {
        let mut state = flow.state.lock().unwrap();
        state.pause_deadline = Some(std::time::Instant::now());
    }
    assert!(!flow.is_paused_at(watermark));
    assert_eq!(flow.reserve(5), Some(1));
}

#[test]
fn handoff_window_labels_are_restricted_to_workspace_windows() {
    assert!(is_supported_workspace_window("main"));
    assert!(is_supported_workspace_window(
        "terminal-8e783338-f464-4b10-b15e-b534748c6241"
    ));
    assert!(!is_supported_workspace_window("settings"));
    assert!(!is_supported_workspace_window("terminal-invalid"));
}

#[test]
fn handoff_snapshot_is_bounded_and_requires_safe_dimensions() {
    let valid = PtyTerminalSnapshot {
        data: "screen".to_string(),
        cols: 120,
        rows: 40,
    };
    assert!(validate_handoff_snapshot(&valid).is_ok());

    let oversized = PtyTerminalSnapshot {
        data: "x".repeat(MAX_HANDOFF_SNAPSHOT_BYTES + 1),
        ..valid.clone()
    };
    assert!(validate_handoff_snapshot(&oversized).is_err());

    let invalid_dimensions = PtyTerminalSnapshot { cols: 0, ..valid };
    assert!(validate_handoff_snapshot(&invalid_dimensions).is_err());
}

#[test]
fn pty_size_is_bounded() {
    assert!(validate_size(PtySizeUpdate {
        cols: 500,
        rows: 300,
        pixel_width: 0,
        pixel_height: 0,
    })
    .is_ok());
    assert!(validate_size(PtySizeUpdate {
        cols: 0,
        rows: 24,
        pixel_width: 0,
        pixel_height: 0,
    })
    .is_err());
    assert!(validate_size(PtySizeUpdate {
        cols: 80,
        rows: 301,
        pixel_width: 0,
        pixel_height: 0,
    })
    .is_err());
    assert!(validate_size(PtySizeUpdate {
        cols: 501,
        rows: 24,
        pixel_width: 0,
        pixel_height: 0,
    })
    .is_err());
}

struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

impl Write for RecordingWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn queued_pty_input_is_written_in_submission_order() {
    let written = Arc::new(Mutex::new(Vec::new()));
    let (sender, receiver) = mpsc::sync_channel(3);
    let worker = start_pty_input_writer(
        Box::new(RecordingWriter(Arc::clone(&written))),
        receiver,
        "test-session".to_string(),
    )
    .unwrap();

    enqueue_pty_input(&sender, b"first").unwrap();
    enqueue_pty_input(&sender, b"second").unwrap();
    enqueue_pty_input(&sender, b"third").unwrap();
    drop(sender);
    worker.join().unwrap();

    assert_eq!(*written.lock().unwrap(), b"firstsecondthird");
}

#[test]
fn full_pty_input_queue_returns_a_typed_backpressure_error() {
    let (sender, _receiver) = mpsc::sync_channel(1);
    enqueue_pty_input(&sender, b"first").unwrap();

    let error = enqueue_pty_input(&sender, b"second").unwrap_err();
    let value = serde_json::to_value(error).unwrap();

    assert_eq!(value["code"], "pty.input_backpressure");
}

#[test]
fn oversized_pty_input_is_rejected_before_queueing() {
    let (sender, _receiver) = mpsc::sync_channel(1);

    let error = enqueue_pty_input(&sender, &vec![b'x'; MAX_PTY_INPUT_BYTES + 1]).unwrap_err();
    let value = serde_json::to_value(error).unwrap();

    assert_eq!(value["code"], "pty.input_backpressure");
}

// ---- manager 级测试（m6-024）：全部通过 insert_test_session 构造真实会话，
// 不启动子进程、不启动输入写线程、不使用 sleep。

const T1: &str = "terminal-11111111-1111-4111-8111-111111111111";
const T2: &str = "terminal-22222222-2222-4222-8222-222222222222";
const T3: &str = "terminal-33333333-3333-4333-8333-333333333333";
const T4: &str = "terminal-44444444-4444-4444-8444-444444444444";
const T5: &str = "terminal-55555555-5555-4555-8555-555555555555";
const T6: &str = "terminal-66666666-6666-4666-8666-666666666666";

fn output(session_id: &str, sequence: u64, data: &str) -> PtyEvent {
    PtyEvent::Output {
        session_id: session_id.to_string(),
        sequence,
        data_base64: data.to_string(),
    }
}

fn snapshot() -> PtyTerminalSnapshot {
    PtyTerminalSnapshot {
        data: "screen".to_string(),
        cols: 80,
        rows: 24,
    }
}

fn size() -> PtySizeUpdate {
    PtySizeUpdate {
        cols: 80,
        rows: 24,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn error_text(error: &AppError) -> String {
    error.to_string()
}

type Records = Arc<Mutex<Vec<serde_json::Value>>>;

fn records(sink: &Records) -> Vec<serde_json::Value> {
    sink.lock().unwrap().clone()
}

fn count_of(records: &[serde_json::Value], event_type: &str) -> usize {
    records
        .iter()
        .filter(|record| record["type"] == event_type)
        .count()
}

/// 所有者 T1 的会话：预留 4 个输出序号，T1 被销毁后（失主）缓冲三条输出和一条失败事件。
/// 返回会话 id、会话对象和旧所有者通道 A 的记录。
fn owner_lost_session_with_buffer(
    manager: &PtySessionManager,
) -> (String, Arc<ManagedSession>, Records) {
    let (channel_a, sink_a) = recording_channel();
    let ts = manager.insert_test_session(T1, Some(channel_a));
    let session = manager.get(&ts.session_id).unwrap();
    for expected in 1..=4u64 {
        assert_eq!(session.flow.reserve(1), Some(expected));
    }
    assert_eq!(manager.reclaim_window(T1), vec![ts.session_id.clone()]);
    for event in [
        output(&ts.session_id, 2, "b2"),
        output(&ts.session_id, 3, "b3"),
        output(&ts.session_id, 4, "b4"),
        PtyEvent::Failed {
            session_id: ts.session_id.clone(),
            message: "x".to_string(),
        },
    ] {
        session.send_event(event).unwrap();
    }
    (ts.session_id, session, sink_a)
}

fn is_paused(session: &ManagedSession) -> bool {
    session.flow.state.lock().unwrap().paused
}

#[test]
fn reclaim_window_pauses_output_and_clears_pending_handoffs() {
    let manager = PtySessionManager::default();

    // S1：所有者 T1，有未确认的输出。
    let (channel_1, sink_1) = recording_channel();
    let ts1 = manager.insert_test_session(T1, Some(channel_1));
    let s1 = ts1.session_id.clone();
    let session_1 = manager.get(&s1).unwrap();
    session_1.flow.reserve(10).unwrap();

    // S2：所有者 main，交接目标是 T2，已经 complete 但尚未 finalize。
    let (channel_2, _sink_2) = recording_channel();
    let ts2 = manager.insert_test_session("main", Some(channel_2));
    let s2 = ts2.session_id.clone();
    let session_2 = manager.get(&s2).unwrap();
    let handoff = manager.begin_handoff(&s2, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s2, "main", &handoff.token, handoff.sequence, snapshot())
        .unwrap();
    let (target_channel, _target_sink) = recording_channel();
    manager
        .complete_handoff(&s2, T2, &handoff.token, target_channel)
        .unwrap();
    assert!(session_2.flow.is_paused_at(handoff.sequence));

    // S3：所有者 T3，镜像窗口是 main。
    let (channel_3, _sink_3) = recording_channel();
    let ts3 = manager.insert_test_session(T3, Some(channel_3));
    let s3 = ts3.session_id.clone();
    let session_3 = manager.get(&s3).unwrap();
    let (mirror_3, _mirror_sink_3) = recording_channel();
    session_3.event_route.lock().unwrap().mirror = Some((
        "main".to_string(),
        Arc::new(mirror_3) as Arc<dyn PtyEventSink>,
    ));

    // S4：所有者 T4，镜像窗口是 T5。
    let (channel_4, _sink_4) = recording_channel();
    let ts4 = manager.insert_test_session(T4, Some(channel_4));
    let s4 = ts4.session_id.clone();
    let session_4 = manager.get(&s4).unwrap();
    let (mirror_4, _mirror_sink_4) = recording_channel();
    session_4.event_route.lock().unwrap().mirror =
        Some((T5.to_string(), Arc::new(mirror_4) as Arc<dyn PtyEventSink>));

    // 失主路径：所有者窗口被销毁，会话被回收给 main 并无限期暂停输出。
    assert_eq!(manager.reclaim_window(T1), vec![s1.clone()]);
    {
        let state = session_1.flow.state.lock().unwrap();
        assert!(state.paused);
        assert!(state.pause_deadline.is_none());
    }
    assert_eq!(
        manager.test_route(&s1),
        TestRoute {
            window_label: "main".into(),
            owner_lost: true,
            has_channel: false,
            buffered_events: 0,
        }
    );
    // 反向断言：回收只是改路由，不会终止进程，也不会向旧通道补发事件。
    assert_eq!(ts1.kills.load(Ordering::SeqCst), 0);
    assert!(records(&sink_1).is_empty());

    // 交接目标窗被销毁：待决交接被清除，输出恢复，所有者仍是 main。
    assert_eq!(manager.reclaim_window(T2), Vec::<String>::new());
    assert!(session_2.pending_handoff.lock().unwrap().is_none());
    assert!(!session_2.flow.is_paused_at(handoff.sequence));
    assert!(!is_paused(&session_2));
    assert_eq!(manager.test_route(&s2).window_label, "main");

    // 镜像窗是 main：main 永远不会被回收，镜像保持。
    assert_eq!(manager.reclaim_window("main"), Vec::<String>::new());
    assert!(session_3.event_route.lock().unwrap().mirror.is_some());

    // 镜像窗 T5 被销毁：只清掉镜像，所有者 T4 不变。
    assert_eq!(manager.reclaim_window(T5), Vec::<String>::new());
    assert!(session_4.event_route.lock().unwrap().mirror.is_none());
    assert_eq!(manager.test_route(&s4).window_label, T4);

    // 无关标签：任何路由都不变。
    let before: Vec<TestRoute> = [&s1, &s2, &s3, &s4]
        .iter()
        .map(|id| manager.test_route(id))
        .collect();
    assert_eq!(manager.reclaim_window(T6), Vec::<String>::new());
    let after: Vec<TestRoute> = [&s1, &s2, &s3, &s4]
        .iter()
        .map(|id| manager.test_route(id))
        .collect();
    assert_eq!(before, after);
    assert!(session_3.event_route.lock().unwrap().mirror.is_some());
    assert!(session_4.event_route.lock().unwrap().mirror.is_none());
}

#[test]
fn reattach_replays_only_buffered_events_after_snapshot_sequence() {
    let manager = PtySessionManager::default();
    let (s1, session, sink_a) = owner_lost_session_with_buffer(&manager);
    let (channel_b, sink_b) = recording_channel();

    let metadata = manager
        .reattach(&s1, "main", channel_b, snapshot(), 3, size())
        .unwrap();

    let received = records(&sink_b);
    assert_eq!(received.len(), 3);
    assert_eq!(received[0]["type"], "snapshot");
    assert_eq!(received[0]["sequence"], 3);
    assert_eq!(received[1]["type"], "output");
    assert_eq!(received[1]["sequence"], 4);
    assert_eq!(received[2]["type"], "failed");
    // 反向断言：快照序号及之前的输出不会被重放。
    assert!(!received.iter().any(|record| {
        record["type"] == "output" && (record["sequence"] == 2 || record["sequence"] == 3)
    }));
    assert_eq!(
        manager.test_route(&s1),
        TestRoute {
            window_label: "main".into(),
            owner_lost: false,
            has_channel: true,
            buffered_events: 0,
        }
    );
    {
        let route = session.event_route.lock().unwrap();
        assert_eq!(route.buffered_bytes, 0);
        assert!(route.mirror.is_none());
    }
    assert!(!is_paused(&session));
    assert_eq!(metadata.session_id, s1);
    // 反向断言：失主之后的事件没有发往旧通道。
    assert!(records(&sink_a).is_empty());
}

#[test]
fn repeated_reattach_is_rejected_without_replacing_the_live_channel() {
    let manager = PtySessionManager::default();
    let (s1, session, _sink_a) = owner_lost_session_with_buffer(&manager);
    let (channel_b, sink_b) = recording_channel();
    manager
        .reattach(&s1, "main", channel_b, snapshot(), 3, size())
        .unwrap();
    let (channel_c, sink_c) = recording_channel();

    let error = manager
        .reattach(&s1, "main", channel_c, snapshot(), 4, size())
        .unwrap_err();

    assert!(
        error_text(&error).contains("不处于可重新接管状态"),
        "{}",
        error_text(&error)
    );
    assert!(records(&sink_c).is_empty());
    session.send_event(output(&s1, 5, "b5")).unwrap();
    let received = records(&sink_b);
    let last = received.last().unwrap();
    assert_eq!(last["type"], "output");
    assert_eq!(last["sequence"], 5);
    assert!(records(&sink_c).is_empty());
    assert!(!is_paused(&session));
    // 反向断言：第二次 reattach 没有给 B 补发新的快照。
    assert_eq!(count_of(&received, "snapshot"), 1);
}

#[test]
fn reattach_requires_main_window_and_owner_lost_state() {
    // 每个子场景用独立的 manager：reclaim_window(T1) 会回收该 manager 里
    // 所有以 T1 为所有者的会话，共用 manager 会让子场景互相影响。

    // 子场景 1：非 main 窗口不能接管。
    let manager_1 = PtySessionManager::default();
    let (channel_1, _sink_1) = recording_channel();
    let ts1 = manager_1.insert_test_session(T1, Some(channel_1));
    let s1 = ts1.session_id.clone();
    manager_1.get(&s1).unwrap().flow.reserve(1).unwrap();
    assert_eq!(manager_1.reclaim_window(T1), vec![s1.clone()]);
    let (new_1, new_sink_1) = recording_channel();
    let error = manager_1
        .reattach(&s1, T1, new_1, snapshot(), 1, size())
        .unwrap_err();
    assert!(
        error_text(&error).contains("只有主窗口可以重新接管终端"),
        "{}",
        error_text(&error)
    );
    assert!(manager_1.test_route(&s1).owner_lost);

    // 子场景 2：所有者没有失主，不能接管。
    let manager_2 = PtySessionManager::default();
    let (channel_2, _sink_2) = recording_channel();
    let ts2 = manager_2.insert_test_session(T1, Some(channel_2));
    let s2 = ts2.session_id.clone();
    let (new_2, new_sink_2) = recording_channel();
    let error = manager_2
        .reattach(&s2, "main", new_2, snapshot(), 0, size())
        .unwrap_err();
    assert!(
        error_text(&error).contains("不处于可重新接管状态"),
        "{}",
        error_text(&error)
    );
    assert_eq!(manager_2.test_route(&s2).window_label, T1);

    // 子场景 3：快照尺寸非法，失主状态与缓冲保持不变。
    let manager_3 = PtySessionManager::default();
    let (channel_3, _sink_3) = recording_channel();
    let ts3 = manager_3.insert_test_session(T1, Some(channel_3));
    let s3 = ts3.session_id.clone();
    let session_3 = manager_3.get(&s3).unwrap();
    session_3.flow.reserve(1).unwrap();
    assert_eq!(manager_3.reclaim_window(T1), vec![s3.clone()]);
    session_3.send_event(output(&s3, 1, "z")).unwrap();
    let (new_3, new_sink_3) = recording_channel();
    let invalid_snapshot = PtyTerminalSnapshot {
        cols: 0,
        ..snapshot()
    };
    let error = manager_3
        .reattach(&s3, "main", new_3, invalid_snapshot, 1, size())
        .unwrap_err();
    assert!(
        error_text(&error).contains("PTY 尺寸必须至少为 1 列和 1 行"),
        "{}",
        error_text(&error)
    );
    let route_3 = manager_3.test_route(&s3);
    assert!(route_3.owner_lost);
    assert_eq!(route_3.buffered_events, 1);

    // 子场景 4：序号超过已预留的最大序号，路由未变，缓冲没有被清空。
    let manager_4 = PtySessionManager::default();
    let (channel_4, _sink_4) = recording_channel();
    let ts4 = manager_4.insert_test_session(T1, Some(channel_4));
    let s4 = ts4.session_id.clone();
    let session_4 = manager_4.get(&s4).unwrap();
    session_4.flow.reserve(1).unwrap();
    assert_eq!(manager_4.reclaim_window(T1), vec![s4.clone()]);
    session_4.send_event(output(&s4, 1, "z")).unwrap();
    let (new_4, new_sink_4) = recording_channel();
    let error = manager_4
        .reattach(&s4, "main", new_4, snapshot(), 99, size())
        .unwrap_err();
    assert!(
        error_text(&error).contains("输出确认序号超出已发送范围"),
        "{}",
        error_text(&error)
    );
    assert_eq!(
        manager_4.test_route(&s4),
        TestRoute {
            window_label: "main".into(),
            owner_lost: true,
            has_channel: false,
            buffered_events: 1,
        }
    );

    // 反向断言：失败的 reattach 不得向新通道发送任何事件。
    for sink in [&new_sink_1, &new_sink_2, &new_sink_3, &new_sink_4] {
        assert!(records(sink).is_empty());
    }
}

#[test]
fn owner_channel_failure_buffers_until_reattach_and_bounds_memory() {
    let manager = PtySessionManager::default();

    // 子场景 1：所有者通道失效，输出被缓冲并无限期暂停；标签保持 T1。
    let ts1 = manager.insert_test_session(T1, Some(failing_channel()));
    let s1 = ts1.session_id.clone();
    let session_1 = manager.get(&s1).unwrap();
    session_1
        .send_event(output(&s1, 1, &"a".repeat(10)))
        .unwrap();
    assert_eq!(
        manager.test_route(&s1),
        TestRoute {
            window_label: T1.into(),
            owner_lost: true,
            has_channel: false,
            buffered_events: 1,
        }
    );
    {
        let state = session_1.flow.state.lock().unwrap();
        assert!(state.paused);
        assert!(state.pause_deadline.is_none());
    }

    // 子场景 2：缓冲超过上限的输出被拒绝，已缓冲字节数不超过上限。
    let error = session_1
        .send_event(output(&s1, 2, &"x".repeat(MAX_OWNER_LOST_BUFFER_BYTES)))
        .unwrap_err();
    assert!(error.contains("输出缓冲区已满"), "{error}");
    assert!(session_1.event_route.lock().unwrap().buffered_bytes <= MAX_OWNER_LOST_BUFFER_BYTES);

    // 子场景 3：退出事件不受输出上限限制，仍被缓冲。
    session_1
        .send_event(PtyEvent::Exited {
            session_id: s1.clone(),
            state: "exited".to_string(),
            exit_code: Some(0),
        })
        .unwrap();
    assert!(matches!(
        session_1.event_route.lock().unwrap().buffered_events.back(),
        Some(PtyEvent::Exited { .. })
    ));

    // 子场景 4：所有者是 main 时通道失效直接报错，不触发失主暂停。
    let ts4 = manager.insert_test_session("main", Some(failing_channel()));
    let s4 = ts4.session_id.clone();
    let session_4 = manager.get(&s4).unwrap();
    let error = session_4.send_event(output(&s4, 1, "a")).unwrap_err();
    assert!(error.contains("输出通道不可用"), "{error}");
    assert!(!manager.test_route(&s4).owner_lost);
    assert!(!is_paused(&session_4));

    // 子场景 5：通道正常时事件同时发往所有者通道和 main 镜像。
    let (channel_a, sink_a) = recording_channel();
    let ts5 = manager.insert_test_session(T1, Some(channel_a));
    let s5 = ts5.session_id.clone();
    let session_5 = manager.get(&s5).unwrap();
    let (mirror, sink_m) = recording_channel();
    session_5.event_route.lock().unwrap().mirror = Some((
        "main".to_string(),
        Arc::new(mirror) as Arc<dyn PtyEventSink>,
    ));
    session_5.send_event(output(&s5, 1, "a")).unwrap();
    assert_eq!(records(&sink_a).len(), 1);
    assert_eq!(records(&sink_m).len(), 1);
}

#[test]
fn pty_input_ownership_size_and_backpressure_boundaries() {
    let manager = PtySessionManager::default();
    let (channel, _sink) = recording_channel();
    let TestSession {
        session_id: s,
        input,
        ..
    } = manager.insert_test_session(T1, Some(channel));
    let code = |error: &AppError| serde_json::to_value(error).unwrap()["code"].clone();

    // 1. 非所有者不能写入，队列保持为空。
    let error = manager.write(&s, "main", b"x").unwrap_err();
    assert!(
        error_text(&error).contains("另一个窗口控制"),
        "{}",
        error_text(&error)
    );
    assert_eq!(input.try_recv(), Err(mpsc::TryRecvError::Empty));

    // 2. 恰好等于上限的输入被接受。
    manager
        .write(&s, T1, &vec![0u8; MAX_PTY_INPUT_BYTES])
        .unwrap();
    assert_eq!(input.try_recv().unwrap().len(), MAX_PTY_INPUT_BYTES);

    // 3. 超过上限一个字节就被背压拒绝，且没有入队。
    let error = manager
        .write(&s, T1, &vec![0u8; MAX_PTY_INPUT_BYTES + 1])
        .unwrap_err();
    assert_eq!(code(&error), "pty.input_backpressure");
    assert_eq!(input.try_recv(), Err(mpsc::TryRecvError::Empty));

    // 4. 后端按字节计数而不是按字符：21846 个汉字 = 65538 字节，被拒绝。
    //    前端因此必须按字节分片（m6-036）。
    let wide = "你".repeat(21846);
    assert_eq!(wide.len(), 65538);
    let error = manager.write(&s, T1, wide.as_bytes()).unwrap_err();
    assert_eq!(code(&error), "pty.input_backpressure");
    assert_eq!(input.try_recv(), Err(mpsc::TryRecvError::Empty));

    // 5. 队列容量为 32：第 33 次写入被背压拒绝，读空后恰为 32 条。
    for _ in 0..PTY_INPUT_QUEUE_CAPACITY {
        manager.write(&s, T1, b"y").unwrap();
    }
    let error = manager.write(&s, T1, b"y").unwrap_err();
    assert_eq!(code(&error), "pty.input_backpressure");
    let mut drained = 0;
    while input.try_recv().is_ok() {
        drained += 1;
    }
    assert_eq!(drained, PTY_INPUT_QUEUE_CAPACITY);

    // 6. 写线程退出（接收端被丢弃）之后返回 unavailable。
    drop(input);
    let error = manager.write(&s, T1, b"z").unwrap_err();
    assert_eq!(code(&error), "pty.input_unavailable");
}

// ---- m6-025：窗口状态报告与交接状态机

const T9: &str = "terminal-99999999-9999-4999-8999-999999999999";
const CONTENT: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";

#[test]
fn window_status_report_includes_owner_label() {
    let manager = PtySessionManager::default();
    let (channel_1, _sink_1) = recording_channel();
    let s1 = manager.insert_test_session(T1, Some(channel_1)).session_id;
    let session_1 = manager.get(&s1).unwrap();

    // 所有者本人查询：Running；其他窗口查询：OwnedByAnotherWindow，两者都带所有者标签。
    assert_eq!(
        manager.window_status_report(&s1, T1).unwrap(),
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::Running,
            owner_window_label: Some(T1.to_string()),
        }
    );
    let foreign = manager.window_status_report(&s1, "main").unwrap();
    assert_eq!(
        foreign,
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::OwnedByAnotherWindow,
            owner_window_label: Some(T1.to_string()),
        }
    );

    // 序列化键恰为 ownerWindowLabel 与 status（驼峰），值与上面一致。
    let serialized = serde_json::to_value(&foreign).unwrap();
    let mut keys: Vec<&str> = serialized
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["ownerWindowLabel", "status"]);
    assert_eq!(serialized["status"], "ownedByAnotherWindow");
    assert_eq!(serialized["ownerWindowLabel"], T1);

    // 会话结束（输出流关闭）后没有所有者标签；序列化为 JSON null 而不是缺失。
    session_1.flow.close();
    let ended = manager.window_status_report(&s1, T1).unwrap();
    assert_eq!(
        ended,
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::Ended,
            owner_window_label: None,
        }
    );
    assert!(serde_json::to_value(&ended).unwrap()["ownerWindowLabel"].is_null());

    // 不存在的会话同样报告 Ended 且没有所有者标签。
    assert_eq!(
        manager.window_status_report("missing", T1).unwrap(),
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::Ended,
            owner_window_label: None,
        }
    );

    // 所有者窗口被销毁后会话归还 main：main 查询得到 Running 且标签为 main。
    let (channel_2, _sink_2) = recording_channel();
    let s2 = manager.insert_test_session(T2, Some(channel_2)).session_id;
    assert_eq!(manager.reclaim_window(T2), vec![s2.clone()]);
    assert_eq!(
        manager.window_status_report(&s2, "main").unwrap(),
        PtySessionWindowStatusReport {
            status: PtySessionWindowStatus::Running,
            owner_window_label: Some("main".to_string()),
        }
    );
}

fn assert_rejected<T: std::fmt::Debug>(result: Result<T, AppError>, needle: &str) {
    let error = result.unwrap_err();
    assert!(
        error_text(&error).contains(needle),
        "expected {needle:?} in {:?}",
        error_text(&error)
    );
}

fn ch() -> Channel<PtyEvent> {
    recording_channel().0
}

/// 所有者为 main 的新会话，返回会话 id 与会话对象。
fn main_owned_session(manager: &PtySessionManager) -> (String, Arc<ManagedSession>) {
    let s = manager.insert_test_session("main", Some(ch())).session_id;
    let session = manager.get(&s).unwrap();
    (s, session)
}

#[test]
fn finalized_handoff_rejects_source_cancel_in_manager() {
    let manager = PtySessionManager::default();
    let (channel_a, _sink_a) = recording_channel();
    let s1 = manager
        .insert_test_session("main", Some(channel_a))
        .session_id;
    let session = manager.get(&s1).unwrap();
    session.flow.reserve(10).unwrap();
    let handoff = manager.begin_handoff(&s1, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s1, "main", &handoff.token, handoff.sequence, snapshot())
        .unwrap();
    let (channel_b, sink_b) = recording_channel();
    manager
        .complete_handoff(&s1, T1, &handoff.token, channel_b)
        .unwrap();

    manager
        .finalize_handoff(&s1, T1, &handoff.token, size())
        .unwrap();

    let after_finalize = TestRoute {
        window_label: T1.into(),
        owner_lost: false,
        has_channel: true,
        buffered_events: 0,
    };
    assert_eq!(manager.test_route(&s1), after_finalize);
    {
        let route = session.event_route.lock().unwrap();
        let (label, _) = route.mirror.as_ref().expect("source keeps a mirror");
        assert_eq!(label, "main");
    }
    assert!(session.pending_handoff.lock().unwrap().is_none());
    assert!(!is_paused(&session));

    // 源窗口（main）在交接完成后不能再取消；新所有者取消是无操作，路由不变。
    assert_rejected(
        manager.cancel_handoff(&s1, "main", &handoff.token),
        "另一个窗口控制",
    );
    assert_eq!(
        manager.window_status_report(&s1, "main").unwrap().status,
        PtySessionWindowStatus::OwnedByAnotherWindow
    );
    assert_eq!(
        manager.window_status_report(&s1, T1).unwrap().status,
        PtySessionWindowStatus::Running
    );
    manager.cancel_handoff(&s1, T1, &handoff.token).unwrap();
    assert_eq!(manager.test_route(&s1), after_finalize);

    // 反向断言：目标窗口收到过快照；源窗口取消失败之后所有者仍是 T1。
    assert_eq!(records(&sink_b)[0]["type"], "snapshot");
    assert_eq!(manager.test_route(&s1).window_label, T1);
}

#[test]
fn handoff_state_machine_rejects_illegal_transitions() {
    // 子用例 1：令牌不匹配。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    assert_rejected(
        manager.stage_handoff_snapshot(&s, "main", "wrong-token", h.sequence, snapshot()),
        "交接已过期",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 2：序号不匹配。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    assert_rejected(
        manager.stage_handoff_snapshot(&s, "main", &h.token, h.sequence + 1, snapshot()),
        "交接已过期",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 3：非所有者窗口不能准备快照。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    assert_rejected(
        manager.stage_handoff_snapshot(&s, T9, &h.token, h.sequence, snapshot()),
        "另一个窗口控制",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 4：快照没有准备好就接管。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    assert_rejected(
        manager.complete_handoff(&s, T1, &h.token, ch()),
        "画面尚未准备好",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 5：目标不是工作台窗口（文件内容窗）。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();
    assert_rejected(
        manager.complete_handoff(&s, CONTENT, &h.token, ch()),
        "目标窗口不允许接管终端",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 6：同一个交接被重复接管。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();
    manager.complete_handoff(&s, T1, &h.token, ch()).unwrap();
    assert_rejected(
        manager.complete_handoff(&s, T1, &h.token, ch()),
        "已经准备接管",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 7：目标窗口还没 complete 就 finalize。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();
    assert_rejected(
        manager.finalize_handoff(&s, T1, &h.token, size()),
        "交接状态已失效",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 8：finalize 的窗口不是 complete 时登记的目标。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();
    manager.complete_handoff(&s, T1, &h.token, ch()).unwrap();
    assert_rejected(
        manager.finalize_handoff(&s, T2, &h.token, size()),
        "交接状态已失效",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 9：暂停仍有效时不能再发起新的交接。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    manager.begin_handoff(&s, "main").unwrap();
    assert_rejected(manager.begin_handoff(&s, "main"), "正在进行窗口交接");
    assert_eq!(manager.test_route(&s), before);

    // 子用例 10：暂停过期之后 complete 被拒绝。
    let manager = PtySessionManager::default();
    let (s, session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();
    session.flow.state.lock().unwrap().pause_deadline =
        Some(std::time::Instant::now() - std::time::Duration::from_millis(1));
    assert_rejected(manager.complete_handoff(&s, T1, &h.token, ch()), "交接超时");
    assert_eq!(manager.test_route(&s), before);

    // 子用例 11：暂停过期后重新发起交接会废弃旧令牌。
    let manager = PtySessionManager::default();
    let (s, session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h1 = manager.begin_handoff(&s, "main").unwrap();
    session.flow.state.lock().unwrap().pause_deadline =
        Some(std::time::Instant::now() - std::time::Duration::from_millis(1));
    let h2 = manager.begin_handoff(&s, "main").unwrap();
    assert_ne!(h2.token, h1.token);
    assert_rejected(
        manager.stage_handoff_snapshot(&s, "main", &h1.token, h1.sequence, snapshot()),
        "交接已过期",
    );
    assert_eq!(manager.test_route(&s), before);

    // 子用例 12：错误令牌的取消被拒绝，待决交接保留。
    let manager = PtySessionManager::default();
    let (s, _session) = main_owned_session(&manager);
    let before = manager.test_route(&s);
    let h = manager.begin_handoff(&s, "main").unwrap();
    assert_rejected(manager.cancel_handoff(&s, "main", "bad-token"), "令牌无效");
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();
    assert_eq!(manager.test_route(&s), before);

    // 子用例 13：目标窗口 complete 之后源窗口被销毁，finalize 被拒绝。
    let manager = PtySessionManager::default();
    let (channel, _sink) = recording_channel();
    let s = manager.insert_test_session(T1, Some(channel)).session_id;
    let h = manager.begin_handoff(&s, T1).unwrap();
    manager
        .stage_handoff_snapshot(&s, T1, &h.token, h.sequence, snapshot())
        .unwrap();
    manager
        .complete_handoff(&s, "main", &h.token, ch())
        .unwrap();
    assert_eq!(manager.reclaim_window(T1), vec![s.clone()]);
    assert_rejected(
        manager.finalize_handoff(&s, "main", &h.token, size()),
        "交接状态已失效",
    );
    assert_eq!(
        manager.test_route(&s),
        TestRoute {
            window_label: "main".into(),
            owner_lost: true,
            has_channel: false,
            buffered_events: 0,
        }
    );
}

#[test]
fn handoff_target_equal_to_source_is_rejected() {
    // PD-09（已确认）：交接目标等于源窗口必须被拒绝，错误码 pty.handoff_target_is_source。
    // 当前代码返回 Ok（T2-N13），由 m6-037 实现拒绝逻辑后去掉 #[ignore]。
    let manager = PtySessionManager::default();
    let (s, session) = main_owned_session(&manager);
    let h = manager.begin_handoff(&s, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();
    let before = manager.test_route(&s);
    let paused_before = is_paused(&session);

    let error = manager
        .complete_handoff(&s, "main", &h.token, ch())
        .unwrap_err();

    assert_eq!(
        serde_json::to_value(&error).unwrap()["code"],
        "pty.handoff_target_is_source"
    );
    assert_eq!(manager.test_route(&s), before);
    assert_eq!(is_paused(&session), paused_before);
}

#[test]
fn handoff_target_rejection_keeps_the_pending_handoff_usable() {
    // PD-09：拒绝不得写入目标或改变路由，之后用正确目标仍可完成同一次交接。
    let manager = PtySessionManager::default();
    let (s, session) = main_owned_session(&manager);
    let h = manager.begin_handoff(&s, "main").unwrap();
    manager
        .stage_handoff_snapshot(&s, "main", &h.token, h.sequence, snapshot())
        .unwrap();

    let error = manager
        .complete_handoff(&s, "main", &h.token, ch())
        .unwrap_err();
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(value["code"], "pty.handoff_target_is_source");
    assert!(value["message"]
        .as_str()
        .unwrap()
        .contains("目标窗口与源窗口相同"));
    assert!(session
        .pending_handoff
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .target_window_label
        .is_none());

    manager
        .complete_handoff(&s, T1, &h.token, recording_channel().0)
        .unwrap();
    manager.finalize_handoff(&s, T1, &h.token, size()).unwrap();
    assert_eq!(manager.test_route(&s).window_label, T1);
}

#[test]
fn exit_cleanup_target_reports_zero_for_an_empty_manager() {
    use crate::services::exit_cleanup::ExitCleanupTarget;

    let manager = PtySessionManager::default();
    let target: &dyn ExitCleanupTarget = &manager;
    assert_eq!(target.name(), "pty_sessions");
    assert_eq!(
        target
            .terminate_all(std::time::Duration::from_millis(100))
            .unwrap(),
        0
    );
    assert_eq!(
        target
            .terminate_all(std::time::Duration::from_millis(100))
            .unwrap(),
        0
    );
    assert_eq!(manager.active_count(), 0);
}

#[test]
fn terminate_all_terminates_real_pty_process_trees() {
    let manager = PtySessionManager::default();
    let first = manager.insert_test_session_with_child("main", None);
    let second = manager.insert_test_session_with_child("main", None);
    assert_eq!(manager.active_count(), 2);
    assert!(manager.get(&first.session_id).is_ok());
    assert!(manager.get(&second.session_id).is_ok());

    let started = std::time::Instant::now();
    manager.terminate_all().expect("terminate_all must succeed");

    assert_eq!(manager.active_count(), 0);
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    // The monitor sets `exited` only after `child.wait()` returned, so it is
    // the equivalent of `try_wait() == Some(_)`.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while !(first.exited.load(Ordering::SeqCst) && second.exited.load(Ordering::SeqCst)) {
        assert!(
            std::time::Instant::now() < deadline,
            "child processes must have exited"
        );
        thread::sleep(std::time::Duration::from_millis(10));
    }
}

const MONITOR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn event_types(events: &Arc<Mutex<Vec<serde_json::Value>>>) -> Vec<String> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| event["type"].as_str().map(str::to_string))
        .collect()
}

#[test]
fn child_monitor_persists_exit_once_removes_the_session_and_delivers_exited() {
    let manager = PtySessionManager::default();
    let (channel, events) = recording_channel();
    let inserted = manager.insert_test_session("main", Some(channel));
    let session = manager.get(&inserted.session_id).unwrap();
    let (child, _master) = spawn_test_child(quick_exit_test_command(3));
    let (store, finished) = FakeStore::new();

    spawn_child_monitor(
        Arc::clone(&session),
        child,
        store.clone(),
        manager.registry_handle(),
    )
    .expect("spawn monitor");

    finished
        .recv_timeout(MONITOR_TIMEOUT)
        .expect("the monitor must persist the exit");
    assert!(
        wait_until(MONITOR_TIMEOUT, || {
            event_types(&events).contains(&"exited".to_string()) && manager.active_count() == 0
        }),
        "the exited event must be delivered and the session removed"
    );

    assert_eq!(
        *store.finished.lock().unwrap(),
        vec![(inserted.session_id.clone(), "exited".to_string(), Some(3))]
    );
    assert_eq!(manager.active_count(), 0);
    let exited: Vec<serde_json::Value> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "exited")
        .cloned()
        .collect();
    assert_eq!(exited.len(), 1);
    assert_eq!(exited[0]["state"], "exited");
    assert_eq!(exited[0]["exitCode"], 3);
    assert!(session.flow.is_closed());
}

#[test]
fn child_monitor_reports_terminated_when_termination_was_requested() {
    let manager = PtySessionManager::default();
    let (channel, events) = recording_channel();
    let inserted = manager.insert_test_session("main", Some(channel));
    let session = manager.get(&inserted.session_id).unwrap();
    let (child, _master) = spawn_test_child(long_running_test_command());
    let mut killer = child.clone_killer();
    let (store, finished) = FakeStore::new();
    session.termination_requested.store(true, Ordering::Release);

    spawn_child_monitor(
        Arc::clone(&session),
        child,
        store.clone(),
        manager.registry_handle(),
    )
    .expect("spawn monitor");
    // portable-pty 0.9 on Windows returns the last OS error from `kill` even
    // when `TerminateProcess` succeeded, so only the monitor's view counts.
    let _ = killer.kill();

    finished
        .recv_timeout(MONITOR_TIMEOUT)
        .expect("the monitor must persist the termination");
    assert!(
        wait_until(MONITOR_TIMEOUT, || manager.active_count() == 0),
        "the session must be removed"
    );

    let rows = store.finished.lock().unwrap().clone();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, inserted.session_id);
    assert_eq!(rows[0].1, "terminated");
    assert!(rows[0].2.is_some());
    assert!(wait_until(MONITOR_TIMEOUT, || event_types(&events)
        .contains(&"exited".to_string())));
}

#[test]
fn child_monitor_survives_a_persistence_failure() {
    let manager = PtySessionManager::default();
    let (channel, events) = recording_channel();
    let inserted = manager.insert_test_session("main", Some(channel));
    let session = manager.get(&inserted.session_id).unwrap();
    let (child, _master) = spawn_test_child(quick_exit_test_command(3));
    let (store, finished) = FakeStore::new();
    store.fail_finish.store(true, Ordering::SeqCst);

    spawn_child_monitor(
        Arc::clone(&session),
        child,
        store.clone(),
        manager.registry_handle(),
    )
    .expect("spawn monitor");

    finished
        .recv_timeout(MONITOR_TIMEOUT)
        .expect("finish must have been attempted");
    assert!(
        wait_until(MONITOR_TIMEOUT, || {
            event_types(&events).contains(&"exited".to_string()) && manager.active_count() == 0
        }),
        "the exited event must still be delivered and the session removed"
    );

    assert_eq!(store.finished.lock().unwrap().len(), 1);
    assert_eq!(manager.active_count(), 0);
}
