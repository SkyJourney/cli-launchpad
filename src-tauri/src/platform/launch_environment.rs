use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

/// The environment every CLI operation (detection, install plans, launch
/// resolution, PTY children) must share, so they all see the same PATH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchEnvironment {
    path: Option<OsString>,
}

impl LaunchEnvironment {
    /// Capture the process PATH; on Windows merge the machine and user PATH
    /// registered in the registry (desktop launches normally have them, but
    /// development or sandbox parents can expose a reduced environment).
    pub fn capture() -> Self {
        let process_path = std::env::var_os("PATH");
        #[cfg(windows)]
        let path =
            crate::platform::windows_environment::merged_registered_path(process_path.as_deref())
                .or(process_path);
        #[cfg(not(windows))]
        let path = process_path;
        Self { path }
    }

    #[cfg_attr(not(test), allow(dead_code))] // no production consumer yet; decide keep-or-remove when m6-069 closes
    pub fn from_path(path: Option<OsString>) -> Self {
        Self { path }
    }

    #[cfg_attr(not(test), allow(dead_code))] // no production consumer yet; decide keep-or-remove when m6-069 closes
    pub fn path(&self) -> Option<&OsStr> {
        self.path.as_deref()
    }

    #[cfg_attr(not(test), allow(dead_code))] // no production consumer yet; decide keep-or-remove when m6-069 closes
    pub fn path_dirs(&self) -> Vec<PathBuf> {
        self.path
            .as_deref()
            .map(|path| {
                std::env::split_paths(path)
                    .filter(|directory| !directory.as_os_str().is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg_attr(not(windows), allow(dead_code))] // only the Windows executable lookup applies it
    pub fn apply_to_std(&self, command: &mut std::process::Command) {
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
    }

    #[cfg_attr(not(test), allow(dead_code))] // no production consumer yet; decide keep-or-remove when m6-069 closes
    pub fn apply_to_tokio(&self, command: &mut tokio::process::Command) {
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
    }

    pub fn apply_to_pty(&self, command: &mut portable_pty::CommandBuilder) {
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::ffi::OsStr;

    #[test]
    fn from_path_exposes_the_directories_in_order() {
        let first = PathBuf::from("first-dir");
        let second = PathBuf::from("second-dir");
        let joined = std::env::join_paths([&first, &second]).unwrap();

        let environment = LaunchEnvironment::from_path(Some(joined));

        assert_eq!(environment.path_dirs(), vec![first, second]);
        assert!(LaunchEnvironment::from_path(None).path_dirs().is_empty());
        assert_eq!(LaunchEnvironment::from_path(None).path(), None);
    }

    #[test]
    fn capture_keeps_the_process_path_directories() {
        let process_dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| {
                std::env::split_paths(&path)
                    .filter(|directory| !directory.as_os_str().is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let captured = LaunchEnvironment::capture().path_dirs();
        // The merge de-duplicates directories ignoring case and a trailing separator, so a process
        // PATH that lists `C:\dotnet` and `C:\dotnet\` keeps only the first spelling.
        let identity = |directory: &PathBuf| {
            directory
                .to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .to_ascii_lowercase()
        };
        let captured_identities: HashSet<String> = captured.iter().map(identity).collect();

        assert_eq!(captured.first(), process_dirs.first());
        for directory in &process_dirs {
            assert!(
                captured_identities.contains(&identity(directory)),
                "{directory:?} 丢失"
            );
        }
    }

    #[test]
    fn apply_sets_the_path_variable_on_std_and_tokio_commands() {
        let environment = LaunchEnvironment::from_path(Some("only-dir".into()));

        let mut std_command = std::process::Command::new("tool");
        environment.apply_to_std(&mut std_command);
        let value = std_command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PATH"))
            .and_then(|(_, value)| value);
        assert_eq!(value, Some(OsStr::new("only-dir")));

        let mut tokio_command = tokio::process::Command::new("tool");
        environment.apply_to_tokio(&mut tokio_command);
        let value = tokio_command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PATH"))
            .and_then(|(_, value)| value);
        assert_eq!(value, Some(OsStr::new("only-dir")));

        // 反向断言：没有 PATH 时不设置该变量。
        let mut untouched = std::process::Command::new("tool");
        LaunchEnvironment::from_path(None).apply_to_std(&mut untouched);
        assert!(untouched
            .get_envs()
            .all(|(key, _)| key != OsStr::new("PATH")));
    }

    #[test]
    fn apply_sets_the_path_variable_on_pty_commands() {
        let environment = LaunchEnvironment::from_path(Some("only-dir".into()));
        let mut command = portable_pty::CommandBuilder::new("tool");

        environment.apply_to_pty(&mut command);

        assert_eq!(command.get_env("PATH"), Some(OsStr::new("only-dir")));
    }
}
