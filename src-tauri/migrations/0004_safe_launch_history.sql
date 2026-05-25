drop table if exists launch_history;

create table launch_history (
  id integer primary key,
  directory_id integer not null references directories(id) on delete cascade,
  tool_key text not null references tools(key) on delete cascade,
  action text not null check (action in ('launch', 'resume')),
  success integer not null default 0,
  error_category text,
  launched_at text not null default current_timestamp
);

create index if not exists idx_launch_history_recent on launch_history(launched_at desc, id desc);
