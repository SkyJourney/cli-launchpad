// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/window-kinds.json
export const WINDOW_KIND_IDS = [
  "main",
  "terminal",
  "workspaceContent"
] as const;
export type WindowKind = (typeof WINDOW_KIND_IDS)[number];
