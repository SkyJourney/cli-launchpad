mod commands;
mod db;
mod error;
mod models;
mod platform;
mod services;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State, WebviewWindow};

pub use error::AppError;

/// Shared SQLite connection guarded by a mutex, stored in Tauri managed state.
pub type Db = Mutex<Connection>;

/// Lock the shared connection and run `f` with it, mapping lock poisoning to an
/// `AppError`. Removes the `state.lock().map_err(...)` boilerplate from commands.
pub fn with_conn<T>(
    state: &State<'_, Db>,
    f: impl FnOnce(&Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let conn = state
        .lock()
        .map_err(|_| AppError::msg("数据库连接锁中毒"))?;
    f(&conn)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_main_window(&window);
            }
        }))
        // Native file/folder picker for the add-directory flow.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = services::storage_service::prepare(app.handle())
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;

            // Register after storage migration so prior window state is available
            // on the first launch under the stable Tauri identifier.
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;

            let connection = db::connection::init_database(&paths.database_path)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            app.manage(Mutex::new(connection));
            app.manage(paths);

            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::launch::preview_launch,
            commands::launch::launch_tool,
            commands::session::list_sessions,
            commands::session::resume_session,
            commands::directory::list_directories,
            commands::directory::add_directory,
            commands::directory::update_directory,
            commands::directory::remove_directory,
            commands::directory::set_directory_pinned,
            commands::tool::list_tools,
            commands::tool::save_tool_global_args,
            commands::cli_status::detect_cli_status,
            commands::install::fetch_latest_versions,
            commands::install::get_install_plan,
            commands::install::run_install,
            commands::shell::get_shell_profiles,
            commands::shell::save_shell_profile,
            commands::shell::set_shell_kind,
            commands::tool_args::get_directory_tool_args,
            commands::tool_args::save_directory_tool_args,
            commands::config::export_config_to_path,
            commands::config::import_config_from_path,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CLI Launchpad");
}

fn show_main_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("CLI Launchpad")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    show_main_window(&window);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    show_main_window(&window);
                }
            }
        })
        .build(app)?;

    Ok(())
}
