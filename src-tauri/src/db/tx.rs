//! The single entry point for SQLite transactions. Every transaction in the application goes through
//! `with_tx`; only the migration runner in `db/connection.rs` manages its own.

use rusqlite::{Connection, Transaction, TransactionBehavior};

/// Runs `f` in a transaction of the given behavior. Returning `Err` drops the transaction, which
/// rolls it back; returning `Ok` commits it.
pub fn with_tx<T, E: From<rusqlite::Error>>(
    connection: &Connection,
    behavior: TransactionBehavior,
    f: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
) -> Result<T, E> {
    let transaction = Transaction::new_unchecked(connection, behavior)?;
    let value = f(&transaction)?;
    transaction.commit()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppError;
    use rusqlite::{Connection, ErrorCode, TransactionBehavior};
    use std::time::Duration;

    fn memory() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("create table t (v integer)")
            .unwrap();
        connection
    }

    fn count(connection: &Connection) -> i64 {
        connection
            .query_row("select count(*) from t", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn with_tx_commits_when_the_closure_succeeds() {
        let connection = memory();
        let value =
            with_tx::<_, rusqlite::Error>(&connection, TransactionBehavior::Deferred, |tx| {
                tx.execute("insert into t values (1)", [])?;
                Ok(7)
            })
            .unwrap();
        assert_eq!(value, 7);
        assert_eq!(count(&connection), 1);
    }

    #[test]
    fn with_tx_rolls_back_when_the_closure_fails() {
        let connection = memory();
        let error =
            with_tx::<(), rusqlite::Error>(&connection, TransactionBehavior::Deferred, |tx| {
                tx.execute("insert into t values (1)", [])?;
                Err(rusqlite::Error::QueryReturnedNoRows)
            })
            .unwrap_err();
        assert!(matches!(error, rusqlite::Error::QueryReturnedNoRows));
        assert_eq!(count(&connection), 0);
        // 反向：回滚之后同一连接可以再开事务并提交。
        with_tx::<_, rusqlite::Error>(&connection, TransactionBehavior::Deferred, |tx| {
            tx.execute("insert into t values (2)", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(count(&connection), 1);
    }

    #[test]
    fn immediate_behavior_takes_the_write_lock_up_front() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tx.db");
        let first = Connection::open(&path).unwrap();
        first.execute_batch("create table t (v integer)").unwrap();
        let second = Connection::open(&path).unwrap();
        second.busy_timeout(Duration::ZERO).unwrap();

        // 反向基线：Deferred 事务在尚未写入时不占写锁，另一个连接的 Immediate 事务可以成功。
        with_tx::<_, rusqlite::Error>(&first, TransactionBehavior::Deferred, |_| {
            with_tx::<_, rusqlite::Error>(&second, TransactionBehavior::Immediate, |_| Ok(()))
                .unwrap();
            Ok(())
        })
        .unwrap();

        // Immediate 在开始时就取得写锁：第一个连接持有期间，第二个连接的 Immediate 事务失败。
        let outcome = with_tx::<_, rusqlite::Error>(&first, TransactionBehavior::Immediate, |_| {
            Ok(with_tx::<(), rusqlite::Error>(
                &second,
                TransactionBehavior::Immediate,
                |_| Ok(()),
            ))
        })
        .unwrap();
        match outcome {
            Err(rusqlite::Error::SqliteFailure(code, _)) => assert!(matches!(
                code.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            )),
            other => panic!("预期忙碌错误，实际为 {other:?}"),
        }
        // 闭包外第一个连接已提交，第二个连接再试一次成功。
        with_tx::<_, rusqlite::Error>(&second, TransactionBehavior::Immediate, |_| Ok(())).unwrap();
    }

    #[derive(Debug)]
    enum TestError {
        Db(rusqlite::Error),
    }

    impl From<rusqlite::Error> for TestError {
        fn from(error: rusqlite::Error) -> Self {
            TestError::Db(error)
        }
    }

    #[test]
    fn with_tx_converts_rusqlite_errors_into_the_caller_error_type() {
        let connection = memory();
        let error = with_tx::<(), TestError>(&connection, TransactionBehavior::Deferred, |tx| {
            tx.execute("insert into missing values (1)", [])?;
            Ok(())
        })
        .unwrap_err();
        match &error {
            TestError::Db(inner) => assert!(inner.to_string().contains("no such table")),
        }

        let app: AppError =
            with_tx::<(), AppError>(&connection, TransactionBehavior::Deferred, |tx| {
                tx.execute("not sql", [])?;
                Ok(())
            })
            .unwrap_err();
        assert!(!app.to_string().is_empty());

        let failure: anyhow::Error =
            with_tx::<(), anyhow::Error>(&connection, TransactionBehavior::Deferred, |tx| {
                tx.execute("not sql", [])?;
                Ok(())
            })
            .unwrap_err();
        assert!(!failure.to_string().is_empty());

        // 反向：成功路径返回 Ok。
        with_tx::<(), TestError>(&connection, TransactionBehavior::Deferred, |_| Ok(())).unwrap();
    }
}
