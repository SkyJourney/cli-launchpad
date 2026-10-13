import type { WorkspacePaneContentRef } from "./tauri";

export function workspaceContentKey(content: WorkspacePaneContentRef): string {
  if (content.kind === "pty") return `pty:${content.slotId}`;
  if (content.kind === "file") return `file:${content.documentId}`;
  return `unknown:${content.originalKind}:${stableJson(content.raw)}`;
}

type ManagedContentRef = Exclude<WorkspacePaneContentRef, { kind: "unknown" }>;

export function ptyContentKey(slotId: string): string {
  return workspaceContentKey({ kind: "pty", slotId });
}

export function fileContentKey(documentId: string): string {
  return workspaceContentKey({ kind: "file", documentId });
}

/** Inverse of workspaceContentKey for draggable content; unknown content has no inverse. */
export function contentRefFromKey(key: string): ManagedContentRef | null {
  const match = /^(pty|file):(.+)$/.exec(key);
  if (!match || match[2].length > 200) return null;
  return match[1] === "pty"
    ? { kind: "pty", slotId: match[2] }
    : { kind: "file", documentId: match[2] };
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
