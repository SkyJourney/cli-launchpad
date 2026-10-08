mod app_menu;
mod commands;
#[cfg(test)]
mod contracts;
mod db;
mod error;
mod models;
mod platform;
mod services;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_window_state::{StateFlags, WindowExt};

pub use error::AppError;
use models::app_setting::CloseBehavior;

/// Business and cache databases are distinct managed-state types so commands
/// cannot accidentally read cache rows through the configuration connection.
#[derive(Clone)]
pub struct Db(pub Arc<Mutex<Connection>>);
#[derive(Clone)]
pub struct CacheDb(pub Arc<Mutex<Connection>>);
pub struct CloseBehaviorState(pub Mutex<CloseBehavior>);
pub struct TrayMenuLabelsState(
    pub  Mutex<
        Option<(
            tauri::menu::MenuItem<tauri::Wry>,
            tauri::menu::MenuItem<tauri::Wry>,
        )>,
    >,
);

impl Default for TrayMenuLabelsState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

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
    with_connection(state.inner(), f)
}

pub fn with_connection<T>(
    state: &Db,
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
    with_cache_connection(state.inner(), f)
}

pub fn with_cache_connection<T>(
    state: &CacheDb,
    f: impl FnOnce(&Connection) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let connection = state
        .0
        .lock()
        .map_err(|_| AppError::msg("缓存数据库连接锁中毒"))?;
    f(&connection)
}

pub fn run() {
    let builder = tauri::Builder::default()
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
            app.manage(Db(Arc::new(Mutex::new(connection))));
            app.manage(services::execution_service::ExecutionTaskManager::default());
            app.manage(services::pty_session_service::PtySessionManager::default());
            app.manage(services::content_window_grants::ContentWindowGrantRegistry::default());
            app.manage(services::app_lifecycle::AppExitGate::default());
            app.manage(CloseBehaviorState(Mutex::new(close_behavior)));
            app.manage(TrayMenuLabelsState::default());
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
            app.manage(CacheDb(Arc::new(Mutex::new(cache))));
            app.manage(paths);

            // 托盘创建失败不能让应用启动失败：降级后主窗口关闭一律走“退出”确认。
            let tray_availability =
                services::app_lifecycle::setup_tray_or_degrade(|| setup_tray(app.handle()));
            app.manage(tray_availability);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::backup::list_backups,
            commands::backup::create_backup,
            commands::backup::restore_backup,
            commands::cache::get_cache_stats,
            commands::cache::clear_cache,
            commands::diagnostics::export_diagnostics_to_path,
            commands::launch_history::list_launch_history,
            commands::launch_history::clear_launch_history,
            commands::launch_history::get_launch_history_limit,
            commands::launch_history::set_launch_history_limit,
            commands::session::list_sessions,
            commands::session::search_sessions,
            commands::session::refresh_session_search_index,
            commands::session::set_session_alias,
            commands::session::delete_session_alias,
            commands::pty_session::create_pty_session,
            commands::pty_session::begin_pty_handoff,
            commands::pty_session::stage_pty_handoff_snapshot,
            commands::pty_session::complete_pty_handoff,
            commands::pty_session::finalize_pty_handoff,
            commands::pty_session::cancel_pty_handoff,
            commands::pty_session::get_pty_session_window_status,
            commands::pty_session::reattach_pty_session,
            commands::pty_session::write_pty_session,
            commands::pty_session::resize_pty_session,
            commands::pty_session::acknowledge_pty_output,
            commands::pty_session::report_pty_frontend_stage,
            commands::pty_session::terminate_pty_session,
            commands::pty_session::confirm_app_exit,
            commands::directory::list_directories,
            commands::directory::add_directory,
            commands::directory::update_directory,
            commands::directory::remove_directory,
            commands::directory::set_directory_pinned,
            commands::directory::reorder_directories,
            commands::directory::open_project_directory,
            commands::files::list_project_files,
            commands::files::open_project_file,
            commands::files::save_project_text_file,
            commands::files::grant_content_window_file,
            commands::files::open_granted_file,
            commands::files::save_granted_text_file,
            commands::files::revoke_content_window_file,
            commands::files::list_project_file_cas_residues,
            commands::files::remove_project_file_cas_residue,
            commands::execution::start_execution_task,
            commands::execution::list_execution_tasks,
            commands::execution::get_execution_task,
            commands::execution::cancel_execution_task,
            commands::execution::clear_execution_task,
            commands::execution::clear_execution_history,
            commands::cli_status::detect_cli_status,
            commands::install::fetch_latest_version,
            commands::install::get_install_plan,
            commands::config::export_config_to_path,
            commands::config::import_config_from_path,
            commands::app_setting::get_close_behavior,
            commands::app_setting::set_close_behavior,
            commands::app_setting::set_tray_menu_labels,
            commands::workspace_layout::get_workspace_layout,
            commands::workspace_layout::save_workspace_layout,
            commands::workspace_layout::reset_workspace_layout,
            commands::workspace_layout::list_workspace_layout_presets,
            commands::workspace_layout::create_workspace_layout_preset,
            commands::workspace_layout::update_workspace_layout_preset,
            commands::workspace_layout::rename_workspace_layout_preset,
            commands::workspace_layout::delete_workspace_layout_preset,
            commands::workspace_layout::plan_apply_workspace_layout_preset,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let label = window.label();
                let grants =
                    window.state::<services::content_window_grants::ContentWindowGrantRegistry>();
                let sessions = window.state::<services::pty_session_service::PtySessionManager>();
                match services::app_lifecycle::cleanup_destroyed_window(label, &grants, &sessions) {
                    Ok(cleanup) => {
                        for session_id in cleanup.owner_lost_session_ids {
                            let _ = window.app_handle().emit_to(
                                "main",
                                "pty-session-owner-lost",
                                serde_json::json!({ "sessionId": session_id }),
                            );
                        }
                    }
                    Err(error) => {
                        log::warn!("unable to clean up destroyed window label={label}: {error}");
                    }
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_behavior = window
                    .state::<CloseBehaviorState>()
                    .0
                    .lock()
                    .map(|behavior| *behavior)
                    .unwrap_or_default();
                // 托管状态在 setup 结束前可能还不存在：按不可用处理（可以退出，
                // 比隐藏后找不回窗口更安全）。
                let tray = window
                    .try_state::<services::app_lifecycle::TrayAvailability>()
                    .map(|state| state.inner().clone())
                    .unwrap_or_else(|| services::app_lifecycle::TrayAvailability::Unavailable {
                        reason: "tray state not initialized".to_string(),
                    });
                match services::app_lifecycle::decide_close_request(
                    window.label(),
                    close_behavior,
                    &tray,
                ) {
                    services::app_lifecycle::MainCloseDecision::NotMainWindow => {}
                    services::app_lifecycle::MainCloseDecision::HideToTray => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    services::app_lifecycle::MainCloseDecision::RequestAppExit => {
                        api.prevent_close();
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .on_menu_event(|app, event| {
            if app_menu::route_app_menu_event(event.id().as_ref())
                == app_menu::AppMenuCommand::RequestExit
            {
                app_menu::request_app_exit(app);
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| app_menu::build_macos_menu(app));
    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build CLI Launchpad");
    app.run(handle_run_event);
}

fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let exit_gate = app.state::<services::app_lifecycle::AppExitGate>();
            let pty_count = app
                .state::<services::pty_session_service::PtySessionManager>()
                .active_count();
            let execution_task_count = app
                .state::<services::execution_service::ExecutionTaskManager>()
                .active_count();
            let main_window = app.get_webview_window("main");
            match services::app_lifecycle::decide_exit_request(
                &exit_gate,
                pty_count,
                execution_task_count,
                main_window.is_some(),
            ) {
                services::app_lifecycle::ExitRequestDecision::AllowExit => {}
                services::app_lifecycle::ExitRequestDecision::PreventAndAskMain {
                    pty_count,
                    execution_task_count,
                } => {
                    api.prevent_exit();
                    if let Some(window) = &main_window {
                        show_main_window(window);
                    }
                    let _ = app.emit_to(
                        "main",
                        "app-exit-requested",
                        serde_json::json!({
                            "ptyCount": pty_count,
                            "executionTaskCount": execution_task_count,
                        }),
                    );
                }
                services::app_lifecycle::ExitRequestDecision::PreventWithoutMain => {
                    api.prevent_exit();
                }
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
    {
        let labels = app.state::<TrayMenuLabelsState>();
        let mut current = labels
            .0
            .lock()
            .map_err(|_| tauri::Error::Anyhow(anyhow::anyhow!("tray menu labels lock poisoned")))?;
        *current = Some((show.clone(), quit.clone()));
    }

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
            "quit" => app_menu::request_app_exit(app),
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
