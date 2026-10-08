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
        async fn job_object_terminate_kills_grandchild_processes() {
            let directory = tempfile::tempdir().unwrap();
            let pid_file = directory.path().join("pid.txt");
            let script = format!(
                "$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '{}' -Value $p.Id; Start-Sleep -Seconds 60",
                pid_file.display().to_string().replace('\'', "''")
            );
            let mut command = tokio::process::Command::new(crate::platform::detect::system32(
                "WindowsPowerShell\\v1.0\\powershell.exe",
            ));
            command
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
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
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "孙进程未在 10 秒内启动，提高超时值"
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
    use std::sync::atomic::{AtomicI32, Ordering};

    use super::*;
    use portable_pty::{Child as PtyChild, MasterPty};

    pub struct ProcessTree {
        process_group: AtomicI32,
    }

    impl ProcessTree {
        pub fn new() -> io::Result<Self> {
            Ok(Self {
                process_group: AtomicI32::new(0),
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
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error)
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
