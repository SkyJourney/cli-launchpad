use std::fmt;
use std::future::Future;
use std::time::Duration;

use crate::models::tool::ToolKey;
use crate::services::cli_adapters::{self, CliAdapter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliRuntimeError {
    TimedOut {
        tool_key: ToolKey,
        operation: &'static str,
    },
    Failed {
        tool_key: ToolKey,
        operation: &'static str,
        detail: String,
    },
}

impl fmt::Display for CliRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TimedOut {
                tool_key,
                operation,
            } => write!(formatter, "{} {operation}超时", tool_key.as_str()),
            Self::Failed {
                tool_key,
                operation,
                detail,
            } => write!(
                formatter,
                "{} {operation}适配器异常：{detail}",
                tool_key.as_str()
            ),
        }
    }
}

impl std::error::Error for CliRuntimeError {}

/// Run one adapter operation in its own task with a single, central budget and
/// panic isolation. Adapters must not add their own timeouts around it.
pub async fn run<T, Fut>(
    tool_key: ToolKey,
    operation: &'static str,
    budget: Duration,
    op: impl FnOnce(&'static dyn CliAdapter) -> Fut + Send + 'static,
) -> Result<T, CliRuntimeError>
where
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    run_with(cli_adapters::get(tool_key), operation, budget, op).await
}

/// Core primitive: run `future` in its own task with `budget`; on timeout the
/// task is aborted, on panic the error is scoped to the tool and operation.
pub async fn run_future<T, Fut>(
    tool_key: ToolKey,
    operation: &'static str,
    budget: Duration,
    future: Fut,
) -> Result<T, CliRuntimeError>
where
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let mut handle = tokio::spawn(future);
    match tokio::time::timeout(budget, &mut handle).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(CliRuntimeError::Failed {
            tool_key,
            operation,
            detail: error.to_string(),
        }),
        Err(_) => {
            handle.abort();
            Err(CliRuntimeError::TimedOut {
                tool_key,
                operation,
            })
        }
    }
}

/// Like `run`, but takes the adapter itself (tests inject adapters this way).
pub async fn run_with<T, Fut>(
    adapter: &'static dyn CliAdapter,
    operation: &'static str,
    budget: Duration,
    op: impl FnOnce(&'static dyn CliAdapter) -> Fut + Send + 'static,
) -> Result<T, CliRuntimeError>
where
    Fut: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    run_future(adapter.tool_key(), operation, budget, async move {
        op(adapter).await
    })
    .await
}

/// Blocking variant. A blocking thread cannot be cancelled: on timeout only
/// the caller is released.
#[cfg_attr(not(test), allow(dead_code))] // no production caller yet; kept as the blocking counterpart of `run`
pub async fn run_blocking<T>(
    tool_key: ToolKey,
    operation: &'static str,
    budget: Duration,
    op: impl FnOnce(&'static dyn CliAdapter) -> T + Send + 'static,
) -> Result<T, CliRuntimeError>
where
    T: Send + 'static,
{
    run_blocking_with(cli_adapters::get(tool_key), operation, budget, op).await
}

/// Blocking variant of `run_with`. A blocking thread cannot be cancelled: on
/// timeout only the caller is released.
pub async fn run_blocking_with<T>(
    adapter: &'static dyn CliAdapter,
    operation: &'static str,
    budget: Duration,
    op: impl FnOnce(&'static dyn CliAdapter) -> T + Send + 'static,
) -> Result<T, CliRuntimeError>
where
    T: Send + 'static,
{
    let tool_key = adapter.tool_key();
    match tokio::time::timeout(budget, tokio::task::spawn_blocking(move || op(adapter))).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(CliRuntimeError::Failed {
            tool_key,
            operation,
            detail: error.to_string(),
        }),
        Err(_) => Err(CliRuntimeError::TimedOut {
            tool_key,
            operation,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn run_returns_the_result_of_the_operation() {
        let value = run(
            ToolKey::Claude,
            "测试",
            Duration::from_secs(5),
            |adapter| async move { adapter.tool_key() },
        )
        .await;

        assert_eq!(value, Ok(ToolKey::Claude));
    }

    #[tokio::test]
    async fn run_reports_a_timeout_naming_the_tool_and_operation() {
        let error = run(
            ToolKey::Codex,
            "版本查询",
            Duration::from_millis(10),
            |_| std::future::pending::<()>(),
        )
        .await
        .unwrap_err();

        assert_eq!(
            error,
            CliRuntimeError::TimedOut {
                tool_key: ToolKey::Codex,
                operation: "版本查询"
            }
        );
        assert_eq!(error.to_string(), "codex 版本查询超时");
    }

    #[tokio::test]
    async fn run_isolates_a_panicking_operation() {
        let error = run(
            ToolKey::Hermes,
            "版本查询",
            Duration::from_secs(5),
            |_| async {
                if true {
                    panic!("adapter panic");
                }
                1u8
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(error, CliRuntimeError::Failed { .. }));
        let text = error.to_string();
        assert!(text.starts_with("hermes 版本查询适配器异常："), "{text}");
        assert!(text.contains("panic"), "{text}");
    }

    #[tokio::test]
    async fn run_blocking_returns_results_and_isolates_panics() {
        let value = run_blocking(ToolKey::Grok, "测试", Duration::from_secs(5), |adapter| {
            adapter.tool_key()
        })
        .await;
        assert_eq!(value, Ok(ToolKey::Grok));

        let error = run_blocking(
            ToolKey::Antigravity,
            "测试",
            Duration::from_secs(5),
            |_| {
                if true {
                    panic!("blocking panic");
                }
                1u8
            },
        )
        .await
        .unwrap_err();
        assert!(error
            .to_string()
            .starts_with("antigravity 测试适配器异常："));
    }

    #[tokio::test]
    async fn run_with_uses_the_given_adapter_and_reports_timeouts() {
        let adapter = cli_adapters::get(ToolKey::Hermes);
        let value = run_with(
            adapter,
            "测试",
            Duration::from_secs(5),
            |adapter| async move { adapter.tool_key() },
        )
        .await;
        assert_eq!(value, Ok(ToolKey::Hermes));

        let error = run_with(adapter, "会话读取", Duration::from_millis(10), |_| {
            std::future::pending::<()>()
        })
        .await
        .unwrap_err();
        assert_eq!(
            error,
            CliRuntimeError::TimedOut {
                tool_key: ToolKey::Hermes,
                operation: "会话读取"
            }
        );
        assert_eq!(error.to_string(), "hermes 会话读取超时");
    }

    #[tokio::test]
    async fn run_future_aborts_the_task_when_the_budget_expires() {
        let finished = Arc::new(AtomicBool::new(false));
        let flag = finished.clone();
        let error = run_future(
            ToolKey::Claude,
            "测试",
            Duration::from_millis(20),
            async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                flag.store(true, Ordering::SeqCst);
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, CliRuntimeError::TimedOut { .. }));

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!finished.load(Ordering::SeqCst), "超时后任务必须被中止");

        let value = run_future(ToolKey::Claude, "测试", Duration::from_secs(5), async {
            7u8
        })
        .await;
        assert_eq!(value, Ok(7));
    }

    #[tokio::test]
    async fn run_blocking_with_isolates_panics_and_times_out() {
        let adapter = cli_adapters::get(ToolKey::Grok);
        let value = run_blocking_with(adapter, "测试", Duration::from_secs(5), |adapter| {
            adapter.tool_key()
        })
        .await;
        assert_eq!(value, Ok(ToolKey::Grok));

        let error = run_blocking_with(adapter, "测试", Duration::from_secs(5), |_| {
            if true {
                panic!("blocking panic");
            }
            1u8
        })
        .await
        .unwrap_err();
        assert!(
            error.to_string().starts_with("grok 测试适配器异常："),
            "{error}"
        );

        let error = run_blocking_with(
            adapter,
            "执行前校验",
            Duration::from_millis(50),
            |_| {
                std::thread::sleep(Duration::from_millis(500));
                1u8
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "grok 执行前校验超时");
    }
}
