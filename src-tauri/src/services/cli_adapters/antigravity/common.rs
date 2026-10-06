use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;
use crate::services::version_service;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{AdapterContext, AdapterFuture, CliAdapter};

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

    fn query_update(&self, context: AdapterContext) -> AdapterFuture<LatestVersion> {
        crate::services::cli_adapters::blocking_latest(ToolKey::Antigravity, context, || {
            let latest = super::version::platform()
                .and_then(|platform| {
                    version_service::fetch_release_text(&format!(
                        "{LATEST_BASE_URL}/{platform}.json"
                    ))
                })
                .and_then(|body| super::version::parse_antigravity_latest(&body));
            version_service::latest_from_version_result(ToolKey::Antigravity, latest)
        })
    }

    fn build_plan(
        &self,
        kind: InstallKind,
        _context: &AdapterContext,
    ) -> anyhow::Result<InstallPlan> {
        platform::build_plan(kind)
    }

    fn list_sessions(
        &self,
        directory_path: String,
        cursor: Option<String>,
        limit: usize,
        context: AdapterContext,
    ) -> AdapterFuture<anyhow::Result<SessionPage>> {
        Box::pin(
            crate::services::cli_adapters::antigravity::history::list_sessions_page(
                directory_path,
                cursor,
                limit,
                context,
            ),
        )
    }

    fn search_index_source(
        &self,
        directory_path: String,
        context: AdapterContext,
    ) -> AdapterFuture<SessionSearchIndexSource> {
        Box::pin(
            crate::services::cli_adapters::antigravity::history::search_index_source(
                directory_path,
                context,
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

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_unsafe_antigravity_session_ids() {
        for session_id in [
            "-resume-as-option".to_string(),
            "x".repeat(257),
            "session id".to_string(),
            "session/child".to_string(),
            "session\\child".to_string(),
        ] {
            assert!(!crate::services::cli_adapters::valid_session_id(
                crate::models::tool::ToolKey::Antigravity,
                &session_id
            ));
        }
    }
}
