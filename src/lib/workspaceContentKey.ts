import {
  CONTENT_KIND_ID_FIELD,
  REGISTERED_CONTENT_KINDS,
  type RegisteredContentKind,
  type RegisteredContentRef,
} from "../generated/contentKinds";
import type { WorkspacePaneContentRef } from "./tauri";

export type PtyContentRef = Extract<RegisteredContentRef, { kind: "pty" }>;
export type FileContentRef = Extract<RegisteredContentRef, { kind: "file" }>;
export type ManagedContentRef = RegisteredContentRef;

/** The only place that spells out the shape of a PTY content reference. */
export function ptyContentRef(slotId: string): PtyContentRef {
  return { kind: "pty", slotId };
}

/** The only place that spells out the shape of a file content reference. */
export function fileContentRef(documentId: string): FileContentRef {
  return { kind: "file", documentId };
}

export function isRegisteredContentKind(
  kind: string,
): kind is RegisteredContentKind {
  return (REGISTERED_CONTENT_KINDS as readonly string[]).includes(kind);
}

/** The identity of a managed content reference, read through the contract's id field. */
export function contentIdOf(content: ManagedContentRef): string {
  const field: string = CONTENT_KIND_ID_FIELD[content.kind];
  return (content as unknown as Record<string, string>)[field];
}

export function workspaceContentKey(content: WorkspacePaneContentRef): string {
  if (content.kind === "unknown") {
    return `unknown:${content.originalKind}:${stableJson(content.raw)}`;
  }
  return `${content.kind}:${contentIdOf(content)}`;
}

export function ptyContentKey(slotId: string): string {
  return workspaceContentKey(ptyContentRef(slotId));
}

export function fileContentKey(documentId: string): string {
  return workspaceContentKey(fileContentRef(documentId));
}

/** Inverse of workspaceContentKey for draggable content; unknown content has no inverse. */
export function contentRefFromKey(key: string): ManagedContentRef | null {
  const match = /^([a-z][A-Za-z0-9]*):(.+)$/.exec(key);
  if (!match || match[2].length > 200) return null;
  const kind = match[1];
  if (!isRegisteredContentKind(kind)) return null;
  return {
    kind,
    [CONTENT_KIND_ID_FIELD[kind]]: match[2],
  } as ManagedContentRef;
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
