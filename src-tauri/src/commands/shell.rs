use tauri::State;

use crate::db::shell_profile_repo;
use crate::models::shell_profile::ShellProfile;
use crate::Db;

#[tauri::command]
pub fn get_shell_profiles(state: State<'_, Db>) -> Result<Vec<ShellProfile>, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    shell_profile_repo::list(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_shell_profile(state: State<'_, Db>, profile: ShellProfile) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    shell_profile_repo::save(&conn, &profile).map_err(|error| error.to_string())
}
