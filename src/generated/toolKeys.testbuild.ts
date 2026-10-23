// 测试构建变体：产品清单加测试夹具。仅由 vitest 别名引用，产品构建不引用。
// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/tool-keys.json 与 src/test/fixtures/tool-keys.json
export const REGISTERED_TOOL_KEYS = [
  "claude",
  "codex",
  "antigravity",
  "grok",
  "hermes",
] as const;

export type RegisteredToolKey = (typeof REGISTERED_TOOL_KEYS)[number];
