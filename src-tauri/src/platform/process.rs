use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[cfg(windows)]
use super::detect;
use super::execution_process::ProcessTree;

/// The extra creation flags CLI children keep; passed to the attached creation, which sets
/// its own `CREATE_SUSPENDED` on top. Ignored outside Windows.
pub(crate) const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub struct BoundedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

pub fn cli_command<I, S>(program: &Path, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = args
        .into_iter()
        .map(|argument| argument.as_ref().to_os_string())
        .collect::<Vec<_>>();
    // 只有 Windows 分支会在 match 之后继续修改 command。
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = match windows_script_kind(program) {
        #[cfg(windows)]
        ScriptKind::Command => {
            let mut command = Command::new(detect::system32("cmd.exe"));
            command.arg("/D").arg("/C").arg(program).args(&args);
            command
        }
        #[cfg(windows)]
        ScriptKind::PowerShell => {
            let mut command =
                Command::new(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(program)
                .args(&args);
            command
        }
        ScriptKind::Native => {
            let mut command = Command::new(program);
            command.args(&args);
            command
        }
    };
    #[cfg(windows)]
    command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
    command
}

pub fn cli_std_command<I, S>(program: &Path, args: I) -> std::process::Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = args
        .into_iter()
        .map(|argument| argument.as_ref().to_os_string())
        .collect::<Vec<_>>();
    // 只有 Windows 分支会在 match 之后继续修改 command。
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = match windows_script_kind(program) {
        #[cfg(windows)]
        ScriptKind::Command => {
            let mut command = std::process::Command::new(detect::system32("cmd.exe"));
            command.arg("/D").arg("/C").arg(program).args(&args);
            command
        }
        #[cfg(windows)]
        ScriptKind::PowerShell => {
            let mut command = std::process::Command::new(detect::system32(
                "WindowsPowerShell\\v1.0\\powershell.exe",
            ));
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(program)
                .args(&args);
            command
        }
        ScriptKind::Native => {
            let mut command = std::process::Command::new(program);
            command.args(&args);
            command
        }
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
    }
    command
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScriptKind {
    Native,
    #[cfg(windows)]
    Command,
    #[cfg(windows)]
    PowerShell,
}

fn windows_script_kind(program: &Path) -> ScriptKind {
    #[cfg(windows)]
    {
        match program
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "cmd" | "bat" => ScriptKind::Command,
            "ps1" => ScriptKind::PowerShell,
            _ => ScriptKind::Native,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = program;
        ScriptKind::Native
    }
}

pub fn remove_pnpm_user_agent(command: &mut Command) {
    command.env_remove("npm_config_user_agent");
}

pub fn remove_pnpm_user_agent_std(command: &mut std::process::Command) {
    command.env_remove("npm_config_user_agent");
}

/// A child process that belongs to its process tree from its first instruction (m6-060). Dropping
/// the handle, including by dropping a future that owns it, ends the whole tree.
pub struct Supervised {
    child: tokio::process::Child,
    tree: ProcessTree,
}

/// Starts `command` attached to a new process tree. `windows_creation_flags` are the extra
/// creation flags to keep (they replace the command's own, see `ProcessTree::spawn_attached`).
pub fn spawn_supervised(
    command: &mut Command,
    windows_creation_flags: u32,
) -> io::Result<Supervised> {
    let tree = ProcessTree::new()?;
    let child = tree.spawn_attached(command, windows_creation_flags)?;
    Ok(Supervised { child, tree })
}

impl Supervised {
    pub fn child_mut(&mut self) -> &mut tokio::process::Child {
        &mut self.child
    }

    pub fn tree(&self) -> &ProcessTree {
        &self.tree
    }

    /// Terminates the tree, waits up to `grace` for the child, then force-kills and reaps it.
    /// Errors from the OS are ignored except for the final wait.
    pub async fn shutdown(&mut self, grace: Duration) -> io::Result<()> {
        let _ = self.tree.terminate();
        if tokio::time::timeout(grace, self.child.wait())
            .await
            .is_err()
        {
            let _ = self.tree.force_kill();
            let _ = self.child.start_kill();
        }
        self.child.wait().await.map(|_| ())
    }
}

impl Drop for Supervised {
    /// Cancellation safety: dropping the handle (including a dropped future) ends the whole tree,
    /// even when the tree was only asked to terminate before and a descendant ignored that.
    fn drop(&mut self) {
        let _ = self.tree.terminate();
        let _ = self.tree.force_kill();
        // Redundant protection if signalling the tree failed: end the direct child as well.
        let _ = self.child.start_kill();
    }
}

pub async fn run_bounded(
    mut command: Command,
    timeout: Duration,
    output_limit: usize,
) -> io::Result<BoundedOutput> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // The child belongs to its process tree before it runs, and dropping `supervised` (also by
    // dropping this future) ends the whole tree.
    let mut supervised = spawn_supervised(&mut command, WINDOWS_CREATE_NO_WINDOW)?;

    let stdout = supervised
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("子进程标准输出不可用"))?;
    let stderr = supervised
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("子进程标准错误不可用"))?;
    let mut stdout_task = tokio::spawn(read_limited_async(stdout, output_limit));
    let mut stderr_task = tokio::spawn(read_limited_async(stderr, output_limit));
    let run = async {
        let status = supervised.child_mut().wait().await?;
        let stdout = (&mut stdout_task)
            .await
            .map_err(|error| io::Error::other(error.to_string()))?;
        let stderr = (&mut stderr_task)
            .await
            .map_err(|error| io::Error::other(error.to_string()))?;
        Ok::<_, io::Error>((status, stdout, stderr))
    };

    // The `run` future borrows `supervised`; finish it before the arms touch the tree again.
    let outcome = tokio::time::timeout(timeout, run).await;
    match outcome {
        Ok(Ok((status, (stdout, stdout_truncated), (stderr, stderr_truncated)))) => {
            Ok(BoundedOutput {
                status,
                stdout,
                stderr,
                truncated: stdout_truncated || stderr_truncated,
            })
        }
        Ok(Err(error)) => {
            let _ = supervised.tree().terminate();
            let _ = supervised.child_mut().kill().await;
            let _ = supervised.child_mut().wait().await;
            stdout_task.abort();
            stderr_task.abort();
            Err(error)
        }
        Err(_) => {
            let _ = supervised.tree().terminate();
            let _ = tokio::time::timeout(OUTPUT_DRAIN_GRACE, supervised.child_mut().wait()).await;
            // The root process can exit while a descendant keeps either pipe
            // open. Always force-kill the group after the grace period, even
            // when waiting for the root has already completed.
            let _ = supervised.tree().force_kill();
            let _ = supervised.child_mut().kill().await;
            let _ = supervised.child_mut().wait().await;
            stdout_task.abort();
            stderr_task.abort();
            Err(io::Error::new(io::ErrorKind::TimedOut, "子进程执行超时"))
        }
    }
}

async fn read_limited_async<R>(mut reader: R, limit: usize) -> (Vec<u8>, bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(limit.min(4096));
    let mut buffer = [0_u8; 4096];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = limit.saturating_sub(output.len());
                let copied = read.min(remaining);
                output.extend_from_slice(&buffer[..copied]);
                truncated |= copied < read;
            }
        }
    }
    (output, truncated)
}

pub fn run_bounded_sync(
    mut command: std::process::Command,
    timeout: Duration,
    output_limit: usize,
) -> io::Result<BoundedOutput> {
    let tree = ProcessTree::new()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = tree.spawn_attached_std(&mut command, WINDOWS_CREATE_NO_WINDOW)?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("子进程标准输出不可用"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("子进程标准错误不可用"))?;
    let stdout_reader = thread::spawn(move || read_limited_sync(stdout, output_limit));
    let stderr_reader = thread::spawn(move || read_limited_sync(stderr, output_limit));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if stdout_reader.is_finished() && stderr_reader.is_finished() {
                    break status;
                }
                if Instant::now() >= deadline {
                    let _ = tree.terminate();
                    let _ = tree.force_kill();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "子进程输出收尾超时",
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = tree.terminate();
                let grace_deadline = Instant::now() + OUTPUT_DRAIN_GRACE;
                while Instant::now() < grace_deadline {
                    if child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                let _ = tree.force_kill();
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(io::Error::new(io::ErrorKind::TimedOut, "子进程执行超时"));
            }
            Err(error) => {
                let _ = tree.terminate();
                let _ = tree.force_kill();
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(error);
            }
        }
    };

    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| io::Error::other("读取子进程标准输出时任务异常"))?;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| io::Error::other("读取子进程标准错误时任务异常"))?;
    Ok(BoundedOutput {
        status,
        stdout,
        stderr,
        truncated: stdout_truncated || stderr_truncated,
    })
}

fn read_limited_sync<R: Read>(mut reader: R, limit: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(limit.min(4096));
    let mut buffer = [0_u8; 4096];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = limit.saturating_sub(output.len());
                let copied = read.min(remaining);
                output.extend_from_slice(&buffer[..copied]);
                truncated |= copied < read;
            }
        }
    }
    (output, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::ffi::OsStr;

    #[cfg(unix)]
    fn shell_command(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(windows)]
    fn shell_command(script: &str) -> Command {
        let mut command = Command::new(detect::system32("WindowsPowerShell\\v1.0\\powershell.exe"));
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
        command
    }

    #[tokio::test]
    async fn bounded_output_is_truncated_while_the_child_is_drained() {
        #[cfg(unix)]
        let command = shell_command("printf '%01000d' 0");
        #[cfg(windows)]
        let command = {
            let mut command = Command::new(detect::system32("cmd.exe"));
            command.args(["/D", "/C", "echo"]).arg("x".repeat(1000));
            command
        };

        let output = run_bounded(command, Duration::from_secs(10), 64)
            .await
            .unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 64);
        assert!(output.truncated);
    }

    #[tokio::test]
    async fn timeout_terminates_the_child_process_tree() {
        #[cfg(unix)]
        let command = shell_command("sleep 30 & wait");
        #[cfg(windows)]
        let command = shell_command("Start-Sleep -Seconds 30");
        let started = Instant::now();

        let error = run_bounded(command, Duration::from_millis(100), 64)
            .await
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_timeout_kills_grandchild_processes() {
        // 子进程由 spawn_attached 以挂起方式创建并先加入 Job（m6-060 已消除 N8 的逃逸窗口）；
        // 这里验证超时必须结束整棵 Job 内的进程树。
        // 父/孙进程都是测试二进制自身（见 execution_process::tree_worker），工人会等到
        // 被 attach 进 Job 之后才派生孙进程，因此不依赖 PowerShell 冷启动速度，也不会
        // 撞上 N8 的逃逸窗口。超时本身是被测行为，必须保持短；极端调度停顿下孙进程仍可能
        // 没赶在 5 秒内写出 pid，所以每个尝试都必须以 TimedOut 结束，只在 pid 尚未写出时
        // 放大超时重试，正常路径仍是 5 秒，断言语义不变。
        let mut pid = None;
        for timeout_seconds in [5, 15, 45] {
            let directory = tempfile::tempdir().unwrap();
            let pid_file = directory.path().join("pid.txt");
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(crate::platform::execution_process::tree_worker::ARGS)
                .envs(crate::platform::execution_process::tree_worker::envs(
                    &pid_file,
                ));
            command.creation_flags(WINDOWS_CREATE_NO_WINDOW);

            let error = run_bounded(command, Duration::from_secs(timeout_seconds), 64)
                .await
                .unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            pid = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.trim().parse::<u32>().ok());
            if pid.is_some() {
                break;
            }
        }
        let pid = pid.unwrap_or_else(|| panic!("孙进程在 45 秒内仍未启动"));
        crate::platform::execution_process::assert_windows_process_terminates(
            pid,
            Duration::from_secs(3),
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_descendants_that_ignore_terminate_after_root_exits() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file_path = directory.path().join("descendant.pid");
        let script = format!(
            "sh -c 'trap \"\" TERM; echo $$ > {}; exec sleep 30' & wait",
            pid_file_path.display()
        );
        let started = Instant::now();
        let error = run_bounded(shell_command(&script), Duration::from_millis(250), 64)
            .await
            .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(3));
        let pid = std::fs::read_to_string(pid_file_path).unwrap();
        let status = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid.trim()])
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(
            status.trim().is_empty() || status.trim_start().starts_with('Z'),
            "descendant process is still alive after timeout: {status}"
        );
    }

    #[test]
    fn bounded_sync_output_is_truncated() {
        #[cfg(unix)]
        let command = {
            let mut command = std::process::Command::new("/bin/sh");
            command.args(["-c", "printf '%01000d' 0"]);
            command
        };
        #[cfg(windows)]
        let command = {
            let output = "x".repeat(1000);
            cli_std_command(
                Path::new(&detect::system32("cmd.exe")),
                ["/D", "/C", "echo", output.as_str()],
            )
        };

        let output = run_bounded_sync(command, Duration::from_secs(10), 64).unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 64);
        assert!(output.truncated);
    }

    #[cfg(windows)]
    #[test]
    fn windows_script_extensions_select_native_hosts() {
        let command = cli_std_command(Path::new(r"C:\tools\cli.cmd"), ["--version"]);
        assert!(command
            .get_program()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with("cmd.exe"));
        assert_eq!(command.get_args().next(), Some(OsStr::new("/D")));

        let command = cli_std_command(Path::new(r"C:\tools\cli.ps1"), ["--version"]);
        assert!(command
            .get_program()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with("powershell.exe"));
        assert!(command
            .get_args()
            .any(|argument| argument == OsStr::new("-File")));
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        if unsafe { libc::kill(pid as i32, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return false;
        }
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let stat = String::from_utf8_lossy(&output.stdout).trim().to_string();
        !(stat.is_empty() || stat.starts_with('Z'))
    }

    /// Whether no process of the group led by `pid` is left.
    #[cfg(unix)]
    fn process_group_is_gone(pid: u32) -> bool {
        let result = unsafe { libc::kill(-(pid as i32), 0) };
        result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }

    #[cfg(windows)]
    fn process_is_alive(pid: u32) -> bool {
        crate::platform::execution_process::windows_process_is_alive(pid)
    }

    /// Polls every 10 ms until `condition` holds; false when `limit` passes first.
    async fn wait_until(limit: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let started = Instant::now();
        while started.elapsed() < limit {
            if condition() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        condition()
    }

    fn read_pid(path: &Path) -> Option<u32> {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok())
    }

    #[tokio::test]
    async fn spawn_attached_child_runs_to_completion_after_release() {
        #[cfg(unix)]
        let command = shell_command("echo ok");
        #[cfg(windows)]
        let command = {
            let mut command = Command::new(detect::system32("cmd.exe"));
            command.args(["/D", "/C", "echo ok"]);
            command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
            command
        };
        let started = Instant::now();

        let output = run_bounded(command, Duration::from_secs(10), 4096)
            .await
            .expect("the released child runs to completion");

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn spawn_attached_std_child_runs_to_completion_after_release() {
        #[cfg(unix)]
        let command = {
            let mut command = std::process::Command::new("/bin/sh");
            command.args(["-c", "echo ok"]);
            command
        };
        #[cfg(windows)]
        let command = cli_std_command(
            Path::new(&detect::system32("cmd.exe")),
            ["/D", "/C", "echo", "ok"],
        );

        let output = run_bounded_sync(command, Duration::from_secs(10), 4096)
            .expect("the released child runs to completion");

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
    }

    #[tokio::test]
    async fn dropping_a_supervised_handle_terminates_the_tree() {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        // Unix: the shell ignores SIGTERM (inherited by its background `sleep`), so only an
        // unconditional kill on drop can end the group after the tree was signalled once.
        #[cfg(unix)]
        let mut command = shell_command(&format!(
            "trap '' TERM; echo ready > {}; sleep 30 & wait",
            ready.display()
        ));
        #[cfg(windows)]
        let mut command = shell_command("Start-Sleep -Seconds 30");
        let mut supervised = spawn_supervised(&mut command, WINDOWS_CREATE_NO_WINDOW).unwrap();
        let pid = supervised.child_mut().id().unwrap();
        assert!(process_is_alive(pid), "alive before the drop");
        #[cfg(unix)]
        {
            assert!(
                wait_until(Duration::from_secs(5), || ready.exists()).await,
                "the shell installed its TERM trap"
            );
            supervised.tree().terminate().unwrap();
            assert!(process_is_alive(pid), "SIGTERM is ignored by the shell");
        }
        #[cfg(windows)]
        let _ = &ready;

        drop(supervised);

        assert!(
            wait_until(Duration::from_secs(5), || !process_is_alive(pid)).await,
            "the root process {pid} survived the drop of its supervised handle"
        );
        #[cfg(unix)]
        assert!(
            wait_until(Duration::from_secs(5), || process_group_is_gone(pid)).await,
            "the process group of {pid} still has members"
        );
    }

    #[tokio::test]
    async fn supervised_shutdown_terminates_and_reaps_within_the_grace() {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        #[cfg(unix)]
        let mut command = shell_command(&format!(
            "trap '' TERM; echo ready > {}; sleep 30",
            ready.display()
        ));
        #[cfg(windows)]
        let mut command = shell_command("Start-Sleep -Seconds 30");
        let mut supervised = spawn_supervised(&mut command, WINDOWS_CREATE_NO_WINDOW).unwrap();
        #[cfg(unix)]
        assert!(
            wait_until(Duration::from_secs(5), || ready.exists()).await,
            "the shell installed its TERM trap"
        );
        #[cfg(windows)]
        let _ = &ready;
        let started = Instant::now();

        let result = tokio::time::timeout(
            Duration::from_secs(5),
            supervised.shutdown(Duration::from_millis(300)),
        )
        .await;

        assert!(result.is_ok(), "shutdown returns within 5 seconds");
        result.unwrap().unwrap();
        assert!(
            supervised.child_mut().try_wait().unwrap().is_some(),
            "the child was reaped"
        );
        #[cfg(unix)]
        {
            let elapsed = started.elapsed();
            assert!(
                elapsed >= Duration::from_millis(250),
                "waited for the grace: {elapsed:?}"
            );
            assert!(
                elapsed < Duration::from_secs(4),
                "then force-killed: {elapsed:?}"
            );
        }
        #[cfg(windows)]
        let _ = started;
    }

    #[tokio::test]
    async fn dropping_the_run_bounded_future_terminates_the_tree() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("grandchild.pid");
        #[cfg(unix)]
        let command = shell_command(&format!(
            "sh -c 'echo $$ > {}; exec sleep 30' & wait",
            pid_file.display()
        ));
        #[cfg(windows)]
        let command = {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(crate::platform::execution_process::tree_worker::ARGS)
                .envs(crate::platform::execution_process::tree_worker::envs(
                    &pid_file,
                ));
            command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
            command
        };
        let handle = tokio::spawn(run_bounded(command, Duration::from_secs(60), 64));

        let mut pid = None;
        assert!(
            wait_until(Duration::from_secs(45), || {
                pid = read_pid(&pid_file);
                pid.is_some()
            })
            .await,
            "the descendant started"
        );
        let pid = pid.unwrap();
        assert!(
            process_is_alive(pid),
            "the descendant is alive before the drop"
        );

        // Dropping the future (the task is cancelled) is how an outer timeout ends a request.
        handle.abort();
        let _ = handle.await;

        assert!(
            wait_until(Duration::from_secs(5), || !process_is_alive(pid)).await,
            "descendant {pid} survived the drop of the run_bounded future"
        );
    }
}
