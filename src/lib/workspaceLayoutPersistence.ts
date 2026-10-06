import {
  listWorkspacePanes,
  placeContentExclusively,
  removeWorkspaceContentFromTree,
  removeWorkspaceSession,
  sameWorkspaceContent,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import {
  type WorkspaceLayoutApplyPlan,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutSaveResult,
  type WorkspaceLayoutSlot,
  type WorkspacePaneContentRef,
  type WorkspaceFileDocument,
  type WorkspaceSlotState,
  type WorkspaceSlotStateKind,
} from "./tauri";
import { workspaceContentKey } from "./workspaceContentKey";

export const WORKSPACE_LAYOUT_SCHEMA_VERSION = 5;

export interface WorkspaceRuntimeSnapshot {
  tree: WorkspaceNode;
  focusedPaneId: string;
  slots: WorkspaceLayoutSlot[];
  documents?: WorkspaceFileDocument[];
  detachedContents: WorkspacePaneContentRef[];
}

export interface RestoredWorkspaceSnapshot extends WorkspaceRuntimeSnapshot {
  slots: RestoredWorkspaceSlot[];
}

export type RestoredWorkspaceSlot = WorkspaceLayoutSlot & {
  restoredState: WorkspaceSlotStateKind;
};

export interface WorkspaceLayoutApplySnapshot extends WorkspaceRuntimeSnapshot {
  slots: (WorkspaceLayoutSlot & {
    restoredState?: WorkspaceSlotStateKind;
  })[];
}

export interface WorkspaceApplyStateVersion {
  tree: WorkspaceNode;
  slots: readonly unknown[];
  focusedPaneId: string;
  detachedContents: readonly WorkspacePaneContentRef[];
}

export function isWorkspaceApplyStateCurrent(
  expected: WorkspaceApplyStateVersion,
  current: WorkspaceApplyStateVersion,
): boolean {
  return (
    expected.tree === current.tree &&
    expected.slots === current.slots &&
    expected.focusedPaneId === current.focusedPaneId &&
    sameWorkspaceContentRefs(
      expected.detachedContents,
      current.detachedContents,
    )
  );
}

export function markWorkspaceSlotsRestored(
  slots: WorkspaceLayoutSlot[],
  slotStates: WorkspaceSlotState[],
): RestoredWorkspaceSlot[] {
  const statesById = new Map(
    slotStates.map((slotState) => [slotState.instanceId, slotState]),
  );

  return slots.map((slot) => {
    const state = statesById.get(slot.instanceId);
    const restoredState = state?.state;
    return {
      ...cloneWorkspaceSlot(slot),
      projectName: state?.currentProjectName ?? slot.projectName,
      restoredState:
        restoredState === "missingProject" ||
        restoredState === "projectIdentityMismatch" ||
        restoredState === "missingSession" ||
        restoredState === "sessionIdentityMismatch"
          ? restoredState
          : "ended",
    };
  });
}

export function removeEndedWorkspaceSlots(
  snapshot: RestoredWorkspaceSnapshot,
): RestoredWorkspaceSnapshot {
  const endedSlotIds = snapshot.slots
    .filter((slot) => slot.restoredState === "ended")
    .map((slot) => slot.instanceId);
  if (endedSlotIds.length === 0) return snapshot;

  let tree = snapshot.tree;
  for (const instanceId of endedSlotIds) {
    tree = removeWorkspaceSession(tree, instanceId);
  }

  return {
    ...snapshot,
    tree,
    slots: snapshot.slots.filter((slot) => slot.restoredState !== "ended"),
    detachedContents: snapshot.detachedContents.filter(
      (content) =>
        content.kind !== "pty" || !endedSlotIds.includes(content.slotId),
    ),
  };
}

export function createWorkspaceLayoutDocument(
  snapshot: WorkspaceRuntimeSnapshot,
): WorkspaceLayoutDocument {
  const document: WorkspaceLayoutDocument = {
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    tree: cloneWorkspaceNode(snapshot.tree),
    focusedPaneId: snapshot.focusedPaneId,
    slots: snapshot.slots.map(cloneWorkspaceSlot),
    documents: (snapshot.documents ?? []).map((document) => ({ ...document })),
    detachedContents: snapshot.detachedContents.map((content) => ({
      ...content,
    })),
  };
  validateWorkspaceLayoutDocument(document);
  return document;
}

export function restoreWorkspaceRuntimeSnapshot(
  sourceDocument: WorkspaceLayoutDocument,
): WorkspaceRuntimeSnapshot {
  const document = migrateWorkspaceLayoutDocument(sourceDocument);
  return {
    tree: cloneWorkspaceNode(document.tree),
    focusedPaneId: document.focusedPaneId,
    slots: document.slots.map(cloneWorkspaceSlot),
    documents: (document.documents ?? []).map((file) => ({ ...file })),
    detachedContents: document.detachedContents.map((content) => ({
      ...content,
    })),
  };
}

export function restoreWorkspaceLayoutApplyPlan(
  plan: WorkspaceLayoutApplyPlan,
): WorkspaceLayoutApplySnapshot {
  const snapshot = restoreWorkspaceRuntimeSnapshot(plan.layout);
  const detachedSlotIds = new Set(
    snapshot.detachedContents.flatMap((content) =>
      content.kind === "pty" ? [content.slotId] : [],
    ),
  );
  const statesById = new Map(
    plan.slotStates.map((slotState) => [slotState.instanceId, slotState]),
  );
  const endedIds = new Set<string>();
  const slots = snapshot.slots.flatMap((slot) => {
    const state = statesById.get(slot.instanceId);
    if (!state || state.state === "ended") {
      endedIds.add(slot.instanceId);
      return [];
    }

    const invalidState =
      state.state === "missingProject" ||
      state.state === "projectIdentityMismatch" ||
      state.state === "missingSession" ||
      state.state === "sessionIdentityMismatch";

    return [
      {
        ...cloneWorkspaceSlot(slot),
        projectName: state.currentProjectName ?? slot.projectName,
        ...(invalidState ? { restoredState: state.state } : {}),
      },
    ];
  });

  let tree = snapshot.tree;
  for (const instanceId of detachedSlotIds) {
    tree = removeWorkspaceSession(tree, instanceId);
  }
  for (const instanceId of endedIds) {
    tree = removeWorkspaceSession(tree, instanceId);
  }

  return {
    ...snapshot,
    tree,
    focusedPaneId: listWorkspacePanes(tree).some(
      (pane) => pane.id === snapshot.focusedPaneId,
    )
      ? snapshot.focusedPaneId
      : listWorkspacePanes(tree)[0].id,
    slots,
    detachedContents: snapshot.detachedContents.filter(
      (content) => content.kind !== "pty" || !endedIds.has(content.slotId),
    ),
  };
}

export function restoreCurrentWorkspaceFilesAfterPreset(input: {
  tree: WorkspaceNode;
  focusedPaneId: string;
  restoredDocuments: WorkspaceFileDocument[];
  currentDocuments: WorkspaceFileDocument[];
  detachedContents: WorkspacePaneContentRef[];
  currentlyDetachedContents: WorkspacePaneContentRef[];
  detachingContents: WorkspacePaneContentRef[];
}): {
  tree: WorkspaceNode;
  documents: WorkspaceFileDocument[];
  detachedContents: WorkspacePaneContentRef[];
} {
  let tree = input.tree;
  const documents = [...input.restoredDocuments];
  const restoredPaths = new Set(
    documents.map(
      (document) => `${document.directoryId}:${document.relativePath}`,
    ),
  );
  const currentDocumentByIdentity = new Map(
    input.currentDocuments.map((document) => [
      `${document.directoryId}:${document.relativePath}`,
      document,
    ]),
  );
  const currentlyDetached = input.currentlyDetachedContents;
  const firstPaneId = listWorkspacePanes(tree)[0].id;

  for (const document of input.currentDocuments) {
    const identity = `${document.directoryId}:${document.relativePath}`;
    const alreadyRestored = restoredPaths.has(identity);
    const canonicalDocument =
      currentDocumentByIdentity.get(identity) ?? document;
    if (!alreadyRestored) documents.push({ ...canonicalDocument });
    restoredPaths.add(identity);
    const content: WorkspacePaneContentRef = {
      kind: "file",
      documentId: canonicalDocument.id,
    };
    if (
      currentlyDetached.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      tree = removeWorkspaceContentFromTree(tree, content);
    } else if (
      input.detachingContents.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      tree = placeContentExclusively(tree, input.focusedPaneId, content);
    } else if (!alreadyRestored) {
      tree = placeContentExclusively(tree, firstPaneId, content);
    }
  }

  const detachedContents = [...input.detachedContents];
  for (const content of input.currentlyDetachedContents) {
    if (
      !detachedContents.some((candidate) =>
        sameWorkspaceContent(candidate, content),
      )
    ) {
      detachedContents.push({ ...content });
    }
  }
  for (const content of detachedContents) {
    if (content.kind === "file") {
      tree = removeWorkspaceContentFromTree(tree, content);
    }
  }
  for (const content of detachedContents) {
    if (content.kind !== "file") continue;
    const document =
      input.currentDocuments.find(
        (candidate) => candidate.id === content.documentId,
      ) ?? documents.find((candidate) => candidate.id === content.documentId);
    if (
      document &&
      !documents.some(
        (candidate) =>
          candidate.directoryId === document.directoryId &&
          candidate.relativePath === document.relativePath,
      )
    ) {
      documents.push({ ...document });
    }
  }

  return { tree, documents, detachedContents };
}

export function rehomeDetachedWorkspaceContents(
  snapshot: WorkspaceRuntimeSnapshot,
): WorkspaceRuntimeSnapshot {
  if (snapshot.detachedContents.length === 0) return snapshot;

  let tree = snapshot.tree;
  const firstPaneId = listWorkspacePanes(tree)[0].id;
  const focusedPaneId = listWorkspacePanes(tree).some(
    (pane) => pane.id === snapshot.focusedPaneId,
  )
    ? snapshot.focusedPaneId
    : firstPaneId;
  for (const content of snapshot.detachedContents) {
    tree = placeContentExclusively(
      tree,
      content.kind === "file" ? focusedPaneId : firstPaneId,
      content,
    );
  }

  return {
    ...snapshot,
    tree,
    focusedPaneId,
    detachedContents: [],
  };
}

export function cloneWorkspaceLayoutDocument(
  document: WorkspaceLayoutDocument,
): WorkspaceLayoutDocument {
  return {
    schemaVersion: document.schemaVersion,
    tree: cloneWorkspaceNode(document.tree),
    focusedPaneId: document.focusedPaneId,
    slots: document.slots.map(cloneWorkspaceSlot),
    documents: (document.documents ?? []).map((file) => ({ ...file })),
    detachedContents: document.detachedContents.map((content) => ({
      ...content,
    })),
  };
}

function cloneWorkspaceSlot(slot: WorkspaceLayoutSlot): WorkspaceLayoutSlot {
  return {
    ...slot,
    title: { ...slot.title },
  };
}

function cloneWorkspaceNode(node: WorkspaceNode): WorkspaceLayoutNode {
  if (node.kind === "pane") {
    return {
      kind: "pane",
      id: node.id,
      paneNumber: node.paneNumber,
      contents: node.contents.map((content) => ({ ...content })),
      activeContent: node.activeContent ? { ...node.activeContent } : null,
    };
  }

  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: cloneWorkspaceNode(node.first),
    second: cloneWorkspaceNode(node.second),
  };
}

function sameWorkspaceContentRefs(
  left: readonly WorkspacePaneContentRef[],
  right: readonly WorkspacePaneContentRef[],
): boolean {
  return (
    left.length === right.length &&
    left.every((content, index) => {
      const other = right[index];
      return workspaceContentKey(content) === workspaceContentKey(other);
    })
  );
}

export function migrateWorkspaceLayoutDocument(
  source: unknown,
): WorkspaceLayoutDocument {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Workspace layout must be an object");
  }
  const value = { ...(source as Record<string, unknown>) };
  if (value.schemaVersion === 3) {
    const legacySlotIds =
      value.detachedSlotIds === undefined ? [] : value.detachedSlotIds;
    if (
      !Array.isArray(legacySlotIds) ||
      legacySlotIds.some((slotId) => typeof slotId !== "string")
    ) {
      throw new Error("Legacy detached slot references are invalid");
    }
    value.detachedContents = [
      ...legacySlotIds.map((slotId) => ({ kind: "pty", slotId })),
    ];
    delete value.detachedSlotIds;
    value.schemaVersion = WORKSPACE_LAYOUT_SCHEMA_VERSION;
  } else if (value.schemaVersion === 4) {
    value.schemaVersion = WORKSPACE_LAYOUT_SCHEMA_VERSION;
  }
  if (value.schemaVersion !== WORKSPACE_LAYOUT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported workspace layout version: ${String(value.schemaVersion)}`,
    );
  }
  if (value.detachedContents === undefined) value.detachedContents = [];
  const document = value as unknown as WorkspaceLayoutDocument;
  validateWorkspaceLayoutDocument(document);
  return document;
}

export function validateWorkspaceLayoutDocument(
  document: WorkspaceLayoutDocument,
): void {
  if (document.schemaVersion !== WORKSPACE_LAYOUT_SCHEMA_VERSION) {
    throw new Error("Workspace layout version is invalid");
  }
  const slotIds = new Set(document.slots.map((slot) => slot.instanceId));
  const documentIds = new Set(document.documents.map((file) => file.id));
  if (!Array.isArray(document.detachedContents)) {
    throw new Error("Detached workspace contents are invalid");
  }
  if (
    slotIds.size !== document.slots.length ||
    documentIds.size !== document.documents.length
  ) {
    throw new Error("Workspace layout identities must be unique");
  }
  const referencedSlots = new Set<string>();
  const referencedDocuments = new Set<string>();
  const paneIds = new Set<string>();
  const visit = (node: WorkspaceLayoutDocument["tree"]): void => {
    if (node.kind === "split") {
      visit(node.first);
      visit(node.second);
      return;
    }
    paneIds.add(node.id);
    for (const content of node.contents) {
      if (content.kind === "unknown") continue;
      if (content.kind === "pty") {
        if (
          !slotIds.has(content.slotId) ||
          referencedSlots.has(content.slotId)
        ) {
          throw new Error("PTY content has missing or duplicate ownership");
        }
        referencedSlots.add(content.slotId);
      } else {
        if (
          !documentIds.has(content.documentId) ||
          referencedDocuments.has(content.documentId)
        ) {
          throw new Error("File content has missing or duplicate ownership");
        }
        referencedDocuments.add(content.documentId);
      }
    }
  };
  visit(document.tree);
  for (const content of document.detachedContents) {
    if (content.kind === "unknown") continue;
    if (content.kind === "pty") {
      if (!slotIds.has(content.slotId) || referencedSlots.has(content.slotId)) {
        throw new Error(
          "Detached PTY content has missing or duplicate ownership",
        );
      }
      referencedSlots.add(content.slotId);
    } else {
      if (
        !documentIds.has(content.documentId) ||
        referencedDocuments.has(content.documentId)
      ) {
        throw new Error(
          "Detached file content has missing or duplicate ownership",
        );
      }
      referencedDocuments.add(content.documentId);
    }
  }
  if (
    !paneIds.has(document.focusedPaneId) ||
    referencedSlots.size !== slotIds.size ||
    referencedDocuments.size !== documentIds.size
  ) {
    throw new Error("Workspace layout contains unowned content or focus");
  }
}

export class WorkspaceLayoutSaveQueue {
  private revision: number;
  private pending: WorkspaceLayoutDocument | null = null;
  private draining: Promise<void> | null = null;

  constructor(
    initialRevision: number,
    private readonly save: (
      revision: number,
      layout: WorkspaceLayoutDocument,
    ) => Promise<WorkspaceLayoutSaveResult>,
    private readonly onError: (error: unknown) => void,
    private readonly onSaved: () => void = () => undefined,
  ) {
    this.revision = Math.max(0, initialRevision);
  }

  enqueue(document: WorkspaceLayoutDocument): void {
    this.pending = cloneWorkspaceLayoutDocument(document);
    this.startDrain();
  }

  async flush(): Promise<void> {
    while (this.draining || this.pending) {
      if (!this.draining) this.startDrain();
      const currentDrain = this.draining;
      if (currentDrain) await currentDrain;
    }
  }

  private startDrain(): void {
    if (this.draining || !this.pending) return;

    const drain = this.drainQueue();
    this.draining = drain.finally(() => {
      this.draining = null;
      if (this.pending) this.startDrain();
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.pending) {
      const document = this.pending;
      this.pending = null;
      const revision = this.revision + 1;
      this.revision = revision;

      try {
        const result = await this.save(
          revision,
          cloneWorkspaceLayoutDocument(document),
        );
        this.revision = Math.max(this.revision, result.revision);
        if (result.saved) {
          try {
            this.onSaved();
          } catch {
            // A UI status callback must not interfere with the save queue.
          }
        }
        if (!result.saved && !this.pending) this.pending = document;
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          // Error reporting must not stop workspace interaction or later saves.
        }
      }
    }
  }
}
