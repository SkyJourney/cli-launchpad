use serde::{Deserialize, Serialize};

use super::tool::ToolKey;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryToolArgs {
    pub directory_id: i64,
    pub tool_key: ToolKey,
    pub args: String,
}
