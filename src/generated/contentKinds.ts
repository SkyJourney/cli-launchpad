// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/content-kinds.json
export const REGISTERED_CONTENT_KINDS = [
  "pty",
  "file",
] as const;

export type RegisteredContentKind = (typeof REGISTERED_CONTENT_KINDS)[number];
