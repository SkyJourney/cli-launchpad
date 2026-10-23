// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/tool-keys.json
export const REGISTERED_TOOL_KEYS = [
  "claude",
  "codex",
  "antigravity",
  "grok",
  "hermes",
] as const;

export type RegisteredToolKey = (typeof REGISTERED_TOOL_KEYS)[number];
