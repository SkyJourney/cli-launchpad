use tauri::{AppHandle, Runtime};
use tauri_plugin_window_state::AppHandleExt;

/// 自定义 Quit 菜单项 id；大小写敏感。
pub const APP_QUIT_MENU_ID: &str = "app.quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMenuCommand {
    RequestExit,
    Unhandled,
}

/// 全局菜单事件路由：只认 `app.quit`；托盘自己的 id（`quit`、`show`）与其他一律 Unhandled。
pub fn route_app_menu_event(menu_id: &str) -> AppMenuCommand {
    if menu_id == APP_QUIT_MENU_ID {
        AppMenuCommand::RequestExit
    } else {
        AppMenuCommand::Unhandled
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppMenuEntry {
    Predefined(&'static str),
    Custom {
        id: &'static str,
        accelerator: &'static str,
    },
    Separator,
}

/// 所有允许出现在 `Predefined(..)` 里的名称；`build_macos_menu` 必须能构造其中每一个。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const PREDEFINED_ENTRY_NAMES: &[&str] = &[
    "about",
    "services",
    "hide",
    "hide_others",
    "show_all",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "select_all",
];

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_app_submenu_entries() -> Vec<AppMenuEntry> {
    vec![
        AppMenuEntry::Predefined("about"),
        AppMenuEntry::Separator,
        AppMenuEntry::Predefined("services"),
        AppMenuEntry::Separator,
        AppMenuEntry::Predefined("hide"),
        AppMenuEntry::Predefined("hide_others"),
        AppMenuEntry::Predefined("show_all"),
        AppMenuEntry::Separator,
        AppMenuEntry::Custom {
            id: APP_QUIT_MENU_ID,
            accelerator: "CmdOrCtrl+Q",
        },
    ]
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_edit_submenu_entries() -> Vec<AppMenuEntry> {
    vec![
        AppMenuEntry::Predefined("undo"),
        AppMenuEntry::Predefined("redo"),
        AppMenuEntry::Separator,
        AppMenuEntry::Predefined("cut"),
        AppMenuEntry::Predefined("copy"),
        AppMenuEntry::Predefined("paste"),
        AppMenuEntry::Predefined("select_all"),
    ]
}

/// 保存窗口状态后退出：`app.exit(0)` 产生可阻止的 `ExitRequested`，由 `handle_run_event` 接入 `AppExitGate`。
/// 托盘“退出”与 macOS 应用菜单的 Quit 共用。
pub fn request_app_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.save_window_state(crate::persistent_window_state_flags()) {
        log::warn!("unable to save main window state before exit request: {error}");
    }
    app.exit(0);
}

#[cfg(target_os = "macos")]
pub use macos_menu::build_macos_menu;

/// macOS 专属：只在 macOS 编译，运行期证据是 H-1 的实机项 M-08。
#[cfg(target_os = "macos")]
mod macos_menu {
    use tauri::menu::{
        AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
    };
    use tauri::{AppHandle, Runtime};

    use super::{
        macos_app_submenu_entries, macos_edit_submenu_entries, AppMenuEntry, PREDEFINED_ENTRY_NAMES,
    };

    /// macOS 自定义 Quit 菜单项的显示文案（应用菜单没有前端同步通道，暂不翻译）。
    const APP_QUIT_MENU_LABEL: &str = "Quit CLI Launchpad";

    fn predefined_item<R: Runtime>(
        app: &AppHandle<R>,
        name: &str,
        about: &AboutMetadata<'_>,
    ) -> tauri::Result<PredefinedMenuItem<R>> {
        // 名称表是唯一来源：不在表里的名称在这里就拒绝，表里的每个名称都必须能在下面构造。
        if !PREDEFINED_ENTRY_NAMES.contains(&name) {
            return Err(tauri::Error::Anyhow(anyhow::anyhow!(
                "unknown predefined menu item {name}"
            )));
        }
        match name {
            "about" => PredefinedMenuItem::about(app, None, Some(about.clone())),
            "services" => PredefinedMenuItem::services(app, None),
            "hide" => PredefinedMenuItem::hide(app, None),
            "hide_others" => PredefinedMenuItem::hide_others(app, None),
            "show_all" => PredefinedMenuItem::show_all(app, None),
            "undo" => PredefinedMenuItem::undo(app, None),
            "redo" => PredefinedMenuItem::redo(app, None),
            "cut" => PredefinedMenuItem::cut(app, None),
            "copy" => PredefinedMenuItem::copy(app, None),
            "paste" => PredefinedMenuItem::paste(app, None),
            "select_all" => PredefinedMenuItem::select_all(app, None),
            other => Err(tauri::Error::Anyhow(anyhow::anyhow!(
                "unknown predefined menu item {other}"
            ))),
        }
    }

    fn build_items<R: Runtime>(
        app: &AppHandle<R>,
        entries: &[AppMenuEntry],
        about: &AboutMetadata<'_>,
    ) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
        entries
            .iter()
            .map(|entry| -> tauri::Result<Box<dyn IsMenuItem<R>>> {
                Ok(match entry {
                    AppMenuEntry::Predefined(name) => Box::new(predefined_item(app, name, about)?),
                    AppMenuEntry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                    AppMenuEntry::Custom { id, accelerator } => Box::new(MenuItem::with_id(
                        app,
                        *id,
                        APP_QUIT_MENU_LABEL,
                        true,
                        Some(*accelerator),
                    )?),
                })
            })
            .collect()
    }

    fn submenu<R: Runtime>(
        app: &AppHandle<R>,
        title: &str,
        items: &[Box<dyn IsMenuItem<R>>],
    ) -> tauri::Result<Submenu<R>> {
        let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|item| item.as_ref()).collect();
        Submenu::with_items(app, title, true, &refs)
    }

    /// 与 tauri 默认菜单的差别只有：应用子菜单去掉系统 Quit、新增 Show All、末尾加自定义 Quit。
    /// 保留 Edit 子菜单，否则 WebView 的复制粘贴快捷键失效。
    pub fn build_macos_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        let package_info = app.package_info();
        let config = app.config();
        let about = AboutMetadata {
            name: Some(package_info.name.clone()),
            version: Some(package_info.version.to_string()),
            copyright: config.bundle.copyright.clone(),
            authors: config
                .bundle
                .publisher
                .clone()
                .map(|publisher| vec![publisher]),
            ..Default::default()
        };

        let app_items = build_items(app, &macos_app_submenu_entries(), &about)?;
        let app_menu = submenu(app, &package_info.name, &app_items)?;
        let file_menu = Submenu::with_items(
            app,
            "File",
            true,
            &[&PredefinedMenuItem::close_window(app, None)?],
        )?;
        let edit_items = build_items(app, &macos_edit_submenu_entries(), &about)?;
        let edit_menu = submenu(app, "Edit", &edit_items)?;
        let view_menu = Submenu::with_items(
            app,
            "View",
            true,
            &[&PredefinedMenuItem::fullscreen(app, None)?],
        )?;
        // 带 WINDOW_SUBMENU_ID：tauri 据此把它注册为 NSApp 的窗口菜单，macOS 才会自动列出打开的窗口。
        let window_menu = Submenu::with_id_and_items(
            app,
            WINDOW_SUBMENU_ID,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ],
        )?;

        Menu::with_items(
            app,
            &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIB_RS: &str = include_str!("lib.rs");

    #[test]
    fn custom_quit_menu_item_requests_gated_exit() {
        assert_eq!(APP_QUIT_MENU_ID, "app.quit");
        assert_eq!(
            route_app_menu_event(APP_QUIT_MENU_ID),
            AppMenuCommand::RequestExit
        );
        // 大小写与空白敏感，且不吞托盘自己的 id。
        for other in ["quit", "show", "", "APP.QUIT", "app.quit "] {
            assert_eq!(
                route_app_menu_event(other),
                AppMenuCommand::Unhandled,
                "{other:?} must not be routed to the gated exit"
            );
        }

        let start = LIB_RS.find("pub fn run()").unwrap();
        let end = LIB_RS.find("fn handle_run_event").unwrap();
        let run_body = &LIB_RS[start..end];
        assert!(run_body.contains(".on_menu_event("));
        assert!(run_body.contains("app_menu::route_app_menu_event"));
        let macos_cfg = run_body.find("#[cfg(target_os = \"macos\")]").unwrap();
        assert!(run_body[macos_cfg..].contains("app_menu::build_macos_menu"));
        // 检索串用 concat! 拼接，避免本文件自己命中“不得出现系统 Quit”的 grep 门禁。
        assert!(!LIB_RS.contains(concat!("PredefinedMenuItem", "::quit")));
        // 全局菜单处理器与托盘各一处。
        assert!(LIB_RS.matches("app_menu::request_app_exit").count() >= 2);
    }

    #[test]
    fn macos_app_menu_entries_replace_predefined_quit() {
        let app = macos_app_submenu_entries();
        assert!(!app.contains(&AppMenuEntry::Predefined("quit")));
        let custom_count = app
            .iter()
            .filter(|entry| matches!(entry, AppMenuEntry::Custom { .. }))
            .count();
        assert_eq!(custom_count, 1);
        let quit = AppMenuEntry::Custom {
            id: APP_QUIT_MENU_ID,
            accelerator: "CmdOrCtrl+Q",
        };
        assert!(app.contains(&quit));
        assert_eq!(app.last(), Some(&quit));
        for name in ["hide", "hide_others", "show_all", "about"] {
            assert!(
                app.contains(&AppMenuEntry::Predefined(name)),
                "application submenu keeps {name}"
            );
        }

        let edit = macos_edit_submenu_entries();
        for name in ["undo", "redo", "cut", "copy", "paste", "select_all"] {
            assert!(
                edit.contains(&AppMenuEntry::Predefined(name)),
                "edit submenu keeps {name} so WebView shortcuts keep working"
            );
        }
        assert!(!edit
            .iter()
            .any(|entry| matches!(entry, AppMenuEntry::Custom { .. })));
    }

    #[test]
    fn predefined_entries_are_all_constructible_names() {
        let app = macos_app_submenu_entries();
        let edit = macos_edit_submenu_entries();
        let used: Vec<&str> = app
            .iter()
            .chain(edit.iter())
            .filter_map(|entry| match entry {
                AppMenuEntry::Predefined(name) => Some(*name),
                _ => None,
            })
            .collect();

        for name in &used {
            assert!(
                PREDEFINED_ENTRY_NAMES.contains(name),
                "{name} is not a constructible predefined entry"
            );
        }
        let mut unique = PREDEFINED_ENTRY_NAMES.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), PREDEFINED_ENTRY_NAMES.len());
        for name in PREDEFINED_ENTRY_NAMES {
            assert!(used.contains(name), "{name} is never used by a submenu");
        }
        assert!(!PREDEFINED_ENTRY_NAMES.contains(&"quit"));
    }

    #[test]
    fn custom_menu_ids_are_unique_and_not_tray_ids() {
        let mut ids: Vec<&str> = macos_app_submenu_entries()
            .into_iter()
            .chain(macos_edit_submenu_entries())
            .filter_map(|entry| match entry {
                AppMenuEntry::Custom { id, .. } => Some(id),
                _ => None,
            })
            .collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "custom menu ids must be unique");
        for tray_id in ["quit", "show"] {
            assert!(
                !ids.contains(&tray_id),
                "{tray_id} is reserved for the tray"
            );
        }
    }
}
