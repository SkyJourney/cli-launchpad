use std::path::Path;

use tauri::State;

use crate::db::directory_repo;
use crate::services::file_service::{
    self, ProjectDirectoryListing, ProjectFileOpenResult, ProjectTextFile,
    ProjectTextFileSaveResult,
};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub async fn list_project_files(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
) -> Result<ProjectDirectoryListing, AppError> {
    let path = project_path(&state, directory_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::list_directory(Path::new(&path), &relative_path)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件列表任务异常：{error}")))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn read_project_text_file(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
) -> Result<ProjectTextFile, AppError> {
    let path = project_path(&state, directory_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::read_text_file(Path::new(&path), &relative_path)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件读取任务异常：{error}")))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn open_project_file(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
) -> Result<ProjectFileOpenResult, AppError> {
    let path = project_path(&state, directory_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::open_file(Path::new(&path), &relative_path)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件打开任务异常：{error}")))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn save_project_text_file(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
    content: String,
    expected_revision: String,
) -> Result<ProjectTextFileSaveResult, AppError> {
    let path = project_path(&state, directory_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::save_text_file(
            Path::new(&path),
            &relative_path,
            &content,
            &expected_revision,
        )
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件保存任务异常：{error}")))?
    .map_err(AppError::from)
}

fn project_path(state: &State<'_, Db>, directory_id: i64) -> Result<String, AppError> {
    with_conn(state, |connection| {
        let directory = directory_repo::get(connection, directory_id)?
            .ok_or_else(|| AppError::msg("项目目录不存在"))?;
        Ok(directory.path)
    })
}
