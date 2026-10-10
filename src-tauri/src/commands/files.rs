use tauri::{State, WebviewWindow};

use crate::models::window_kind::{window_kind_of, WindowKind};
use crate::services::content_window_grants::{ContentWindowFileGrant, ContentWindowGrantRegistry};
use crate::services::file_service::{
    self, ProjectDirectoryListing, ProjectFileCasResidue, ProjectFileCasResidueListing,
    ProjectFileOpenResult, ProjectTextFileSaveResult,
};
use crate::services::project_directory::ProjectDirectory;
use crate::{blocking, blocking_unbounded, budgets, AppError, Db};

fn ensure_main_window(label: &str) -> Result<(), AppError> {
    if label == "main" {
        Ok(())
    } else {
        Err(AppError::msg("只有主窗口可以管理文件窗口授权"))
    }
}

/// Database stage (`Db::call`, no filesystem) followed by the filesystem
/// stage (`blocking`, no database lock): path snapshot comparison and open.
async fn open_project(
    db: &Db,
    directory_id: i64,
    expected_path: String,
) -> Result<ProjectDirectory, AppError> {
    let directory = db
        .call("project.lookup", move |connection| {
            ProjectDirectory::lookup(connection, directory_id)
        })
        .await?;
    blocking("project.open", budgets::PROJECT_DIRECTORY, move || {
        ProjectDirectory::open_snapshot(&directory.path, &expected_path)
    })
    .await
}

#[tauri::command]
pub async fn list_project_files(
    state: State<'_, Db>,
    directory_id: i64,
    directory_path: String,
    relative_path: String,
) -> Result<ProjectDirectoryListing, AppError> {
    let root = open_project(&state, directory_id, directory_path).await?;
    blocking("project_files.list", budgets::FILE_OPERATION, move || {
        file_service::list_directory_in(&root, &relative_path).map_err(AppError::from)
    })
    .await
}

#[tauri::command]
pub async fn open_project_file(
    state: State<'_, Db>,
    directory_id: i64,
    directory_path: String,
    relative_path: String,
) -> Result<ProjectFileOpenResult, AppError> {
    let root = open_project(&state, directory_id, directory_path).await?;
    blocking("project_files.open", budgets::FILE_OPERATION, move || {
        file_service::open_file_in(&root, &relative_path).map_err(AppError::from)
    })
    .await
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
    let root = open_project(&state, directory_id, directory_path).await?;
    // Writes are unbounded: a timed-out save may still land, see `blocking_unbounded`.
    blocking_unbounded("project_files.save", move || {
        file_service::save_text_file_in(&root, &relative_path, &content, &expected_revision)
            .map_err(AppError::from)
    })
    .await
}

#[tauri::command]
pub async fn grant_content_window_file(
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
    open_project(&state, directory_id, directory_path.clone()).await?;
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
    let root = open_project(&state, grant.directory_id, grant.directory_path.clone()).await?;
    blocking(
        "project_files.open_granted",
        budgets::FILE_OPERATION,
        move || file_service::open_file_in(&root, &grant.relative_path).map_err(AppError::from),
    )
    .await
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
    let root = open_project(&state, grant.directory_id, grant.directory_path.clone()).await?;
    // Writes are unbounded: a timed-out save may still land, see `blocking_unbounded`.
    blocking_unbounded("project_files.save_granted", move || {
        file_service::save_text_file_in(&root, &grant.relative_path, &content, &expected_revision)
            .map_err(AppError::from)
    })
    .await
}

// Pure in-memory registry operation: allowed to stay synchronous (R-RS-1).
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
    let root = open_project(&state, directory_id, directory_path).await?;
    blocking(
        "project_files.list_residues",
        budgets::FILE_OPERATION,
        move || file_service::list_file_cas_residues_in(&root).map_err(AppError::from),
    )
    .await
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
    let root = open_project(&state, directory_id, directory_path).await?;
    let residue = ProjectFileCasResidue {
        relative_path,
        size_bytes,
        modified_at_ms,
        file_identity,
    };
    // Deletion is a write: a timed-out removal may still complete, see `blocking_unbounded`.
    blocking_unbounded("project_files.remove_residue", move || {
        file_service::remove_file_cas_residue_in(&root, &residue).map_err(AppError::from)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::ensure_main_window;
    use super::open_project;
    use crate::{AppError, Db};
    use std::sync::{Arc, Mutex};

    #[test]
    fn only_main_window_can_manage_file_grants() {
        assert!(ensure_main_window("main").is_ok());
        assert!(
            ensure_main_window("workspace-content-8e783338-f464-4b10-b15e-b534748c6241").is_err()
        );
    }

    fn memory_db() -> Db {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::connection::apply_migrations(&connection).unwrap();
        Db(Arc::new(Mutex::new(connection)))
    }

    fn code_of(error: &AppError) -> String {
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn open_project_rejects_a_stale_path_snapshot_with_the_identity_changed_code() {
        let db = memory_db();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().display().to_string();
        let record = {
            let connection = db.0.lock().unwrap();
            crate::db::directory_repo::add(&connection, "project", &path, None).unwrap()
        };

        let error = match open_project(&db, record.id, "C:/another/project".to_string()).await {
            Ok(_) => panic!("a stale snapshot must be rejected"),
            Err(error) => error,
        };

        assert_eq!(code_of(&error), "project_identity_changed");
    }

    #[tokio::test]
    async fn open_project_opens_a_matching_directory() {
        let db = memory_db();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().display().to_string();
        let record = {
            let connection = db.0.lock().unwrap();
            crate::db::directory_repo::add(&connection, "project", &path, None).unwrap()
        };

        assert!(open_project(&db, record.id, path).await.is_ok());
    }

    #[tokio::test]
    async fn open_project_reports_a_missing_directory_as_not_found() {
        let db = memory_db();

        let error = match open_project(&db, 4242, "C:/project".to_string()).await {
            Ok(_) => panic!("a missing directory row must be reported"),
            Err(error) => error,
        };

        assert_eq!(code_of(&error), "file.not_found");
    }
}
