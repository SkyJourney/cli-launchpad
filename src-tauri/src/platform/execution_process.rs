use std::io;

use portable_pty::{Child as PtyChild, MasterPty};
use tokio::process::Child;

pub fn attach_pty_or_terminate(
    process_tree: &ProcessTree,
    child: &mut Box<dyn PtyChild + Send + Sync>,
    master: &dyn MasterPty,
) -> io::Result<()> {
    if let Err(error) = process_tree.attach_pty(&**child, master) {
        let _ = process_tree.terminate();
        let _ = process_tree.force_kill();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(())
}

#[cfg(all(test, windows))]
pub(crate) fn windows_process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0u32;
        let queried = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        queried != 0 && exit_code == STILL_ACTIVE
    }
}

/// 每 100 毫秒轮询，直到进程消失；超时仍存活则用 taskkill 兜底后 panic。
#[cfg(all(test, windows))]
pub(crate) fn assert_windows_process_terminates(pid: u32, within: std::time::Duration) {
    let started = std::time::Instant::now();
    while started.elapsed() < within {
        if !windows_process_is_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    panic!("孙进程 {pid} 在 {within:?} 后仍然存活");
}

/// 进程树测试用的“工人”：让测试二进制自己充当父进程和孙进程。
///
/// 早先用 PowerShell 嵌套 `Start-Process` 造孙进程，空载冷启动就要 0.3–0.7 秒，
/// CI 上数百个测试并行时会被放大到数秒，导致“孙进程没来得及启动”类偶发超时；
/// 同时 PowerShell 的慢启动还掩盖了“spawn 之后才 attach”的竞态（N8）。
/// 测试二进制自启动约 60 毫秒，且工人会等到自己确实进入带
/// `KILL_ON_JOB_CLOSE` 的 Job 之后才派生孙进程，所以验证是确定的，不靠运气。
#[cfg(all(test, windows))]
pub(crate) mod tree_worker {
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const MODE: &str = "CLP_TREE_WORKER_MODE";
    const PID_FILE: &str = "CLP_TREE_WORKER_PID_FILE";
    const PARENT_PID: &str = "CLP_TREE_WORKER_PARENT_PID";
    const SLEEP: Duration = Duration::from_secs(120);

    /// 测试二进制调用工人所需的参数；调用方再附加 [`envs`]。
    pub(crate) const ARGS: [&str; 4] = [
        "--ignored",
        "--exact",
        "platform::execution_process::tree_worker::process_tree_worker",
        "--nocapture",
    ];

    pub(crate) fn envs(pid_file: &Path) -> [(&'static str, std::ffi::OsString); 3] {
        [
            (MODE, "parent".into()),
            (PID_FILE, pid_file.as_os_str().to_owned()),
            // 工人据此判断“自己所在的 Job 是不是只属于被测对象”。
            (PARENT_PID, std::process::id().to_string().into()),
        ]
    }

    /// 本进程最内层 Job 的 (LimitFlags, 成员 pid 列表)；未被任何 Job 约束时为 None。
    /// `hJob` 传 NULL 表示“调用进程所在的（最内层）Job”。
    fn job_state() -> Option<(u32, Vec<u32>)> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        // 与 JOBOBJECT_BASIC_PROCESS_ID_LIST 同布局，但 ProcessIdList 预留 64 个槽位。
        #[repr(C)]
        struct ProcessIdList {
            assigned: u32,
            listed: u32,
            ids: [usize; 64],
        }
        unsafe {
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            let limits_queried = QueryInformationJobObject(
                std::ptr::null_mut(),
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            let mut list: ProcessIdList = std::mem::zeroed();
            // 成员多于 64 个时返回 ERROR_MORE_DATA 但前 64 个仍会填入，这里只关心有没有父进程。
            let list_queried = QueryInformationJobObject(
                std::ptr::null_mut(),
                JobObjectBasicProcessIdList,
                &mut list as *mut _ as *mut _,
                std::mem::size_of::<ProcessIdList>() as u32,
                std::ptr::null_mut(),
            );
            (limits_queried != 0 && (list_queried != 0 || list.listed > 0)).then(|| {
                (
                    limits.BasicLimitInformation.LimitFlags,
                    list.ids[..list.listed as usize]
                        .iter()
                        .map(|id| *id as u32)
                        .collect(),
                )
            })
        }
    }

    /// 本进程是否已被放进“专属”的 Job：带 `KILL_ON_JOB_CLOSE`，成员里有自己、没有父进程。
    ///
    /// 只看 `KILL_ON_JOB_CLOSE` 不够：`cargo test` 自己就会把测试进程放进带该标志的外层
    /// Job（实测 flags=0x2000），那样门一开始就为真，形同虚设。外层 Job 一定含有父进程
    /// （测试进程），而被 `ProcessTree::attach` 放进新建嵌套 Job 的工人，其 Job 里只有它自己
    /// （以及 CREATE_NO_WINDOW 带来的控制台宿主），不含父进程。
    fn in_dedicated_kill_on_close_job(parent_pid: u32) -> bool {
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        match job_state() {
            Some((flags, members)) => {
                flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
                    && members.contains(&std::process::id())
                    && !members.contains(&parent_pid)
            }
            None => false,
        }
    }

    #[test]
    #[ignore = "仅由进程树测试以子进程调用"]
    fn process_tree_worker() {
        let Ok(mode) = std::env::var(MODE) else {
            return;
        };
        match mode.as_str() {
            "sleeper" => std::thread::sleep(SLEEP),
            "parent" => {
                // 父进程被 spawn 出来之后才会被 attach 到专属 Job；先等进入专属 Job 再派生孙进程，
                // 孙进程才一定继承 Job，不会逃逸。
                let parent_pid: u32 = std::env::var(PARENT_PID).unwrap().parse().unwrap();
                let deadline = Instant::now() + Duration::from_secs(30);
                while !in_dedicated_kill_on_close_job(parent_pid) {
                    assert!(
                        Instant::now() < deadline,
                        "工人 30 秒内未被放进专属 Job（flags, 活动进程数）：{:?}",
                        job_state()
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                let pid_file = std::path::PathBuf::from(std::env::var(PID_FILE).unwrap());
                // 孙进程不继承标准流，避免占住 run_bounded 的输出管道。
                let grandchild = Command::new(std::env::current_exe().unwrap())
                    .args(ARGS)
                    .env(MODE, "sleeper")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                // 先写临时文件再改名，读取方不会看到写了一半的 pid。
                let staging = pid_file.with_extension("tmp");
                std::fs::write(&staging, grandchild.id().to_string()).unwrap();
                std::fs::rename(&staging, &pid_file).unwrap();
                std::thread::sleep(SLEEP);
            }
            other => panic!("未知工人模式：{other}"),
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::mem::size_of;

    use portable_pty::Child as PtyChild;
    use portable_pty::MasterPty;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

    use super::*;

    pub struct ProcessTree {
        job: HANDLE,
    }

    // Job handles can be used from any thread. Ownership remains unique and
    // Drop closes the handle exactly once.
    unsafe impl Send for ProcessTree {}

    impl ProcessTree {
        pub fn new() -> io::Result<Self> {
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }

            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                unsafe { std::mem::zeroed() };
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &information as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(job);
                }
                return Err(error);
            }
            Ok(Self { job })
        }

        pub fn attach(&self, child: &Child) -> io::Result<()> {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("子进程句柄不可用"))?
                as HANDLE;
            if unsafe { AssignProcessToJobObject(self.job, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn attach_pty(&self, child: &dyn PtyChild, _master: &dyn MasterPty) -> io::Result<()> {
            use std::os::windows::io::RawHandle;

            let process = child
                .as_raw_handle()
                .ok_or_else(|| io::Error::other("PTY 子进程句柄不可用"))?
                as RawHandle as HANDLE;
            if unsafe { AssignProcessToJobObject(self.job, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn configure(&self, _command: &mut tokio::process::Command) -> io::Result<()> {
            Ok(())
        }

        pub fn configure_std(&self, _command: &mut std::process::Command) -> io::Result<()> {
            Ok(())
        }

        pub fn attach_std(&self, child: &std::process::Child) -> io::Result<()> {
            use std::os::windows::io::AsRawHandle;

            let process = AsRawHandle::as_raw_handle(child) as HANDLE;
            if unsafe { AssignProcessToJobObject(self.job, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Creates the child already attached to this tree (m6-060): the child belongs to the tree
        /// before it has run any code of its own. `windows_creation_flags` are the extra creation
        /// flags to keep (for example `CREATE_NO_WINDOW`); they replace whatever the command had.
        pub fn spawn_attached(
            &self,
            command: &mut tokio::process::Command,
            windows_creation_flags: u32,
        ) -> io::Result<Child> {
            self.spawn_attached_inner(command, windows_creation_flags, |_| {})
        }

        /// `spawn_attached` for a blocking `std::process::Command`.
        pub fn spawn_attached_std(
            &self,
            command: &mut std::process::Command,
            windows_creation_flags: u32,
        ) -> io::Result<std::process::Child> {
            use std::os::windows::process::CommandExt;

            self.configure_std(command)?;
            command.creation_flags(CREATE_SUSPENDED | windows_creation_flags);
            let mut child = command.spawn()?;
            if let Err(error) = self.attach_std(&child) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            if let Err(error) = resume_main_thread(child.id()) {
                let _ = self.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(child)
        }

        /// Test hook: `before_release` runs with the child's pid after it joined the tree and
        /// before it is allowed to run.
        #[cfg(test)]
        pub(crate) fn spawn_attached_with_hook(
            &self,
            command: &mut tokio::process::Command,
            windows_creation_flags: u32,
            before_release: impl FnOnce(u32),
        ) -> io::Result<Child> {
            self.spawn_attached_inner(command, windows_creation_flags, before_release)
        }

        fn spawn_attached_inner(
            &self,
            command: &mut tokio::process::Command,
            windows_creation_flags: u32,
            before_release: impl FnOnce(u32),
        ) -> io::Result<Child> {
            self.configure(command)?;
            // The extra flags replace the command's own creation flags, so the caller passes the
            // ones it needs (for example `CREATE_NO_WINDOW`); `CREATE_SUSPENDED` is ours.
            command.creation_flags(CREATE_SUSPENDED | windows_creation_flags);
            let mut child = command.spawn()?;
            let Some(pid) = child.id() else {
                let _ = child.start_kill();
                return Err(io::Error::other("子进程 ID 不可用"));
            };
            if let Err(error) = self.attach(&child) {
                let _ = child.start_kill();
                return Err(error);
            }
            before_release(pid);
            if let Err(error) = resume_main_thread(pid) {
                // A child that stays suspended would live forever: end the whole tree.
                let _ = self.terminate();
                let _ = child.start_kill();
                return Err(error);
            }
            Ok(child)
        }

        #[cfg(test)]
        pub(crate) fn job_handle(&self) -> HANDLE {
            self.job
        }

        pub fn terminate(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.job, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn force_kill(&self) -> io::Result<()> {
            self.terminate()
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job);
            }
        }
    }

    /// Lets the main thread of a process that was created suspended run.
    fn resume_main_thread(pid: u32) -> io::Result<()> {
        use windows_sys::Win32::System::Threading::{
            OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        };

        let thread_id = main_thread_id(pid)?;
        // SAFETY: the handle returned by `OpenThread` is checked for null, used only for
        // `ResumeThread`, and closed exactly once.
        unsafe {
            let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id);
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            let previous = ResumeThread(thread);
            let result = if previous == u32::MAX {
                Err(io::Error::last_os_error())
            } else if previous == 0 {
                // Not suspended: this is not the creation-suspended main thread, so the real one
                // may still be stuck. Fail so the caller ends the tree instead of hanging.
                Err(io::Error::other("被枚举到的线程未处于挂起状态"))
            } else {
                Ok(())
            };
            CloseHandle(thread);
            result
        }
    }

    /// The id of the first thread that belongs to `pid` (a process created suspended has exactly
    /// one thread).
    pub(super) fn main_thread_id(pid: u32) -> io::Result<u32> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        };

        // SAFETY: the snapshot handle is checked, closed exactly once, and `entry.dwSize` is set
        // before the first call as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut found = None;
            let mut more = Thread32First(snapshot, &mut entry);
            while more != 0 {
                if entry.th32OwnerProcessID == pid {
                    found = Some(entry.th32ThreadID);
                    break;
                }
                more = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            found.ok_or_else(|| io::Error::other("未找到被挂起子进程的主线程"))
        }
    }

    #[cfg(test)]
    mod tests {
        use std::time::Duration;
        use std::{thread, time::Instant};

        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        use super::*;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        #[tokio::test]
        async fn job_object_terminates_attached_process() {
            let mut command = tokio::process::Command::new(crate::platform::detect::system32(
                "WindowsPowerShell\\v1.0\\powershell.exe",
            ));
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .creation_flags(CREATE_NO_WINDOW);
            let mut child = command.spawn().expect("spawn harmless test process");
            let tree = ProcessTree::new().expect("create job object");
            tree.attach(&child).expect("attach process to job");
            tree.terminate().expect("terminate job");

            let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .expect("process should terminate before timeout")
                .expect("wait for process");
            assert!(!status.success());
        }

        #[tokio::test]
        async fn dropping_the_job_kills_attached_processes() {
            let mut command = tokio::process::Command::new(crate::platform::detect::system32(
                "WindowsPowerShell\\v1.0\\powershell.exe",
            ));
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .creation_flags(CREATE_NO_WINDOW);
            let mut child = command.spawn().expect("spawn harmless test process");
            let tree = ProcessTree::new().expect("create job object");
            tree.attach(&child).expect("attach process to job");
            assert!(child.try_wait().unwrap().is_none(), "alive before the drop");

            drop(tree);

            tokio::time::timeout(Duration::from_secs(5), child.wait())
                .await
                .expect("closing the job handle must end the process (KILL_ON_JOB_CLOSE)")
                .expect("wait for process");
        }

        #[tokio::test]
        async fn job_object_terminate_kills_grandchild_processes() {
            let directory = tempfile::tempdir().unwrap();
            let pid_file = directory.path().join("pid.txt");
            // 工人（测试二进制自身）会等到被 attach 进 Job 之后才派生孙进程。
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(super::super::tree_worker::ARGS)
                .envs(super::super::tree_worker::envs(&pid_file))
                .creation_flags(CREATE_NO_WINDOW);
            let mut child = command.spawn().expect("spawn grandchild launcher");
            let tree = ProcessTree::new().expect("create job object");
            tree.attach(&child).expect("attach process to job");

            let started = Instant::now();
            let pid = loop {
                let parsed = std::fs::read_to_string(&pid_file)
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok());
                if let Some(pid) = parsed {
                    break pid;
                }
                // 工人只依赖测试二进制自启动（常态约 60 毫秒），但 CI 上几百个测试并行时
                // 调度仍可能停顿数秒。这里是轮询，pid 一出现就返回，所以 45 秒只是兜底上限，
                // 不增加常规耗时；孙进程睡 120 秒，覆盖这个上限。
                assert!(
                    started.elapsed() < Duration::from_secs(45),
                    "孙进程未在 45 秒内启动"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            };
            assert!(
                super::super::windows_process_is_alive(pid),
                "孙进程启动后必须存活"
            );

            tree.terminate().expect("terminate job");
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
            super::super::assert_windows_process_terminates(pid, Duration::from_secs(3));
        }

        #[test]
        fn tree_worker_waits_for_the_dedicated_job_before_spawning() {
            let directory = tempfile::tempdir().unwrap();
            let pid_file = directory.path().join("pid.txt");
            let mut worker = std::process::Command::new(std::env::current_exe().unwrap())
                .args(super::super::tree_worker::ARGS)
                .envs(super::super::tree_worker::envs(&pid_file))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn tree worker");

            // 未 attach：工人（即使身处 cargo 的外层 Job 里）也不能派生孙进程。
            // 1.5 秒远大于测试二进制 60 毫秒左右的自启动时间。
            thread::sleep(Duration::from_millis(1500));
            assert!(
                !pid_file.exists(),
                "工人在被放进专属 Job 之前就派生了孙进程"
            );

            // attach 之后：工人必须放行并写出孙进程 pid。
            let tree = ProcessTree::new().expect("create job object");
            tree.attach_std(&worker).expect("attach worker to job");
            let started = Instant::now();
            let pid = loop {
                if let Some(pid) = std::fs::read_to_string(&pid_file)
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok())
                {
                    break pid;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(45),
                    "attach 之后工人 45 秒内仍未派生孙进程"
                );
                thread::sleep(Duration::from_millis(50));
            };

            tree.terminate().expect("terminate job");
            let _ = worker.wait();
            super::super::assert_windows_process_terminates(pid, Duration::from_secs(3));
        }

        #[test]
        fn job_object_terminates_pty_process() {
            let system = native_pty_system();
            let pair = system.openpty(PtySize::default()).expect("open ConPTY");
            let mut command = CommandBuilder::new(crate::platform::detect::system32(
                "WindowsPowerShell\\v1.0\\powershell.exe",
            ));
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            let mut child = pair
                .slave
                .spawn_command(command)
                .expect("spawn PTY test process");
            let tree = ProcessTree::new().expect("create job object");
            tree.attach_pty(&*child, &*pair.master)
                .expect("attach PTY process");
            tree.terminate().expect("terminate PTY process tree");

            let started = Instant::now();
            loop {
                if child.try_wait().expect("poll PTY process").is_some() {
                    break;
                }
                assert!(started.elapsed() < Duration::from_secs(3));
                thread::sleep(Duration::from_millis(20));
            }
        }

        #[test]
        fn failed_job_attachment_terminates_pty_process() {
            let system = native_pty_system();
            let pair = system.openpty(PtySize::default()).expect("open ConPTY");
            let mut command = CommandBuilder::new(crate::platform::detect::system32(
                "WindowsPowerShell\\v1.0\\powershell.exe",
            ));
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            let mut child = pair
                .slave
                .spawn_command(command)
                .expect("spawn PTY test process");
            let process_tree = ProcessTree {
                job: std::ptr::null_mut(),
            };

            assert!(attach_pty_or_terminate(&process_tree, &mut child, &*pair.master).is_err());
            assert!(child.try_wait().expect("poll terminated child").is_some());
        }
    }
}

#[cfg(unix)]
mod unix {
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

    use super::*;
    use portable_pty::{Child as PtyChild, MasterPty};

    pub struct ProcessTree {
        process_group: AtomicI32,
        /// Set once a signal was delivered (or the group was already gone): `Drop` then does
        /// nothing, so a recycled pid is not signalled a second time.
        signalled: AtomicBool,
    }

    impl ProcessTree {
        pub fn new() -> io::Result<Self> {
            Ok(Self {
                process_group: AtomicI32::new(0),
                signalled: AtomicBool::new(false),
            })
        }

        pub fn configure(&self, command: &mut tokio::process::Command) -> io::Result<()> {
            use std::os::unix::process::CommandExt;

            command.as_std_mut().process_group(0);
            Ok(())
        }

        pub fn configure_std(&self, command: &mut std::process::Command) -> io::Result<()> {
            use std::os::unix::process::CommandExt;

            command.process_group(0);
            Ok(())
        }

        pub fn attach_std(&self, child: &std::process::Child) -> io::Result<()> {
            let pid =
                i32::try_from(child.id()).map_err(|_| io::Error::other("子进程 ID 不可用"))?;
            self.process_group.store(pid, Ordering::Release);
            Ok(())
        }

        pub fn attach(&self, child: &Child) -> io::Result<()> {
            let pid = child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .ok_or_else(|| io::Error::other("子进程 ID 不可用"))?;
            self.process_group.store(pid, Ordering::Release);
            Ok(())
        }

        /// Creates the child already attached to this tree (m6-060): the child belongs to the tree
        /// before it has run any code of its own. `windows_creation_flags` are the extra creation
        /// flags to keep (for example `CREATE_NO_WINDOW`); they replace whatever the command had.
        pub fn spawn_attached(
            &self,
            command: &mut tokio::process::Command,
            windows_creation_flags: u32,
        ) -> io::Result<Child> {
            self.spawn_attached_inner(command, windows_creation_flags, |_| {})
        }

        /// `spawn_attached` for a blocking `std::process::Command`.
        pub fn spawn_attached_std(
            &self,
            command: &mut std::process::Command,
            windows_creation_flags: u32,
        ) -> io::Result<std::process::Child> {
            let _ = windows_creation_flags;
            self.configure_std(command)?;
            let mut child = command.spawn()?;
            if let Err(error) = self.attach_std(&child) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(child)
        }

        /// Test hook: `before_release` runs with the child's pid after it joined the tree and
        /// before it is allowed to run.
        #[cfg(test)]
        pub(crate) fn spawn_attached_with_hook(
            &self,
            command: &mut tokio::process::Command,
            windows_creation_flags: u32,
            before_release: impl FnOnce(u32),
        ) -> io::Result<Child> {
            self.spawn_attached_inner(command, windows_creation_flags, before_release)
        }

        fn spawn_attached_inner(
            &self,
            command: &mut tokio::process::Command,
            windows_creation_flags: u32,
            before_release: impl FnOnce(u32),
        ) -> io::Result<Child> {
            let _ = windows_creation_flags;
            self.configure(command)?;
            let mut child = command.spawn()?;
            if let Err(error) = self.attach(&child) {
                let _ = child.start_kill();
                return Err(error);
            }
            if let Some(pid) = child.id() {
                before_release(pid);
            }
            Ok(child)
        }

        pub fn attach_pty(&self, child: &dyn PtyChild, master: &dyn MasterPty) -> io::Result<()> {
            let pid = master
                .process_group_leader()
                .or_else(|| child.process_id().and_then(|pid| i32::try_from(pid).ok()))
                .ok_or_else(|| io::Error::other("PTY 进程组 ID 不可用"))?;
            if pid <= 0 {
                return Err(io::Error::other("PTY 进程组 ID 无效"));
            }
            self.process_group.store(pid, Ordering::Release);
            Ok(())
        }

        pub fn terminate(&self) -> io::Result<()> {
            self.signal(libc::SIGTERM)
        }

        pub fn force_kill(&self) -> io::Result<()> {
            self.signal(libc::SIGKILL)
        }

        fn signal(&self, signal: i32) -> io::Result<()> {
            let process_group = self.process_group.load(Ordering::Acquire);
            if process_group <= 0 {
                return Err(io::Error::other("进程组尚未附加"));
            }
            if unsafe { libc::kill(-process_group, signal) } == 0 {
                self.signalled.store(true, Ordering::Release);
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                self.signalled.store(true, Ordering::Release);
                Ok(())
            } else {
                Err(error)
            }
        }
    }

    impl Drop for ProcessTree {
        /// Parity with the Windows job object (`KILL_ON_JOB_CLOSE`): an attached tree that was
        /// never signalled kills its group when dropped. `kill(-pgid, 0)` first confirms the group
        /// still has a member, which narrows (but cannot remove) the pid-reuse window; this is the
        /// accepted risk D1 of m6-058.
        fn drop(&mut self) {
            let group = self.process_group.load(Ordering::Acquire);
            if group <= 0 || self.signalled.load(Ordering::Acquire) {
                return;
            }
            if unsafe { libc::kill(-group, 0) } == 0 {
                let _ = unsafe { libc::kill(-group, libc::SIGKILL) };
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use std::time::Duration;
        use std::{thread, time::Instant};

        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        use super::*;

        #[tokio::test]
        async fn process_group_terminates_shell_and_descendant() {
            let tree = ProcessTree::new().unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "sleep 30 & wait"]);
            tree.configure(&mut command).unwrap();
            let mut child = command.spawn().unwrap();
            tree.attach(&child).unwrap();
            tree.terminate().unwrap();

            let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .expect("process group should terminate")
                .unwrap();
            assert!(!status.success());
        }

        #[tokio::test]
        async fn dropping_an_attached_process_tree_kills_the_whole_group() {
            let tree = ProcessTree::new().unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "sleep 30 & wait"]);
            tree.configure(&mut command).unwrap();
            let mut child = command.spawn().unwrap();
            tree.attach(&child).unwrap();
            let group = i32::try_from(child.id().unwrap()).unwrap();
            assert!(child.try_wait().unwrap().is_none(), "alive before the drop");

            drop(tree);

            let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .expect("dropping the tree must end the group")
                .unwrap();
            assert!(!status.success());
            // The background `sleep` was in the same group and is gone as well.
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let result = unsafe { libc::kill(-group, 0) };
                if result == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                assert!(Instant::now() < deadline, "the group still has members");
                thread::sleep(Duration::from_millis(20));
            }
        }

        #[tokio::test]
        async fn dropping_after_the_group_is_gone_is_a_no_op() {
            let tree = ProcessTree::new().unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "exit 0"]);
            tree.configure(&mut command).unwrap();
            let mut child = command.spawn().unwrap();
            tree.attach(&child).unwrap();
            child.wait().await.unwrap();
            assert!(!tree.signalled.load(Ordering::Acquire));
            // Signalling a group that is already gone is not an error and counts as signalled.
            tree.terminate().unwrap();
            assert!(tree.signalled.load(Ordering::Acquire));
            drop(tree); // nothing left to signal: no panic

            // An attached tree whose group is gone and that was never signalled: Drop is a no-op.
            let tree = ProcessTree::new().unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "exit 0"]);
            tree.configure(&mut command).unwrap();
            let mut child = command.spawn().unwrap();
            tree.attach(&child).unwrap();
            child.wait().await.unwrap();
            drop(tree);

            let tree = ProcessTree::new().unwrap();
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "sleep 30"]);
            tree.configure(&mut command).unwrap();
            let mut child = command.spawn().unwrap();
            tree.attach(&child).unwrap();
            tree.terminate().unwrap();
            assert!(tree.signalled.load(Ordering::Acquire));
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
            drop(tree); // already signalled: Drop does nothing
        }

        #[test]
        fn process_group_terminates_pty_process() {
            let system = native_pty_system();
            let pair = system.openpty(PtySize::default()).expect("open PTY");
            let mut command = CommandBuilder::new("/bin/sh");
            command.args(["-c", "sleep 30 & wait"]);
            let mut child = pair
                .slave
                .spawn_command(command)
                .expect("spawn PTY test process");
            let tree = ProcessTree::new().expect("create process tree");
            tree.attach_pty(&*child, &*pair.master)
                .expect("attach PTY process group");
            tree.terminate().expect("terminate PTY process group");

            let started = Instant::now();
            loop {
                if child.try_wait().expect("poll PTY process").is_some() {
                    break;
                }
                assert!(started.elapsed() < Duration::from_secs(3));
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[cfg(unix)]
pub use unix::ProcessTree;
#[cfg(windows)]
pub use windows::ProcessTree;

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[cfg(windows)]
    fn long_command() -> tokio::process::Command {
        let mut command = tokio::process::Command::new(crate::platform::detect::system32(
            "WindowsPowerShell\\v1.0\\powershell.exe",
        ));
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        command
    }

    #[cfg(unix)]
    fn long_command() -> tokio::process::Command {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        command
    }

    /// What the hook can observe about the not-yet-released child.
    #[derive(Debug)]
    struct Observation {
        /// Windows: the child is a member of the tree's job.
        in_tree: bool,
        /// Windows: the main thread's previous suspend count (1 while it has not run).
        /// Unix: whether the child already leads its own process group.
        pending: bool,
    }

    #[cfg(windows)]
    fn observe(tree: &ProcessTree, pid: u32) -> Observation {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, OpenThread, ResumeThread, SuspendThread,
            PROCESS_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
        };

        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            assert!(!process.is_null(), "OpenProcess failed for {pid}");
            let mut in_job = 0;
            assert_ne!(
                IsProcessInJob(process, tree.job_handle(), &mut in_job),
                0,
                "IsProcessInJob failed"
            );
            CloseHandle(process);

            let thread_id = super::windows::main_thread_id(pid).expect("main thread of the child");
            let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id);
            assert!(!thread.is_null(), "OpenThread failed");
            // Suspending adds one to the count; the returned previous count is 1 only if the main
            // thread was still suspended from creation. Undo our own suspension immediately.
            let previous = SuspendThread(thread);
            ResumeThread(thread);
            CloseHandle(thread);
            Observation {
                in_tree: in_job != 0,
                pending: previous == 1,
            }
        }
    }

    #[cfg(unix)]
    fn observe(_tree: &ProcessTree, pid: u32) -> Observation {
        let leads_group = unsafe { libc::getpgid(pid as i32) } == pid as i32;
        Observation {
            in_tree: leads_group,
            pending: leads_group,
        }
    }

    #[tokio::test]
    async fn spawn_attached_places_the_child_in_the_tree_before_it_runs() {
        let tree = ProcessTree::new().unwrap();
        let mut command = long_command();
        let mut observed = None;

        let mut child = tree
            .spawn_attached_with_hook(&mut command, 0, |pid| {
                observed = Some(observe(&tree, pid));
            })
            .expect("spawn the child attached to the tree");

        let observed = observed.expect("the hook ran with the child's pid");
        assert!(
            observed.in_tree,
            "the child must already be in the tree: {observed:?}"
        );
        assert!(
            observed.pending,
            "the child must not have run any code yet: {observed:?}"
        );
        // Extra creation flags are accepted and kept.
        let mut flagged = long_command();
        let mut flagged_child = tree
            .spawn_attached(&mut flagged, 0x0800_0000)
            .expect("spawn with an extra creation flag");

        tree.terminate().unwrap();
        for process in [&mut child, &mut flagged_child] {
            tokio::time::timeout(Duration::from_secs(3), process.wait())
                .await
                .expect("the tree's processes end after terminate")
                .unwrap();
        }
    }
}
