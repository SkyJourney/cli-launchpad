use anyhow::{bail, Result};

/// Rules shared by every platform.
pub(crate) fn common_component_violation(component: &str) -> Option<&'static str> {
    if component.is_empty() || component == "." || component == ".." || component.contains('/') {
        return Some("文件名不是有效的路径组件");
    }
    if component.chars().any(char::is_control) {
        return Some("文件名包含控制字符");
    }
    None
}

/// Windows file-name rules, compiled on every platform so that they can be
/// tested everywhere. Only `validate_component` applies them on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_component_violation(component: &str) -> Option<&'static str> {
    if component.ends_with(['.', ' '])
        || component.chars().any(|character| {
            character.is_control()
                || matches!(character, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*')
        })
    {
        return Some("文件名包含 Windows 不允许的字符");
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
                || (suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'0'..=b'9'))
        })
    });
    if reserved {
        return Some("文件名与 Windows 保留设备名冲突");
    }
    None
}

pub fn validate_component(component: &str) -> Result<()> {
    if let Some(message) = common_component_violation(component) {
        bail!(message);
    }
    #[cfg(windows)]
    if let Some(message) = windows_component_violation(component) {
        bail!(message);
    }
    Ok(())
}

pub fn validate_entry_name(name: &str) -> Result<()> {
    validate_component(name)
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

    #[test]
    fn windows_reserved_device_names_cover_com0_lpt0_and_superscripts() {
        let fixed = [
            "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM¹", "COM²", "COM³", "LPT¹",
            "LPT²", "LPT³",
        ];
        let names: Vec<String> = fixed
            .into_iter()
            .map(str::to_string)
            .chain((0..=9).map(|index| format!("COM{index}")))
            .chain((0..=9).map(|index| format!("LPT{index}")))
            .collect();
        for name in &names {
            for variant in [
                name.clone(),
                name.to_lowercase(),
                format!("{name}.txt"),
                format!("{name}.tar.gz"),
                format!("{name} .txt"),
            ] {
                assert_eq!(
                    windows_component_violation(&variant),
                    Some("文件名与 Windows 保留设备名冲突"),
                    "{variant} must be reserved on Windows"
                );
            }
        }
        for name in [
            "COM10",
            "LPT10",
            "CONSOLE",
            "AUXILIARY.txt",
            "COM",
            "com1x",
            "nul_file",
        ] {
            assert_eq!(
                windows_component_violation(name),
                None,
                "{name} is not a reserved device name"
            );
        }
        #[cfg(windows)]
        {
            assert!(validate_entry_name("COM0.txt").is_err());
            assert!(validate_entry_name("LPT0").is_err());
        }
    }

    #[test]
    fn windows_component_violation_rejects_forbidden_characters_trailing_dots_and_controls() {
        for character in ['<', '>', ':', '"', '\\', '|', '?', '*'] {
            assert_eq!(
                windows_component_violation(&format!("a{character}b")),
                Some("文件名包含 Windows 不允许的字符"),
                "{character} is forbidden in Windows file names"
            );
        }
        for name in ["a.", "a ", "a\u{1}b"] {
            assert_eq!(
                windows_component_violation(name),
                Some("文件名包含 Windows 不允许的字符"),
                "{name:?} is forbidden in Windows file names"
            );
        }
        for name in [
            "note.txt",
            "项目文档",
            "report-final",
            "a b.txt",
            "résumé.md",
        ] {
            assert_eq!(windows_component_violation(name), None, "{name} is valid");
        }
    }

    #[test]
    fn control_characters_are_rejected_on_every_platform() {
        for name in ["a\nb", "a\tb", "a\u{7f}b", "\u{85}x", "\0"] {
            assert_eq!(
                common_component_violation(name),
                Some("文件名包含控制字符"),
                "{name:?} contains a control character"
            );
        }
        for name in ["", ".", "..", "a/b"] {
            assert_eq!(
                common_component_violation(name),
                Some("文件名不是有效的路径组件"),
                "{name:?} is not a valid path component"
            );
        }
        for name in ["note.txt", "项目文档", "report:final", "folder\\name"] {
            assert_eq!(common_component_violation(name), None, "{name} is valid");
        }
        assert!(validate_component("a\nb").is_err());
        assert!(validate_entry_name("tab\tname").is_err());
    }
}
