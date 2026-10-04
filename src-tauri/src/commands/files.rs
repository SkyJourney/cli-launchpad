use std::path::Path;

use tauri::State;

use crate::db::directory_repo;
use crate::services::file_service::{
    self, ProjectDirectoryListing, ProjectFileOpenResult, ProjectTextFile,
};
use crate::{with_conn, AppError, Db};

#[tauri::command]
pub fn list_project_files(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
) -> Result<ProjectDirectoryListing, AppError> {
    let path = project_path(&state, directory_id)?;
    Ok(file_service::list_directory(
        Path::new(&path),
        &relative_path,
    )?)
}

#[tauri::command]
pub fn read_project_text_file(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
) -> Result<ProjectTextFile, AppError> {
    let path = project_path(&state, directory_id)?;
    Ok(file_service::read_text_file(
        Path::new(&path),
        &relative_path,
    )?)
}

#[tauri::command]
pub fn open_project_file(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
) -> Result<ProjectFileOpenResult, AppError> {
    let path = project_path(&state, directory_id)?;
    Ok(file_service::open_file(Path::new(&path), &relative_path)?)
}

#[tauri::command]
pub fn save_project_text_file(
    state: State<'_, Db>,
    directory_id: i64,
    relative_path: String,
    content: String,
    expected_revision: String,
) -> Result<ProjectTextFile, AppError> {
    let path = project_path(&state, directory_id)?;
    Ok(file_service::save_text_file(
        Path::new(&path),
        &relative_path,
        &content,
        &expected_revision,
    )?)
}

fn project_path(state: &State<'_, Db>, directory_id: i64) -> Result<String, AppError> {
    with_conn(state, |connection| {
        let directory = directory_repo::get(connection, directory_id)?
            .ok_or_else(|| AppError::msg("项目目录不存在"))?;
        Ok(directory.path)
    })
}
