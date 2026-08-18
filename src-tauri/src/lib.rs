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
use tauri::{Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_window_state::StateFlags;

pub use error::AppError;
use models::app_setting::CloseBehavior;

/// Business and cache databases are distinct managed-state types so commands
/// cannot accidentally read cache rows through the configuration connection.
pub struct Db(pub Mutex<Connection>);
pub struct CacheDb(pub Mutex<Connection>);
pub struct CloseBehaviorState(pub Mutex<CloseBehavior>);

pub fn update_close_behavior_state(
    state: &State<'_, CloseBehaviorState>,
    close_behavior: CloseBehavior,
) -> Result<(), AppError> {
    let mut current = state
        .0
        .lock()
        .map_err(|_| AppError::msg("关闭行为状态锁中毒"))?;
    *current = close_behavior;
    Ok(())
}

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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_main_window(&window);
            }
        }))
        // Native file/folder picker for the add-directory flow.
        .plugin(tauri_plugin_dialog::init())
        // Open trusted external links with the operating system's default app.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = services::storage_service::prepare(app.handle())
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            #[cfg(target_os = "macos")]
            match platform::macos_launch_artifacts::cleanup_stale(&paths.cache_dir) {
                Ok(removed) if removed > 0 => {
                    log::info!("removed {removed} stale macOS launch artifact(s)")
                }
                Ok(_) => {}
                Err(error) => log::warn!("unable to prune macOS launch artifacts: {error}"),
            }
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
            // on the first launch under the stable Tauri identifier. Visibility
            // is deliberately excluded: closing to tray must not hide the next launch.
            app.handle().plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(StateFlags::all().difference(StateFlags::VISIBLE))
                    .build(),
            )?;

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
            let interrupted = db::execution_task_repo::mark_unfinished_interrupted(
                &connection,
                services::execution_service::now_ms(),
            )?;
            if interrupted != 0 {
                log::warn!("marked {interrupted} unfinished execution task(s) as interrupted");
            }
            let close_behavior = db::app_setting_repo::get_close_behavior(&connection)?;
            app.manage(Db(Mutex::new(connection)));
            app.manage(services::execution_service::ExecutionTaskManager::default());
            app.manage(commands::terminal::TerminalEnvironmentCache::default());
            app.manage(CloseBehaviorState(Mutex::new(close_behavior)));
            let cache = match db::cache_connection::init_cache(&paths.cache_dir.join("cache.db")) {
                Ok(cache) => cache,
                Err(error) => {
                    log::warn!("persistent cache unavailable; using memory cache error={error}");
                    db::cache_connection::init_ephemeral_cache()
                        .map_err(|fallback| anyhow::anyhow!(fallback.to_string()))?
                }
            };
            services::cache_service::remove_prefix(&cache, "sessions:")
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
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
            commands::session::set_session_alias,
            commands::session::delete_session_alias,
            commands::session::resume_session,
            commands::model::get_model_catalog,
            commands::directory::list_directories,
            commands::directory::add_directory,
            commands::directory::update_directory,
            commands::directory::remove_directory,
            commands::directory::set_directory_pinned,
            commands::directory::open_project_directory,
            commands::execution::start_execution_task,
            commands::execution::list_execution_tasks,
            commands::execution::get_execution_task,
            commands::execution::cancel_execution_task,
            commands::execution::clear_execution_task,
            commands::execution::clear_execution_history,
            commands::tool::list_tools,
            commands::tool::save_tool_global_args_batch,
            commands::cli_status::detect_cli_status,
            commands::install::fetch_latest_versions,
            commands::install::get_install_plan,
            commands::terminal::detect_terminal_environment,
            commands::terminal::get_launch_target,
            commands::terminal::set_launch_target,
            commands::tool_args::get_directory_tool_args,
            commands::tool_args::save_directory_tool_args_batch,
            commands::config::export_config_to_path,
            commands::config::import_config_from_path,
            commands::app_setting::get_close_behavior,
            commands::app_setting::set_close_behavior,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_behavior = window
                    .state::<CloseBehaviorState>()
                    .0
                    .lock()
                    .map(|behavior| *behavior)
                    .unwrap_or_default();
                if close_behavior == CloseBehavior::MinimizeToTray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build CLI Launchpad");
    app.run(handle_run_event);
}

#[cfg(target_os = "macos")]
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Reopen { .. } = event {
        if let Some(window) = app.get_webview_window("main") {
            show_main_window(&window);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn handle_run_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {}

fn show_main_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
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
            if let TrayIconEvent::DoubleClick {
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
