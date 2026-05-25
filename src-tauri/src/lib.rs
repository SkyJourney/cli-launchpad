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
use tauri_plugin_log::{Target, TargetKind};

pub use error::AppError;

/// Business and cache databases are distinct managed-state types so commands
/// cannot accidentally read cache rows through the configuration connection.
pub struct Db(pub Mutex<Connection>);
pub struct CacheDb(pub Mutex<Connection>);

/// Lock the shared connection and run `f` with it, mapping lock poisoning to an
/// `AppError`. Removes the `state.lock().map_err(...)` boilerplate from commands.
pub fn with_conn<T>(
    state: &State<'_, Db>,
    f: impl FnOnce(&mut Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut conn = state
        .0
        .lock()
        .map_err(|_| AppError::msg("数据库连接锁中毒"))?;
    f(&mut conn)
}

pub fn with_cache<T>(
    state: &State<'_, CacheDb>,
    f: impl FnOnce(&Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let connection = state
        .0
        .lock()
        .map_err(|_| AppError::msg("缓存数据库连接锁中毒"))?;
    f(&connection)
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
            if let Err(error) = services::diagnostics_service::cleanup_logs(&paths) {
                eprintln!("unable to prune diagnostic logs: {error}");
            }
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .clear_targets()
                    .target(Target::new(TargetKind::Folder {
                        path: paths.logs_dir.clone(),
                        file_name: Some("cli-launchpad".to_string()),
                    }))
                    .max_file_size(2_000_000)
                    .build(),
            )?;
            log::info!("application startup storage_root={}", paths.root.display());

            // Register after storage migration so prior window state is available
            // on the first launch under the stable Tauri identifier.
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;

            let existing_database = paths.database_path.is_file();
            let connection = db::connection::open_database(&paths.database_path)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            db::connection::ensure_supported_schema(&connection)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if existing_database && db::connection::has_pending_migrations(&connection)? {
                services::backup_service::create(
                    &connection,
                    &paths,
                    models::backup::BackupReason::PreMigration,
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                log::info!("database pre-migration backup created");
            }
            db::connection::apply_migrations(&connection)?;
            log::info!(
                "database initialized schema_version={}",
                db::connection::schema_version(&connection)?
            );
            app.manage(Db(Mutex::new(connection)));
            let cache = match db::cache_connection::init_cache(&paths.cache_dir.join("cache.db")) {
                Ok(cache) => cache,
                Err(error) => {
                    log::warn!("persistent cache unavailable; using memory cache error={error}");
                    db::cache_connection::init_ephemeral_cache()
                        .map_err(|fallback| anyhow::anyhow!(fallback.to_string()))?
                }
            };
            app.manage(CacheDb(Mutex::new(cache)));
            app.manage(paths);

            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::backup::list_backups,
            commands::backup::create_backup,
            commands::backup::restore_backup,
            commands::cache::get_cache_stats,
            commands::cache::clear_cache,
            commands::diagnostics::export_diagnostics_to_path,
            commands::launch::preview_launch,
            commands::launch::launch_tool,
            commands::launch_history::list_launch_history,
            commands::launch_history::clear_launch_history,
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
