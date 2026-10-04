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
use tauri::{Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

pub use error::AppError;
use models::app_setting::CloseBehavior;

/// Business and cache databases are distinct managed-state types so commands
/// cannot accidentally read cache rows through the configuration connection.
pub struct Db(pub Mutex<Connection>);
pub struct CacheDb(pub Mutex<Connection>);
pub struct CloseBehaviorState(pub Mutex<CloseBehavior>);

fn persistent_window_state_flags() -> StateFlags {
    StateFlags::all().difference(StateFlags::VISIBLE | StateFlags::DECORATIONS)
}

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
        .plugin(tauri_plugin_clipboard_manager::init())
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
                    .level(log::LevelFilter::Info)
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
            let window_state_flags = persistent_window_state_flags();
            app.handle().plugin(
                tauri_plugin_window_state::Builder::default()
                    .skip_initial_state("main")
                    .with_state_flags(window_state_flags)
                    .build(),
            )?;
            if let Some(window) = app.get_webview_window("main") {
                // Window-state files written by older app versions can contain
                // `decorated: true`; enforce the Windows custom chrome before
                // restoring size and position so stale state cannot revive it.
                #[cfg(target_os = "windows")]
                if let Err(error) = window.set_decorations(false) {
                    log::warn!("unable to disable main window decorations: {error}");
                }

                // Restore explicitly after the storage migration and before applying
                // monitor bounds. The plugin's automatic restore runs on window-ready,
                // which would otherwise happen after this setup hook's bounds correction.
                if let Err(error) = window.restore_state(window_state_flags) {
                    log::warn!("unable to restore main window state: {error}");
                }
                #[cfg(target_os = "windows")]
                match window.is_decorated() {
                    Ok(false) => log::info!("main window native decorations are disabled"),
                    Ok(true) => log::error!("main window still has native decorations enabled"),
                    Err(error) => log::warn!("unable to verify main window decorations: {error}"),
                }
                let window_config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|config| config.label == "main");
                let min_width = window_config
                    .and_then(|config| config.min_width)
                    .unwrap_or(1.0);
                let min_height = window_config
                    .and_then(|config| config.min_height)
                    .unwrap_or(1.0);
                if let Err(error) = platform::window_geometry::constrain_restored_window(
                    &window, min_width, min_height,
                ) {
                    log::warn!("unable to constrain restored main window bounds: {error}");
                }
            }

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
            let ended_pty_sessions = db::pty_session_repo::mark_running_ended(
                &connection,
                services::execution_service::now_ms(),
            )?;
            if ended_pty_sessions != 0 {
                log::warn!("marked {ended_pty_sessions} stale PTY session(s) as ended");
            }
            let close_behavior = db::app_setting_repo::get_close_behavior(&connection)?;
            app.manage(Db(Mutex::new(connection)));
            app.manage(services::execution_service::ExecutionTaskManager::default());
            app.manage(services::pty_session_service::PtySessionManager::default());
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
            commands::launch_history::get_launch_history_limit,
            commands::launch_history::set_launch_history_limit,
            commands::session::list_sessions,
            commands::session::search_sessions,
            commands::session::refresh_session_search_index,
            commands::session::set_session_alias,
            commands::session::delete_session_alias,
            commands::session::resume_session,
            commands::pty_session::create_pty_session,
            commands::pty_session::begin_pty_handoff,
            commands::pty_session::stage_pty_handoff_snapshot,
            commands::pty_session::complete_pty_handoff,
            commands::pty_session::finalize_pty_handoff,
            commands::pty_session::cancel_pty_handoff,
            commands::pty_session::get_pty_session_window_status,
            commands::pty_session::write_pty_session,
            commands::pty_session::resize_pty_session,
            commands::pty_session::acknowledge_pty_output,
            commands::pty_session::report_pty_frontend_stage,
            commands::pty_session::terminate_pty_session,
            commands::pty_session::list_pty_sessions,
            commands::pty_session::confirm_pty_exit,
            commands::directory::list_directories,
            commands::directory::add_directory,
            commands::directory::update_directory,
            commands::directory::remove_directory,
            commands::directory::set_directory_pinned,
            commands::directory::reorder_directories,
            commands::directory::open_project_directory,
            commands::files::list_project_files,
            commands::files::read_project_text_file,
            commands::files::open_project_file,
            commands::files::save_project_text_file,
            commands::workspace_file_index::get_workspace_file_index,
            commands::execution::start_execution_task,
            commands::execution::list_execution_tasks,
            commands::execution::get_execution_task,
            commands::execution::cancel_execution_task,
            commands::execution::clear_execution_task,
            commands::execution::clear_execution_history,
            commands::cli_status::detect_cli_status,
            commands::install::fetch_latest_version,
            commands::install::get_install_plan,
            commands::terminal::detect_terminal_environment,
            commands::terminal::get_launch_target,
            commands::terminal::set_launch_target,
            commands::config::export_config_to_path,
            commands::config::import_config_from_path,
            commands::app_setting::get_close_behavior,
            commands::app_setting::set_close_behavior,
            commands::workspace_layout::get_workspace_layout,
            commands::workspace_layout::save_workspace_layout,
            commands::workspace_layout::reset_workspace_layout,
            commands::workspace_layout::list_workspace_layout_presets,
            commands::workspace_layout::get_workspace_layout_preset,
            commands::workspace_layout::create_workspace_layout_preset,
            commands::workspace_layout::update_workspace_layout_preset,
            commands::workspace_layout::rename_workspace_layout_preset,
            commands::workspace_layout::delete_workspace_layout_preset,
            commands::workspace_layout::plan_apply_workspace_layout_preset,
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
                } else {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build CLI Launchpad");
    app.run(handle_run_event);
}

fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let sessions = app.state::<services::pty_session_service::PtySessionManager>();
            if sessions.consume_exit_authorization() {
                return;
            }
            let active_count = sessions.active_count();
            if active_count > 0 {
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") {
                    show_main_window(&window);
                }
                let _ = app.emit("pty-exit-requested", active_count);
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                show_main_window(&window);
            }
        }
        _ => {}
    }
}

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
        .show_menu_on_left_click(true);
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
            "quit" => {
                if let Err(error) = app.save_window_state(persistent_window_state_flags()) {
                    log::warn!("unable to save main window state before tray exit: {error}");
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let is_visible = window.is_visible().unwrap_or(false);
                    let is_minimized = window.is_minimized().unwrap_or(false);
                    if is_visible && !is_minimized {
                        let _ = window.hide();
                    } else {
                        show_main_window(&window);
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}
