use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;
use crate::services::version_service;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{AdapterFuture, CliAdapter};

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

    fn resume_args(&self, session_id: &str, mut existing_args: Vec<String>) -> Vec<String> {
        existing_args.push("--resume".to_string());
        existing_args.push(session_id.to_string());
        existing_args
    }

    fn query_update(&self) -> LatestVersion {
        let latest = version_service::fetch_release_text(LATEST_URL).and_then(|body| {
            version_service::normalize_semver(body.trim().trim_matches('"'))
                .ok_or_else(|| "Claude 官方版本响应格式无效".to_string())
        });
        version_service::latest_from_version_result(ToolKey::Claude, latest)
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
