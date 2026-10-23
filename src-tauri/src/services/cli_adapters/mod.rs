use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
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

pub(crate) mod antigravity;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod descriptor;
pub(crate) mod grok;
pub(crate) mod hermes;
pub(crate) mod support;

pub use descriptor::{
    ManagedUpdatePolicy, ProviderCapabilities, ProviderDescriptor, UpdateSemantics,
    PROVIDER_DESCRIPTOR_API_VERSION,
};

pub trait CliAdapter: Sync {
    fn tool_key(&self) -> ToolKey;

    /// Static facts about this provider. No default: adding a provider must
    /// declare its capabilities.
    fn descriptor(&self) -> ProviderDescriptor;

    /// Managed update status given the source verification evidence.
    fn managed_update(
        &self,
        source_verified: Option<bool>,
    ) -> crate::models::install::ManagedUpdateStatus {
        self.descriptor()
            .capabilities
            .managed_update
            .status(source_verified)
    }

    /// Managed update status when the version query itself failed.
    fn managed_update_after_failed_query(&self) -> crate::models::install::ManagedUpdateStatus {
        self.descriptor()
            .capabilities
            .managed_update
            .status_after_failed_query()
    }

    fn resume_args(&self, session_id: &str) -> Result<Vec<String>>;

    fn valid_session_id(&self, session_id: &str) -> bool {
        crate::services::cli_adapters::support::safe_session_id(session_id)
    }

    fn command_candidates(&self) -> &'static [&'static str];

    /// Whether any operation of this adapter reads `AdapterContext::resolved_path`.
    /// Only adapters returning `true` pay for executable resolution.
    fn requires_executable_path(&self) -> bool {
        false
    }

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

fn resolve_installed_blocking(adapter: &dyn CliAdapter) -> Option<PathBuf> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::platform::executable_resolver::resolve_blocking(
            adapter.command_candidates(),
            &adapter.additional_install_dirs(),
            &crate::platform::launch_environment::LaunchEnvironment::capture(),
        )
        .map(|found| found.path)
    }))
    .ok()
    .flatten()
}

/// Resolves the executable path of an adapter. Replaceable so tests can inject
/// slow, panicking or counting resolvers without touching the real PATH.
pub trait ExecutableResolver: Send + Sync + 'static {
    fn resolve(&self, adapter: &'static dyn CliAdapter) -> Option<PathBuf>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NativeExecutableResolver;

impl ExecutableResolver for NativeExecutableResolver {
    fn resolve(&self, adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
        resolve_installed_blocking(adapter)
    }
}

/// Resolves the adapter's executable path inside the budget. Only adapters that declare
/// `requires_executable_path()` pay for it; resolution runs on a blocking thread, so a slow
/// probe never occupies the async executor. Exhausting the budget means "timed out": the
/// remaining budget is zero and the adapter must not be called. A panicking resolver counts as
/// "not found" and keeps the remaining budget.
pub async fn context_within_budget(
    adapter: &'static dyn CliAdapter,
    budget: Duration,
    home: PathBuf,
    resolver: Arc<dyn ExecutableResolver>,
) -> (AdapterContext, Duration) {
    let needs_path = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        adapter.requires_executable_path()
    }))
    .unwrap_or(false);
    if !needs_path {
        return (
            AdapterContext {
                resolved_path: None,
                home,
                budget,
            },
            budget,
        );
    }
    let started = std::time::Instant::now();
    let (resolved_path, exhausted) = match tokio::time::timeout(
        budget,
        tokio::task::spawn_blocking(move || resolver.resolve(adapter)),
    )
    .await
    {
        Ok(Ok(path)) => (path, false),
        // The resolver panicked: treat as "not found" and keep the budget.
        Ok(Err(_)) => (None, false),
        Err(_) => (None, true),
    };
    let remaining = if exhausted {
        Duration::ZERO
    } else {
        budget.saturating_sub(started.elapsed())
    };
    (
        AdapterContext {
            resolved_path,
            home,
            budget: remaining,
        },
        remaining,
    )
}

/// Plan building always needs the executable (updates run it), regardless of
/// `requires_executable_path()` which only governs the history and version paths.
fn plan_context_with(
    adapter: &'static dyn CliAdapter,
    budget: Duration,
    home: PathBuf,
    resolver: &dyn ExecutableResolver,
) -> AdapterContext {
    AdapterContext {
        resolved_path: resolver.resolve(adapter),
        home,
        budget,
    }
}

pub fn build_plan(tool_key: ToolKey, kind: InstallKind) -> Result<InstallPlan> {
    let context = plan_context_with(
        get(tool_key),
        Duration::from_secs(30),
        crate::platform::home::home_dir()?,
        &NativeExecutableResolver,
    );
    let mut plan = catch_adapter(tool_key, "构造安装或更新计划", || {
        get(tool_key).build_plan(kind, &context)
    })?;
    plan.refresh_fingerprint();
    Ok(plan)
}

pub async fn query_update(tool_key: ToolKey, context: AdapterContext) -> LatestVersion {
    let budget = context.budget;
    match crate::services::cli_runtime::run(tool_key, "版本查询", budget, move |adapter| {
        adapter.query_update(context)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => crate::services::version_service::latest_from_version_result(
            tool_key,
            Err(error.to_string()),
        ),
    }
}

/// Runs a blocking version query on the blocking pool. The budget is enforced
/// once, by `cli_runtime::run` around the whole adapter call, so the context
/// is accepted only to keep adapters passing their own.
pub(crate) fn blocking_latest(
    tool_key: ToolKey,
    _context: AdapterContext,
    operation: impl FnOnce() -> LatestVersion + Send + 'static,
) -> AdapterFuture<LatestVersion> {
    Box::pin(async move {
        match tokio::task::spawn_blocking(operation).await {
            Ok(result) => result,
            Err(error) => crate::services::version_service::latest_from_version_result(
                tool_key,
                Err(format!("{} 版本查询适配器异常：{error}", tool_key.as_str())),
            ),
        }
    })
}

pub(crate) const VERSION_PROBE_BUDGET: Duration = Duration::from_secs(15);
pub(crate) const EXECUTION_PREFLIGHT_BUDGET: Duration = Duration::from_secs(30);

pub async fn probe_version_bounded(
    adapter: &'static dyn CliAdapter,
    path: PathBuf,
    budget: Duration,
) -> Result<String, String> {
    match crate::services::cli_runtime::run_with(
        adapter,
        "版本探测",
        budget,
        move |adapter| async move { adapter.probe_current_version(&path).await },
    )
    .await
    {
        Ok(result) => result,
        Err(error) => Err(error.to_string()),
    }
}

pub async fn execution_preflight_bounded(
    adapter: &'static dyn CliAdapter,
    plan: InstallPlan,
    budget: Duration,
) -> std::result::Result<ExecutionPreflight, String> {
    let tool_key = adapter.tool_key();
    match crate::services::cli_runtime::run_blocking_with(
        adapter,
        "执行前校验",
        budget,
        move |adapter| {
            catch_adapter(tool_key, "执行前校验", || {
                run_execution_preflight(adapter, &plan)
            })
        },
    )
    .await
    {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    }
}

pub async fn execution_preflight(
    plan: InstallPlan,
) -> std::result::Result<ExecutionPreflight, String> {
    execution_preflight_bounded(get(plan.tool_key), plan, EXECUTION_PREFLIGHT_BUDGET).await
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
    probe_version_bounded(
        get(plan.tool_key),
        PathBuf::from(&plan.program),
        VERSION_PROBE_BUDGET,
    )
    .await
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
    fn claude_and_codex_require_canonical_uuid_session_ids() {
        let accepted = [
            "8e783338-f464-4b10-b15e-b534748c6241",
            "01890a5d-ac96-774b-bcce-b302099a8057",
        ];
        let rejected = [
            "session-1",
            "8e783338f4644b10b15eb534748c6241",
            "{8e783338-f464-4b10-b15e-b534748c6241}",
            "8E783338-F464-4B10-B15E-B534748C6241",
            "8e783338-F464-4b10-b15e-b534748c6241",
            "8e783338-f464-4b10-b15e-b534748c6241-extra",
            "8e783338-f464-4b10-b15e-b534748c624",
            "8e783338-f464-4b10-b15e-b534748c6241 ",
            "8e783338_f464_4b10_b15e_b534748c6241",
            "",
            "-8e783338-f464-4b10-b15e-b534748c6241",
        ];
        for key in [ToolKey::Claude, ToolKey::Codex] {
            for session_id in accepted {
                assert!(valid_session_id(key, session_id), "{key:?} {session_id}");
            }
            for session_id in rejected {
                assert!(
                    !valid_session_id(key, session_id),
                    "{key:?} {session_id:?} must be rejected"
                );
            }
        }
        assert!(valid_session_id(ToolKey::Antigravity, "session-1"));
        assert!(valid_session_id(ToolKey::Grok, "session-1"));
        assert!(valid_session_id(ToolKey::Hermes, "a.b:c"));
    }

    #[test]
    fn executable_path_requirement_matches_the_adapter_scope() {
        let expected = [
            (ToolKey::Claude, false),
            (ToolKey::Codex, true),
            (ToolKey::Antigravity, false),
            (ToolKey::Grok, true),
            (ToolKey::Hermes, true),
        ];
        assert_eq!(ToolKey::ALL.len(), expected.len());
        for (tool_key, required) in expected {
            assert_eq!(
                get(tool_key).requires_executable_path(),
                required,
                "{}",
                tool_key.as_str()
            );
        }
    }

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

        fn descriptor(&self) -> ProviderDescriptor {
            get(ToolKey::Hermes).descriptor()
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

        fn descriptor(&self) -> ProviderDescriptor {
            get(ToolKey::Hermes).descriptor()
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

    struct PathlessAdapter;
    static PATHLESS: PathlessAdapter = PathlessAdapter;

    impl CliAdapter for PathlessAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> ProviderDescriptor {
            get(ToolKey::Claude).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["x"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    struct PathNeedingAdapter;
    static PATH_NEEDING: PathNeedingAdapter = PathNeedingAdapter;

    impl CliAdapter for PathNeedingAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Hermes
        }

        fn descriptor(&self) -> ProviderDescriptor {
            get(ToolKey::Hermes).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["x"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn requires_executable_path(&self) -> bool {
            true
        }
    }

    struct UnknownCommandAdapter;
    static UNKNOWN_COMMAND: UnknownCommandAdapter = UnknownCommandAdapter;

    impl CliAdapter for UnknownCommandAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Grok
        }

        fn descriptor(&self) -> ProviderDescriptor {
            get(ToolKey::Grok).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["cli-launchpad-test-nonexistent-command-8f3a"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn requires_executable_path(&self) -> bool {
            true
        }
    }

    struct CountingResolver {
        calls: std::sync::atomic::AtomicUsize,
        answer: Option<PathBuf>,
    }

    impl ExecutableResolver for CountingResolver {
        fn resolve(&self, _adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.answer.clone()
        }
    }

    struct SleepingResolver(std::time::Duration);

    impl ExecutableResolver for SleepingResolver {
        fn resolve(&self, _adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
            std::thread::sleep(self.0);
            None
        }
    }

    struct PanickingResolver;

    impl ExecutableResolver for PanickingResolver {
        fn resolve(&self, _adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
            panic!("resolver panic")
        }
    }

    #[tokio::test]
    async fn context_within_budget_skips_resolution_for_adapters_that_do_not_need_a_path() {
        let resolver = Arc::new(CountingResolver {
            calls: std::sync::atomic::AtomicUsize::new(0),
            answer: Some(PathBuf::from("/opt/cli")),
        });
        let home = tempfile::tempdir().unwrap();

        let (context, remaining) = context_within_budget(
            &PATHLESS,
            Duration::from_secs(5),
            home.path().to_path_buf(),
            resolver.clone(),
        )
        .await;

        assert!(context.resolved_path.is_none());
        assert_eq!(remaining, Duration::from_secs(5));
        assert_eq!(context.budget, Duration::from_secs(5));
        assert_eq!(resolver.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn context_within_budget_resolves_for_adapters_that_need_a_path() {
        let resolver = Arc::new(CountingResolver {
            calls: std::sync::atomic::AtomicUsize::new(0),
            answer: Some(PathBuf::from("/opt/cli")),
        });
        let home = tempfile::tempdir().unwrap();

        let (context, remaining) = context_within_budget(
            &PATH_NEEDING,
            Duration::from_secs(5),
            home.path().to_path_buf(),
            resolver.clone(),
        )
        .await;

        assert_eq!(context.resolved_path, Some(PathBuf::from("/opt/cli")));
        assert_eq!(resolver.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(remaining > Duration::ZERO && remaining <= Duration::from_secs(5));
        assert_eq!(context.budget, remaining);
        assert_eq!(context.home, home.path());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn context_within_budget_reports_exhausted_budget_when_resolution_is_slow() {
        let ticks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ticker = tokio::spawn({
            let ticks = ticks.clone();
            async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    ticks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
        });
        let home = tempfile::tempdir().unwrap();

        let started = std::time::Instant::now();
        let (context, remaining) = context_within_budget(
            &PATH_NEEDING,
            Duration::from_millis(300),
            home.path().to_path_buf(),
            Arc::new(SleepingResolver(Duration::from_secs(2))),
        )
        .await;
        let elapsed = started.elapsed();
        ticker.abort();

        assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
        assert!(context.resolved_path.is_none());
        assert_eq!(remaining, Duration::ZERO);
        assert!(
            ticks.load(std::sync::atomic::Ordering::SeqCst) >= 10,
            "the executor must stay responsive while a resolver is slow"
        );
    }

    #[tokio::test]
    async fn context_within_budget_turns_a_resolver_panic_into_no_path() {
        let home = tempfile::tempdir().unwrap();

        let (context, remaining) = context_within_budget(
            &PATH_NEEDING,
            Duration::from_secs(5),
            home.path().to_path_buf(),
            Arc::new(PanickingResolver),
        )
        .await;

        assert!(context.resolved_path.is_none());
        assert!(remaining > Duration::ZERO);
    }

    #[test]
    fn native_resolver_returns_none_for_unknown_commands() {
        assert!(NativeExecutableResolver.resolve(&UNKNOWN_COMMAND).is_none());
    }

    #[test]
    fn descriptors_declare_the_confirmed_capabilities_for_all_five_clis() {
        let always = ManagedUpdatePolicy::Always;
        let plain = |tool_key| ProviderDescriptor {
            tool_key,
            api_version: PROVIDER_DESCRIPTOR_API_VERSION,
            capabilities: ProviderCapabilities {
                history: true,
                resume: true,
                update_semantics: UpdateSemantics::Version,
                managed_update: always,
                install_effects_key: None,
            },
        };
        let expected = [
            plain(ToolKey::Claude),
            plain(ToolKey::Codex),
            plain(ToolKey::Antigravity),
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
            },
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
            },
        ];

        assert_eq!(ToolKey::ALL.len(), expected.len());
        for (tool_key, expected) in ToolKey::ALL.into_iter().zip(expected) {
            let actual = get(tool_key).descriptor();
            assert_eq!(actual, expected, "{}", tool_key.as_str());
            assert_eq!(actual.tool_key, get(tool_key).tool_key());
        }
    }

    #[test]
    fn managed_update_policy_maps_source_verification_to_a_status() {
        use crate::models::install::ManagedUpdateStatus;

        for evidence in [Some(true), Some(false), None] {
            assert_eq!(
                ManagedUpdatePolicy::Always.status(evidence),
                ManagedUpdateStatus::Allowed
            );
        }
        let policy = ManagedUpdatePolicy::SourceVerified {
            denied_reason_key: "settings.x",
        };
        assert_eq!(policy.status(Some(true)), ManagedUpdateStatus::Allowed);
        for evidence in [Some(false), None] {
            assert_eq!(
                policy.status(evidence),
                ManagedUpdateStatus::Denied {
                    reason_key: "settings.x".to_string()
                }
            );
        }
        assert_eq!(
            policy.status_after_failed_query(),
            ManagedUpdateStatus::NotApplicable
        );
        assert_eq!(
            ManagedUpdatePolicy::Always.status_after_failed_query(),
            ManagedUpdateStatus::Allowed
        );
    }

    #[test]
    fn failed_version_queries_never_report_a_denied_update_source() {
        use crate::models::install::ManagedUpdateStatus;
        use crate::services::version_service::latest_from_version_result;

        for tool_key in [ToolKey::Grok, ToolKey::Hermes] {
            let failed = latest_from_version_result(tool_key, Err("network".to_string()));
            assert_eq!(
                failed.managed_update,
                ManagedUpdateStatus::NotApplicable,
                "{}",
                tool_key.as_str()
            );
            // 反向断言：没有来源验证证据的成功结果仍然按拒绝处理。
            assert!(matches!(
                get(tool_key).managed_update(None),
                ManagedUpdateStatus::Denied { .. }
            ));
        }
        for tool_key in [ToolKey::Claude, ToolKey::Codex, ToolKey::Antigravity] {
            let failed = latest_from_version_result(tool_key, Err("network".to_string()));
            assert_eq!(failed.managed_update, ManagedUpdateStatus::Allowed);
        }
    }

    fn failed_context(budget: Duration) -> AdapterContext {
        AdapterContext {
            resolved_path: None,
            home: std::env::temp_dir(),
            budget,
        }
    }

    #[tokio::test]
    async fn blocking_latest_reports_adapter_panics_with_the_query_message() {
        let result = blocking_latest(
            ToolKey::Codex,
            failed_context(Duration::from_secs(5)),
            || -> LatestVersion { panic!("adapter panic") },
        )
        .await;

        let error = result.error.expect("panic must become an error result");
        assert!(error.starts_with("codex 版本查询适配器异常："), "{error}");
    }

    #[tokio::test]
    async fn blocking_latest_does_not_apply_its_own_timeout() {
        let result = blocking_latest(
            ToolKey::Codex,
            failed_context(Duration::from_millis(1)),
            || {
                std::thread::sleep(Duration::from_millis(50));
                LatestVersion {
                    tool_key: ToolKey::Codex,
                    latest: Some("9.9.9".to_string()),
                    update_availability: crate::models::install::UpdateAvailability::Unknown,
                    commits_behind: None,
                    error: None,
                    from_cache: false,
                    managed_update: crate::models::install::ManagedUpdateStatus::Allowed,
                }
            },
        )
        .await;

        // 预算只由 cli_runtime::run 在外层执行一次；这里得到操作自己的结果。
        assert_eq!(result.latest.as_deref(), Some("9.9.9"));
        assert!(result.error.is_none());
    }

    #[test]
    fn plan_context_resolves_the_executable_even_without_the_history_requirement() {
        struct FixedResolver(PathBuf);
        impl ExecutableResolver for FixedResolver {
            fn resolve(&self, _adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
                Some(self.0.clone())
            }
        }

        let adapter = get(ToolKey::Claude);
        let context = plan_context_with(
            adapter,
            Duration::from_secs(5),
            std::env::temp_dir(),
            &FixedResolver(PathBuf::from("custom-bin/claude")),
        );

        assert!(!adapter.requires_executable_path());
        assert_eq!(
            context.resolved_path,
            Some(PathBuf::from("custom-bin/claude"))
        );
    }

    fn plain_descriptor(tool_key: ToolKey) -> ProviderDescriptor {
        ProviderDescriptor {
            tool_key,
            api_version: PROVIDER_DESCRIPTOR_API_VERSION,
            capabilities: ProviderCapabilities {
                history: false,
                resume: false,
                update_semantics: UpdateSemantics::Version,
                managed_update: ManagedUpdatePolicy::Always,
                install_effects_key: None,
            },
        }
    }

    enum ProbeMode {
        Stalled,
        Version,
        Panic,
    }

    struct ProbeAdapter(ProbeMode);

    impl CliAdapter for ProbeAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> ProviderDescriptor {
            plain_descriptor(ToolKey::Claude)
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["x"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn probe_current_version<'a>(
            &'a self,
            _path: &'a Path,
        ) -> Pin<Box<dyn Future<Output = std::result::Result<String, String>> + Send + 'a>>
        {
            match self.0 {
                ProbeMode::Stalled => Box::pin(async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    Ok("1.0.0".to_string())
                }),
                ProbeMode::Version => Box::pin(async { Ok("1.2.3".to_string()) }),
                ProbeMode::Panic => Box::pin(async {
                    if true {
                        panic!("probe panic");
                    }
                    Ok(String::new())
                }),
            }
        }
    }

    static STALLED_PROBE: ProbeAdapter = ProbeAdapter(ProbeMode::Stalled);
    static VERSION_PROBE: ProbeAdapter = ProbeAdapter(ProbeMode::Version);
    static PANIC_PROBE: ProbeAdapter = ProbeAdapter(ProbeMode::Panic);

    #[tokio::test]
    async fn probe_version_bounded_times_out_a_stalled_probe() {
        let started = std::time::Instant::now();
        let error = probe_version_bounded(
            &STALLED_PROBE,
            PathBuf::from("claude"),
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "claude 版本探测超时");
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn probe_version_bounded_passes_results_and_reports_panics() {
        let value = probe_version_bounded(
            &VERSION_PROBE,
            PathBuf::from("claude"),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(value, Ok("1.2.3".to_string()));

        let error = probe_version_bounded(
            &PANIC_PROBE,
            PathBuf::from("claude"),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("claude 版本探测适配器异常："), "{error}");
        assert!(error.contains("panic"), "{error}");
    }

    enum ValidateMode {
        Slow,
        Panic,
    }

    struct ValidateAdapter(ValidateMode);

    impl CliAdapter for ValidateAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> ProviderDescriptor {
            plain_descriptor(ToolKey::Claude)
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["x"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn validate_execution(&self, _plan: &InstallPlan) -> std::result::Result<(), String> {
            match self.0 {
                ValidateMode::Slow => {
                    std::thread::sleep(Duration::from_secs(3));
                    Ok(())
                }
                ValidateMode::Panic => panic!("validate panic"),
            }
        }
    }

    static SLOW_VALIDATE: ValidateAdapter = ValidateAdapter(ValidateMode::Slow);
    static PANIC_VALIDATE: ValidateAdapter = ValidateAdapter(ValidateMode::Panic);

    fn preflight_plan() -> InstallPlan {
        crate::services::install_service::resolved_plan(
            ToolKey::Claude,
            InstallKind::Update,
            "claude".to_string(),
            vec!["update".to_string()],
            "test",
            "claude update".to_string(),
        )
    }

    #[tokio::test]
    async fn execution_preflight_times_out_a_stalled_validation() {
        let started = std::time::Instant::now();
        let error = execution_preflight_bounded(
            &SLOW_VALIDATE,
            preflight_plan(),
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "claude 执行前校验超时");
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn execution_preflight_keeps_the_adapter_panic_message() {
        let error =
            execution_preflight_bounded(&PANIC_VALIDATE, preflight_plan(), Duration::from_secs(5))
                .await
                .unwrap_err();
        assert_eq!(error, "claude 适配器在执行前校验时发生异常");
    }

    const REJECTION_MESSAGE: &str = "claude 更新前校验失败：固定的拒绝原因";

    struct ValidateRejectsWithoutMessageAdapter {
        reject: bool,
    }

    impl CliAdapter for ValidateRejectsWithoutMessageAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> ProviderDescriptor {
            plain_descriptor(ToolKey::Claude)
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["x"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn validate_execution(&self, _plan: &InstallPlan) -> std::result::Result<(), String> {
            if self.reject {
                Err(REJECTION_MESSAGE.to_string())
            } else {
                Ok(())
            }
        }
    }

    static REJECTING_VALIDATE: ValidateRejectsWithoutMessageAdapter =
        ValidateRejectsWithoutMessageAdapter { reject: true };
    static ACCEPTING_VALIDATE: ValidateRejectsWithoutMessageAdapter =
        ValidateRejectsWithoutMessageAdapter { reject: false };

    #[tokio::test]
    async fn execution_preflight_returns_the_validation_error_when_there_is_no_preflight_message() {
        assert_eq!(
            REJECTING_VALIDATE.execution_preflight_message(&preflight_plan()),
            None
        );

        let error = run_execution_preflight(&REJECTING_VALIDATE, &preflight_plan()).unwrap_err();
        assert_eq!(error.to_string(), REJECTION_MESSAGE);

        let error = execution_preflight_bounded(
            &REJECTING_VALIDATE,
            preflight_plan(),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(error, REJECTION_MESSAGE);
        assert!(!error.contains("适配器在执行前校验时发生异常"), "{error}");
        assert!(!error.contains("执行前校验超时"), "{error}");

        let accepted = ExecutionPreflight {
            message: None,
            verify_update_result: false,
        };
        assert_eq!(
            run_execution_preflight(&ACCEPTING_VALIDATE, &preflight_plan()).unwrap(),
            accepted
        );
        assert_eq!(
            execution_preflight_bounded(
                &ACCEPTING_VALIDATE,
                preflight_plan(),
                Duration::from_secs(5),
            )
            .await,
            Ok(accepted)
        );
    }
}
