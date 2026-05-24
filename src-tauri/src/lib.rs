mod commands;
mod db;
mod models;
mod platform;
mod services;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

/// Shared SQLite connection guarded by a mutex, stored in Tauri managed state.
pub type Db = Mutex<Connection>;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("cli-launchpad.db");
            let connection = db::connection::init_database(&db_path)?;
            app.manage(Mutex::new(connection));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::launch::preview_launch,
            commands::launch::launch_tool,
            commands::directory::list_directories,
            commands::directory::add_directory,
            commands::directory::update_directory,
            commands::directory::remove_directory,
            commands::directory::set_directory_pinned,
            commands::tool::list_tools,
            commands::cli_status::detect_cli_status,
            commands::shell::get_shell_profiles,
            commands::shell::save_shell_profile,
            commands::tool_args::get_directory_tool_args,
            commands::tool_args::save_directory_tool_args,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CLI Launchpad");
}
