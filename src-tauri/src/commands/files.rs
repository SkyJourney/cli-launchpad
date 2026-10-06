use tauri::State;

use crate::services::file_service::{
    self, ProjectDirectoryListing, ProjectFileOpenResult, ProjectTextFileSaveResult,
};
use crate::services::project_directory::ProjectDirectory;
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub async fn list_project_files(
    state: State<'_, Db>,
    directory_id: i64,
    directory_path: String,
    relative_path: String,
) -> Result<ProjectDirectoryListing, AppError> {
    let root = project_directory(&state, directory_id, &directory_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::list_directory_in(&root, &relative_path)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件列表任务异常：{error}")))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn open_project_file(
    state: State<'_, Db>,
    directory_id: i64,
    directory_path: String,
    relative_path: String,
) -> Result<ProjectFileOpenResult, AppError> {
    let root = project_directory(&state, directory_id, &directory_path)?;
    tauri::async_runtime::spawn_blocking(move || file_service::open_file_in(&root, &relative_path))
        .await
        .map_err(|error| AppError::msg(format!("项目文件打开任务异常：{error}")))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn save_project_text_file(
    state: State<'_, Db>,
    directory_id: i64,
    directory_path: String,
    relative_path: String,
    content: String,
    expected_revision: String,
) -> Result<ProjectTextFileSaveResult, AppError> {
    let root = project_directory(&state, directory_id, &directory_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::save_text_file_in(&root, &relative_path, &content, &expected_revision)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件保存任务异常：{error}")))?
    .map_err(AppError::from)
}

fn project_directory(
    state: &State<'_, Db>,
    directory_id: i64,
    expected_path: &str,
) -> Result<ProjectDirectory, AppError> {
    with_conn(state, |connection| {
        ProjectDirectory::open_for(connection, directory_id, expected_path)
    })
}
