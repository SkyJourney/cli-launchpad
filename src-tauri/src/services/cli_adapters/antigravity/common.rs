use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;
use crate::services::version_service;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{AdapterFuture, CliAdapter};

const LATEST_BASE_URL: &str =
    "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

pub struct AntigravityAdapter;
pub static ADAPTER: AntigravityAdapter = AntigravityAdapter;

impl CliAdapter for AntigravityAdapter {
    fn tool_key(&self) -> ToolKey {
        ToolKey::Antigravity
    }

    fn command_candidates(&self) -> &'static [&'static str] {
        &["agy", "antigravity"]
    }

    fn additional_install_dirs(&self) -> Vec<std::path::PathBuf> {
        #[cfg(windows)]
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            return vec![std::path::PathBuf::from(local_app_data)
                .join("agy")
                .join("bin")];
        }
        Vec::new()
    }

    fn resume_args(&self, session_id: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec![format!("--conversation={session_id}")])
    }

    fn query_update(&self) -> LatestVersion {
        let latest = super::version::platform()
            .and_then(|platform| {
                version_service::fetch_release_text(&format!("{LATEST_BASE_URL}/{platform}.json"))
            })
            .and_then(|body| super::version::parse_antigravity_latest(&body));
        version_service::latest_from_version_result(ToolKey::Antigravity, latest)
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
            crate::services::cli_adapters::antigravity::history::list_sessions_page(
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
        Box::pin(
            crate::services::cli_adapters::antigravity::history::search_index_source(
                directory_path,
            ),
        )
    }

    fn session_belongs_to_directory(
        &self,
        directory_path: String,
        session_id: String,
    ) -> AdapterFuture<anyhow::Result<bool>> {
        Box::pin(
            crate::services::cli_adapters::antigravity::history::session_belongs_to_directory(
                directory_path,
                session_id,
            ),
        )
    }
}
