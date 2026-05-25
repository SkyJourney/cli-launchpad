use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::Result;

pub fn replace_file(destination: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = sibling_suffix(destination, ".writing");
    let previous = sibling_suffix(destination, ".previous");
    let _ = fs::remove_file(&temporary);
    fs::write(&temporary, bytes)?;
    OpenOptions::new()
        .write(true)
        .open(&temporary)?
        .sync_all()?;

    commit_replacement(destination, &temporary, &previous)
}

fn sibling_suffix(destination: &Path, suffix: &str) -> PathBuf {
    let mut result = destination.as_os_str().to_os_string();
    result.push(suffix);
    PathBuf::from(result)
}

#[cfg(windows)]
fn commit_replacement(destination: &Path, temporary: &Path, previous: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        fs::rename(temporary, destination)?;
        return Ok(());
    }

    let _ = fs::remove_file(previous);
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let destination_wide = wide(destination);
    let temporary_wide = wide(temporary);
    let previous_wide = wide(previous);
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            previous_wide.as_ptr(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let _ = fs::remove_file(previous);
    Ok(())
}

#[cfg(not(windows))]
fn commit_replacement(destination: &Path, temporary: &Path, _previous: &Path) -> Result<()> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn replaces_existing_file_with_complete_payload() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("export.json");
        fs::write(&destination, "old").unwrap();
        replace_file(&destination, b"new").unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "new");
    }

    #[test]
    fn temporary_path_keeps_original_extension_identity() {
        let json = Path::new("report.json");
        let text = Path::new("report.txt");
        assert_ne!(
            sibling_suffix(json, ".writing"),
            sibling_suffix(text, ".writing")
        );
    }
}
