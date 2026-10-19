-- 0015_legacy_cleanup: remove data structures left behind by the 0.2.x
-- external-terminal launch chain (deleted in 0.4.0 M6). Nothing reads them.
drop table if exists directory_tool_args;
drop table if exists shell_profiles;

delete from application_settings where key = 'launch_target';

alter table tools drop column display_name;
alter table tools drop column executable;

alter table directories drop column last_used_at;
