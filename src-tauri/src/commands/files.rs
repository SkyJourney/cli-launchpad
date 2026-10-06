use tauri::{State, WebviewWindow};

use crate::models::window_kind::{window_kind_of, WindowKind};
use crate::services::content_window_grants::{ContentWindowFileGrant, ContentWindowGrantRegistry};
use crate::services::file_service::{
    self, ProjectDirectoryListing, ProjectFileCasResidue, ProjectFileCasResidueListing,
    ProjectFileOpenResult, ProjectTextFileSaveResult,
};
use crate::services::project_directory::ProjectDirectory;
use crate::{with_conn, AppError, Db};

fn ensure_main_window(label: &str) -> Result<(), AppError> {
    if label == "main" {
        Ok(())
    } else {
        Err(AppError::msg("只有主窗口可以管理文件窗口授权"))
    }
}

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

#[tauri::command]
pub fn grant_content_window_file(
    caller: WebviewWindow,
    state: State<'_, Db>,
    grants: State<'_, ContentWindowGrantRegistry>,
    target_label: String,
    directory_id: i64,
    directory_path: String,
    relative_path: String,
) -> Result<(), AppError> {
    ensure_main_window(caller.label())?;
    if relative_path.is_empty() {
        return Err(AppError::msg("文件授权必须指向一个项目内文件"));
    }
    let _root = project_directory(&state, directory_id, &directory_path)?;
    grants
        .grant(
            &target_label,
            ContentWindowFileGrant {
                directory_id,
                directory_path,
                relative_path,
            },
        )
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn open_granted_file(
    caller: WebviewWindow,
    state: State<'_, Db>,
    grants: State<'_, ContentWindowGrantRegistry>,
) -> Result<ProjectFileOpenResult, AppError> {
    let grant = grants.get(caller.label()).map_err(AppError::from)?;
    let root = project_directory(&state, grant.directory_id, &grant.directory_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::open_file_in(&root, &grant.relative_path)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件打开任务异常：{error}")))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn save_granted_text_file(
    caller: WebviewWindow,
    state: State<'_, Db>,
    grants: State<'_, ContentWindowGrantRegistry>,
    content: String,
    expected_revision: String,
) -> Result<ProjectTextFileSaveResult, AppError> {
    let grant = grants.get(caller.label()).map_err(AppError::from)?;
    let root = project_directory(&state, grant.directory_id, &grant.directory_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_service::save_text_file_in(&root, &grant.relative_path, &content, &expected_revision)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目文件保存任务异常：{error}")))?
    .map_err(AppError::from)
}

#[tauri::command]
pub fn revoke_content_window_file(
    caller: WebviewWindow,
    grants: State<'_, ContentWindowGrantRegistry>,
    target_label: String,
) -> Result<bool, AppError> {
    ensure_main_window(caller.label())?;
    if window_kind_of(&target_label) != Some(WindowKind::WorkspaceContent) {
        return Err(AppError::msg("撤销目标不是已登记的内容窗口"));
    }
    grants.revoke(&target_label).map_err(AppError::from)
}

#[tauri::command]
pub async fn list_project_file_cas_residues(
    state: State<'_, Db>,
    directory_id: i64,
    directory_path: String,
) -> Result<ProjectFileCasResidueListing, AppError> {
    let root = project_directory(&state, directory_id, &directory_path)?;
    tauri::async_runtime::spawn_blocking(move || file_service::list_file_cas_residues_in(&root))
        .await
        .map_err(|error| AppError::msg(format!("项目临时文件扫描任务异常：{error}")))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn remove_project_file_cas_residue(
    state: State<'_, Db>,
    directory_id: i64,
    directory_path: String,
    relative_path: String,
    size_bytes: u64,
    modified_at_ms: u64,
    file_identity: String,
) -> Result<(), AppError> {
    let root = project_directory(&state, directory_id, &directory_path)?;
    let residue = ProjectFileCasResidue {
        relative_path,
        size_bytes,
        modified_at_ms,
        file_identity,
    };
    tauri::async_runtime::spawn_blocking(move || {
        file_service::remove_file_cas_residue_in(&root, &residue)
    })
    .await
    .map_err(|error| AppError::msg(format!("项目临时文件清理任务异常：{error}")))?
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

#[cfg(test)]
mod tests {
    use super::ensure_main_window;

    #[test]
    fn only_main_window_can_manage_file_grants() {
        assert!(ensure_main_window("main").is_ok());
        assert!(
            ensure_main_window("workspace-content-8e783338-f464-4b10-b15e-b534748c6241").is_err()
        );
    }
}
