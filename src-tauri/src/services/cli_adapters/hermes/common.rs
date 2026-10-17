use super::version;
use crate::models::install::{InstallKind, InstallPlan, LatestVersion, UpdateAvailability};
use crate::models::tool::ToolKey;

use super::platform;
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::services::cli_adapters::{
    AdapterContext, AdapterFuture, CliAdapter, ManagedUpdatePolicy, ProviderCapabilities,
    ProviderDescriptor, UpdateSemantics, PROVIDER_DESCRIPTOR_API_VERSION,
};

pub struct HermesAdapter;
pub static ADAPTER: HermesAdapter = HermesAdapter;

impl CliAdapter for HermesAdapter {
    fn tool_key(&self) -> ToolKey {
        ToolKey::Hermes
    }

    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            tool_key: ToolKey::Hermes,
            api_version: PROVIDER_DESCRIPTOR_API_VERSION,
            capabilities: ProviderCapabilities {
                history: true,
                resume: true,
                update_semantics: UpdateSemantics::Branch,
                managed_update: ManagedUpdatePolicy::SourceVerified {
                    denied_reason_key: "settings.hermesUpdateSourceDenied",
                },
                install_effects_key: Some("hermes"),
            },
        }
    }

    fn command_candidates(&self) -> &'static [&'static str] {
        &["hermes"]
    }

    fn requires_executable_path(&self) -> bool {
        true
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

    fn query_update(&self, context: AdapterContext) -> AdapterFuture<LatestVersion> {
        let path = context.resolved_path.clone();
        let home = context.home.clone();
        crate::services::cli_adapters::blocking_latest(ToolKey::Hermes, context, move || {
            match version::fetch_hermes_update_check(path.as_deref(), &home) {
                Ok(check) => {
                    let managed_update = hermes_managed_update(&check);
                    LatestVersion {
                        tool_key: ToolKey::Hermes,
                        latest: None,
                        update_availability: match check.update_available {
                            Some(true) => UpdateAvailability::Available,
                            Some(false) => UpdateAvailability::UpToDate,
                            None => UpdateAvailability::Unknown,
                        },
                        commits_behind: check.commits_behind,
                        error: check.error,
                        from_cache: false,
                        managed_update,
                    }
                }
                Err(error) => LatestVersion {
                    tool_key: ToolKey::Hermes,
                    latest: None,
                    update_availability: UpdateAvailability::Unknown,
                    commits_behind: None,
                    error: Some(error),
                    from_cache: false,
                    managed_update: ADAPTER.managed_update_after_failed_query(),
                },
            }
        })
    }

    fn build_plan(
        &self,
        kind: InstallKind,
        context: &AdapterContext,
    ) -> anyhow::Result<InstallPlan> {
        platform::build_plan(kind, context)
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

fn hermes_managed_update(
    check: &super::version::HermesUpdateCheck,
) -> crate::models::install::ManagedUpdateStatus {
    // 官方检查输出被截断：既没有验证来源，也没有证据表明来源被拒，按“查询失败”处理。
    if check.error.is_some() && !check.managed_update_allowed {
        return ADAPTER.managed_update_after_failed_query();
    }
    ADAPTER.managed_update(Some(check.managed_update_allowed))
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_unsafe_hermes_session_ids() {
        for session_id in [
            "-resume-as-option".to_string(),
            "x".repeat(257),
            "session id".to_string(),
            "session/child".to_string(),
            "session\\child".to_string(),
        ] {
            assert!(!crate::services::cli_adapters::valid_session_id(
                crate::models::tool::ToolKey::Hermes,
                &session_id
            ));
        }
    }

    #[test]
    fn inconclusive_hermes_checks_do_not_report_a_denied_source() {
        use super::hermes_managed_update;
        use crate::models::install::ManagedUpdateStatus;
        use crate::services::cli_adapters::hermes::version::HermesUpdateCheck;

        let check = |error: Option<&str>, allowed: bool| HermesUpdateCheck {
            update_available: None,
            commits_behind: None,
            error: error.map(str::to_string),
            managed_update_allowed: allowed,
            management_message: None,
        };

        // 输出被截断：无法确认，不是“来源被拒”。
        assert_eq!(
            hermes_managed_update(&check(Some("输出超过上限"), false)),
            ManagedUpdateStatus::NotApplicable
        );
        // 来源已验证、只是更新检查失败：保持允许。
        assert_eq!(
            hermes_managed_update(&check(Some("检查失败"), true)),
            ManagedUpdateStatus::Allowed
        );
        // 来源验证被拒（没有错误文本）：才是真正的 Denied。
        assert!(matches!(
            hermes_managed_update(&check(None, false)),
            ManagedUpdateStatus::Denied { .. }
        ));
        assert_eq!(
            hermes_managed_update(&check(None, true)),
            ManagedUpdateStatus::Allowed
        );
    }
}
