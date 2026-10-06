use tauri::{State, WebviewWindow};

use crate::db::app_setting_repo;
use crate::models::app_setting::CloseBehavior;
use crate::{
    update_close_behavior_state, with_conn, AppError, CloseBehaviorState, Db, TrayMenuLabelsState,
};

#[tauri::command]
pub fn get_close_behavior(state: State<'_, Db>) -> Result<CloseBehavior, AppError> {
    with_conn(&state, |conn| {
        Ok(app_setting_repo::get_close_behavior(conn)?)
    })
}

#[tauri::command]
pub fn set_close_behavior(
    state: State<'_, Db>,
    close_behavior_state: State<'_, CloseBehaviorState>,
    close_behavior: CloseBehavior,
) -> Result<(), AppError> {
    with_conn(&state, |conn| {
        Ok(app_setting_repo::set_close_behavior(conn, close_behavior)?)
    })?;
    update_close_behavior_state(&close_behavior_state, close_behavior)
}

#[tauri::command]
pub fn set_tray_menu_labels(
    window: WebviewWindow,
    state: State<'_, TrayMenuLabelsState>,
    show: String,
    quit: String,
) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(AppError::msg("只有主窗口可以更新托盘菜单文案"));
    }
    if show.trim().is_empty() || quit.trim().is_empty() || show.len() > 256 || quit.len() > 256 {
        return Err(AppError::msg("托盘菜单文案无效"));
    }

    let labels = state
        .0
        .lock()
        .map_err(|_| AppError::msg("托盘菜单状态锁中毒"))?;
    let (show_item, quit_item) = labels
        .as_ref()
        .ok_or_else(|| AppError::msg("托盘菜单尚未初始化"))?;
    show_item
        .set_text(show)
        .map_err(|error| AppError::msg(format!("更新托盘显示文案失败：{error}")))?;
    quit_item
        .set_text(quit)
        .map_err(|error| AppError::msg(format!("更新托盘退出文案失败：{error}")))?;
    Ok(())
}
