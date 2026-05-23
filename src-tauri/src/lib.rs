mod commands;
mod db;
mod models;
mod platform;
mod services;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::launch::preview_launch,
            commands::launch::launch_tool
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CLI Launchpad");
}

