use super::version;
use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{AdapterFuture, CliAdapter};

pub struct HermesAdapter;
pub static ADAPTER: HermesAdapter = HermesAdapter;

impl CliAdapter for HermesAdapter {
    fn tool_key(&self) -> ToolKey {
        ToolKey::Hermes
    }

    fn command_candidates(&self) -> &'static [&'static str] {
        &["hermes"]
    }

    fn additional_install_dirs(&self) -> Vec<std::path::PathBuf> {
        super::version::hermes_install_dirs()
    }

    fn probe_current_version<'a>(
        &'a self,
        path: &'a std::path::Path,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = std::result::Result<String, String>> + Send + 'a>,
    > {
        Box::pin(super::version::probe_current_version(path))
    }

    fn resume_args(&self, session_id: &str, mut existing_args: Vec<String>) -> Vec<String> {
        existing_args.push("--resume".to_string());
        existing_args.push(session_id.to_string());
        existing_args.push("--no-restore-cwd".to_string());
        existing_args
    }

    fn valid_session_id(&self, session_id: &str) -> bool {
        super::history::valid_session_id(session_id)
    }

    fn query_update(&self) -> LatestVersion {
        match version::fetch_hermes_update_check() {
            Ok(check) => LatestVersion {
                tool_key: ToolKey::Hermes,
                latest: None,
                update_available: check.update_available,
                commits_behind: check.commits_behind,
                error: check.error,
                from_cache: false,
                managed_update_allowed: check.managed_update_allowed,
                management_message: check.management_message,
            },
            Err(error) => LatestVersion {
                tool_key: ToolKey::Hermes,
                latest: None,
                update_available: None,
                commits_behind: None,
                error: Some(error),
                from_cache: false,
                managed_update_allowed: false,
                management_message: Some(
                    "无法确认 Hermes Agent 的官方源码安装状态；请检查 CLI 后重试".to_string(),
                ),
            },
        }
    }

    fn build_plan(&self, kind: InstallKind) -> anyhow::Result<InstallPlan> {
        platform::build_plan(kind)
    }

    fn list_sessions(
        &self,
        directory_path: String,
        cursor: Option<String>,
        limit: usize,
    ) -> AdapterFuture<anyhow::Result<SessionPage>> {
        Box::pin(super::history::list_sessions_page(
            directory_path,
            cursor,
            limit,
        ))
    }

    fn search_index_source(
        &self,
        directory_path: String,
    ) -> AdapterFuture<SessionSearchIndexSource> {
        Box::pin(super::history::search_index_source(directory_path))
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
