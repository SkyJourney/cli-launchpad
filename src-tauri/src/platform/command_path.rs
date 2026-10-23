pub fn quote_command_path(path: &str) -> String {
    if path.chars().any(char::is_whitespace) {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_command_path_quotes_only_paths_with_whitespace() {
        assert_eq!(quote_command_path("plain"), "plain");
        assert_eq!(
            quote_command_path("/usr/local/bin/hermes"),
            "/usr/local/bin/hermes"
        );
        assert_eq!(
            quote_command_path("C:\\Program Files\\x\\cli.exe"),
            "\"C:\\Program Files\\x\\cli.exe\""
        );
        assert_eq!(quote_command_path("a b\"c"), "\"a b\\\"c\"");
    }
}
