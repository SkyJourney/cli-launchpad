use tauri::State;

use crate::db::shell_profile_repo;
use crate::models::shell_profile::ShellProfile;
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn get_shell_profiles(state: State<'_, Db>) -> Result<Vec<ShellProfile>, AppError> {
    with_conn(&state, |conn| Ok(shell_profile_repo::list(conn)?))
}

/// Set the launch mode of the default shell profile to a supported PowerShell mode.
#[tauri::command]
pub fn set_shell_kind(state: State<'_, Db>, kind: String) -> Result<(), AppError> {
    if !matches!(kind.as_str(), "wt-pwsh" | "pwsh") {
        return Err(AppError::msg("仅支持安全的 PowerShell 启动方式"));
    }
    with_conn(&state, |conn| {
        Ok(shell_profile_repo::set_default_kind(conn, &kind)?)
    })
}
