use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::State;

use crate::db::app_setting_repo;
use crate::models::terminal::TerminalEnvironment;
use crate::{with_conn, AppError, Db};

const TERMINAL_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct TerminalEnvironmentCache(Mutex<Option<(Instant, TerminalEnvironment)>>);

pub async fn load_terminal_environment(
    cache: &TerminalEnvironmentCache,
    force: bool,
) -> Result<TerminalEnvironment, AppError> {
    if !force {
        let cached = cache
            .0
            .lock()
            .map_err(|_| AppError::msg("终端环境缓存锁中毒"))?
            .as_ref()
            .filter(|(created_at, _)| created_at.elapsed() < TERMINAL_CACHE_TTL)
            .map(|(_, environment)| environment.clone());
        if let Some(environment) = cached {
            return Ok(environment);
        }
    }

    let environment = crate::platform::terminal::detect_environment().await;
    *cache
        .0
        .lock()
        .map_err(|_| AppError::msg("终端环境缓存锁中毒"))? =
        Some((Instant::now(), environment.clone()));
    Ok(environment)
}

#[tauri::command]
pub async fn detect_terminal_environment(
    state: State<'_, TerminalEnvironmentCache>,
    force: bool,
) -> Result<TerminalEnvironment, AppError> {
    load_terminal_environment(&state, force).await
}

#[tauri::command]
pub fn get_launch_target(state: State<'_, Db>) -> Result<String, AppError> {
    with_conn(&state, |conn| {
        Ok(app_setting_repo::get_launch_target(conn)?)
    })
}

#[tauri::command]
pub fn set_launch_target(state: State<'_, Db>, target_id: String) -> Result<(), AppError> {
    if !is_valid_target_id(&target_id) {
        return Err(AppError::msg("无效的终端启动目标"));
    }
    with_conn(&state, |conn| {
        Ok(app_setting_repo::set_launch_target(conn, &target_id)?)
    })
}

fn is_valid_target_id(value: &str) -> bool {
    if matches!(
        value,
        "auto"
            | "direct:pwsh"
            | "direct:windows-powershell"
            | "direct:cmd"
            | "macos:terminal"
            | "macos:iterm2"
            | "macos:ghostty"
            | "macos:wezterm"
            | "macos:kitty"
    ) {
        return true;
    }

    let mut parts = value.split(':');
    let (Some("wt"), Some(distribution), Some(guid), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    matches!(distribution, "stable" | "preview" | "canary" | "unpackaged")
        && uuid::Uuid::parse_str(guid).is_ok()
}

#[cfg(test)]
mod tests {
    use super::is_valid_target_id;

    #[test]
    fn accepts_known_targets() {
        assert!(is_valid_target_id("auto"));
        assert!(is_valid_target_id("direct:pwsh"));
        for target_id in [
            "macos:terminal",
            "macos:iterm2",
            "macos:ghostty",
            "macos:wezterm",
            "macos:kitty",
        ] {
            assert!(is_valid_target_id(target_id));
        }
        assert!(is_valid_target_id(
            "wt:stable:574e775e-4f2a-5b96-ac1e-a2962a402336"
        ));
    }

    #[test]
    fn rejects_unknown_or_malformed_targets() {
        assert!(!is_valid_target_id("direct:bash"));
        assert!(!is_valid_target_id("macos:unknown"));
        assert!(!is_valid_target_id("macos:alacritty"));
        assert!(!is_valid_target_id("macos:warp"));
        assert!(!is_valid_target_id("wt:stable:not-a-guid"));
        assert!(!is_valid_target_id(
            "wt:unknown:574e775e-4f2a-5b96-ac1e-a2962a402336"
        ));
    }
}
