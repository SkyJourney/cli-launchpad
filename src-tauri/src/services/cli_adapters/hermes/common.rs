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

    fn resume_args(&self, session_id: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec![
            "--resume".to_string(),
            session_id.to_string(),
            "--no-restore-cwd".to_string(),
        ])
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

    fn execution_preflight_message(&self, plan: &InstallPlan) -> Option<&'static str> {
        (plan.kind == InstallKind::Update).then_some("正在后台校验 Hermes Agent 源码安装来源。")
    }

    fn validate_execution(&self, plan: &InstallPlan) -> Result<(), String> {
        if plan.kind != InstallKind::Update {
            return Ok(());
        }
        version::validate_managed_install(std::path::Path::new(&plan.program))
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
