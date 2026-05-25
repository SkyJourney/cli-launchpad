use tauri::State;

use crate::db::shell_profile_repo;
use crate::models::shell_profile::ShellProfile;
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn get_shell_profiles(state: State<'_, Db>) -> Result<Vec<ShellProfile>, AppError> {
    with_conn(&state, |conn| Ok(shell_profile_repo::list(conn)?))
}

#[tauri::command]
pub fn save_shell_profile(state: State<'_, Db>, profile: ShellProfile) -> Result<(), AppError> {
    with_conn(&state, |conn| Ok(shell_profile_repo::save(conn, &profile)?))
}

/// Set the launch mode of the default shell profile ("wt-pwsh" | "pwsh" | "cmd").
#[tauri::command]
pub fn set_shell_kind(state: State<'_, Db>, kind: String) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(shell_profile_repo::set_default_kind(conn, &kind)?)
    })
}
