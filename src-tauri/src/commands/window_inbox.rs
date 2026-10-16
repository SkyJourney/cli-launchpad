use std::sync::Arc;

use tauri::{ipc::Channel, State};

use crate::models::window_kind::{CallerWindow, WindowKind};
use crate::services::window_inbox::{InboxMessage, WindowInboxRegistry, WindowInboxSubscription};
use crate::AppError;

/// Installs the calling window's private inbox channel and flushes what was buffered before it
/// subscribed. Only the main window has an inbox in this layer (m6-061); the caller's identity
/// comes from the webview that invoked the command, never from a payload.
#[tauri::command]
pub async fn subscribe_window_inbox(
    caller: CallerWindow,
    registry: State<'_, WindowInboxRegistry>,
    on_event: Channel<InboxMessage>,
) -> Result<WindowInboxSubscription, AppError> {
    caller.require(&[WindowKind::Main])?;
    registry.subscribe(caller.label(), Arc::new(on_event))
}
