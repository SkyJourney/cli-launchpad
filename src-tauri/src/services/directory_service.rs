use std::path::Path;

use anyhow::{bail, Result};

pub fn validate_path(path: &str) -> Result<()> {
    let directory = Path::new(path);
    if !directory.exists() {
        bail!("项目目录不存在，请检查路径后重试");
    }
    if !directory.is_dir() {
        bail!("项目路径不是目录，请选择文件夹");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn accepts_existing_directory() {
        let directory = tempdir().unwrap();
        assert!(validate_path(directory.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn rejects_missing_directory_and_file() {
        let directory = tempdir().unwrap();
        assert!(validate_path(directory.path().join("missing").to_str().unwrap()).is_err());
        let file = directory.path().join("file.txt");
        std::fs::write(&file, "data").unwrap();
        assert!(validate_path(file.to_str().unwrap()).is_err());
    }
}
