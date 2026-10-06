use std::ffi::OsString;
use std::path::Path;

use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;
use crate::services::version_service;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{AdapterContext, AdapterFuture, CliAdapter};

const LATEST_URL: &str = "https://downloads.claude.ai/claude-code-releases/latest";

pub struct ClaudeAdapter;
pub static ADAPTER: ClaudeAdapter = ClaudeAdapter;

impl CliAdapter for ClaudeAdapter {
    fn tool_key(&self) -> ToolKey {
        ToolKey::Claude
    }

    fn command_candidates(&self) -> &'static [&'static str] {
        &["claude"]
    }

    fn probe_current_version<'a>(
        &'a self,
        path: &'a Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>
    {
        let environment = version_probe_environment(path);
        Box::pin(async move {
            crate::platform::detect::probe_version_with_env(path, &environment).await
        })
    }

    fn resume_args(&self, session_id: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec!["--resume".to_string(), session_id.to_string()])
    }

    fn query_update(&self, context: AdapterContext) -> AdapterFuture<LatestVersion> {
        crate::services::cli_adapters::blocking_latest(ToolKey::Claude, context, || {
            let latest = version_service::fetch_release_text(LATEST_URL).and_then(|body| {
                version_service::normalize_semver(body.trim().trim_matches('"'))
                    .ok_or_else(|| "Claude 官方版本响应格式无效".to_string())
            });
            version_service::latest_from_version_result(ToolKey::Claude, latest)
        })
    }

    fn build_plan(
        &self,
        kind: InstallKind,
        _context: &AdapterContext,
    ) -> anyhow::Result<InstallPlan> {
        platform::build_plan(kind)
    }

    fn prepare_command(&self, plan: &InstallPlan) -> tokio::process::Command {
        let mut command = crate::services::install_service::build_command(plan);
        if plan.kind == InstallKind::Update {
            if let Some((home, data_home)) =
                platform::native_install_context(Path::new(&plan.program))
            {
                command.env("HOME", home);
                command.env("XDG_DATA_HOME", data_home);
            }
        }
        command
    }

    fn execution_preflight(
        &self,
        plan: &InstallPlan,
    ) -> std::result::Result<crate::services::cli_adapters::ExecutionPreflight, String> {
        self.validate_execution(plan)?;
        Ok(crate::services::cli_adapters::ExecutionPreflight {
            message: self.execution_preflight_message(plan),
            verify_update_result: plan.kind == InstallKind::Update,
        })
    }

    fn list_sessions(
        &self,
        directory_path: String,
        cursor: Option<String>,
        limit: usize,
        context: AdapterContext,
    ) -> AdapterFuture<anyhow::Result<SessionPage>> {
        Box::pin(super::history::list_sessions_page(
            directory_path,
            cursor,
            limit,
            context,
        ))
    }

    fn search_index_source(
        &self,
        directory_path: String,
        context: AdapterContext,
    ) -> AdapterFuture<SessionSearchIndexSource> {
        Box::pin(super::history::search_index_source(directory_path, context))
    }

    fn session_belongs_to_directory(
        &self,
        directory_path: String,
        session_id: String,
    ) -> AdapterFuture<anyhow::Result<bool>> {
        Box::pin(super::history::session_belongs_to_directory(
            directory_path,
            session_id,
        ))
    }
}

fn version_probe_environment(path: &Path) -> Vec<(String, OsString)> {
    let mut environment = vec![("DISABLE_AUTOUPDATER".to_string(), OsString::from("1"))];
    if let Some((home, data_home)) = platform::native_install_context(path) {
        environment.push(("HOME".to_string(), home.into_os_string()));
        environment.push(("XDG_DATA_HOME".to_string(), data_home.into_os_string()));
    }
    environment
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::models::tool::ToolKey;
    use std::ffi::OsStr;
    use tempfile::tempdir;

    #[test]
    fn native_update_command_uses_install_home_not_isolated_app_home() {
        let root = tempdir().unwrap();
        let home = std::fs::canonicalize(root.path()).unwrap();
        let versions = home.join(".local/share/claude/versions");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let versioned_binary = versions.join("2.1.280");
        let command_link = bin.join("claude");
        std::fs::write(&versioned_binary, b"test").unwrap();
        std::os::unix::fs::symlink(&versioned_binary, &command_link).unwrap();
        let plan = InstallPlan {
            tool_key: ToolKey::Claude,
            kind: InstallKind::Update,
            program: command_link.display().to_string(),
            args: vec!["update".to_string()],
            fingerprint: String::new(),
            source: "test".to_string(),
            preview: "claude update".to_string(),
            effects: None,
        };

        let command = ADAPTER.prepare_command(&plan);
        assert!(command
            .as_std()
            .get_envs()
            .any(|(key, value)| { key == OsStr::new("HOME") && value == Some(home.as_os_str()) }));
        assert!(command.as_std().get_envs().any(|(key, value)| {
            key == OsStr::new("XDG_DATA_HOME")
                && value == Some(home.join(".local/share").as_os_str())
        }));
    }

    #[test]
    fn version_probe_disables_automatic_updates_and_uses_native_home() {
        let root = tempdir().unwrap();
        let home = std::fs::canonicalize(root.path()).unwrap();
        let versions = home.join(".local/share/claude/versions");
        std::fs::create_dir_all(&versions).unwrap();
        let binary = versions.join("2.1.280");
        std::fs::write(&binary, b"test").unwrap();

        let environment = version_probe_environment(&binary);

        assert!(environment
            .iter()
            .any(|(key, value)| { key == "DISABLE_AUTOUPDATER" && value == OsStr::new("1") }));
        assert!(environment
            .iter()
            .any(|(key, value)| { key == "HOME" && value == home.as_os_str() }));
        assert!(environment.iter().any(|(key, value)| {
            key == "XDG_DATA_HOME" && value == home.join(".local/share").as_os_str()
        }));
    }
}

#[cfg(test)]
mod session_id_tests {
    use crate::models::tool::ToolKey;

    #[test]
    fn rejects_unsafe_claude_session_ids() {
        for session_id in [
            "-resume-as-option".to_string(),
            "x".repeat(257),
            "session id".to_string(),
            "session/child".to_string(),
            "session\\child".to_string(),
        ] {
            assert!(!crate::services::cli_adapters::valid_session_id(
                ToolKey::Claude,
                &session_id
            ));
        }
    }
}

#[cfg(test)]
mod preflight_tests {
    use super::*;

    fn plan(kind: InstallKind) -> InstallPlan {
        InstallPlan {
            tool_key: ToolKey::Claude,
            kind,
            program: "claude".to_string(),
            args: Vec::new(),
            fingerprint: String::new(),
            source: "test".to_string(),
            preview: "claude".to_string(),
            effects: None,
        }
    }

    #[test]
    fn update_result_verification_is_part_of_execution_preflight() {
        assert!(
            !ADAPTER
                .execution_preflight(&plan(InstallKind::Install))
                .unwrap()
                .verify_update_result
        );
        assert!(
            ADAPTER
                .execution_preflight(&plan(InstallKind::Update))
                .unwrap()
                .verify_update_result
        );
    }
}
