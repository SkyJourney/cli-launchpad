use std::sync::Arc;

use tauri::{ipc::Channel, State};

use crate::models::window_kind::{CallerWindow, WindowKind};
use crate::services::window_inbox::{InboxMessage, WindowInboxRegistry, WindowInboxSubscription};
use crate::services::window_relay::{self, SendWindowMessageResult};
use crate::AppError;

/// Installs the calling window's private inbox channel and flushes what was buffered before it
/// subscribed. Each window can only subscribe its own inbox: the caller's identity comes from
/// the webview that invoked the command, never from a payload.
#[tauri::command]
pub async fn subscribe_window_inbox(
    caller: CallerWindow,
    registry: State<'_, WindowInboxRegistry>,
    on_event: Channel<InboxMessage>,
) -> Result<WindowInboxSubscription, AppError> {
    caller.require(&[
        WindowKind::Main,
        WindowKind::Terminal,
        WindowKind::WorkspaceContent,
    ])?;
    registry.subscribe(caller.label(), Arc::new(on_event))
}

/// Relays one message to another window's inbox. The relay checks the message type against
/// `contracts/window-messages.json` and stamps the sender from the calling webview.
#[tauri::command]
pub async fn send_window_message(
    caller: CallerWindow,
    registry: State<'_, WindowInboxRegistry>,
    target: String,
    message_type: String,
    payload: serde_json::Value,
) -> Result<SendWindowMessageResult, AppError> {
    window_relay::relay(&registry, &caller, &target, &message_type, payload)
}
