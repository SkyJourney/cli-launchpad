use super::version;
use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{AdapterFuture, CliAdapter};

pub struct GrokAdapter;
pub static ADAPTER: GrokAdapter = GrokAdapter;

impl CliAdapter for GrokAdapter {
    fn tool_key(&self) -> ToolKey {
        ToolKey::Grok
    }

    fn command_candidates(&self) -> &'static [&'static str] {
        &["grok"]
    }

    fn additional_install_dirs(&self) -> Vec<std::path::PathBuf> {
        version::grok_native_install_dirs()
    }

    fn resume_args(&self, session_id: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec!["--resume".to_string(), session_id.to_string()])
    }

    fn query_update(&self) -> LatestVersion {
        match version::fetch_grok_update_check() {
            Ok((check, managed_update_allowed, management_message)) => LatestVersion {
                tool_key: ToolKey::Grok,
                latest: Some(check.latest_version),
                update_available: None,
                commits_behind: None,
                error: None,
                from_cache: false,
                managed_update_allowed,
                management_message,
            },
            Err(error) => LatestVersion {
                tool_key: ToolKey::Grok,
                latest: None,
                update_available: None,
                commits_behind: None,
                error: Some(error),
                from_cache: false,
                managed_update_allowed: false,
                management_message: Some(
                    "无法确认 Grok Build 安装来源；请检查 CLI 后重试".to_string(),
                ),
            },
        }
    }

    fn prepare_command(&self, plan: &InstallPlan) -> tokio::process::Command {
        let mut command = crate::services::install_service::build_command(plan);
        if plan.kind == InstallKind::Update {
            crate::platform::process::remove_pnpm_user_agent(&mut command);
        }
        command
    }

    fn execution_preflight_message(&self, plan: &InstallPlan) -> Option<&'static str> {
        (plan.kind == InstallKind::Update).then_some("正在后台校验 Grok Build 更新来源。")
    }

    fn validate_execution(&self, plan: &InstallPlan) -> Result<(), String> {
        if plan.kind != InstallKind::Update {
            return Ok(());
        }
        let path = std::path::Path::new(&plan.program);
        let check = version::inspect_grok_update_check(path)?;
        version::validate_grok_native_update_source(check.installer.as_deref())
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
        Box::pin(
            crate::services::cli_adapters::grok::history::list_sessions_page(
                directory_path,
                cursor,
                limit,
            ),
        )
    }

    fn search_index_source(
        &self,
        directory_path: String,
    ) -> AdapterFuture<SessionSearchIndexSource> {
        Box::pin(crate::services::cli_adapters::grok::history::search_index_source(directory_path))
    }

    fn session_belongs_to_directory(
        &self,
        directory_path: String,
        session_id: String,
    ) -> AdapterFuture<anyhow::Result<bool>> {
        Box::pin(
            crate::services::cli_adapters::grok::history::session_belongs_to_directory(
                directory_path,
                session_id,
            ),
        )
    }
}
