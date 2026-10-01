import {
  listWorkspacePanes,
  removeWorkspaceSession,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import {
  type WorkspaceLayoutApplyPlan,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutSaveResult,
  type WorkspaceLayoutSlot,
  type WorkspaceSlotState,
  type WorkspaceSlotStateKind,
} from "./tauri";

export const WORKSPACE_LAYOUT_SCHEMA_VERSION = 1;

export interface WorkspaceRuntimeSnapshot {
  tree: WorkspaceNode;
  focusedPaneId: string;
  slots: WorkspaceLayoutSlot[];
  detachedSlotIds: string[];
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
  detachedSlotIds: ReadonlySet<string>;
}

export function isWorkspaceApplyStateCurrent(
  expected: WorkspaceApplyStateVersion,
  current: WorkspaceApplyStateVersion,
): boolean {
  return (
    expected.tree === current.tree &&
    expected.slots === current.slots &&
    expected.focusedPaneId === current.focusedPaneId &&
    expected.detachedSlotIds === current.detachedSlotIds
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
    detachedSlotIds: snapshot.detachedSlotIds.filter(
      (instanceId) => !endedSlotIds.includes(instanceId),
    ),
  };
}

export function createWorkspaceLayoutDocument(
  snapshot: WorkspaceRuntimeSnapshot,
): WorkspaceLayoutDocument {
  return {
    schemaVersion: WORKSPACE_LAYOUT_SCHEMA_VERSION,
    tree: cloneWorkspaceNode(snapshot.tree),
    focusedPaneId: snapshot.focusedPaneId,
    slots: snapshot.slots.map(cloneWorkspaceSlot),
    detachedSlotIds: [...snapshot.detachedSlotIds],
  };
}

export function restoreWorkspaceRuntimeSnapshot(
  document: WorkspaceLayoutDocument,
): WorkspaceRuntimeSnapshot {
  return {
    tree: cloneWorkspaceNode(document.tree),
    focusedPaneId: document.focusedPaneId,
    slots: document.slots.map(cloneWorkspaceSlot),
    detachedSlotIds: [...document.detachedSlotIds],
  };
}

export function restoreWorkspaceLayoutApplyPlan(
  plan: WorkspaceLayoutApplyPlan,
): WorkspaceLayoutApplySnapshot {
  const snapshot = restoreWorkspaceRuntimeSnapshot(plan.layout);
  const detachedIds = new Set(snapshot.detachedSlotIds);
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
  for (const instanceId of detachedIds) {
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
    detachedSlotIds: snapshot.detachedSlotIds.filter(
      (instanceId) => !endedIds.has(instanceId),
    ),
  };
}

export function rehomeDetachedWorkspaceSlots(
  snapshot: WorkspaceRuntimeSnapshot,
): WorkspaceRuntimeSnapshot {
  if (snapshot.detachedSlotIds.length === 0) return snapshot;

  return {
    ...snapshot,
    tree: appendToFirstWorkspacePane(snapshot.tree, snapshot.detachedSlotIds),
    detachedSlotIds: [],
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
    detachedSlotIds: [...document.detachedSlotIds],
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
      sessionIds: [...node.sessionIds],
      activeSessionId: node.activeSessionId,
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

function appendToFirstWorkspacePane(
  node: WorkspaceNode,
  slotIds: string[],
): WorkspaceNode {
  if (node.kind === "pane") {
    const sessionIds = [...node.sessionIds, ...slotIds];
    return {
      ...node,
      sessionIds,
      activeSessionId: slotIds[slotIds.length - 1] ?? node.activeSessionId,
    };
  }
  return {
    ...node,
    first: appendToFirstWorkspacePane(node.first, slotIds),
  };
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
