use tauri::State;

use crate::db::app_setting_repo;
use crate::models::app_setting::CloseBehavior;
use crate::{update_close_behavior_state, with_conn, AppError, CloseBehaviorState, Db};

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
