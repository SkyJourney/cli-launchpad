// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/content-kinds.json
export const REGISTERED_CONTENT_KINDS = [
  "pty",
  "file",
] as const;

export type RegisteredContentKind = (typeof REGISTERED_CONTENT_KINDS)[number];

/** 每种内容引用里承载身份的字段名（JSON 布局中的字段）。 */
export const CONTENT_KIND_ID_FIELD = {
  pty: "slotId",
  file: "documentId",
} as const satisfies Record<RegisteredContentKind, string>;

/** 所有已登记内容的引用形状：`{ kind, <idField>: string }`，由契约派生。 */
export type RegisteredContentRef = {
  [Kind in RegisteredContentKind]: { kind: Kind } & Record<
    (typeof CONTENT_KIND_ID_FIELD)[Kind],
    string
  >;
}[RegisteredContentKind];
