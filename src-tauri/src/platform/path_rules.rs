use anyhow::{bail, Result};

pub fn validate_component(component: &str) -> Result<()> {
    if component.is_empty() || component == "." || component == ".." || component.contains('/') {
        bail!("文件名不是有效的路径组件");
    }
    #[cfg(windows)]
    validate_windows_component(component)?;
    Ok(())
}

pub fn validate_entry_name(name: &str) -> Result<()> {
    validate_component(name)
}

#[cfg(windows)]
fn validate_windows_component(component: &str) -> Result<()> {
    if component.ends_with(['.', ' '])
        || component.chars().any(|character| {
            character.is_control()
                || matches!(character, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*')
        })
    {
        bail!("文件名包含 Windows 不允许的字符");
    }
    let device_stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(['.', ' '])
        .to_ascii_uppercase();
    let reserved = matches!(
        device_stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        device_stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(suffix, "¹" | "²" | "³")
                || (suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
        })
    });
    if reserved {
        bail!("文件名与 Windows 保留设备名冲突");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn unix_allows_colon_and_backslash_as_filename_characters() {
        assert!(validate_entry_name("report:final").is_ok());
        assert!(validate_entry_name(r"folder\name").is_ok());
        assert!(validate_entry_name("项目文档").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_ads_reserved_names_and_trailing_dots() {
        assert!(validate_entry_name("note.txt").is_ok());
        assert!(validate_entry_name("note:stream").is_err());
        assert!(validate_entry_name("CON.txt").is_err());
        assert!(validate_entry_name("CONIN$.txt").is_err());
        assert!(validate_entry_name("CONOUT$.txt").is_err());
        assert!(validate_entry_name("COM¹.log").is_err());
        assert!(validate_entry_name("LPT³.log").is_err());
        assert!(validate_entry_name("name.").is_err());
        assert!(validate_entry_name("name ").is_err());
    }

    #[test]
    fn rejects_path_separators_and_dot_components() {
        assert!(validate_entry_name("").is_err());
        assert!(validate_entry_name(".").is_err());
        assert!(validate_entry_name("..").is_err());
        assert!(validate_entry_name("nested/name").is_err());
    }
}
