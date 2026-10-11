use std::ffi::OsString;
use std::path::{Component, Path};

use anyhow::{bail, Context, Result};
use cap_std::fs::Dir;

/// A retained parent directory capability plus an unresolved final name.
pub struct FileLocation {
    pub parent: Dir,
    pub name: OsString,
}

/// Walks `relative` one component at a time under `root`. Every intermediate
/// component must be a real directory (symbolic links and junctions are
/// refused). The final component is returned unresolved.
pub fn locate_nofollow(root: &Dir, relative: &Path) -> Result<FileLocation> {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_owned()),
            _ => bail!("文件路径必须是规范的项目内相对路径"),
        }
    }
    let name = parts.pop().context("文件路径不能为空")?;
    let mut current = root.try_clone()?;
    for part in parts {
        let metadata = current
            .symlink_metadata(&part)
            .context("项目路径不存在或无法访问")?;
        if metadata.file_type().is_symlink() {
            bail!(
                "项目路径包含符号链接，已拒绝访问：{}",
                part.to_string_lossy()
            );
        }
        if !metadata.is_dir() {
            bail!("项目路径的中间组件不是目录");
        }
        current = current
            .open_dir(&part)
            .context("项目路径不存在或无法访问")?;
    }
    Ok(FileLocation {
        parent: current,
        name,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use cap_std::ambient_authority;
    use cap_std::fs::Dir;

    use super::locate_nofollow;

    fn root() -> (tempfile::TempDir, Dir) {
        let root = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        (root, dir)
    }

    #[test]
    fn locate_returns_parent_handle_and_final_name_without_resolving_the_final_component() {
        let (root, dir) = root();
        fs::create_dir_all(root.path().join("sub")).unwrap();
        fs::write(root.path().join("sub/note.txt"), "inside").unwrap();

        let location = locate_nofollow(&dir, Path::new("sub/note.txt")).unwrap();

        assert_eq!(location.name.to_str(), Some("note.txt"));
        assert_eq!(
            location.parent.read_to_string("note.txt").unwrap(),
            "inside"
        );
        assert!(location.parent.symlink_metadata("sub").is_err());
    }

    #[test]
    fn locate_accepts_a_missing_final_component() {
        let (root, dir) = root();
        fs::create_dir(root.path().join("sub")).unwrap();

        let location = locate_nofollow(&dir, Path::new("sub/missing.txt")).unwrap();

        assert_eq!(location.name.to_str(), Some("missing.txt"));
        assert!(location.parent.symlink_metadata("missing.txt").is_err());
    }

    #[test]
    fn locate_rejects_a_missing_intermediate_directory() {
        let (_root, dir) = root();

        let error = match locate_nofollow(&dir, Path::new("nope/note.txt")) {
            Ok(_) => panic!("a missing intermediate directory must be rejected"),
            Err(error) => error,
        };

        assert!(format!("{error:#}").contains("项目路径不存在或无法访问"));
    }

    #[cfg(unix)]
    #[test]
    fn locate_rejects_a_symlink_intermediate_component() {
        let (root, dir) = root();
        fs::create_dir(root.path().join("real")).unwrap();
        fs::write(root.path().join("real/note.txt"), "x").unwrap();
        std::os::unix::fs::symlink(root.path().join("real"), root.path().join("link")).unwrap();

        let error = match locate_nofollow(&dir, Path::new("link/note.txt")) {
            Ok(_) => panic!("a symbolic link intermediate component must be rejected"),
            Err(error) => error,
        };

        assert!(format!("{error:#}").contains("项目路径包含符号链接，已拒绝访问：link"));
        assert!(locate_nofollow(&dir, Path::new("real/note.txt")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn locate_rejects_a_junction_intermediate_component() {
        let (root, dir) = root();
        fs::create_dir(root.path().join("real")).unwrap();
        fs::write(root.path().join("real/note.txt"), "x").unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.path().join("link"))
            .arg(root.path().join("real"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let error = match locate_nofollow(&dir, Path::new("link/note.txt")) {
            Ok(_) => panic!("a junction intermediate component must be rejected"),
            Err(error) => error,
        };

        assert!(format!("{error:#}").contains("项目路径包含符号链接，已拒绝访问：link"));
        assert!(locate_nofollow(&dir, Path::new("real/note.txt")).is_ok());
    }

    #[test]
    fn locate_rejects_a_file_used_as_a_directory() {
        let (root, dir) = root();
        fs::write(root.path().join("a.txt"), "a").unwrap();

        let error = match locate_nofollow(&dir, Path::new("a.txt/b")) {
            Ok(_) => panic!("a file used as a directory must be rejected"),
            Err(error) => error,
        };

        assert!(format!("{error:#}").contains("项目路径的中间组件不是目录"));
    }

    #[test]
    fn locate_rejects_empty_absolute_and_parent_traversal_paths() {
        let (_root, dir) = root();
        for path in ["", "/x", "../x", "a/../b", "."] {
            assert!(locate_nofollow(&dir, Path::new(path)).is_err(), "{path}");
        }
        let empty = match locate_nofollow(&dir, Path::new("")) {
            Ok(_) => panic!("an empty path must be rejected"),
            Err(error) => error,
        };
        assert!(format!("{empty:#}").contains("文件路径不能为空"));
        for path in ["/x", "../x", "a/../b", "."] {
            let error = match locate_nofollow(&dir, Path::new(path)) {
                Ok(_) => panic!("{path} must be rejected"),
                Err(error) => error,
            };
            assert!(
                format!("{error:#}").contains("文件路径必须是规范的项目内相对路径"),
                "{path}"
            );
        }
        #[cfg(windows)]
        assert!(locate_nofollow(&dir, Path::new("C:/x")).is_err());
        assert!(locate_nofollow(&dir, Path::new("a")).is_ok());
    }
}
