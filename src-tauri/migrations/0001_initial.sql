create table if not exists directories (
  id integer primary key,
  name text not null,
  path text not null unique,
  sort_order integer not null default 0,
  pinned integer not null default 0,
  last_used_at text,
  note text
);

create table if not exists tools (
  id integer primary key,
  key text not null unique,
  display_name text not null,
  executable text not null,
  global_args text not null default '',
  enabled integer not null default 1
);

create table if not exists directory_tool_args (
  id integer primary key,
  directory_id integer not null references directories(id) on delete cascade,
  tool_key text not null references tools(key) on delete cascade,
  args text not null default '',
  unique(directory_id, tool_key)
);

create table if not exists shell_profiles (
  id integer primary key,
  name text not null,
  terminal_exe text not null default 'wt.exe',
  shell_exe text not null default 'pwsh.exe',
  shell_args text not null default '-NoLogo -NoExit',
  init_script text not null default '',
  is_default integer not null default 0
);

create table if not exists launch_history (
  id integer primary key,
  directory_id integer not null references directories(id) on delete cascade,
  tool_key text not null,
  launched_at text not null default current_timestamp,
  preview_command text not null
);

insert or ignore into tools (key, display_name, executable)
values
  ('antigravity', 'Antigravity', 'antigravity'),
  ('codex', 'Codex', 'codex'),
  ('claude', 'Claude Code', 'claude');

insert or ignore into shell_profiles (
  id,
  name,
  terminal_exe,
  shell_exe,
  shell_args,
  init_script,
  is_default
) values (
  1,
  'Windows Terminal + PowerShell UTF-8',
  'wt.exe',
  'pwsh.exe',
  '-NoLogo -NoExit',
  '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new()',
  1
);

