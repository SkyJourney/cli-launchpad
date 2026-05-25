use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    #[default]
    MinimizeToTray,
    Quit,
}

impl CloseBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MinimizeToTray => "minimize_to_tray",
            Self::Quit => "quit",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "minimize_to_tray" => Some(Self::MinimizeToTray),
            "quit" => Some(Self::Quit),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CloseBehavior;

    #[test]
    fn parse_accepts_supported_close_behaviors() {
        assert_eq!(
            CloseBehavior::parse("minimize_to_tray"),
            Some(CloseBehavior::MinimizeToTray)
        );
        assert_eq!(CloseBehavior::parse("quit"), Some(CloseBehavior::Quit));
        assert_eq!(CloseBehavior::parse("unknown"), None);
    }
}
