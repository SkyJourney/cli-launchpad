//! Home-directory lookup for code that reads the user's profile directory.

use std::ffi::OsString;
use std::path::PathBuf;

use anyhow::{anyhow, Result};

/// The user's home directory: `USERPROFILE`, then `HOME`.
pub fn home_dir() -> Result<PathBuf> {
    home_from(std::env::var_os("USERPROFILE"), std::env::var_os("HOME"))
}

fn home_from(userprofile: Option<OsString>, home: Option<OsString>) -> Result<PathBuf> {
    userprofile
        .or(home)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("无法确定用户主目录，不能读取会话历史"))
}

/// The POSIX home directory, read from `HOME` only.
#[cfg(not(windows))]
pub fn posix_home_dir() -> Option<PathBuf> {
    posix_home_from(std::env::var_os("HOME"))
}

#[cfg(any(not(windows), test))]
fn posix_home_from(home: Option<OsString>) -> Option<PathBuf> {
    home.map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn home_dir_prefers_userprofile_over_home() {
        assert_eq!(
            home_from(Some("C:\\Users\\a".into()), Some("/home/a".into())).unwrap(),
            PathBuf::from("C:\\Users\\a")
        );
        assert_eq!(
            home_from(None, Some("/home/a".into())).unwrap(),
            PathBuf::from("/home/a")
        );
        assert_eq!(
            home_from(Some("C:\\Users\\a".into()), None).unwrap(),
            PathBuf::from("C:\\Users\\a")
        );
    }

    #[test]
    fn home_dir_fails_with_a_clear_message_when_nothing_is_set() {
        let error = home_from(None, None).unwrap_err();
        assert_eq!(error.to_string(), "无法确定用户主目录，不能读取会话历史");
        // 反向：空字符串按已设置处理，与 std::env::var 的语义一致。
        assert!(home_from(Some("".into()), None).is_ok());
    }

    #[test]
    fn posix_home_dir_reads_home_only() {
        assert_eq!(
            posix_home_from(Some("/home/a".into())),
            Some(PathBuf::from("/home/a"))
        );
        assert_eq!(posix_home_from(None), None);
    }
}
