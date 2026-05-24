-- Antigravity's official command is `agy`, not `antigravity`. Correct existing
-- databases that were seeded before this fix.
update tools set executable = 'agy' where key = 'antigravity' and executable = 'antigravity';
