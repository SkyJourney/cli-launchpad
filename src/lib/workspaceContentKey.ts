import type { WorkspacePaneContentRef } from "./tauri";

export function workspaceContentKey(content: WorkspacePaneContentRef): string {
  if (content.kind === "pty") return `pty:${content.slotId}`;
  if (content.kind === "file") return `file:${content.documentId}`;
  return `unknown:${content.originalKind}:${stableJson(content.raw)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
