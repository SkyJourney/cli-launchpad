use tauri::State;

use crate::services::config_service;
use crate::Db;

#[tauri::command]
pub fn export_config(state: State<'_, Db>) -> Result<String, String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    config_service::export_json(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_config(state: State<'_, Db>, json: String) -> Result<(), String> {
    let conn = state.lock().map_err(|error| error.to_string())?;
    config_service::import_json(&conn, &json).map_err(|error| error.to_string())
}
