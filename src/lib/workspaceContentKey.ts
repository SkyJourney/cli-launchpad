import type { WorkspacePaneContentRef } from "./tauri";

export type PtyContentRef = { kind: "pty"; slotId: string };
export type FileContentRef = { kind: "file"; documentId: string };
export type ManagedContentRef = PtyContentRef | FileContentRef;

/** The only place that spells out the shape of a PTY content reference. */
export function ptyContentRef(slotId: string): PtyContentRef {
  return { kind: "pty", slotId };
}

/** The only place that spells out the shape of a file content reference. */
export function fileContentRef(documentId: string): FileContentRef {
  return { kind: "file", documentId };
}

export function workspaceContentKey(content: WorkspacePaneContentRef): string {
  if (content.kind === "pty") return `pty:${content.slotId}`;
  if (content.kind === "file") return `file:${content.documentId}`;
  return `unknown:${content.originalKind}:${stableJson(content.raw)}`;
}

export function ptyContentKey(slotId: string): string {
  return workspaceContentKey(ptyContentRef(slotId));
}

export function fileContentKey(documentId: string): string {
  return workspaceContentKey(fileContentRef(documentId));
}

/** Inverse of workspaceContentKey for draggable content; unknown content has no inverse. */
export function contentRefFromKey(key: string): ManagedContentRef | null {
  const match = /^(pty|file):(.+)$/.exec(key);
  if (!match || match[2].length > 200) return null;
  return match[1] === "pty"
    ? ptyContentRef(match[2])
    : fileContentRef(match[2]);
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
