use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{bail, Result};

use crate::models::window_kind::{window_kind_of, WindowKind};
use crate::services::project_directory::ProjectDirectory;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentWindowFileGrant {
    pub directory_id: i64,
    pub directory_path: String,
    pub relative_path: String,
}

#[derive(Default)]
pub struct ContentWindowGrantRegistry {
    grants: Mutex<HashMap<String, ContentWindowFileGrant>>,
}

impl ContentWindowGrantRegistry {
    pub fn grant(&self, label: &str, grant: ContentWindowFileGrant) -> Result<()> {
        if window_kind_of(label) != Some(WindowKind::WorkspaceContent) {
            bail!("文件授权目标不是已登记的内容窗口");
        }
        ProjectDirectory::validate_relative_path(&grant.relative_path)?;
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?;
        match grants.entry(label.to_string()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(grant);
                Ok(())
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                bail!("内容窗口已有文件授权")
            }
        }
    }

    pub fn get(&self, label: &str) -> Result<ContentWindowFileGrant> {
        if window_kind_of(label) != Some(WindowKind::WorkspaceContent) {
            bail!("调用窗口不是已登记的内容窗口");
        }
        self.grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?
            .get(label)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("文件窗口没有文件授权"))
    }

    pub fn revoke(&self, label: &str) -> Result<bool> {
        Ok(self
            .grants
            .lock()
            .map_err(|_| anyhow::anyhow!("内容窗口授权表锁中毒"))?
            .remove(label)
            .is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST_LABEL: &str = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";
    const SECOND_LABEL: &str = "workspace-content-11111111-2222-4333-8444-555555555555";

    fn grant(relative_path: &str) -> ContentWindowFileGrant {
        ContentWindowFileGrant {
            directory_id: 7,
            directory_path: "C:/workspace".to_string(),
            relative_path: relative_path.to_string(),
        }
    }

    #[test]
    fn grants_only_registered_content_windows_and_one_relative_file() {
        let registry = ContentWindowGrantRegistry::default();

        assert!(registry.grant("main", grant("notes.md")).is_err());
        assert!(registry
            .grant("workspace-content-invalid", grant("notes.md"))
            .is_err());
        assert!(registry.grant(FIRST_LABEL, grant("../outside.md")).is_err());

        registry.grant(FIRST_LABEL, grant("notes.md")).unwrap();
        assert_eq!(registry.get(FIRST_LABEL).unwrap(), grant("notes.md"));
        assert!(registry.get(SECOND_LABEL).is_err());
    }

    #[test]
    fn revocation_is_scoped_to_the_exact_window_label() {
        let registry = ContentWindowGrantRegistry::default();
        registry.grant(FIRST_LABEL, grant("one.md")).unwrap();
        registry.grant(SECOND_LABEL, grant("two.md")).unwrap();

        assert!(registry.revoke(FIRST_LABEL).unwrap());
        assert!(registry.get(FIRST_LABEL).is_err());
        assert_eq!(registry.get(SECOND_LABEL).unwrap(), grant("two.md"));
        assert!(!registry.revoke(FIRST_LABEL).unwrap());
    }
}
