use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use cap_std::ambient_authority;
use cap_std::fs::Dir;

/// A retained capability to one project directory. All paths accepted by this
/// type are validated project-relative paths and all filesystem operations are
/// performed through the retained directory handle.
pub struct ProjectDirectory {
    dir: Dir,
}

impl ProjectDirectory {
    pub fn open(root: &Path) -> Result<Self> {
        let dir =
            Dir::open_ambient_dir(root, ambient_authority()).context("项目目录不存在或无法访问")?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Dir {
        &self.dir
    }

    pub fn validate_relative_path(path: &str) -> Result<()> {
        if path.is_empty() {
            return Ok(());
        }
        if path.starts_with('/')
            || path.contains('\\')
            || path.contains(':')
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            bail!("文件路径必须是规范的项目内相对路径");
        }
        Ok(())
    }

    pub fn path(relative_path: &str) -> Result<PathBuf> {
        Self::validate_relative_path(relative_path)?;
        Ok(PathBuf::from(relative_path))
    }
}
