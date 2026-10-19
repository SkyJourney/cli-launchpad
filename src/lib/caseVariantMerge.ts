// Merging file documents whose paths differ only by letter case (PD-10). Pure functions: the
// host asks the backend for file identities and decides which variants may go. The rules are
// the ones the Rust reference (`workspace_layout_case_merge.rs`) holds, and both read the
// scenarios in `contracts/path-key/case-merge-cases.json`.
import { pathKeyOf, type PathSemantics } from "./pathKey";
import {
  listWorkspacePanes,
  remapWorkspaceFileIds,
  removeWorkspaceContentFromPane,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import type { WorkspaceFileDocument, WorkspacePaneContentRef } from "./tauri";

export interface CaseMergeInput {
  documents: WorkspaceFileDocument[];
  tree: WorkspaceNode;
  detachedContents: WorkspacePaneContentRef[];
}

export interface CaseMergeGroup {
  directoryId: number;
  /** The document that stays: the first one the layout shows. */
  canonicalId: string;
  variantIds: string[];
}

/** The document ids among some workspace contents (panes, detached, window-owned). */
export function fileDocumentIdsOf(
  contents: readonly WorkspacePaneContentRef[],
): string[] {
  return contents.flatMap((content) =>
    content.kind === "file" ? [content.documentId] : [],
  );
}

/** Ids of the file documents shown in some pane of the tree. */
export function listPlacedFileIds(tree: WorkspaceNode): Set<string> {
  const placed = new Set<string>();
  for (const pane of listWorkspacePanes(tree)) {
    for (const content of pane.contents) {
      if (content.kind === "file") placed.add(content.documentId);
    }
  }
  return placed;
}

/** Document ids in the order the layout shows them, then whatever only the list holds. */
function firstSeenOrder(input: CaseMergeInput): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const note = (content: WorkspacePaneContentRef) => {
    if (content.kind === "file" && !seen.has(content.documentId)) {
      seen.add(content.documentId);
      order.push(content.documentId);
    }
  };
  for (const pane of listWorkspacePanes(input.tree)) {
    pane.contents.forEach(note);
  }
  input.detachedContents.forEach(note);
  for (const document of input.documents) {
    if (!seen.has(document.id)) {
      seen.add(document.id);
      order.push(document.id);
    }
  }
  return order;
}

/**
 * Candidate groups: documents of one project whose key is the same under `insensitive`
 * semantics. Projects that are `sensitive` or `unknown` never form a group. The caller still
 * has to confirm each variant against the canonical file before merging it.
 */
export function findCaseVariantGroups(
  input: CaseMergeInput,
  semanticsOf: (directoryId: number) => PathSemantics,
): CaseMergeGroup[] {
  const byId = new Map(
    input.documents.map((document) => [document.id, document]),
  );
  const groups: Array<CaseMergeGroup & { key: string }> = [];
  for (const id of firstSeenOrder(input)) {
    const document = byId.get(id);
    if (!document) continue;
    const semantics = semanticsOf(document.directoryId);
    if (semantics.case !== "insensitive") continue;
    const key = pathKeyOf(document.relativePath, semantics);
    const group = groups.find(
      (candidate) =>
        candidate.directoryId === document.directoryId && candidate.key === key,
    );
    if (group) {
      group.variantIds.push(id);
    } else {
      groups.push({
        directoryId: document.directoryId,
        key,
        canonicalId: id,
        variantIds: [],
      });
    }
  }
  return groups
    .filter((group) => group.variantIds.length > 0)
    .map(({ directoryId, canonicalId, variantIds }) => ({
      directoryId,
      canonicalId,
      variantIds,
    }));
}

/**
 * Rewrites every reference of a merged variant to its canonical document, keeps a file only in
 * the first pane that shows it (a removed active tab hands over to its neighbour), drops detached
 * duplicates and removes the variant documents. A group with a variant in `skipVariantIds`
 * (for example one with unsaved edits) is left whole. Nothing to merge returns the input
 * objects unchanged.
 */
export function applyCaseVariantMerge(
  input: CaseMergeInput,
  groups: readonly CaseMergeGroup[],
  skipVariantIds: ReadonlySet<string>,
): CaseMergeInput & { merged: CaseMergeGroup[] } {
  const merged = groups.filter(
    (group) =>
      group.variantIds.length > 0 &&
      !group.variantIds.some((id) => skipVariantIds.has(id)),
  );
  if (merged.length === 0) return { ...input, merged: [] };

  const idMap = new Map<string, string>();
  for (const group of merged) {
    for (const variantId of group.variantIds) {
      idMap.set(variantId, group.canonicalId);
    }
  }

  let tree = remapWorkspaceFileIds(input.tree, idMap);
  const shown = new Set<string>();
  for (const pane of listWorkspacePanes(tree)) {
    for (const content of pane.contents) {
      if (content.kind !== "file") continue;
      if (shown.has(content.documentId)) {
        tree = removeWorkspaceContentFromPane(tree, pane.id, content);
      } else {
        shown.add(content.documentId);
      }
    }
  }

  const detachedContents: WorkspacePaneContentRef[] = [];
  for (const content of input.detachedContents) {
    const mapped: WorkspacePaneContentRef =
      content.kind === "file"
        ? {
            ...content,
            documentId: idMap.get(content.documentId) ?? content.documentId,
          }
        : content;
    if (mapped.kind === "file") {
      if (shown.has(mapped.documentId)) continue;
      shown.add(mapped.documentId);
    }
    detachedContents.push(mapped);
  }

  return {
    tree,
    detachedContents,
    documents: input.documents.filter((document) => !idMap.has(document.id)),
    merged,
  };
}
