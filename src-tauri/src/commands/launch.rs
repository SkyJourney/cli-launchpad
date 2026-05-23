use crate::models::tool::ToolKey;
use crate::services::launch_service::LaunchService;

#[tauri::command]
pub fn preview_launch(directory_id: i64, tool_key: ToolKey) -> Result<String, String> {
    LaunchService::default()
        .preview(directory_id, tool_key)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn launch_tool(directory_id: i64, tool_key: ToolKey) -> Result<(), String> {
    LaunchService::default()
        .launch(directory_id, tool_key)
        .map_err(|error| error.to_string())
}

