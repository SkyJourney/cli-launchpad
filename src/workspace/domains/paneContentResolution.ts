import type { PtyWorkspaceSlot } from "../../components/WorkspacePtySessionRegistry";
import type { WorkspaceFileDocument, WorkspacePaneContentRef } from "../../lib/tauri";

/**
 * Per-kind resolution of pane contents to the records the pane view shows. The lookups that depend
 * on a content kind live in the domain layer, so the pane view resolves contents without branching
 * on a kind of its own.
 */
export type ResolvedPaneContent =
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "pty" }>;
      slot: PtyWorkspaceSlot;
    }
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "file" }>;
      file: WorkspaceFileDocument;
    }
  | {
      content: Extract<WorkspacePaneContentRef, { kind: "unknown" }>;
    };

/** The session slot a content refers to; undefined for any other content. */
export function slotOf(
  content: WorkspacePaneContentRef,
  slots: readonly PtyWorkspaceSlot[],
): PtyWorkspaceSlot | undefined {
  if (content.kind !== "pty") return undefined;
  return slots.find((slot) => slot.instanceId === content.slotId);
}

/** The document a content refers to; undefined for any other content. */
export function fileOf(
  content: WorkspacePaneContentRef,
  fileDocuments: readonly WorkspaceFileDocument[],
): WorkspaceFileDocument | undefined {
  if (content.kind !== "file") return undefined;
  return fileDocuments.find((file) => file.id === content.documentId);
}

/**
 * Resolves one pane content for display. A session without a slot and a document that is detached
 * into its own window are not shown in the pane.
 */
export function resolvePaneContent(
  content: WorkspacePaneContentRef,
  context: {
    slots: readonly PtyWorkspaceSlot[];
    fileDocuments: readonly WorkspaceFileDocument[];
    isDetachedContent: (content: WorkspacePaneContentRef) => boolean;
  },
): ResolvedPaneContent[] {
  if (content.kind === "unknown") return [{ content }];
  if (content.kind === "pty") {
    const slot = slotOf(content, context.slots);
    return slot ? [{ content, slot }] : [];
  }
  const file = fileOf(content, context.fileDocuments);
  return file && !context.isDetachedContent(content) ? [{ content, file }] : [];
}

/** The title of a tab: file tabs show the file name, not the relative path. */
export function displayTitleOf(
  content: WorkspacePaneContentRef,
  title: string,
): string | undefined {
  return content.kind === "file" ? title.split(/[\\/]/).pop() : title;
}

/** The document id of the pane's active content, when that content is a document. */
export function activeDocumentIdOf(pane: {
  activeContent?: WorkspacePaneContentRef | null;
}): string | null {
  const active = pane.activeContent;
  return active?.kind === "file" ? active.documentId : null;
}
