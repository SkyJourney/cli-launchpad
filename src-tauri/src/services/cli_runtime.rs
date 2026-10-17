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
    let adapter = cli_adapters::get(tool_key);
    let mut handle = tokio::spawn(async move { op(adapter).await });
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
    let adapter = cli_adapters::get(tool_key);
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
}
