create table if not exists application_settings (
  key text primary key,
  value text not null
);

insert or ignore into application_settings (key, value)
values ('close_behavior', 'minimize_to_tray');
