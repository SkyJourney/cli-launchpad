use super::version;
use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::tool::ToolKey;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{
    AdapterContext, AdapterFuture, CliAdapter, ManagedUpdatePolicy, ProviderCapabilities,
    ProviderDescriptor, UpdateSemantics, PROVIDER_DESCRIPTOR_API_VERSION,
};

pub struct GrokAdapter;
pub static ADAPTER: GrokAdapter = GrokAdapter;

impl CliAdapter for GrokAdapter {
    fn tool_key(&self) -> ToolKey {
        ToolKey::Grok
    }

    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            tool_key: ToolKey::Grok,
            api_version: PROVIDER_DESCRIPTOR_API_VERSION,
            capabilities: ProviderCapabilities {
                history: true,
                resume: true,
                update_semantics: UpdateSemantics::Version,
                managed_update: ManagedUpdatePolicy::SourceVerified {
                    denied_reason_key: "settings.grokUpdateSourceDenied",
                },
                install_effects_key: Some("grok"),
            },
        }
    }

    fn command_candidates(&self) -> &'static [&'static str] {
        &["grok"]
    }

    fn requires_executable_path(&self) -> bool {
        true
    }

    fn additional_install_dirs(&self) -> Vec<std::path::PathBuf> {
        version::grok_native_install_dirs()
    }

    fn resume_args(&self, session_id: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec!["--resume".to_string(), session_id.to_string()])
    }

    fn query_update(&self, context: AdapterContext) -> AdapterFuture<LatestVersion> {
        let path = context.resolved_path.clone();
        crate::services::cli_adapters::blocking_latest(ToolKey::Grok, context, move || {
            match version::fetch_grok_update_check(path.as_deref()) {
                Ok((check, managed_update_allowed, _management_message)) => LatestVersion {
                    tool_key: ToolKey::Grok,
                    latest: Some(check.latest_version),
                    update_availability: crate::models::install::UpdateAvailability::Unknown,
                    commits_behind: None,
                    error: None,
                    from_cache: false,
                    managed_update: ADAPTER.managed_update(Some(managed_update_allowed)),
                },
                Err(error) => LatestVersion {
                    tool_key: ToolKey::Grok,
                    latest: None,
                    update_availability: crate::models::install::UpdateAvailability::Unknown,
                    commits_behind: None,
                    error: Some(error),
                    from_cache: false,
                    managed_update: ADAPTER.managed_update_after_failed_query(),
                },
            }
        })
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

    fn build_plan(
        &self,
        kind: InstallKind,
        context: &AdapterContext,
    ) -> anyhow::Result<InstallPlan> {
        platform::build_plan(kind, context)
    }

    fn list_sessions(
        &self,
        directory_path: String,
        cursor: Option<String>,
        limit: usize,
        context: AdapterContext,
    ) -> AdapterFuture<anyhow::Result<SessionPage>> {
        Box::pin(
            crate::services::cli_adapters::grok::history::list_sessions_page(
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
            crate::services::cli_adapters::grok::history::search_index_source(
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
            crate::services::cli_adapters::grok::history::session_belongs_to_directory(
                directory_path,
                session_id,
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_unsafe_grok_session_ids() {
        for session_id in [
            "-resume-as-option".to_string(),
            "x".repeat(257),
            "session id".to_string(),
            "session/child".to_string(),
            "session\\child".to_string(),
        ] {
            assert!(!crate::services::cli_adapters::valid_session_id(
                crate::models::tool::ToolKey::Grok,
                &session_id
            ));
        }
    }
}
