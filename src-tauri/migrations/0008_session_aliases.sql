create table session_aliases (
    tool_key text not null check (tool_key in ('claude', 'codex', 'antigravity')),
    session_id text not null check (length(trim(session_id)) > 0),
    alias text not null check (length(trim(alias)) > 0),
    updated_at_ms integer not null,
    primary key (tool_key, session_id)
);
