import {
  listWorkspacePanes,
  removeWorkspaceFileFromPane,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import type { WorkspaceFileDocument } from "./tauri";
import type { WorkspaceFileBuffer } from "./workspaceFileBuffer";

export interface WorkspaceFileCloseState {
  tree: WorkspaceNode;
  documents: WorkspaceFileDocument[];
  buffers: Record<string, WorkspaceFileBuffer>;
}

export function closeWorkspaceFileState(
  state: WorkspaceFileCloseState,
  requestedDocumentIds: string[],
): WorkspaceFileCloseState & { closedDocumentIds: string[] } {
  const requested = new Set(requestedDocumentIds);
  const closedDocumentIds = state.documents
    .filter((document) => requested.has(document.id))
    .map((document) => document.id);
  if (closedDocumentIds.length === 0) {
    return { ...state, closedDocumentIds };
  }

  const closed = new Set(closedDocumentIds);
  const tree = listWorkspacePanes(state.tree).reduce(
    (current, pane) =>
      closedDocumentIds.reduce(
        (updated, documentId) =>
          removeWorkspaceFileFromPane(updated, pane.id, documentId),
        current,
      ),
    state.tree,
  );
  const documents = state.documents.filter(
    (document) => !closed.has(document.id),
  );
  const buffers = { ...state.buffers };
  closedDocumentIds.forEach((documentId) => delete buffers[documentId]);

  return { tree, documents, buffers, closedDocumentIds };
}
