create table workspace_state (
    id integer primary key check (id = 1),
    schema_version integer not null check (schema_version > 0),
    revision integer not null check (revision >= 0),
    payload_json text not null check (length(cast(payload_json as blob)) <= 2097152),
    updated_at_ms integer not null
);

create table workspace_layout_presets (
    id text primary key not null check (length(trim(id)) > 0),
    name text not null check (length(trim(name)) between 1 and 64),
    schema_version integer not null check (schema_version > 0),
    payload_json text not null check (length(cast(payload_json as blob)) <= 2097152),
    created_at_ms integer not null,
    updated_at_ms integer not null
);

create unique index workspace_layout_presets_name_ci_idx
    on workspace_layout_presets(lower(name));
