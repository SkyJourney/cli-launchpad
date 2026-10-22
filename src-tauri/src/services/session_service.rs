use crate::error_codes::ErrorCode;
use crate::platform::home::home_dir;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use rusqlite::Connection;

use crate::db::directory_repo;
use crate::models::session::{
    SessionPage, SessionSearchIndexRefresh, SessionSearchIndexSource, SessionSearchResults,
};
use crate::models::tool::ToolKey;
use crate::services::cli_adapters::support::TITLE_MAX_CHARS;
use crate::services::cli_adapters::CliAdapter;
use crate::AppError;

const MAX_PAGE_SIZE: usize = 50;
const MAX_SEARCH_QUERY_CHARS: usize = 200;
const SEARCH_INDEX_ADAPTER_BUDGET: Duration = Duration::from_secs(10);
const LIST_SESSIONS_BUDGET: Duration = Duration::from_secs(30);
const SESSION_OWNERSHIP_BUDGET: Duration = Duration::from_secs(30);

/// Resolve a directory id to its filesystem path (the input to session reading).
pub fn directory_path(conn: &Connection, directory_id: i64) -> Result<String> {
    directory_repo::get(conn, directory_id)?
        .map(|directory| directory.path)
        .ok_or_else(|| anyhow!("directory {directory_id} not found"))
}

/// Bumped once per backup restore, while the business database lock is held,
/// after the database file content has been replaced.
#[derive(Clone, Debug, Default)]
pub struct RestoreGeneration(Arc<AtomicU64>);

impl RestoreGeneration {
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    /// Returns the new generation.
    pub fn advance(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[derive(Debug)]
pub enum IndexWriteOutcome {
    Written(SessionSearchIndexRefresh),
    Discarded,
}

impl IndexWriteOutcome {
    pub fn into_result(self) -> Result<SessionSearchIndexRefresh, AppError> {
        match self {
            IndexWriteOutcome::Written(refresh) => Ok(refresh),
            IndexWriteOutcome::Discarded => Err(AppError::coded(
                ErrorCode::BackupIndexRefreshDiscarded,
                "数据已替换（恢复备份或导入配置），已丢弃替换前开始的会话索引刷新",
            )),
        }
    }
}

/// The caller must hold the cache connection lock for the whole call, so that the
/// comparison and the write cannot interleave with the restore's cache cleanup.
pub fn write_search_index_if_current(
    connection: &Connection,
    generation: &RestoreGeneration,
    expected: u64,
    directory_id: i64,
    sources: &[SessionSearchIndexSource],
) -> Result<IndexWriteOutcome> {
    if generation.current() != expected {
        return Ok(IndexWriteOutcome::Discarded);
    }
    let refresh = crate::db::session_search_repo::refresh(connection, directory_id, sources)?;
    Ok(IndexWriteOutcome::Written(refresh))
}

pub async fn list_sessions(
    tool_key: ToolKey,
    directory_path: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SessionPage> {
    list_sessions_with(
        crate::services::cli_adapters::get(tool_key),
        directory_path.to_string(),
        cursor.map(str::to_string),
        limit,
        Arc::new(crate::services::cli_adapters::NativeExecutableResolver),
        home_dir()?,
        LIST_SESSIONS_BUDGET,
    )
    .await
}

/// Every adapter reported as incomplete with no documents, in product order. Used when the
/// refresh cannot run at all (for example the user directory is unknown).
fn incomplete_sources(adapters: &[&'static dyn CliAdapter]) -> Vec<SessionSearchIndexSource> {
    let mut sources: Vec<_> = adapters
        .iter()
        .map(|adapter| SessionSearchIndexSource {
            tool_key: adapter.tool_key(),
            documents: None,
            incomplete: true,
        })
        .collect();
    sources.sort_by_key(|source| {
        ToolKey::ALL
            .iter()
            .position(|tool_key| *tool_key == source.tool_key)
            .unwrap_or(usize::MAX)
    });
    sources
}

pub async fn refresh_search_index(directory_path: &str) -> Result<Vec<SessionSearchIndexSource>> {
    let adapters: Vec<&'static dyn CliAdapter> = crate::services::cli_adapters::all().collect();
    match home_dir() {
        Ok(home) => Ok(refresh_search_index_with(
            directory_path,
            adapters,
            Arc::new(crate::services::cli_adapters::NativeExecutableResolver),
            home,
            SEARCH_INDEX_ADAPTER_BUDGET,
        )
        .await),
        Err(error) => {
            log::warn!("会话索引刷新无法确定用户目录，所有来源降级为不完整：{error}");
            Ok(incomplete_sources(&adapters))
        }
    }
}

async fn refresh_search_index_with(
    directory_path: &str,
    adapters: Vec<&'static dyn CliAdapter>,
    resolver: Arc<dyn crate::services::cli_adapters::ExecutableResolver>,
    home: PathBuf,
    budget: Duration,
) -> Vec<SessionSearchIndexSource> {
    let mut tasks = tokio::task::JoinSet::new();
    let mut task_tools = HashMap::new();
    // A tool whose context cannot be built keeps its last usable index; it must not
    // fail the refresh for the other tools.
    let mut sources = Vec::with_capacity(ToolKey::ALL.len());
    for adapter in adapters {
        let tool_key = adapter.tool_key();
        let path = directory_path.to_string();
        let home = home.clone();
        let resolver = resolver.clone();
        let task = tasks.spawn(async move {
            let (context, remaining) = crate::services::cli_adapters::context_within_budget(
                adapter, budget, home, resolver,
            )
            .await;
            let source = if remaining.is_zero() {
                log::warn!(
                    "{} 会话索引解析可执行文件超过预算，保留上次可用索引",
                    tool_key.as_str()
                );
                SessionSearchIndexSource {
                    tool_key,
                    documents: None,
                    incomplete: true,
                }
            } else {
                bounded_search_index_source(
                    tool_key,
                    adapter.search_index_source(path, context),
                    remaining,
                )
                .await
            };
            (tool_key, source)
        });
        task_tools.insert(task.id(), tool_key);
    }

    while let Some(result) = tasks.join_next_with_id().await {
        match result {
            Ok((id, (expected_tool, source))) => {
                task_tools.remove(&id);
                if source.tool_key == expected_tool {
                    sources.push(source);
                } else {
                    log::warn!(
                        "session adapter returned mismatched tool expected={} actual={}",
                        expected_tool.as_str(),
                        source.tool_key.as_str()
                    );
                    sources.push(SessionSearchIndexSource {
                        tool_key: expected_tool,
                        documents: None,
                        incomplete: true,
                    });
                }
            }
            Err(error) => {
                if let Some(tool_key) = task_tools.remove(&error.id()) {
                    log::warn!(
                        "{} 会话索引适配器异常，保留上次可用索引：{error}",
                        tool_key.as_str()
                    );
                    sources.push(SessionSearchIndexSource {
                        tool_key,
                        documents: None,
                        incomplete: true,
                    });
                }
            }
        }
    }
    sources.sort_by_key(|source| {
        ToolKey::ALL
            .iter()
            .position(|tool_key| *tool_key == source.tool_key)
            .unwrap_or(usize::MAX)
    });
    sources
}

async fn bounded_search_index_source<F>(
    tool_key: ToolKey,
    source_future: F,
    budget: Duration,
) -> SessionSearchIndexSource
where
    F: std::future::Future<Output = SessionSearchIndexSource> + Send + 'static,
{
    match crate::services::cli_runtime::run_future(tool_key, "会话索引扫描", budget, source_future)
        .await
    {
        Ok(source) if source.tool_key == tool_key => source,
        Ok(source) => {
            log::warn!(
                "session adapter returned mismatched tool expected={} actual={}",
                tool_key.as_str(),
                source.tool_key.as_str()
            );
            SessionSearchIndexSource {
                tool_key,
                documents: None,
                incomplete: true,
            }
        }
        Err(error) => {
            log::warn!("{error}，保留上次可用索引");
            SessionSearchIndexSource {
                tool_key,
                documents: None,
                incomplete: true,
            }
        }
    }
}

pub fn search_indexed_sessions(
    connection: &Connection,
    directory_id: i64,
    query: &str,
    aliases: &HashMap<ToolKey, HashMap<String, String>>,
) -> Result<SessionSearchResults> {
    let query = normalize_search_query(query)?;
    crate::db::session_search_repo::search(connection, directory_id, &query, aliases)
}

fn normalize_search_query(query: &str) -> Result<String> {
    let query = query.trim();
    if query.is_empty() {
        return Err(anyhow!("会话搜索内容不能为空"));
    }
    if query.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(anyhow!(
            "会话搜索内容不能超过 {MAX_SEARCH_QUERY_CHARS} 个字符"
        ));
    }
    Ok(query.to_lowercase())
}

pub fn apply_aliases(page: &mut SessionPage, aliases: &HashMap<String, String>) {
    for session in &mut page.items {
        session.alias = aliases.get(&session.session_id).cloned();
    }
}

pub fn normalize_alias(alias: &str) -> Result<String> {
    let alias = alias.trim();
    if alias.is_empty() {
        return Err(anyhow!("会话别名不能为空"));
    }
    if alias.chars().count() > TITLE_MAX_CHARS {
        return Err(anyhow!("会话别名不能超过 {TITLE_MAX_CHARS} 个字符"));
    }
    Ok(alias.to_string())
}

pub(crate) async fn list_sessions_with(
    adapter: &'static dyn CliAdapter,
    directory_path: String,
    cursor: Option<String>,
    limit: usize,
    resolver: Arc<dyn crate::services::cli_adapters::ExecutableResolver>,
    home: PathBuf,
    budget: Duration,
) -> Result<SessionPage> {
    let limit = limit.clamp(1, MAX_PAGE_SIZE);
    let tool_key = adapter.tool_key();
    let (context, remaining) =
        crate::services::cli_adapters::context_within_budget(adapter, budget, home, resolver).await;
    if remaining.is_zero() {
        return Err(anyhow::Error::new(
            crate::services::cli_runtime::CliRuntimeError::TimedOut {
                tool_key,
                operation: "会话读取",
            },
        ));
    }
    crate::services::cli_runtime::run_with(adapter, "会话读取", remaining, move |adapter| {
        adapter.list_sessions(directory_path, cursor, limit, context)
    })
    .await
    .map_err(anyhow::Error::from)?
}

pub(crate) async fn session_belongs_to_directory_with(
    adapter: &'static dyn CliAdapter,
    directory_path: String,
    session_id: String,
    budget: Duration,
) -> Result<bool> {
    crate::services::cli_runtime::run_with(adapter, "会话归属验证", budget, move |adapter| {
        adapter.session_belongs_to_directory(directory_path, session_id)
    })
    .await
    .map_err(anyhow::Error::from)?
}

pub async fn session_belongs_to_directory(
    tool_key: ToolKey,
    directory_path: &str,
    session_id: &str,
) -> Result<bool> {
    if !crate::services::cli_adapters::valid_session_id(tool_key, session_id) {
        return Ok(false);
    }
    session_belongs_to_directory_with(
        crate::services::cli_adapters::get(tool_key),
        directory_path.to_string(),
        session_id.to_string(),
        SESSION_OWNERSHIP_BUDGET,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::session::{SessionInfo, SessionSearchIndexDocument};
    #[cfg(windows)]
    use crate::services::cli_adapters::support::paths_match;
    use crate::services::cli_adapters::support::{
        is_canonical_uuid, page_local, safe_session_id, truncate_chars,
    };

    #[tokio::test]
    async fn a_failing_adapter_context_does_not_fail_the_whole_refresh() {
        // Every adapter's context fails, so no scan runs: each source must keep its
        // last usable index and be marked incomplete, and the refresh itself succeeds.
        let sources = refresh_search_index_with(
            "C:/project",
            crate::services::cli_adapters::all().collect(),
            Arc::new(crate::services::cli_adapters::NativeExecutableResolver),
            std::env::temp_dir(),
            Duration::ZERO,
        )
        .await;

        assert_eq!(sources.len(), ToolKey::ALL.len());
        for source in &sources {
            assert!(
                source.documents.is_none(),
                "{} must keep its last index",
                source.tool_key.as_str()
            );
            assert!(
                source.incomplete,
                "{} must be marked incomplete",
                source.tool_key.as_str()
            );
        }
    }

    #[test]
    fn search_query_is_bounded_and_normalized() {
        assert_eq!(
            normalize_search_query("  Mixed Case  ").unwrap(),
            "mixed case"
        );
        assert!(normalize_search_query(" \t ").is_err());
        assert!(normalize_search_query(&"字".repeat(MAX_SEARCH_QUERY_CHARS + 1)).is_err());
    }

    #[test]
    fn local_pagination_uses_bounded_offset_cursor() {
        let sessions: Vec<SessionInfo> = (0..12)
            .map(|index| SessionInfo {
                tool_key: ToolKey::Claude,
                session_id: index.to_string(),
                title: index.to_string(),
                alias: None,
                last_active_ms: Some(index),
            })
            .collect();
        let first = page_local(sessions.clone(), None, 10).unwrap();
        assert_eq!(first.items.len(), 10);
        assert_eq!(first.next_cursor.as_deref(), Some("offset:10"));
        let second = page_local(sessions, first.next_cursor.as_deref(), 10).unwrap();
        assert_eq!(second.items.len(), 2);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    #[cfg(windows)]
    fn paths_match_ignores_separators_and_case() {
        assert!(paths_match("C:/Projects/Demo", "c:\\projects\\demo\\"));
        assert!(!paths_match("C:\\a", "C:\\b"));
    }

    #[test]
    fn truncate_appends_ellipsis() {
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        assert_eq!(truncate_chars("ab", 3), "ab");
    }

    #[test]
    fn rejects_path_like_session_ids() {
        assert!(safe_session_id("7f9f9a2e-1b3c-4c7a-9b0e-abcdef012345"));
        assert!(!safe_session_id("../outside"));
        assert!(!safe_session_id("folder\\outside"));
        assert!(!safe_session_id("-resume-as-option"));
    }

    #[test]
    fn canonical_uuid_session_id_accepts_only_lowercase_hyphenated_forms() {
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
        for session_id in accepted {
            assert!(
                is_canonical_uuid(session_id),
                "{session_id} must be accepted"
            );
        }
        for session_id in rejected {
            assert!(
                !is_canonical_uuid(session_id),
                "{session_id:?} must be rejected"
            );
        }
        assert!(safe_session_id("session-1"));
    }

    #[test]
    fn aliases_only_override_sessions_present_in_the_page() {
        let mut page = SessionPage {
            items: vec![SessionInfo {
                tool_key: ToolKey::Claude,
                session_id: "matched".to_string(),
                title: "原始标题".to_string(),
                alias: None,
                last_active_ms: None,
            }],
            next_cursor: None,
        };
        let aliases = HashMap::from([
            ("matched".to_string(), "手动标题".to_string()),
            ("orphan".to_string(), "不应出现".to_string()),
        ]);

        apply_aliases(&mut page, &aliases);

        assert_eq!(page.items[0].title, "原始标题");
        assert_eq!(page.items[0].alias.as_deref(), Some("手动标题"));
        assert_eq!(page.items.len(), 1);
    }

    #[test]
    fn alias_normalization_trims_and_rejects_invalid_values() {
        assert_eq!(normalize_alias("  简洁标题  ").unwrap(), "简洁标题");
        assert!(normalize_alias("  ").is_err());
        assert!(normalize_alias(&"长".repeat(TITLE_MAX_CHARS + 1)).is_err());
    }

    #[tokio::test]
    async fn stalled_search_adapter_is_marked_incomplete_within_budget() {
        let started = std::time::Instant::now();
        let source = bounded_search_index_source(
            ToolKey::Claude,
            std::future::pending(),
            Duration::from_millis(10),
        )
        .await;

        assert!(source.incomplete);
        assert!(source.documents.is_none());
        assert_eq!(source.tool_key, ToolKey::Claude);
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    use crate::db::cache_connection::init_ephemeral_cache;

    fn index_sources(session_id: &str) -> Vec<SessionSearchIndexSource> {
        vec![SessionSearchIndexSource {
            tool_key: ToolKey::Claude,
            documents: Some(vec![SessionSearchIndexDocument {
                tool_key: ToolKey::Claude,
                session_id: session_id.to_string(),
                title: "query title".to_string(),
                last_active_ms: Some(1),
                fields: vec!["query title".to_string()],
            }]),
            incomplete: false,
        }]
    }

    fn indexed_session_ids(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("select session_id from session_search_documents where directory_id = 1 order by session_id")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    fn run_with_timeout<R: Send + 'static>(
        seconds: u64,
        f: impl FnOnce() -> R + Send + 'static,
    ) -> R {
        use std::sync::mpsc::{channel, RecvTimeoutError};
        let (sender, receiver) = channel();
        std::thread::spawn(move || {
            let _ = sender.send(f());
        });
        match receiver.recv_timeout(std::time::Duration::from_secs(seconds)) {
            Ok(value) => value,
            Err(RecvTimeoutError::Timeout) => panic!("操作在 {seconds} 秒内没有完成（可能死锁）"),
            Err(RecvTimeoutError::Disconnected) => panic!("工作线程 panic"),
        }
    }

    #[test]
    fn index_refresh_started_before_restore_is_discarded_after_restore() {
        let connection = init_ephemeral_cache().unwrap();
        let generation = RestoreGeneration::default();
        let g0 = generation.current();
        generation.advance(); // simulated restore

        let outcome =
            write_search_index_if_current(&connection, &generation, g0, 1, &index_sources("stale"))
                .unwrap();
        assert!(matches!(outcome, IndexWriteOutcome::Discarded));
        assert_eq!(indexed_session_ids(&connection), Vec::<String>::new());
        // The source status row must not have been written either.
        let search =
            crate::db::session_search_repo::search(&connection, 1, "query", &HashMap::new())
                .unwrap();
        assert!(search.items.is_empty());
        assert_eq!(search.incomplete_tools, Vec::<ToolKey>::new());

        // Reverse: the same write with the current generation is applied.
        let fresh = generation.current();
        let outcome = write_search_index_if_current(
            &connection,
            &generation,
            fresh,
            1,
            &index_sources("fresh"),
        )
        .unwrap();
        let IndexWriteOutcome::Written(refresh) = outcome else {
            panic!("a refresh with the current generation must be written");
        };
        assert_eq!(refresh.indexed_sessions, 1);
        assert_eq!(indexed_session_ids(&connection), vec!["fresh".to_string()]);
    }

    #[test]
    fn refresh_that_captured_its_generation_before_a_restore_is_discarded_even_after_the_index_was_cleared(
    ) {
        let (captured_tx, captured_rx) = std::sync::mpsc::channel::<u64>();
        let (restored_tx, restored_rx) = std::sync::mpsc::channel::<()>();
        let cache = crate::CacheDb::new(init_ephemeral_cache().unwrap());
        let generation = RestoreGeneration::default();

        let refresh_cache = cache.clone();
        let refresh_generation = generation.clone();
        let refresh = std::thread::spawn(move || {
            let captured = refresh_generation.current();
            captured_tx.send(captured).unwrap();
            restored_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("the restore did not finish");
            let connection = refresh_cache.lock_for_test();
            let outcome = write_search_index_if_current(
                &connection,
                &refresh_generation,
                captured,
                1,
                &index_sources("stale"),
            )
            .unwrap();
            matches!(outcome, IndexWriteOutcome::Discarded)
        });

        let captured = captured_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the refresh did not capture a generation");
        assert_eq!(captured, 0);
        // Same order as the restore orchestration: advance first, clear the cache afterwards.
        generation.advance();
        {
            let connection = cache.lock_for_test();
            crate::db::cache_repo::clear_session_search(&crate::runtime::CacheConn::for_test(
                &connection,
            ))
            .unwrap();
        }
        restored_tx.send(()).unwrap();

        assert!(
            refresh.join().unwrap(),
            "the refresh that started before the restore must be discarded"
        );
        {
            let connection = cache.lock_for_test();
            assert_eq!(indexed_session_ids(&connection), Vec::<String>::new());
        }

        // Reverse: a refresh that captures the new generation writes normally.
        let connection = cache.lock_for_test();
        let fresh = generation.current();
        let outcome = write_search_index_if_current(
            &connection,
            &generation,
            fresh,
            1,
            &index_sources("fresh"),
        )
        .unwrap();
        assert!(matches!(outcome, IndexWriteOutcome::Written(_)));
        assert_eq!(indexed_session_ids(&connection), vec!["fresh".to_string()]);
    }

    #[test]
    fn concurrent_refreshes_and_restores_never_leave_stale_documents() {
        let (final_generation, remaining) = run_with_timeout(30, || {
            let cache = crate::CacheDb::new(init_ephemeral_cache().unwrap());
            let generation = RestoreGeneration::default();
            std::thread::scope(|scope| {
                for _ in 0..3 {
                    let cache = cache.clone();
                    let generation = generation.clone();
                    scope.spawn(move || {
                        for _ in 0..100 {
                            // Capture first, as the command does; write later under the cache lock.
                            let captured = generation.current();
                            let sources = index_sources(&format!("g{captured}"));
                            let connection = cache.lock_for_test();
                            write_search_index_if_current(
                                &connection,
                                &generation,
                                captured,
                                1,
                                &sources,
                            )
                            .unwrap();
                        }
                    });
                }
                let cache = cache.clone();
                let generation = generation.clone();
                scope.spawn(move || {
                    for _ in 0..100 {
                        generation.advance();
                        let connection = cache.lock_for_test();
                        crate::db::cache_repo::clear_session_search(
                            &crate::runtime::CacheConn::for_test(&connection),
                        )
                        .unwrap();
                    }
                });
            });
            let connection = cache.lock_for_test();
            (generation.current(), indexed_session_ids(&connection))
        });

        assert_eq!(final_generation, 100);
        assert!(
            remaining.len() <= 1,
            "one source per tool keeps at most one document: {remaining:?}"
        );
        for tag in &remaining {
            assert_eq!(
                tag, "g100",
                "a document written under an older generation survived a restore"
            );
        }
    }

    #[test]
    fn restore_generation_advances_monotonically_and_clones_share_state() {
        let generation = RestoreGeneration::default();
        let clone = generation.clone();
        assert_eq!(generation.current(), 0);
        assert_eq!(clone.advance(), 1);
        assert_eq!(generation.current(), 1);
        assert_eq!(generation.advance(), 2);
        assert_eq!(clone.current(), 2);
        assert_eq!(
            RestoreGeneration::default().current(),
            0,
            "separate instances do not share state"
        );
    }

    #[test]
    fn discarded_outcome_maps_to_an_error_and_written_passes_through() {
        let written = IndexWriteOutcome::Written(SessionSearchIndexRefresh {
            incomplete_tools: vec![ToolKey::Codex],
            indexed_sessions: 4,
        })
        .into_result()
        .unwrap();
        assert_eq!(written.indexed_sessions, 4);
        assert_eq!(written.incomplete_tools, vec![ToolKey::Codex]);

        let error = IndexWriteOutcome::Discarded.into_result().unwrap_err();
        assert_eq!(error.code(), "backup.index_refresh_discarded");
        let message = serde_json::to_value(&error).unwrap()["message"]
            .as_str()
            .unwrap()
            .to_string();
        // Neutral wording: the same outcome follows a restore and an imported configuration.
        assert!(
            message.contains("数据已替换") && message.contains("已丢弃替换前开始的会话索引刷新"),
            "{message}"
        );
    }

    use crate::services::cli_adapters::{
        AdapterContext, AdapterFuture, CliAdapter, ExecutableResolver,
    };
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};

    fn budget_ticker() -> (Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let ticks = Arc::new(AtomicUsize::new(0));
        let ticker = tokio::spawn({
            let ticks = ticks.clone();
            async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    ticks.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        (ticks, ticker)
    }

    struct SleepingBudgetResolver(Duration);

    impl ExecutableResolver for SleepingBudgetResolver {
        fn resolve(&self, _adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
            std::thread::sleep(self.0);
            None
        }
    }

    struct FixedBudgetResolver {
        delay: Duration,
        answer: Option<PathBuf>,
    }

    impl ExecutableResolver for FixedBudgetResolver {
        fn resolve(&self, _adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
            std::thread::sleep(self.delay);
            self.answer.clone()
        }
    }

    struct FastHistory;
    static FAST_HISTORY: FastHistory = FastHistory;
    static FAST_HISTORY_CALLED: AtomicBool = AtomicBool::new(false);

    impl CliAdapter for FastHistory {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Hermes
        }

        fn descriptor(&self) -> crate::services::cli_adapters::ProviderDescriptor {
            crate::services::cli_adapters::get(ToolKey::Hermes).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["hermes"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn requires_executable_path(&self) -> bool {
            true
        }

        fn list_sessions(
            &self,
            _directory_path: String,
            _cursor: Option<String>,
            _limit: usize,
            _context: AdapterContext,
        ) -> AdapterFuture<Result<SessionPage>> {
            FAST_HISTORY_CALLED.store(true, Ordering::SeqCst);
            Box::pin(async {
                Ok(SessionPage {
                    items: Vec::new(),
                    next_cursor: None,
                })
            })
        }
    }

    struct BudgetProbe;
    static BUDGET_PROBE: BudgetProbe = BudgetProbe;
    static SAW_PATH: AtomicBool = AtomicBool::new(false);
    static SAW_BUDGET_MS: AtomicU64 = AtomicU64::new(0);

    impl CliAdapter for BudgetProbe {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Hermes
        }

        fn descriptor(&self) -> crate::services::cli_adapters::ProviderDescriptor {
            crate::services::cli_adapters::get(ToolKey::Hermes).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["hermes"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn requires_executable_path(&self) -> bool {
            true
        }

        fn list_sessions(
            &self,
            _directory_path: String,
            _cursor: Option<String>,
            _limit: usize,
            context: AdapterContext,
        ) -> AdapterFuture<Result<SessionPage>> {
            SAW_PATH.store(context.resolved_path.is_some(), Ordering::SeqCst);
            SAW_BUDGET_MS.store(context.budget.as_millis() as u64, Ordering::SeqCst);
            Box::pin(async {
                Ok(SessionPage {
                    items: Vec::new(),
                    next_cursor: None,
                })
            })
        }
    }

    struct SlowOwnership;
    static SLOW_OWNERSHIP: SlowOwnership = SlowOwnership;

    impl CliAdapter for SlowOwnership {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> crate::services::cli_adapters::ProviderDescriptor {
            crate::services::cli_adapters::get(ToolKey::Claude).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["claude"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn session_belongs_to_directory(
            &self,
            _directory_path: String,
            _session_id: String,
        ) -> AdapterFuture<Result<bool>> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(true)
            })
        }
    }

    enum OwnershipAnswer {
        Yes,
        No,
        Fails,
    }

    struct FixedOwnership(OwnershipAnswer);

    impl CliAdapter for FixedOwnership {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> crate::services::cli_adapters::ProviderDescriptor {
            crate::services::cli_adapters::get(ToolKey::Claude).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["claude"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn session_belongs_to_directory(
            &self,
            _directory_path: String,
            _session_id: String,
        ) -> AdapterFuture<Result<bool>> {
            let answer = match self.0 {
                OwnershipAnswer::Yes => Ok(true),
                OwnershipAnswer::No => Ok(false),
                OwnershipAnswer::Fails => Err(anyhow!("adapter failed")),
            };
            Box::pin(async move { answer })
        }
    }

    static OWNERSHIP_YES: FixedOwnership = FixedOwnership(OwnershipAnswer::Yes);
    static OWNERSHIP_NO: FixedOwnership = FixedOwnership(OwnershipAnswer::No);
    static OWNERSHIP_FAILS: FixedOwnership = FixedOwnership(OwnershipAnswer::Fails);

    #[derive(Clone, Copy)]
    enum IndexBehavior {
        Complete,
        PanicInFuture,
        WrongTool,
    }

    struct FakeIndexAdapter {
        tool: ToolKey,
        requires_path: bool,
        behavior: IndexBehavior,
    }

    static CLAUDE_FAKE: FakeIndexAdapter = FakeIndexAdapter {
        tool: ToolKey::Claude,
        requires_path: false,
        behavior: IndexBehavior::Complete,
    };
    static CODEX_FAKE: FakeIndexAdapter = FakeIndexAdapter {
        tool: ToolKey::Codex,
        requires_path: true,
        behavior: IndexBehavior::Complete,
    };
    static ANTIGRAVITY_FAKE: FakeIndexAdapter = FakeIndexAdapter {
        tool: ToolKey::Antigravity,
        requires_path: false,
        behavior: IndexBehavior::Complete,
    };
    static GROK_FAKE: FakeIndexAdapter = FakeIndexAdapter {
        tool: ToolKey::Grok,
        requires_path: false,
        behavior: IndexBehavior::PanicInFuture,
    };
    static HERMES_FAKE: FakeIndexAdapter = FakeIndexAdapter {
        tool: ToolKey::Hermes,
        requires_path: false,
        behavior: IndexBehavior::WrongTool,
    };
    static CODEX_CALLED: AtomicBool = AtomicBool::new(false);

    impl CliAdapter for FakeIndexAdapter {
        fn tool_key(&self) -> ToolKey {
            self.tool
        }

        fn descriptor(&self) -> crate::services::cli_adapters::ProviderDescriptor {
            crate::services::cli_adapters::get(self.tool).descriptor()
        }

        fn command_candidates(&self) -> &'static [&'static str] {
            &["fake"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn requires_executable_path(&self) -> bool {
            self.requires_path
        }

        fn search_index_source(
            &self,
            _directory_path: String,
            _context: AdapterContext,
        ) -> AdapterFuture<SessionSearchIndexSource> {
            if self.tool == ToolKey::Codex {
                CODEX_CALLED.store(true, Ordering::SeqCst);
            }
            let tool = self.tool;
            match self.behavior {
                IndexBehavior::Complete => Box::pin(async move {
                    SessionSearchIndexSource {
                        tool_key: tool,
                        documents: Some(Vec::new()),
                        incomplete: false,
                    }
                }),
                IndexBehavior::PanicInFuture => Box::pin(async move { panic!("adapter panic") }),
                IndexBehavior::WrongTool => Box::pin(async move {
                    SessionSearchIndexSource {
                        tool_key: ToolKey::Claude,
                        documents: Some(Vec::new()),
                        incomplete: false,
                    }
                }),
            }
        }
    }

    struct SelectiveSleepResolver;

    impl ExecutableResolver for SelectiveSleepResolver {
        fn resolve(&self, adapter: &'static dyn CliAdapter) -> Option<PathBuf> {
            if adapter.tool_key() == ToolKey::Codex {
                std::thread::sleep(Duration::from_secs(5));
            }
            None
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_sessions_budget_includes_executable_resolution() {
        let (ticks, ticker) = budget_ticker();
        let home = tempfile::tempdir().unwrap();

        let started = std::time::Instant::now();
        let result = list_sessions_with(
            &FAST_HISTORY,
            "project".to_string(),
            None,
            10,
            Arc::new(SleepingBudgetResolver(Duration::from_secs(5))),
            home.path().to_path_buf(),
            Duration::from_millis(300),
        )
        .await;
        let elapsed = started.elapsed();
        ticker.abort();

        assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
        let error = match result {
            Ok(_) => panic!("resolution must count against the budget"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("超时"));
        assert_eq!(AppError::from(error).code(), "blocking.timeout");
        assert!(!FAST_HISTORY_CALLED.load(Ordering::SeqCst));
        assert!(ticks.load(Ordering::SeqCst) >= 10);
    }

    #[tokio::test]
    async fn list_sessions_passes_the_remaining_budget_to_the_adapter() {
        let home = tempfile::tempdir().unwrap();

        let result = list_sessions_with(
            &BUDGET_PROBE,
            "project".to_string(),
            None,
            10,
            Arc::new(FixedBudgetResolver {
                delay: Duration::from_millis(200),
                answer: Some(PathBuf::from("/opt/cli")),
            }),
            home.path().to_path_buf(),
            Duration::from_secs(5),
        )
        .await;

        assert!(result.is_ok());
        assert!(SAW_PATH.load(Ordering::SeqCst));
        let budget_ms = SAW_BUDGET_MS.load(Ordering::SeqCst);
        assert!(
            budget_ms > 4000 && budget_ms < 5000,
            "the resolution time must be deducted from the budget: {budget_ms} ms"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_search_index_isolates_slow_resolution_and_panicking_adapter() {
        let (ticks, ticker) = budget_ticker();
        let home = tempfile::tempdir().unwrap();
        let adapters: Vec<&'static dyn CliAdapter> = vec![
            &CLAUDE_FAKE,
            &CODEX_FAKE,
            &ANTIGRAVITY_FAKE,
            &GROK_FAKE,
            &HERMES_FAKE,
        ];

        let started = std::time::Instant::now();
        let sources = refresh_search_index_with(
            "project",
            adapters,
            Arc::new(SelectiveSleepResolver),
            home.path().to_path_buf(),
            Duration::from_millis(300),
        )
        .await;
        let elapsed = started.elapsed();
        ticker.abort();

        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
        let tools: Vec<ToolKey> = sources.iter().map(|source| source.tool_key).collect();
        assert_eq!(tools, ToolKey::ALL.to_vec());
        for tool in [ToolKey::Claude, ToolKey::Antigravity] {
            let source = sources
                .iter()
                .find(|source| source.tool_key == tool)
                .unwrap();
            assert!(matches!(&source.documents, Some(documents) if documents.is_empty()));
            assert!(!source.incomplete);
        }
        for tool in [ToolKey::Codex, ToolKey::Grok, ToolKey::Hermes] {
            let source = sources
                .iter()
                .find(|source| source.tool_key == tool)
                .unwrap();
            assert!(source.documents.is_none(), "{}", tool.as_str());
            assert!(source.incomplete, "{}", tool.as_str());
        }
        assert!(!CODEX_CALLED.load(Ordering::SeqCst));
        assert!(ticks.load(Ordering::SeqCst) >= 10);
    }

    #[tokio::test]
    async fn session_ownership_check_is_bounded_by_budget() {
        let started = std::time::Instant::now();
        let result = session_belongs_to_directory_with(
            &SLOW_OWNERSHIP,
            "project".to_string(),
            "session".to_string(),
            Duration::from_millis(300),
        )
        .await;
        let elapsed = started.elapsed();

        assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
        let error = match result {
            Ok(value) => panic!("an unbounded ownership check returned {value}"),
            Err(error) => error,
        };
        assert!(format!("{error:#}").contains("超时"));
        assert_eq!(AppError::from(error).code(), "blocking.timeout");
    }

    #[tokio::test]
    async fn session_ownership_check_returns_the_adapter_result_within_budget() {
        let budget = Duration::from_secs(5);

        assert!(session_belongs_to_directory_with(
            &OWNERSHIP_YES,
            "project".to_string(),
            "session".to_string(),
            budget,
        )
        .await
        .unwrap());
        assert!(!session_belongs_to_directory_with(
            &OWNERSHIP_NO,
            "project".to_string(),
            "session".to_string(),
            budget,
        )
        .await
        .unwrap());
        let error = session_belongs_to_directory_with(
            &OWNERSHIP_FAILS,
            "project".to_string(),
            "session".to_string(),
            budget,
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains("adapter failed"));
    }

    #[test]
    fn incomplete_sources_cover_every_adapter_in_product_order() {
        let mut adapters: Vec<&'static dyn CliAdapter> =
            crate::services::cli_adapters::all().collect();
        adapters.reverse();

        let sources = incomplete_sources(&adapters);

        let tools: Vec<ToolKey> = sources.iter().map(|source| source.tool_key).collect();
        assert_eq!(sources.len(), 5);
        assert_eq!(tools, ToolKey::ALL.to_vec());
        for source in &sources {
            assert!(source.documents.is_none(), "{}", source.tool_key.as_str());
            assert!(source.incomplete, "{}", source.tool_key.as_str());
        }
    }

    struct PanicAdapter;

    impl crate::services::cli_adapters::CliAdapter for PanicAdapter {
        fn tool_key(&self) -> ToolKey {
            ToolKey::Claude
        }

        fn descriptor(&self) -> crate::services::cli_adapters::ProviderDescriptor {
            use crate::services::cli_adapters::{
                ManagedUpdatePolicy, ProviderCapabilities, ProviderDescriptor, UpdateSemantics,
                PROVIDER_DESCRIPTOR_API_VERSION,
            };
            ProviderDescriptor {
                tool_key: ToolKey::Claude,
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

        fn command_candidates(&self) -> &'static [&'static str] {
            &["x"]
        }

        fn resume_args(&self, _session_id: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        fn list_sessions(
            &self,
            _directory_path: String,
            _cursor: Option<String>,
            _limit: usize,
            _context: crate::services::cli_adapters::AdapterContext,
        ) -> crate::services::cli_adapters::AdapterFuture<Result<SessionPage>> {
            Box::pin(async {
                if true {
                    panic!("list panic");
                }
                Ok(SessionPage {
                    items: Vec::new(),
                    next_cursor: None,
                })
            })
        }

        fn session_belongs_to_directory(
            &self,
            _directory_path: String,
            _session_id: String,
        ) -> crate::services::cli_adapters::AdapterFuture<Result<bool>> {
            Box::pin(async {
                if true {
                    panic!("ownership panic");
                }
                Ok(true)
            })
        }
    }

    static PANIC_ADAPTER: PanicAdapter = PanicAdapter;

    #[tokio::test]
    async fn list_sessions_reports_adapter_panics_through_cli_runtime() {
        let home = tempfile::tempdir().unwrap();
        let error = list_sessions_with(
            &PANIC_ADAPTER,
            "project".to_string(),
            None,
            10,
            Arc::new(crate::services::cli_adapters::NativeExecutableResolver),
            home.path().to_path_buf(),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        let text = error.to_string();
        assert!(text.starts_with("claude 会话读取适配器异常："), "{text}");
        assert!(text.contains("panic"), "{text}");
    }

    #[tokio::test]
    async fn ownership_check_keeps_the_adapter_panic_message() {
        let error = session_belongs_to_directory_with(
            &PANIC_ADAPTER,
            "project".to_string(),
            "s".to_string(),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        let text = error.to_string();
        assert!(
            text.starts_with("claude 会话归属验证适配器异常："),
            "{text}"
        );
        assert!(text.contains("panic"), "{text}");
    }

    #[tokio::test]
    async fn search_index_scan_panic_becomes_an_incomplete_source() {
        let source = bounded_search_index_source(
            ToolKey::Claude,
            async {
                if true {
                    panic!("scan panic");
                }
                SessionSearchIndexSource {
                    tool_key: ToolKey::Claude,
                    documents: None,
                    incomplete: false,
                }
            },
            Duration::from_secs(5),
        )
        .await;
        assert!(source.incomplete);
        assert!(source.documents.is_none());
        assert_eq!(source.tool_key, ToolKey::Claude);
    }
}
