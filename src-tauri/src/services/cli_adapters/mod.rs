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

impl AdapterContext {
    // Blocking: only call from a blocking thread (see commands that run build_plan inside blocking).
    fn for_adapter_blocking(adapter: &dyn CliAdapter, budget: Duration) -> Result<Self> {
        let resolved_path = if adapter.requires_executable_path() {
            installed_path(adapter)
        } else {
            None
        };
        Ok(Self {
            resolved_path,
            home: crate::services::session_service::home_dir()?,
            budget,
        })
    }
}

pub(crate) mod antigravity;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod descriptor;
pub(crate) mod grok;
pub(crate) mod hermes;

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
        crate::services::session_service::safe_session_id(session_id)
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

/// Resolves the executable path of an adapter. Replaceable so tests can inject
/// slow, panicking or counting resolvers without touching the real PATH.
pub trait ExecutableResolver: Send + Sync + 'static {
    fn resolve(&self, adapter: &'static dyn CliAdapter) -> Option<PathBuf>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NativeExecutableResolver;

impl ExecutableResolver for NativeExecutableResolver {
    fn resolve(&self, adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
        installed_path(adapter)
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

pub fn build_plan(tool_key: ToolKey, kind: InstallKind) -> Result<InstallPlan> {
    let context = AdapterContext::for_adapter_blocking(get(tool_key), Duration::from_secs(30))?;
    let mut plan = catch_adapter(tool_key, "构造安装或更新计划", || {
        get(tool_key).build_plan(kind, &context)
    })?;
    plan.refresh_fingerprint();
    Ok(plan)
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
}
