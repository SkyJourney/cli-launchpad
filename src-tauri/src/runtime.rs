//! Unified execution policy for commands (main report 3B.3.5): database
//! access goes through `Db::call` / `CacheDb::call`, other blocking work
//! goes through `blocking(op, budget, f)`, and writes whose timeout would be
//! misleading (a save that may still land) go through `blocking_unbounded`.
//! All of them run on the blocking
//! pool, map task failures to one error code, and never run IO on the
//! async worker. `Db` and `CacheDb` are leaf locks: never take a manager
//! lock while the closure runs, and never do filesystem work inside it.
//! A closure passed to `Db::call` must not call `Db::call` or `Db::with_sync` again:
//! the connection mutex is not reentrant and the nested call would deadlock.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::json;

use crate::error_codes::{BLOCKING_TIMEOUT, DB_POISONED, INTERNAL_TASK_FAILED};
use crate::AppError;

/// Business and cache databases are distinct managed-state types so commands cannot accidentally
/// read cache rows through the configuration connection. The connection is private: the only
/// entry points are `call` (async commands) and `with_sync` (code already off the async workers).
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

/// The cache database; see `Db`.
#[derive(Clone)]
pub struct CacheDb(Arc<Mutex<Connection>>);

// m6-033 moves these into the error code registry.

async fn run_on_blocking_pool<T: Send + 'static>(
    op: &'static str,
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|error| {
            AppError::coded_with_params(
                INTERNAL_TASK_FAILED,
                format!("{op}: {error}"),
                json!({ "op": op }),
            )
        })?
}

impl Db {
    /// Wraps a connection (the constructor to use outside tests).
    pub fn new(connection: Connection) -> Self {
        Self(Arc::new(Mutex::new(connection)))
    }

    /// Synchronous access for code that is NOT on an async worker: PTY monitor threads,
    /// functions already running inside `spawn_blocking`/`blocking`, and application setup.
    /// Poisoning maps to `db.poisoned` like `call`. Never call this from an `async fn`.
    pub fn with_sync<T>(
        &self,
        op: &'static str,
        f: impl FnOnce(&mut Connection) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut connection = self.0.lock().map_err(|_| {
            AppError::coded_with_params(DB_POISONED, "数据库连接锁中毒", json!({ "op": op }))
        })?;
        f(&mut connection)
    }

    #[cfg(test)]
    pub(crate) fn shared_for_test(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.0)
    }

    /// Test-only direct lock, for assertions that must hold the connection across an `await`.
    #[cfg(test)]
    pub(crate) fn lock_for_test(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap()
    }

    /// The only entry point for business database access.
    pub async fn call<T: Send + 'static>(
        &self,
        op: &'static str,
        f: impl FnOnce(&mut Connection) -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let db = self.clone();
        run_on_blocking_pool(op, move || {
            let mut connection =
                db.0.lock()
                    .map_err(|_| AppError::coded(DB_POISONED, "数据库连接锁中毒"))?;
            f(&mut connection)
        })
        .await
    }
}

impl CacheDb {
    /// Wraps a connection (the constructor to use outside tests).
    pub fn new(connection: Connection) -> Self {
        Self(Arc::new(Mutex::new(connection)))
    }

    /// Synchronous access with the same rules as `Db::with_sync`.
    pub fn with_sync<T>(
        &self,
        op: &'static str,
        f: impl FnOnce(&Connection) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let connection = self.0.lock().map_err(|_| {
            AppError::coded_with_params(DB_POISONED, "缓存数据库连接锁中毒", json!({ "op": op }))
        })?;
        f(&connection)
    }

    /// Test-only direct lock; see `Db::lock_for_test`.
    #[cfg(test)]
    pub(crate) fn lock_for_test(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap()
    }

    /// The only entry point for cache database access.
    pub async fn call<T: Send + 'static>(
        &self,
        op: &'static str,
        f: impl FnOnce(&Connection) -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let cache = self.clone();
        run_on_blocking_pool(op, move || {
            let connection = cache
                .0
                .lock()
                .map_err(|_| AppError::coded(DB_POISONED, "缓存数据库连接锁中毒"))?;
            f(&connection)
        })
        .await
    }
}

/// The shared entry point for blocking filesystem, process, `canonicalize`
/// and executable-resolution work. Adapter executable resolution inside the
/// adapter budget calls `spawn_blocking` directly (`cli_adapters::context_within_budget`),
/// which is allowed by R-RS-1. A timed-out closure cannot be cancelled;
/// it keeps running on its pool thread and the caller gets `blocking.timeout`.
pub async fn blocking<T: Send + 'static>(
    op: &'static str,
    budget: Duration,
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    match tokio::time::timeout(budget, run_on_blocking_pool(op, f)).await {
        Ok(result) => result,
        Err(_) => Err(blocking_timeout(op, budget)),
    }
}

fn blocking_timeout(op: &'static str, budget: Duration) -> AppError {
    let budget_ms = budget.as_millis() as u64;
    AppError::coded_with_params(
        BLOCKING_TIMEOUT,
        format!("{op} 超过 {budget_ms} ms 仍未完成"),
        json!({ "op": op, "budgetMs": budget_ms }),
    )
}

/// Gives an external `await` (a CLI session file read, an executable lookup) a time budget.
pub async fn bounded<T>(
    op: &'static str,
    budget: Duration,
    future: impl std::future::Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    match tokio::time::timeout(budget, future).await {
        Ok(result) => result,
        Err(_) => Err(blocking_timeout(op, budget)),
    }
}

/// Blocking work that must not be given a timeout: a write whose budget expires
/// may still complete, so reporting `blocking.timeout` would describe a write
/// that is still happening. Still runs on the blocking pool and maps panics to
/// `internal.task_failed`. Use `blocking` for everything that can be bounded.
pub async fn blocking_unbounded<T: Send + 'static>(
    op: &'static str,
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    run_on_blocking_pool(op, f).await
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use rusqlite::Connection;

    use crate::{blocking, AppError, CacheDb, Db};

    fn memory_db() -> Db {
        Db::new(Connection::open_in_memory().unwrap())
    }

    fn memory_cache() -> CacheDb {
        CacheDb::new(Connection::open_in_memory().unwrap())
    }

    fn code_of(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn message_of(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["message"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn poison(connection: Arc<Mutex<Connection>>) {
        let handle = thread::spawn(move || {
            let _guard = connection.lock().unwrap();
            panic!("poison the connection lock on purpose");
        });
        assert!(handle.join().is_err(), "the poisoning thread must panic");
    }

    #[tokio::test]
    async fn db_call_runs_on_a_blocking_thread_and_returns_the_value() {
        let db = memory_db();
        let caller = thread::current().id();
        let (value, worker) = db
            .call("test.select", move |connection| {
                let value: i64 = connection.query_row("select 41 + 1", [], |row| row.get(0))?;
                Ok((value, thread::current().id()))
            })
            .await
            .unwrap();
        assert_eq!(value, 42);
        assert_ne!(
            worker, caller,
            "the closure must not run on the async thread"
        );
    }

    #[tokio::test]
    async fn db_call_passes_closure_errors_through_unchanged() {
        let db = memory_db();
        let error = db
            .call("test.failure", |_connection| -> Result<(), AppError> {
                Err(AppError::coded("test.failure", "boom"))
            })
            .await
            .unwrap_err();
        assert_eq!(code_of(&error), "test.failure");
        assert_eq!(message_of(&error), "boom");
    }

    #[tokio::test]
    async fn db_call_maps_a_poisoned_lock_to_a_coded_error_without_running_the_closure() {
        let db = memory_db();
        poison(db.0.clone());
        let (ran_tx, ran_rx) = mpsc::channel::<()>();
        let error = db
            .call("test.poisoned", move |_connection| {
                ran_tx.send(()).ok();
                Ok(())
            })
            .await
            .unwrap_err();
        assert_eq!(code_of(&error), "db.poisoned");
        assert!(
            ran_rx.try_recv().is_err(),
            "the closure must not run when the lock is poisoned"
        );
    }

    #[tokio::test]
    async fn db_call_maps_a_panic_to_internal_task_failed_and_poisons_later_calls() {
        let db = memory_db();
        let error = db
            .call("test.panic", |_connection| -> Result<(), AppError> {
                panic!("closure exploded");
            })
            .await
            .unwrap_err();
        assert_eq!(code_of(&error), "internal.task_failed");
        assert!(
            message_of(&error).contains("test.panic"),
            "the message must name the operation: {}",
            message_of(&error)
        );
        let later = db
            .call("test.after_panic", |_connection| Ok(()))
            .await
            .unwrap_err();
        assert_eq!(code_of(&later), "db.poisoned");
    }

    #[tokio::test]
    async fn db_call_serializes_concurrent_callers_on_one_connection() {
        let db = memory_db();
        db.call("test.create", |connection| {
            connection.execute("create table counter (n integer not null)", [])?;
            connection.execute("insert into counter (n) values (0)", [])?;
            Ok(())
        })
        .await
        .unwrap();
        let bump = |db: Db| async move {
            for _ in 0..50 {
                db.call("test.bump", |connection| {
                    connection.execute("update counter set n = n + 1", [])?;
                    Ok(())
                })
                .await
                .unwrap();
            }
        };
        tokio::join!(bump(db.clone()), bump(db.clone()));
        let total: i64 = db
            .call("test.total", |connection| {
                Ok(connection.query_row("select n from counter", [], |row| row.get(0))?)
            })
            .await
            .unwrap();
        assert_eq!(total, 100);
    }

    #[tokio::test]
    async fn cache_db_call_returns_the_value_from_a_blocking_thread() {
        let cache = memory_cache();
        let caller = thread::current().id();
        let (value, worker) = cache
            .call("test.cache_select", move |connection| {
                let value: i64 = connection.query_row("select 6 * 7", [], |row| row.get(0))?;
                Ok((value, thread::current().id()))
            })
            .await
            .unwrap();
        assert_eq!(value, 42);
        assert_ne!(worker, caller);
    }

    #[tokio::test]
    async fn cache_db_call_maps_a_poisoned_lock_to_a_coded_error() {
        let cache = memory_cache();
        poison(cache.0.clone());
        let error = cache
            .call("test.cache_poisoned", |_connection| Ok(()))
            .await
            .unwrap_err();
        assert_eq!(code_of(&error), "db.poisoned");
        assert!(
            message_of(&error).contains("缓存"),
            "the cache message must say it is the cache connection: {}",
            message_of(&error)
        );
    }

    #[tokio::test]
    async fn blocking_runs_off_the_async_thread_and_returns_the_value() {
        let caller = thread::current().id();
        let (value, worker) = blocking("test.fast", Duration::from_secs(5), move || {
            Ok((7, thread::current().id()))
        })
        .await
        .unwrap();
        assert_eq!(value, 7);
        assert_ne!(worker, caller);
    }

    #[tokio::test]
    async fn blocking_passes_closure_errors_through_unchanged() {
        let error = blocking(
            "test.failure",
            Duration::from_secs(5),
            || -> Result<(), AppError> { Err(AppError::coded("test.failure", "boom")) },
        )
        .await
        .unwrap_err();
        assert_eq!(code_of(&error), "test.failure");
        assert_eq!(message_of(&error), "boom");
    }

    #[tokio::test]
    async fn blocking_maps_a_panic_to_internal_task_failed() {
        let error = blocking(
            "test.panic",
            Duration::from_secs(5),
            || -> Result<(), AppError> {
                panic!("closure exploded");
            },
        )
        .await
        .unwrap_err();
        assert_eq!(code_of(&error), "internal.task_failed");
        assert!(message_of(&error).contains("test.panic"));
    }

    #[tokio::test]
    async fn blocking_reports_a_timeout_with_the_operation_and_budget() {
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let result = blocking("test.stuck", Duration::from_millis(50), move || {
            release_rx.recv().ok();
            Ok(())
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(code_of(&error), "blocking.timeout");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["params"]["op"], "test.stuck");
        assert_eq!(value["params"]["budgetMs"], 50);
        assert!(message_of(&error).contains("test.stuck"));
        release_tx.send(()).ok();
    }

    #[tokio::test]
    async fn blocking_does_not_time_out_a_closure_that_finishes_within_the_budget() {
        let value = blocking("test.quick", Duration::from_secs(30), || Ok("done"))
            .await
            .unwrap();
        assert_eq!(value, "done");
    }

    #[tokio::test]
    async fn blocking_unbounded_waits_for_a_slow_closure_and_returns_the_value() {
        // The closure stays blocked for a while before it finishes. The entry point
        // takes no budget, so it must return the real value, never a timeout.
        let (release, gate) = mpsc::channel::<()>();
        let releaser = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            release.send(()).unwrap();
        });
        let value = crate::blocking_unbounded("test.write", move || {
            gate.recv().unwrap();
            Ok("written")
        })
        .await
        .unwrap();
        releaser.await.unwrap();
        assert_eq!(value, "written");
    }

    #[tokio::test]
    async fn bounded_returns_the_future_result_within_the_budget() {
        let value = super::bounded("test.op", Duration::from_millis(500), async {
            Ok::<_, AppError>(7)
        })
        .await
        .unwrap();
        assert_eq!(value, 7);

        let error = super::bounded("test.op", Duration::from_millis(500), async {
            Err::<(), AppError>(AppError::coded("test.failure", "boom"))
        })
        .await
        .unwrap_err();
        assert_eq!(code_of(&error), "test.failure");
        assert_eq!(message_of(&error), "boom");
    }

    #[tokio::test]
    async fn bounded_reports_blocking_timeout_with_the_operation_and_budget() {
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            super::bounded(
                "test.slow",
                Duration::from_millis(50),
                std::future::pending::<Result<(), AppError>>(),
            ),
        )
        .await;

        let error = outcome
            .expect("bounded must return on its own budget")
            .unwrap_err();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "blocking.timeout");
        assert_eq!(value["params"]["op"], "test.slow");
        assert_eq!(value["params"]["budgetMs"], 50);
    }

    #[test]
    fn db_with_sync_runs_the_closure_and_returns_its_result() {
        let db = Db::new(Connection::open_in_memory().unwrap());
        db.with_sync("test.create", |c| {
            c.execute("create table t(x integer)", [])?;
            Ok(())
        })
        .unwrap();

        db.with_sync("test.insert", |c| {
            c.execute("insert into t values (7)", [])?;
            Ok(())
        })
        .unwrap();
        let value = db
            .with_sync("test.read", |c| {
                Ok(c.query_row("select x from t", [], |r| r.get::<_, i64>(0))?)
            })
            .unwrap();
        assert_eq!(value, 7);

        let error = db
            .with_sync("test.fail", |_| -> Result<(), AppError> {
                Err(AppError::coded("test.failure", "boom"))
            })
            .unwrap_err();
        assert_eq!(code_of(&error), "test.failure");
    }

    #[test]
    fn db_with_sync_maps_a_poisoned_lock_to_db_poisoned() {
        let db = Db::new(Connection::open_in_memory().unwrap());
        let shared = db.shared_for_test();
        let _ = std::thread::spawn(move || {
            let _guard = shared.lock().unwrap();
            panic!("poison");
        })
        .join();

        let error = db.with_sync("test.poisoned", |_| Ok(())).unwrap_err();

        assert_eq!(code_of(&error), "db.poisoned");
    }

    #[test]
    fn cache_db_with_sync_runs_the_closure_and_returns_its_result() {
        let cache = CacheDb::new(Connection::open_in_memory().unwrap());

        let value = cache
            .with_sync("test.read", |c| {
                Ok(c.query_row("select 41 + 1", [], |r| r.get::<_, i64>(0))?)
            })
            .unwrap();
        assert_eq!(value, 42);

        let error = cache
            .with_sync("test.fail", |_| -> Result<(), AppError> {
                Err(AppError::coded("test.failure", "boom"))
            })
            .unwrap_err();
        assert_eq!(code_of(&error), "test.failure");
    }
}
