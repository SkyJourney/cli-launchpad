import type { WorkspaceFileDocument } from "./tauri";

export function droppedFileDocumentIds(
  previous: readonly WorkspaceFileDocument[],
  next: readonly WorkspaceFileDocument[],
): string[] {
  const kept = new Set(next.map((document) => document.id));
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const document of previous) {
    if (kept.has(document.id) || seen.has(document.id)) continue;
    seen.add(document.id);
    dropped.push(document.id);
  }
  return dropped;
}
