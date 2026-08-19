use std::collections::HashSet;
use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
};

const MACHINE_ENVIRONMENT_KEY: &str =
    r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
const USER_ENVIRONMENT_KEY: &str = r"Environment";

/// Merge Windows' registered machine/user PATH entries into the process PATH.
/// Desktop launches normally have these entries already, while development or
/// sandbox parents can expose a deliberately reduced process environment.
pub fn merged_registered_path(current: Option<&OsStr>) -> Option<OsString> {
    let registered = [
        read_registry_string(HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT_KEY, "Path"),
        read_registry_string(HKEY_CURRENT_USER, USER_ENVIRONMENT_KEY, "Path"),
    ];
    merge_path_values(current, registered.iter().filter_map(Option::as_deref))
}

fn merge_path_values<'a>(
    current: Option<&OsStr>,
    registered: impl IntoIterator<Item = &'a str>,
) -> Option<OsString> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    if let Some(current) = current {
        append_unique_path_entries(&current.to_string_lossy(), &mut entries, &mut seen);
    }
    for value in registered {
        append_unique_path_entries(value, &mut entries, &mut seen);
    }

    (!entries.is_empty()).then(|| OsString::from(entries.join(";")))
}

fn append_unique_path_entries(value: &str, entries: &mut Vec<String>, seen: &mut HashSet<String>) {
    for entry in value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let identity = entry
            .trim_matches('"')
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase();
        if !identity.is_empty() && seen.insert(identity) {
            entries.push(entry.to_string());
        }
    }
}

fn read_registry_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
    let subkey = wide_null(subkey);
    let value = wide_null(value);
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut byte_len = 0_u32;
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value.as_ptr(),
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if status != 0 || byte_len < 2 {
        return None;
    }

    let mut buffer = vec![0_u16; (byte_len as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value.as_ptr(),
            flags,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast::<c_void>(),
            &mut byte_len,
        )
    };
    if status != 0 {
        return None;
    }

    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..length]))
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::merge_path_values;
    use std::ffi::OsStr;

    #[test]
    fn appends_registered_entries_missing_from_isolated_path() {
        let merged = merge_path_values(
            Some(OsStr::new(r"C:\Sandbox\bin;C:\Windows\System32")),
            [
                r"C:\Windows\System32;C:\Program Files\PowerShell\7",
                r"C:\Users\me\.bun\bin",
            ],
        )
        .unwrap();

        assert_eq!(
            merged.to_string_lossy(),
            r"C:\Sandbox\bin;C:\Windows\System32;C:\Program Files\PowerShell\7;C:\Users\me\.bun\bin"
        );
    }

    #[test]
    fn deduplicates_case_and_trailing_separators() {
        let merged = merge_path_values(
            Some(OsStr::new(r"C:\Tools\Bin\")),
            [r"c:\tools\bin;C:\Other"],
        )
        .unwrap();

        assert_eq!(merged.to_string_lossy(), r"C:\Tools\Bin\;C:\Other");
    }
}
