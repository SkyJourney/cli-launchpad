use super::*;
use crate::models::pty_session::PtySessionState;
#[cfg(test)]
use crate::models::window_kind::test_label;
use std::sync::mpsc::{self, Receiver};

use anyhow::anyhow;
use portable_pty::ChildKiller;

/// 测试用的 `ChildKiller`：只记录 `kill` 被调用的次数，不触碰任何进程。
#[cfg(test)]
#[derive(Debug)]
struct FakeKiller(Arc<std::sync::atomic::AtomicUsize>);

#[cfg(test)]
impl ChildKiller for FakeKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(FakeKiller(Arc::clone(&self.0)))
    }
}

/// 把发往通道的 JSON 事件记录下来的通道替身。
#[cfg(test)]
pub(crate) fn recording_channel() -> (Channel<PtyEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
    let sink: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let writer = Arc::clone(&sink);
    let channel = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            writer
                .lock()
                .unwrap()
                .push(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, sink)
}

/// 每次发送都失败的通道替身，用来模拟所有者窗口已销毁。
#[cfg(test)]
pub(crate) fn failing_channel() -> Channel<PtyEvent> {
    Channel::new(|_| Err(tauri::Error::Anyhow(anyhow!("closed"))))
}

/// `insert_test_session` 的返回值。不暴露私有的 `ManagedSession`（会触发
/// `private_interfaces` 警告）：同模块的测试用 `PtySessionManager::get` 取会话。
#[cfg(test)]
pub(crate) struct TestSession {
    pub session_id: String,
    pub input: Receiver<Vec<u8>>,
    pub kills: Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TestRoute {
    pub window_label: String,
    pub owner_lost: bool,
    pub has_channel: bool,
    pub buffered_events: usize,
}

#[cfg(test)]
impl PtySessionManager {
    /// 不启动子进程、不启动输入写线程，直接把一个带通道的会话放进会话表。
    pub(crate) fn insert_test_session(
        &self,
        owner_label: &str,
        channel: Option<Channel<PtyEvent>>,
    ) -> TestSession {
        self.insert_test_session_in_directory(owner_label, 1, channel)
    }

    /// 与 `insert_test_session` 相同，只是 `directory_id` 可指定。
    pub(crate) fn insert_test_session_in_directory(
        &self,
        owner_label: &str,
        directory_id: i64,
        channel: Option<Channel<PtyEvent>>,
    ) -> TestSession {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty must succeed for PTY manager tests");
        drop(pair.slave);
        let kills = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (writer, input) = pty_input_channel();
        let session_id = Uuid::new_v4().to_string();
        let session = Arc::new(ManagedSession {
            session_id: session_id.clone(),
            directory_id,
            tool_key: ToolKey::Claude,
            working_directory: "C:/project".to_string(),
            started_at_ms: 0,
            terminal: Mutex::new(TerminalState {
                master: Some(pair.master),
                last_size: (80, 24),
            }),
            writer,
            killer: Mutex::new(Box::new(FakeKiller(Arc::clone(&kills)))),
            process_tree: Mutex::new(None),
            flow: Arc::new(OutputFlow::new()),
            route_and_handoff: Mutex::new(RouteAndHandoff {
                route: EventRoute {
                    window_label: test_label(owner_label),
                    channel: channel.map(|channel| Arc::new(channel) as Arc<dyn PtyEventSink>),
                    mirror: None,
                    owner_lost: false,
                    buffered_events: VecDeque::new(),
                    buffered_bytes: 0,
                    epoch: 0,
                    reattaching: false,
                },
                handoff: HandoffState::Idle,
            }),
            first_output_logged: AtomicBool::new(false),
            output_chunks: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            acknowledgement_calls: AtomicU64::new(0),
            last_acknowledged_sequence: AtomicU64::new(0),
            termination_requested: AtomicBool::new(false),
            reader_done: AtomicBool::new(false),
        });
        self.registry.insert(session).unwrap();
        TestSession {
            session_id,
            input,
            kills,
        }
    }

    /// Test seam: forgets a session registered with `insert_test_session`.
    pub(crate) fn remove_test_session(&self, session_id: &str) {
        self.registry.remove(session_id);
    }

    pub(crate) fn test_route(&self, session_id: &str) -> TestRoute {
        let session = self.get(session_id).expect("test session must exist");
        let route = session.route_guard();
        TestRoute {
            window_label: route.window_label.as_str().to_string(),
            owner_lost: route.owner_lost,
            has_channel: route.channel.is_some(),
            buffered_events: route.buffered_events.len(),
        }
    }

    /// 会话上是否还有未结束的交接记录（测试用只读 helper）。
    pub(crate) fn has_pending_handoff(&self, session_id: &str) -> bool {
        let session = self.get(session_id).expect("test session must exist");
        let state = session.handoff_guard();
        !state.is_idle()
    }

    /// 与 `insert_test_session` 相同，但会话背后是真实的 PTY 子进程：真实 killer、真实进程树，
    /// 并有一个只等待子进程退出的监控线程。`exited` 在 `child.wait()` 返回之后才置位。
    pub(crate) fn insert_test_session_with_child(
        &self,
        owner_label: &str,
        channel: Option<Channel<PtyEvent>>,
    ) -> TestChildSession {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty must succeed for PTY manager tests");
        let mut child = pair
            .slave
            .spawn_command(long_running_test_command())
            .expect("spawn PTY test child");
        drop(pair.slave);
        let process_tree = ProcessTree::new().expect("create process tree");
        attach_pty_or_terminate(&process_tree, &mut child, &*pair.master)
            .expect("attach PTY child to the process tree");
        let (writer, _input) = pty_input_channel();
        let session_id = Uuid::new_v4().to_string();
        let session = Arc::new(ManagedSession {
            session_id: session_id.clone(),
            directory_id: 1,
            tool_key: ToolKey::Claude,
            working_directory: "C:/project".to_string(),
            started_at_ms: 0,
            terminal: Mutex::new(TerminalState {
                master: Some(pair.master),
                last_size: (80, 24),
            }),
            writer,
            killer: Mutex::new(child.clone_killer()),
            process_tree: Mutex::new(Some(process_tree)),
            flow: Arc::new(OutputFlow::new()),
            route_and_handoff: Mutex::new(RouteAndHandoff {
                route: EventRoute {
                    window_label: test_label(owner_label),
                    channel: channel.map(|channel| Arc::new(channel) as Arc<dyn PtyEventSink>),
                    mirror: None,
                    owner_lost: false,
                    buffered_events: VecDeque::new(),
                    buffered_bytes: 0,
                    epoch: 0,
                    reattaching: false,
                },
                handoff: HandoffState::Idle,
            }),
            first_output_logged: AtomicBool::new(false),
            output_chunks: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            acknowledgement_calls: AtomicU64::new(0),
            last_acknowledged_sequence: AtomicU64::new(0),
            termination_requested: AtomicBool::new(false),
            reader_done: AtomicBool::new(false),
        });
        self.registry.insert(session).unwrap();

        let exited = Arc::new(AtomicBool::new(false));
        let registry = self.registry_handle();
        let monitor_exited = Arc::clone(&exited);
        let monitor_id = session_id.clone();
        thread::Builder::new()
            .name(format!("pty-test-monitor-{session_id}"))
            .spawn(move || {
                let _ = child.wait();
                monitor_exited.store(true, Ordering::SeqCst);
                registry.remove(&monitor_id);
            })
            .expect("spawn test monitor");
        TestChildSession { session_id, exited }
    }

    /// A session backed by a real PTY child, built like the production launch: the session owns
    /// the real master and process tree. Returns the child (for `spawn_child_monitor`) and a
    /// reader that also answers the ConPTY cursor position request (for `spawn_output_reader`).
    pub(crate) fn insert_test_session_with_real_pty(
        &self,
        owner_label: &str,
        channel: Option<Channel<PtyEvent>>,
        command: CommandBuilder,
    ) -> (
        String,
        Box<dyn PtyChild + Send + Sync>,
        Box<dyn std::io::Read + Send>,
    ) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty must succeed for PTY manager tests");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn PTY test child");
        drop(pair.slave);
        let process_tree = ProcessTree::new().expect("create process tree");
        attach_pty_or_terminate(&process_tree, &mut child, &*pair.master)
            .expect("attach PTY child to the process tree");
        let reader = dsr_answering_reader(
            pair.master
                .try_clone_reader()
                .expect("clone the PTY reader"),
            pair.master.take_writer().expect("take the PTY writer"),
        );
        let (writer, _input) = pty_input_channel();
        let session_id = Uuid::new_v4().to_string();
        let session = Arc::new(ManagedSession {
            session_id: session_id.clone(),
            directory_id: 1,
            tool_key: ToolKey::Claude,
            working_directory: "C:/project".to_string(),
            started_at_ms: 0,
            terminal: Mutex::new(TerminalState {
                master: Some(pair.master),
                last_size: (80, 24),
            }),
            writer,
            killer: Mutex::new(child.clone_killer()),
            process_tree: Mutex::new(Some(process_tree)),
            flow: Arc::new(OutputFlow::new()),
            route_and_handoff: Mutex::new(RouteAndHandoff {
                route: EventRoute {
                    window_label: test_label(owner_label),
                    channel: channel.map(|channel| Arc::new(channel) as Arc<dyn PtyEventSink>),
                    mirror: None,
                    owner_lost: false,
                    buffered_events: VecDeque::new(),
                    buffered_bytes: 0,
                    epoch: 0,
                    reattaching: false,
                },
                handoff: HandoffState::Idle,
            }),
            first_output_logged: AtomicBool::new(false),
            output_chunks: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            acknowledgement_calls: AtomicU64::new(0),
            last_acknowledged_sequence: AtomicU64::new(0),
            termination_requested: AtomicBool::new(false),
            reader_done: AtomicBool::new(false),
        });
        self.registry.insert(session).unwrap();
        (session_id, child, reader)
    }
}

/// `insert_test_session_with_child` 的返回值。
#[cfg(test)]
pub(crate) struct TestChildSession {
    pub session_id: String,
    /// 监控线程在 `child.wait()` 返回之后置位。
    pub exited: Arc<AtomicBool>,
}

#[cfg(test)]
pub(crate) fn long_running_test_command() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new(crate::platform::detect::system32(
            "WindowsPowerShell\\v1.0\\powershell.exe",
        ));
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 60"]);
        command
    }
}

#[cfg(test)]
type StoreHook = Box<dyn Fn(&str) + Send + Sync>;

/// 记录 `finish` 调用的 `PtySessionStore` 替身。`fail_finish` 为 true 时记录之后返回错误。
#[cfg(test)]

pub(crate) struct FakeStore {
    pub inserted: Mutex<Vec<String>>,
    pub finished: Mutex<Vec<(String, String, Option<i64>)>>,
    pub fail_finish: AtomicBool,
    finish_failures_remaining: std::sync::atomic::AtomicUsize,
    insert_failures_remaining: std::sync::atomic::AtomicUsize,
    calls: Mutex<Vec<String>>,
    on_insert: Mutex<Option<StoreHook>>,
    on_finish: Mutex<Option<StoreHook>>,
    notify: Mutex<Option<mpsc::SyncSender<()>>>,
}

#[cfg(test)]
impl FakeStore {
    /// 返回替身与一个“每次 finish 之后收到一条通知”的接收端。
    pub(crate) fn new() -> (Arc<Self>, Receiver<()>) {
        let (sender, receiver) = mpsc::sync_channel(16);
        let store = Arc::new(Self {
            inserted: Mutex::new(Vec::new()),
            finished: Mutex::new(Vec::new()),
            fail_finish: AtomicBool::new(false),
            finish_failures_remaining: std::sync::atomic::AtomicUsize::new(0),
            insert_failures_remaining: std::sync::atomic::AtomicUsize::new(0),
            calls: Mutex::new(Vec::new()),
            on_insert: Mutex::new(None),
            on_finish: Mutex::new(None),
            notify: Mutex::new(Some(sender)),
        });
        (store, receiver)
    }

    /// 接下来的 `n` 次 `finish` 失败（设置为 0 即取消）。
    pub(crate) fn fail_next_finishes(&self, n: usize) {
        self.finish_failures_remaining.store(n, Ordering::SeqCst);
    }

    /// 接下来的 `n` 次 `insert_running` 失败（设置为 0 即取消）。
    pub(crate) fn fail_next_inserts(&self, n: usize) {
        self.insert_failures_remaining.store(n, Ordering::SeqCst);
    }

    /// 按调用顺序记录 `insert:<id>` 与 `finish:<id>:<state>`，失败的调用也记录。
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    /// 每次 `insert_running` 开始时调用（参数为会话 ID）。
    pub(crate) fn set_on_insert(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        *self.on_insert.lock().unwrap() = Some(Box::new(hook));
    }

    /// 每次 `finish` 开始时调用（参数为会话 ID）。
    pub(crate) fn set_on_finish(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.on_finish.lock().unwrap() = Some(Box::new(move |_| hook()));
    }
}

#[cfg(test)]
impl PtySessionStore for FakeStore {
    fn insert_running(
        &self,
        session_id: &str,
        _directory_id: i64,
        _tool_key: ToolKey,
        _working_directory: &str,
        _started_at_ms: i64,
    ) -> Result<(), AppError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("insert:{session_id}"));
        if let Some(hook) = self.on_insert.lock().unwrap().as_ref() {
            hook(session_id);
        }
        let remaining = self.insert_failures_remaining.load(Ordering::SeqCst);
        if remaining > 0 {
            self.insert_failures_remaining
                .store(remaining - 1, Ordering::SeqCst);
            return Err(AppError::internal("injected insert failure"));
        }
        self.inserted.lock().unwrap().push(session_id.to_string());
        Ok(())
    }

    fn finish(
        &self,
        session_id: &str,
        state: PtySessionState,
        _ended_at_ms: i64,
        exit_code: Option<i64>,
    ) -> Result<(), AppError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("finish:{session_id}:{state}"));
        self.finished
            .lock()
            .unwrap()
            .push((session_id.to_string(), state.to_string(), exit_code));
        if let Some(notify) = self.notify.lock().unwrap().as_ref() {
            let _ = notify.try_send(());
        }
        if let Some(hook) = self.on_finish.lock().unwrap().as_ref() {
            hook(session_id);
        }
        let remaining = self.finish_failures_remaining.load(Ordering::SeqCst);
        if remaining > 0 {
            self.finish_failures_remaining
                .store(remaining - 1, Ordering::SeqCst);
            return Err(AppError::internal("injected persistence failure"));
        }
        if self.fail_finish.load(Ordering::SeqCst) {
            return Err(AppError::internal("injected persistence failure"));
        }
        Ok(())
    }
}

/// 立即以给定退出码结束的真实子进程命令。
#[cfg(test)]
pub(crate) fn quick_exit_test_command(code: i32) -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new(crate::platform::detect::system32(
            "WindowsPowerShell\\v1.0\\powershell.exe",
        ));
        command.args([
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            format!("exit {code}"),
        ]);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c".to_string(), format!("exit {code}")]);
        command
    }
}

/// 终端启动时 ConPTY 发出的光标位置请求（ESC [ 6 n）与终端应答（ESC [ 1 ; 1 R）。
#[cfg(test)]
const DSR_REQUEST: &[u8] = &[0x1b, 0x5b, 0x36, 0x6e];
#[cfg(test)]
const DSR_REPLY: &[u8] = &[0x1b, 0x5b, 0x31, 0x3b, 0x31, 0x52];

/// 在新的 PTY 上启动真实子进程。返回的 master 必须由调用者保持存活直到子进程结束。
#[cfg(test)]
pub(crate) fn spawn_test_child(
    command: CommandBuilder,
) -> (
    Box<dyn PtyChild + Send + Sync>,
    Box<dyn portable_pty::MasterPty + Send>,
) {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty must succeed for PTY manager tests");
    let child = pair
        .slave
        .spawn_command(command)
        .expect("spawn PTY test child");
    drop(pair.slave);
    // Like the production terminal (xterm), keep reading the output and answer the
    // cursor position request ConPTY issues at startup; without both a child can
    // block before it ever runs.
    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("clone the PTY reader");
    let mut writer = pair.master.take_writer().expect("take the PTY writer");
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(read) = std::io::Read::read(&mut reader, &mut buffer) {
            if read == 0 {
                break;
            }
            if buffer[..read]
                .windows(DSR_REQUEST.len())
                .any(|window| window == DSR_REQUEST)
            {
                let _ = std::io::Write::write_all(&mut writer, DSR_REPLY);
                let _ = std::io::Write::flush(&mut writer);
            }
        }
    });
    (child, pair.master)
}

/// Wraps a PTY reader so the cursor position request ConPTY issues at startup is answered
/// through `writer` (without the answer a child can block before it ever runs). The data is
/// passed through unchanged.
#[cfg(test)]
pub(crate) fn dsr_answering_reader(
    reader: Box<dyn std::io::Read + Send>,
    writer: Box<dyn std::io::Write + Send>,
) -> Box<dyn std::io::Read + Send> {
    struct Answering {
        reader: Box<dyn std::io::Read + Send>,
        writer: Box<dyn std::io::Write + Send>,
    }
    impl std::io::Read for Answering {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.reader.read(buffer)?;
            if buffer[..read]
                .windows(DSR_REQUEST.len())
                .any(|window| window == DSR_REQUEST)
            {
                let _ = self.writer.write_all(DSR_REPLY);
                let _ = self.writer.flush();
            }
            Ok(read)
        }
    }
    Box::new(Answering { reader, writer })
}

/// 在截止时间之前轮询条件（10 ms 间隔）；超时返回 false。
#[cfg(test)]
pub(crate) fn wait_until(
    timeout: std::time::Duration,
    mut condition: impl FnMut() -> bool,
) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if condition() {
            return true;
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }
    condition()
}

/// 记录事件的 `PtyEventSink` 替身；`fail_next_with` 让下一次 `send` 返回该文本的错误（一次性）。
#[cfg(test)]
pub(crate) struct FakeSink {
    events: Mutex<Vec<PtyEvent>>,
    fail_with: Mutex<Option<String>>,
}

#[cfg(test)]
impl FakeSink {
    pub(crate) fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            fail_with: Mutex::new(None),
        }
    }

    pub(crate) fn events(&self) -> Vec<PtyEvent> {
        self.events.lock().unwrap().clone()
    }

    pub(crate) fn fail_next_with(&self, message: &str) {
        *self.fail_with.lock().unwrap() = Some(message.to_string());
    }
}

#[cfg(test)]
impl PtyEventSink for FakeSink {
    fn send(&self, event: PtyEvent) -> Result<(), String> {
        if let Some(message) = self.fail_with.lock().unwrap().take() {
            return Err(message);
        }
        self.events.lock().unwrap().push(event);
        Ok(())
    }
}

/// 发送时阻塞的通道替身：返回 (channel, entered_rx, release_tx)。回调每次开始时向 `entered_rx`
/// 发一个单元，然后最多等 10 秒从 `release_tx` 取一个放行单元。
#[cfg(test)]
pub(crate) fn blocking_channel() -> (Channel<PtyEvent>, Receiver<()>, mpsc::SyncSender<()>) {
    let (entered_tx, entered_rx) = mpsc::sync_channel::<()>(16);
    let (release_tx, release_rx) = mpsc::sync_channel::<()>(16);
    let release_rx = Arc::new(Mutex::new(release_rx));
    let channel = Channel::new(move |_body| {
        let _ = entered_tx.try_send(());
        let _ = release_rx
            .lock()
            .unwrap()
            .recv_timeout(std::time::Duration::from_secs(10));
        Ok(())
    });
    (channel, entered_rx, release_tx)
}

/// 在返回 `Err("closed")` 之前先调用 `before_failing` 的通道替身。
#[cfg(test)]
pub(crate) fn failing_channel_with(
    before_failing: impl Fn() + Send + Sync + 'static,
) -> Channel<PtyEvent> {
    Channel::new(move |_| {
        before_failing();
        Err(tauri::Error::Anyhow(anyhow!("closed")))
    })
}

/// 在新线程里运行 `f`，最多等 `seconds` 秒；`None` 表示没有在时限内完成（线程被遗弃）。
#[cfg(test)]
pub(crate) fn run_with_timeout<R: Send + 'static>(
    seconds: u64,
    f: impl FnOnce() -> R + Send + 'static,
) -> Option<R> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(f());
    });
    receiver
        .recv_timeout(std::time::Duration::from_secs(seconds))
        .ok()
}

/// 测试用的路由守卫：解引用到 `EventRoute`。
#[cfg(test)]
pub(super) struct RouteGuard<'a>(std::sync::MutexGuard<'a, RouteAndHandoff>);

#[cfg(test)]
impl std::ops::Deref for RouteGuard<'_> {
    type Target = EventRoute;
    fn deref(&self) -> &EventRoute {
        &self.0.route
    }
}

#[cfg(test)]
impl std::ops::DerefMut for RouteGuard<'_> {
    fn deref_mut(&mut self) -> &mut EventRoute {
        &mut self.0.route
    }
}

/// 测试用的交接守卫：解引用到 `HandoffState`。
#[cfg(test)]
pub(super) struct HandoffGuard<'a>(std::sync::MutexGuard<'a, RouteAndHandoff>);

#[cfg(test)]
impl std::ops::Deref for HandoffGuard<'_> {
    type Target = HandoffState;
    fn deref(&self) -> &HandoffState {
        &self.0.handoff
    }
}

#[cfg(test)]
impl std::ops::DerefMut for HandoffGuard<'_> {
    fn deref_mut(&mut self) -> &mut HandoffState {
        &mut self.0.handoff
    }
}

#[cfg(test)]
impl ManagedSession {
    pub(super) fn route_guard(&self) -> RouteGuard<'_> {
        RouteGuard(self.route_and_handoff.lock().unwrap())
    }

    pub(super) fn handoff_guard(&self) -> HandoffGuard<'_> {
        HandoffGuard(self.route_and_handoff.lock().unwrap())
    }
}

/// 记录观察者回调的替身：`(kind, session_id, attempts)`。
#[cfg(test)]
#[derive(Default)]
pub(crate) struct RecordingObserver {
    events: Mutex<Vec<(String, String, u32)>>,
}

#[cfg(test)]
impl RecordingObserver {
    pub(crate) fn events(&self) -> Vec<(String, String, u32)> {
        self.events.lock().unwrap().clone()
    }
}

#[cfg(test)]
impl super::persistence::PersistenceObserver for RecordingObserver {
    fn finish_failed(
        &self,
        session_id: &str,
        _state: PtySessionState,
        attempts: u32,
        _error: &AppError,
    ) {
        self.events.lock().unwrap().push((
            "finish_failed".to_string(),
            session_id.to_string(),
            attempts,
        ));
    }

    fn finish_gave_up(&self, session_id: &str, _state: PtySessionState, attempts: u32) {
        self.events.lock().unwrap().push((
            "finish_gave_up".to_string(),
            session_id.to_string(),
            attempts,
        ));
    }
}
