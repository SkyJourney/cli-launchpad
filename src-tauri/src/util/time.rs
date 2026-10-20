//! Wall-clock helpers shared by the services that used to carry their own `now_ms`.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;

/// Milliseconds since the Unix epoch. A clock before the epoch reads as 0 and values are clamped to `i64::MAX`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

/// Like `now_ms`, but a clock before the epoch or an unrepresentable value is an error.
pub fn checked_now_ms() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn wall_clock_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn now_ms_tracks_the_system_clock() {
        let before = wall_clock_ms();
        let value = now_ms();
        let after = wall_clock_ms();
        assert!(value >= before - 1000 && value <= after + 1000);
        // 反向：连续两次调用不会倒退。
        let first = now_ms();
        let second = now_ms();
        assert!(second >= first);
    }

    #[test]
    fn checked_now_ms_agrees_with_now_ms() {
        let checked = checked_now_ms().unwrap();
        assert!((checked - now_ms()).abs() <= 1000);
        assert!(checked > 0);
    }
}
