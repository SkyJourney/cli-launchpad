alter table launch_history add column directory_path text;
alter table launch_history add column pty_session_id text;

delete from launch_history where id not in
(select id from launch_history order by id desc limit 100);
