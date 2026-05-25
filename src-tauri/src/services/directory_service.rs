use std::path::Path;

use anyhow::{bail, Result};

pub fn validate_path(path: &str) -> Result<()> {
    normalized_existing_path(path).map(|_| ())
}

pub fn normalized_existing_path(path: &str) -> Result<String> {
    let directory = Path::new(path);
    let normalized = normalized_configured_path(path)?;
    if !directory.exists() {
        bail!("项目目录不存在，请检查路径后重试");
    }
    if !directory.is_dir() {
        bail!("项目路径不是目录，请选择文件夹");
    }
    Ok(normalized)
}

/// Normalize configured project identity while retaining unavailable absolute
/// paths so imported configuration can be repaired after a checkout or move.
pub fn normalized_configured_path(path: &str) -> Result<String> {
    let directory = Path::new(path);
    if !directory.is_absolute() {
        bail!("项目目录必须使用绝对路径");
    }
    if directory.exists() {
        Ok(std::fs::canonicalize(directory)?.display().to_string())
    } else {
        Ok(directory.display().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn accepts_existing_directory() {
        let directory = tempdir().unwrap();
        assert!(normalized_existing_path(directory.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn rejects_missing_directory_and_file() {
        let directory = tempdir().unwrap();
        assert!(validate_path(directory.path().join("missing").to_str().unwrap()).is_err());
        let file = directory.path().join("file.txt");
        std::fs::write(&file, "data").unwrap();
        assert!(validate_path(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn rejects_relative_directory_paths() {
        assert!(normalized_existing_path(".").is_err());
        assert!(normalized_configured_path(".").is_err());
    }
}
