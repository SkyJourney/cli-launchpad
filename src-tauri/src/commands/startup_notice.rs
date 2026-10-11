use tauri::State;

use crate::models::window_kind::{CallerWindow, WindowKind};
use crate::services::startup_notices::{StartupNotice, StartupNotices};
use crate::AppError;

/// Pure in-memory take-and-clear, so a synchronous command is allowed (R-RS-1).
/// Only the main window's capability grants `allow-take-startup-notices`;
/// the caller check below is defense in depth.
#[tauri::command]
pub fn take_startup_notices(
    caller: CallerWindow,
    notices: State<'_, StartupNotices>,
) -> Result<Vec<StartupNotice>, AppError> {
    caller.require(&[WindowKind::Main])?;
    Ok(notices.take())
}
