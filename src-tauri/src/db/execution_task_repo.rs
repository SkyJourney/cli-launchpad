use rusqlite::{params, Connection, OptionalExtension};

use crate::models::execution::{
    ExecutionLogChunk, ExecutionStatus, ExecutionStream, ExecutionTask, ExecutionTaskDetail,
};
use crate::models::install::{InstallKind, InstallPlan};
use crate::models::tool::ToolKey;

pub const TASK_HISTORY_LIMIT: i64 = 50;
pub const TASK_LOG_LIMIT_BYTES: usize = 1024 * 1024;

const TASK_COLUMNS: &str = "id, tool_key, kind, source, preview, status, started_at_ms, \
    finished_at_ms, exit_code, error_message, log_truncated";

pub fn insert(
    connection: &Connection,
    id: &str,
    plan: &InstallPlan,
    started_at_ms: i64,
) -> rusqlite::Result<ExecutionTask> {
    let args_json = serde_json::to_string(&plan.args)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    connection.execute(
        "insert into execution_tasks (id, tool_key, kind, source, program, args_json, preview, status, started_at_ms) \
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'preparing', ?8)",
        params![
            id,
            plan.tool_key.as_str(),
            plan.kind.as_str(),
            plan.source,
            plan.program,
            args_json,
            plan.preview,
            started_at_ms,
        ],
    )?;
    get(connection, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get(connection: &Connection, id: &str) -> rusqlite::Result<Option<ExecutionTask>> {
    connection
        .query_row(
            &format!("select {TASK_COLUMNS} from execution_tasks where id = ?1"),
            [id],
            map_task,
        )
        .optional()
}

pub fn list_recent(connection: &Connection) -> rusqlite::Result<Vec<ExecutionTask>> {
    let mut statement = connection.prepare(&format!(
        "select {TASK_COLUMNS} from execution_tasks order by started_at_ms desc, rowid desc limit ?1"
    ))?;
    let tasks = statement
        .query_map([TASK_HISTORY_LIMIT], map_task)?
        .collect();
    tasks
}

pub fn detail(connection: &Connection, id: &str) -> rusqlite::Result<Option<ExecutionTaskDetail>> {
    let Some(task) = get(connection, id)? else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "select task_id, sequence, stream, content, created_at_ms \
         from execution_task_logs where task_id = ?1 order by sequence",
    )?;
    let logs = statement
        .query_map([id], |row| {
            let stream: String = row.get(2)?;
            Ok(ExecutionLogChunk {
                task_id: row.get(0)?,
                sequence: row.get(1)?,
                stream: ExecutionStream::from_str(&stream).ok_or(rusqlite::Error::InvalidQuery)?,
                content: row.get(3)?,
                created_at_ms: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(ExecutionTaskDetail { task, logs }))
}

pub fn update_status(
    connection: &Connection,
    id: &str,
    status: ExecutionStatus,
    finished_at_ms: Option<i64>,
    exit_code: Option<i32>,
    error_message: Option<&str>,
) -> rusqlite::Result<ExecutionTask> {
    let changed = connection.execute(
        "update execution_tasks set status = ?2, finished_at_ms = ?3, exit_code = ?4, error_message = ?5 where id = ?1",
        params![id, status.as_str(), finished_at_ms, exit_code, error_message],
    )?;
    if changed == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    get(connection, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn append_log(
    connection: &mut Connection,
    task_id: &str,
    stream: ExecutionStream,
    content: &str,
    created_at_ms: i64,
) -> rusqlite::Result<(Option<ExecutionLogChunk>, bool)> {
    if content.is_empty() {
        return Ok((None, false));
    }
    let transaction = connection.transaction()?;
    let used: i64 = transaction.query_row(
        "select coalesce(sum(length(cast(content as blob))), 0) from execution_task_logs where task_id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    let remaining = TASK_LOG_LIMIT_BYTES.saturating_sub(used.max(0) as usize);
    if remaining == 0 {
        let newly_truncated = transaction.execute(
            "update execution_tasks set log_truncated = 1 where id = ?1 and log_truncated = 0",
            [task_id],
        )? != 0;
        transaction.commit()?;
        return Ok((None, newly_truncated));
    }

    let stored = truncate_utf8(content, remaining);
    let sequence: i64 = transaction.query_row(
        "select coalesce(max(sequence), -1) + 1 from execution_task_logs where task_id = ?1",
        [task_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "insert into execution_task_logs (task_id, sequence, stream, content, created_at_ms) values (?1, ?2, ?3, ?4, ?5)",
        params![task_id, sequence, stream.as_str(), stored, created_at_ms],
    )?;
    let newly_truncated = if stored.len() < content.len() {
        transaction.execute(
            "update execution_tasks set log_truncated = 1 where id = ?1 and log_truncated = 0",
            [task_id],
        )? != 0
    } else {
        false
    };
    transaction.commit()?;

    Ok((
        Some(ExecutionLogChunk {
            task_id: task_id.to_string(),
            sequence,
            stream,
            content: stored.to_string(),
            created_at_ms,
        }),
        newly_truncated,
    ))
}

pub fn mark_unfinished_interrupted(
    connection: &Connection,
    finished_at_ms: i64,
) -> rusqlite::Result<usize> {
    connection.execute(
        "update execution_tasks set status = 'interrupted', finished_at_ms = ?1, \
         error_message = '应用退出时任务尚未结束' \
         where status in ('preparing', 'running', 'cancelling')",
        [finished_at_ms],
    )
}

pub fn delete_finished(connection: &Connection, id: &str) -> rusqlite::Result<bool> {
    let changed = connection.execute(
        "delete from execution_tasks where id = ?1 and status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')",
        [id],
    )?;
    Ok(changed != 0)
}

pub fn clear_finished(connection: &Connection) -> rusqlite::Result<usize> {
    connection.execute(
        "delete from execution_tasks where status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')",
        [],
    )
}

pub fn prune_old_finished(connection: &Connection) -> rusqlite::Result<usize> {
    connection.execute(
        "delete from execution_tasks where id in (\
           select id from execution_tasks order by started_at_ms desc, rowid desc limit -1 offset ?1\
         ) and status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')",
        [TASK_HISTORY_LIMIT],
    )
}

fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExecutionTask> {
    let tool_key: String = row.get(1)?;
    let kind: String = row.get(2)?;
    let status: String = row.get(5)?;
    Ok(ExecutionTask {
        id: row.get(0)?,
        tool_key: ToolKey::from_key(&tool_key).ok_or(rusqlite::Error::InvalidQuery)?,
        kind: InstallKind::from_str(&kind).ok_or(rusqlite::Error::InvalidQuery)?,
        source: row.get(3)?,
        preview: row.get(4)?,
        status: ExecutionStatus::from_str(&status).ok_or(rusqlite::Error::InvalidQuery)?,
        started_at_ms: row.get(6)?,
        finished_at_ms: row.get(7)?,
        exit_code: row.get(8)?,
        error_message: row.get(9)?,
        log_truncated: row.get::<_, i64>(10)? != 0,
    })
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &value[..boundary]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection;

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection::apply_migrations(&connection).unwrap();
        connection
    }

    fn plan() -> InstallPlan {
        InstallPlan {
            tool_key: ToolKey::Codex,
            kind: InstallKind::Update,
            program: "C:\\codex.exe".to_string(),
            args: vec!["update".to_string()],
            source: "test".to_string(),
            preview: "C:\\codex.exe update".to_string(),
        }
    }

    #[test]
    fn task_and_logs_round_trip() {
        let mut connection = memory_db();
        let task = insert(&connection, "task-1", &plan(), 100).unwrap();
        assert_eq!(task.status, ExecutionStatus::Preparing);

        let (chunk, _) = append_log(
            &mut connection,
            "task-1",
            ExecutionStream::Stdout,
            "hello",
            101,
        )
        .unwrap();
        let chunk = chunk.unwrap();
        assert_eq!(chunk.sequence, 0);

        update_status(
            &connection,
            "task-1",
            ExecutionStatus::Succeeded,
            Some(102),
            Some(0),
            None,
        )
        .unwrap();
        let detail = detail(&connection, "task-1").unwrap().unwrap();
        assert_eq!(detail.logs[0].content, "hello");
        assert!(detail.task.status.is_terminal());
    }

    #[test]
    fn log_limit_preserves_utf8_boundary_and_marks_truncated() {
        let mut connection = memory_db();
        insert(&connection, "task-1", &plan(), 100).unwrap();
        let oversized = "界".repeat(TASK_LOG_LIMIT_BYTES / 3 + 2);
        let (chunk, newly_truncated) = append_log(
            &mut connection,
            "task-1",
            ExecutionStream::Stderr,
            &oversized,
            101,
        )
        .unwrap();
        let chunk = chunk.unwrap();
        assert!(chunk.content.len() <= TASK_LOG_LIMIT_BYTES);
        assert!(newly_truncated);
        assert!(get(&connection, "task-1").unwrap().unwrap().log_truncated);
    }

    #[test]
    fn startup_marks_unfinished_tasks_interrupted() {
        let connection = memory_db();
        insert(&connection, "task-1", &plan(), 100).unwrap();
        assert_eq!(mark_unfinished_interrupted(&connection, 200).unwrap(), 1);
        let task = get(&connection, "task-1").unwrap().unwrap();
        assert_eq!(task.status, ExecutionStatus::Interrupted);
        assert_eq!(task.finished_at_ms, Some(200));
    }

    #[test]
    fn history_cleanup_never_deletes_running_tasks() {
        let connection = memory_db();
        insert(&connection, "running", &plan(), 1).unwrap();
        insert(&connection, "finished", &plan(), 2).unwrap();
        update_status(
            &connection,
            "finished",
            ExecutionStatus::Succeeded,
            Some(3),
            Some(0),
            None,
        )
        .unwrap();

        assert!(!delete_finished(&connection, "running").unwrap());
        assert!(delete_finished(&connection, "finished").unwrap());
        assert!(get(&connection, "running").unwrap().is_some());
    }

    #[test]
    fn pruning_keeps_the_latest_fifty_tasks() {
        let connection = memory_db();
        for index in 0..=TASK_HISTORY_LIMIT {
            let id = format!("task-{index}");
            insert(&connection, &id, &plan(), index).unwrap();
            update_status(
                &connection,
                &id,
                ExecutionStatus::Succeeded,
                Some(index + 1),
                Some(0),
                None,
            )
            .unwrap();
        }

        assert_eq!(prune_old_finished(&connection).unwrap(), 1);
        assert_eq!(list_recent(&connection).unwrap().len(), 50);
        assert!(get(&connection, "task-0").unwrap().is_none());
    }
}
