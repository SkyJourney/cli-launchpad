create table pty_sessions (
    session_id text primary key not null,
    directory_id integer not null references directories(id) on delete cascade,
    tool_key text not null check (tool_key in ('claude', 'codex', 'antigravity')),
    working_directory text not null,
    state text not null check (state in ('running', 'exited', 'terminated', 'failed')),
    started_at_ms integer not null,
    ended_at_ms integer,
    exit_code integer
);

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
