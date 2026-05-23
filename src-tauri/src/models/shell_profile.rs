use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShellProfile {
    pub id: i64,
    pub name: String,
    pub terminal_exe: String,
    pub shell_exe: String,
    pub shell_args: String,
    pub init_script: String,
    pub is_default: bool,
}

