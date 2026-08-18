create table execution_tasks (
  id text primary key,
  tool_key text not null references tools(key) on delete restrict,
  kind text not null check (kind in ('install', 'update')),
  source text not null,
  program text not null,
  args_json text not null,
  preview text not null,
  status text not null check (
    status in (
      'preparing',
      'running',
      'cancelling',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'interrupted'
    )
  ),
  started_at_ms integer not null,
  finished_at_ms integer,
  exit_code integer,
  error_message text,
  log_truncated integer not null default 0 check (log_truncated in (0, 1))
);

create index execution_tasks_started_at_idx
  on execution_tasks(started_at_ms desc);

create index execution_tasks_status_idx
  on execution_tasks(status);

create table execution_task_logs (
  task_id text not null references execution_tasks(id) on delete cascade,
  sequence integer not null,
  stream text not null check (stream in ('stdout', 'stderr', 'system')),
  content text not null,
  created_at_ms integer not null,
  primary key (task_id, sequence)
);

create index execution_task_logs_created_at_idx
  on execution_task_logs(task_id, created_at_ms, sequence);
