insert or ignore into tools (key, display_name, executable)
values ('grok', 'Grok Build', 'grok');

create table session_aliases_grok (
    tool_key text not null check (tool_key in ('claude', 'codex', 'antigravity', 'grok')),
    session_id text not null check (length(trim(session_id)) > 0),
    alias text not null check (length(trim(alias)) > 0),
    updated_at_ms integer not null,
    primary key (tool_key, session_id)
);

insert into session_aliases_grok (tool_key, session_id, alias, updated_at_ms)
select tool_key, session_id, alias, updated_at_ms from session_aliases;
drop table session_aliases;
alter table session_aliases_grok rename to session_aliases;

drop trigger if exists prevent_directory_delete_with_running_pty;
drop index if exists pty_sessions_directory_state_idx;

create table pty_sessions_grok (
    session_id text primary key not null,
    directory_id integer not null references directories(id) on delete cascade,
    tool_key text not null check (tool_key in ('claude', 'codex', 'antigravity', 'grok')),
    working_directory text not null,
    state text not null check (state in ('running', 'exited', 'terminated', 'failed')),
    started_at_ms integer not null,
    ended_at_ms integer,
    exit_code integer
);

insert into pty_sessions_grok (
    session_id, directory_id, tool_key, working_directory, state,
    started_at_ms, ended_at_ms, exit_code
)
select
    session_id, directory_id, tool_key, working_directory, state,
    started_at_ms, ended_at_ms, exit_code
from pty_sessions;
drop table pty_sessions;
alter table pty_sessions_grok rename to pty_sessions;

create index pty_sessions_directory_state_idx
    on pty_sessions(directory_id, state);

create trigger prevent_directory_delete_with_running_pty
before delete on directories
when exists (
    select 1 from pty_sessions
    where directory_id = old.id and state = 'running'
)
begin
    select raise(abort, 'directory has active PTY sessions');
end;
