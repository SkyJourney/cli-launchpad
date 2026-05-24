-- Launch mode for shell profiles: how the terminal/shell is composed.
-- 'wt-pwsh' = Windows Terminal + PowerShell, 'pwsh' = PowerShell window,
-- 'cmd' = Command Prompt window.
alter table shell_profiles add column kind text not null default 'wt-pwsh';
