use tauri::State;

use crate::services::config_service;
use crate::Db;

#[tauri::command]
pub fn export_config_to_path(state: State<'_, Db>, path: String) -> Result<(), String> {
    let json = {
        let conn = state.lock().map_err(|error| error.to_string())?;
        config_service::export_json(&conn).map_err(|error| error.to_string())?
    };
    std::fs::write(&path, json).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_config_from_path(state: State<'_, Db>, path: String) -> Result<(), String> {
    let json = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let conn = state.lock().map_err(|error| error.to_string())?;
    config_service::import_json(&conn, &json).map_err(|error| error.to_string())
}
