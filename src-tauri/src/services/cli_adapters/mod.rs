use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use anyhow::Result;

use crate::models::install::{InstallKind, InstallPlan, LatestVersion};
use crate::models::session::{SessionPage, SessionSearchIndexSource};
use crate::models::tool::ToolKey;

pub(crate) type AdapterFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Debug, Clone)]
pub struct AdapterContext {
    pub resolved_path: Option<PathBuf>,
    pub home: PathBuf,
    pub budget: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionPreflight {
    pub message: Option<&'static str>,
    pub verify_update_result: bool,
}

impl AdapterContext {
    fn for_adapter(adapter: &dyn CliAdapter, budget: Duration) -> Result<Self> {
        Ok(Self {
            resolved_path: installed_path(adapter),
            home: crate::services::session_service::home_dir()?,
            budget,
        })
    }
}

pub(crate) mod antigravity;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod grok;
pub(crate) mod hermes;

pub trait CliAdapter: Sync {
    fn tool_key(&self) -> ToolKey;

    fn resume_args(&self, session_id: &str) -> Result<Vec<String>>;

    fn valid_session_id(&self, session_id: &str) -> bool {
        crate::services::session_service::safe_session_id(session_id)
    }

    fn command_candidates(&self) -> &'static [&'static str];

    fn additional_install_dirs(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    fn probe_current_version<'a>(
        &'a self,
        path: &'a Path,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<String, String>> + Send + 'a>> {
        Box::pin(crate::platform::detect::probe_version(path))
    }

    fn query_update(&self, context: AdapterContext) -> AdapterFuture<LatestVersion> {
        let tool_key = self.tool_key();
        Box::pin(async move {
            let _ = context;
            crate::services::version_service::latest_from_version_result(
                tool_key,
                Err(format!("{} 尚未配置版本或更新状态查询", tool_key.as_str())),
            )
        })
    }

    fn build_plan(&self, _kind: InstallKind, _context: &AdapterContext) -> Result<InstallPlan> {
        anyhow::bail!("{} 尚未配置安装或更新计划", self.tool_key().as_str())
    }

    fn list_sessions(
        &self,
        _directory_path: String,
        _cursor: Option<String>,
        _limit: usize,
        _context: AdapterContext,
    ) -> AdapterFuture<Result<SessionPage>> {
        let tool_key = self.tool_key();
        Box::pin(async move { anyhow::bail!("{} 尚未实现会话历史读取", tool_key.as_str()) })
    }

    fn search_index_source(
        &self,
        directory_path: String,
        _context: AdapterContext,
    ) -> AdapterFuture<SessionSearchIndexSource> {
        let _ = directory_path;
        let tool_key = self.tool_key();
        Box::pin(async move {
            SessionSearchIndexSource {
                tool_key,
                documents: None,
                incomplete: true,
            }
        })
    }

    fn session_belongs_to_directory(
        &self,
        _directory_path: String,
        _session_id: String,
    ) -> AdapterFuture<Result<bool>> {
        let tool_key = self.tool_key();
        Box::pin(async move { anyhow::bail!("{} 尚未实现会话归属校验", tool_key.as_str()) })
    }

    fn prepare_command(&self, plan: &InstallPlan) -> tokio::process::Command {
        crate::services::install_service::build_command(plan)
    }

    fn execution_preflight_message(&self, _plan: &InstallPlan) -> Option<&'static str> {
        None
    }

    fn execution_preflight(
        &self,
        plan: &InstallPlan,
    ) -> std::result::Result<ExecutionPreflight, String> {
        self.validate_execution(plan)?;
        Ok(ExecutionPreflight {
            message: self.execution_preflight_message(plan),
            verify_update_result: false,
        })
    }

    fn validate_execution(&self, _plan: &InstallPlan) -> std::result::Result<(), String> {
        Ok(())
    }
}

pub fn get(tool_key: ToolKey) -> &'static dyn CliAdapter {
    match tool_key {
        ToolKey::Claude => &claude::ADAPTER,
        ToolKey::Codex => &codex::ADAPTER,
        ToolKey::Antigravity => &antigravity::ADAPTER,
        ToolKey::Grok => &grok::ADAPTER,
        ToolKey::Hermes => &hermes::ADAPTER,
    }
}

pub(crate) fn all() -> impl Iterator<Item = &'static dyn CliAdapter> {
    ToolKey::ALL.into_iter().map(get)
}

pub fn installed_path(adapter: &dyn CliAdapter) -> Option<PathBuf> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::platform::detect::resolve_executable_path_with_dirs(
            adapter.command_candidates(),
            &adapter.additional_install_dirs(),
        )
        .map(PathBuf::from)
    }))
    .ok()
    .flatten()
}

pub async fn installed_path_async(adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
    let candidates = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        adapter.command_candidates()
    }))
    .ok()?;
    for candidate in candidates {
        if let Some(path) = crate::platform::detect::which(candidate).await {
            return Some(path);
        }
    }
    let additional_dirs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        adapter.additional_install_dirs()
    }))
    .ok()?;
    for candidate in candidates {
        if let Some(path) =
            crate::platform::detect::find_in_known_dirs_with(candidate, &additional_dirs)
        {
            return Some(path);
        }
    }
    None
}

pub fn build_plan(tool_key: ToolKey, kind: InstallKind) -> Result<InstallPlan> {
    let context = AdapterContext::for_adapter(get(tool_key), Duration::from_secs(30))?;
    let mut plan = catch_adapter(tool_key, "构造安装或更新计划", || {
        get(tool_key).build_plan(kind, &context)
    })?;
    plan.refresh_fingerprint();
    Ok(plan)
}

pub fn context_for_tool(tool_key: ToolKey, budget: Duration) -> Result<AdapterContext> {
    AdapterContext::for_adapter(get(tool_key), budget)
}

pub async fn query_update(tool_key: ToolKey, context: AdapterContext) -> LatestVersion {
    let budget = context.budget;
    let query = get(tool_key).query_update(context);
    match tokio::time::timeout(budget, tokio::spawn(query)).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => crate::services::version_service::latest_from_version_result(
            tool_key,
            Err(format!("{} 版本查询适配器异常：{error}", tool_key.as_str())),
        ),
        Err(_) => crate::services::version_service::latest_from_version_result(
            tool_key,
            Err(format!("{} 版本查询超时", tool_key.as_str())),
        ),
    }
}

pub(crate) fn blocking_latest(
    tool_key: ToolKey,
    context: AdapterContext,
    operation: impl FnOnce() -> LatestVersion + Send + 'static,
) -> AdapterFuture<LatestVersion> {
    Box::pin(async move {
        match tokio::time::timeout(context.budget, tokio::task::spawn_blocking(operation)).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => crate::services::version_service::latest_from_version_result(
                tool_key,
                Err(format!("{} 版本查询适配器异常：{error}", tool_key.as_str())),
            ),
            Err(_) => crate::services::version_service::latest_from_version_result(
                tool_key,
                Err(format!("{} 版本查询超时", tool_key.as_str())),
            ),
        }
    })
}

pub fn execution_preflight(plan: &InstallPlan) -> std::result::Result<ExecutionPreflight, String> {
    catch_adapter(plan.tool_key, "执行前校验", || {
        run_execution_preflight(get(plan.tool_key), plan)
    })
    .map_err(|error| error.to_string())
}

fn run_execution_preflight(
    adapter: &dyn CliAdapter,
    plan: &InstallPlan,
) -> Result<ExecutionPreflight> {
    adapter
        .execution_preflight(plan)
        .map_err(anyhow::Error::msg)
}

pub fn prepare_command(plan: &InstallPlan) -> Result<tokio::process::Command> {
    catch_adapter(plan.tool_key, "准备执行命令", || {
        Ok(get(plan.tool_key).prepare_command(plan))
    })
}

pub async fn probe_plan_version(plan: &InstallPlan) -> Result<String, String> {
    let tool_key = plan.tool_key;
    let path = PathBuf::from(&plan.program);
    tokio::spawn(async move { get(tool_key).probe_current_version(&path).await })
        .await
        .map_err(|error| format!("{} 版本探测适配器异常：{error}", tool_key.as_str()))?
}

pub fn resume_args(tool_key: ToolKey, session_id: &str) -> Result<Vec<String>> {
    if !valid_session_id(tool_key, session_id) {
        anyhow::bail!("{} 会话 ID 格式无效", tool_key.as_str());
    }
    catch_adapter(tool_key, "构造会话恢复参数", || {
        get(tool_key).resume_args(session_id)
    })
}

pub fn valid_session_id(tool_key: ToolKey, session_id: &str) -> bool {
    !session_id.starts_with('-')
        && std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            get(tool_key).valid_session_id(session_id)
        }))
        .unwrap_or(false)
}

fn catch_adapter<T>(
    tool_key: ToolKey,
    operation: &str,
    operation_fn: impl FnOnce() -> Result<T>,
) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation_fn))
        .map_err(|_| anyhow::anyhow!("{} 适配器在{operation}时发生异常", tool_key.as_str()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_registry_covers_the_fixed_cli_scope_in_product_order() {
        let registered: Vec<_> = all().map(|adapter| adapter.tool_key()).collect();

        assert_eq!(registered, ToolKey::ALL);
    }

    #[test]
    fn adapter_panics_become_scoped_errors() {
        let error = catch_adapter(ToolKey::Hermes, "测试", || -> Result<()> {
            panic!("adapter panic")
        })
        .unwrap_err();

        assert!(error.to_string().contains("hermes"));
        assert!(error.to_string().contains("测试"));
    }

    struct MissingHistoryAdapter;

    impl CliAdapter for MissingHistoryAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Hermes
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["hermes"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            anyhow::bail!("会话恢复未实现")
        }
    }

    #[tokio::test]
    async fn missing_history_capabilities_return_errors_instead_of_empty_success() {
        let adapter = MissingHistoryAdapter;
        assert!(adapter
            .list_sessions(
                "project".to_string(),
                None,
                10,
                AdapterContext {
                    resolved_path: None,
                    home: std::env::temp_dir(),
                    budget: Duration::from_secs(1),
                }
            )
            .await
            .is_err());
        assert!(adapter
            .session_belongs_to_directory("project".to_string(), "session".to_string())
            .await
            .is_err());
        let index = adapter
            .search_index_source(
                "project".to_string(),
                AdapterContext {
                    resolved_path: None,
                    home: std::env::temp_dir(),
                    budget: Duration::from_secs(1),
                },
            )
            .await;
        assert!(index.incomplete);
        assert!(index.documents.is_none());
    }

    struct ValidateWithoutMessageAdapter(std::sync::atomic::AtomicBool);

    impl CliAdapter for ValidateWithoutMessageAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Hermes
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["hermes"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn validate_execution(&self, _plan: &InstallPlan) -> std::result::Result<(), String> {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn execution_validation_runs_even_without_a_preflight_message() {
        use std::sync::atomic::Ordering;

        let adapter = ValidateWithoutMessageAdapter(std::sync::atomic::AtomicBool::new(false));
        let plan = InstallPlan {
            tool_key: ToolKey::Hermes,
            kind: InstallKind::Update,
            program: "hermes".to_string(),
            args: vec!["update".to_string()],
            fingerprint: String::new(),
            source: "test".to_string(),
            preview: "hermes update".to_string(),
            effects: None,
        };

        assert_eq!(
            run_execution_preflight(&adapter, &plan).unwrap(),
            ExecutionPreflight {
                message: None,
                verify_update_result: false,
            }
        );
        assert!(adapter.0.load(Ordering::SeqCst));
    }

    #[test]
    fn adapter_resume_errors_fail_closed() {
        let adapter = MissingHistoryAdapter;

        assert!(adapter.resume_args("session").is_err());
    }
}
