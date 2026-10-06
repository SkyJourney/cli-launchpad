import type {
  PtyHandoff,
  PtyTerminalSnapshot,
  WorkspaceFileDocument,
  WorkspacePaneContentRef,
} from "./tauri";
import type { WorkspaceFileBuffer } from "./workspaceFileBuffer";

export interface WorkspacePaneOwner {
  kind: "pane";
  windowLabel: string;
  paneId: string;
}

export interface WorkspaceWindowOwner {
  kind: "window";
  windowLabel: string;
}

export type WorkspaceContentOwner = WorkspacePaneOwner | WorkspaceWindowOwner;

export type ManagedWorkspacePaneContentRef = Extract<
  WorkspacePaneContentRef,
  { kind: "pty" | "file" }
>;

export function canChangeWorkspaceContentPane(
  state: WorkspaceContentLifecycleState | undefined,
): boolean {
  return state?.phase === "attached";
}

interface LifecycleIdentity {
  content: WorkspacePaneContentRef;
  generation: number;
}

export type WorkspaceContentLifecycleState =
  | (LifecycleIdentity & {
      phase: "attached";
      owner: WorkspacePaneOwner;
    })
  | (LifecycleIdentity & {
      phase: "detaching";
      transferId: string;
      source: WorkspacePaneOwner;
      target: WorkspaceWindowOwner;
    })
  | (LifecycleIdentity & {
      phase: "detached";
      owner: WorkspaceWindowOwner;
      windowToken: string;
      lastPaneId: string;
    })
  | (LifecycleIdentity & {
      phase: "returning";
      transferId: string;
      source: WorkspaceWindowOwner;
      target: WorkspacePaneOwner;
      windowToken: string;
      lastPaneId: string;
    })
  | (LifecycleIdentity & {
      phase: "closing";
      requestId: string;
      closeStatus: "approved" | "pending";
      owner: WorkspaceContentOwner;
      windowToken?: string;
      lastPaneId?: string;
    })
  | (LifecycleIdentity & { phase: "disposed" });

interface WorkspaceContentHandoffEventIdentity {
  content: WorkspacePaneContentRef;
  source: WorkspaceContentOwner;
  target: WorkspaceContentOwner;
}

interface WorkspaceContentCloseEventIdentity {
  content: WorkspacePaneContentRef;
  owner: WorkspaceContentOwner;
  generation: number;
}

interface WorkspaceContentOwnerEndEventIdentity {
  content: WorkspacePaneContentRef;
  owner: WorkspaceContentOwner;
  generation: number;
}

export type WorkspaceContentLifecycleEvent =
  | {
      type: "paneOwnerChanged";
      source: WorkspacePaneOwner;
      target: WorkspacePaneOwner;
    }
  | {
      type: "detachRequested";
      transferId: string;
      target: WorkspaceWindowOwner;
    }
  | ({
      type: "detachReady";
      transferId: string;
      generation: number;
    } & WorkspaceContentHandoffEventIdentity)
  | ({
      type: "detachFailed";
      transferId: string;
      generation: number;
    } & WorkspaceContentHandoffEventIdentity)
  | ({
      type: "detachCancelled";
      transferId: string;
      generation: number;
    } & WorkspaceContentHandoffEventIdentity)
  | {
      type: "returnRequested";
      transferId: string;
      targetWindowLabel: string;
      targetPaneId?: string;
    }
  | ({
      type: "returnReady";
      transferId: string;
      generation: number;
    } & WorkspaceContentHandoffEventIdentity)
  | ({
      type: "returnFailed";
      transferId: string;
      generation: number;
    } & WorkspaceContentHandoffEventIdentity)
  | ({
      type: "returnCancelled";
      transferId: string;
      generation: number;
    } & WorkspaceContentHandoffEventIdentity)
  | ({
      type: "closeApproved";
      requestId: string;
    } & WorkspaceContentCloseEventIdentity)
  | ({
      type: "closePending";
      requestId: string;
    } & WorkspaceContentCloseEventIdentity)
  | ({
      type: "closeCancelled";
      requestId: string;
    } & WorkspaceContentCloseEventIdentity)
  | ({
      type: "disposeCompleted";
      requestId: string;
    } & WorkspaceContentCloseEventIdentity)
  | ({ type: "ownerEnded" } & WorkspaceContentOwnerEndEventIdentity);

export interface WorkspaceContentLifecycleTransition {
  state: WorkspaceContentLifecycleState;
  outcome: "changed" | "ignored";
}

export interface WorkspaceContentHandoffPayloadByKind {
  pty: {
    handoff: Pick<PtyHandoff, "token"> & Partial<Pick<PtyHandoff, "sequence">>;
    snapshot?: PtyTerminalSnapshot;
  };
  file: {
    document: WorkspaceFileDocument;
    buffer: WorkspaceFileBuffer;
  };
}

export type WorkspaceContentHandoffEnvelope = {
  [Kind in keyof WorkspaceContentHandoffPayloadByKind]: {
    apiVersion: 1;
    transferId: string;
    generation: number;
    content: Extract<WorkspacePaneContentRef, { kind: Kind }>;
    source: WorkspaceContentOwner;
    target: WorkspaceContentOwner;
    payload: WorkspaceContentHandoffPayloadByKind[Kind];
  };
}[keyof WorkspaceContentHandoffPayloadByKind];

export function createWorkspaceContentLifecycle(
  content: ManagedWorkspacePaneContentRef,
  owner: WorkspacePaneOwner,
): WorkspaceContentLifecycleState {
  const contentId =
    content.kind === "pty" ? content.slotId : content.documentId;
  if (
    !hasText(contentId) ||
    !hasText(owner.windowLabel) ||
    !hasText(owner.paneId)
  ) {
    throw new Error("工作区内容身份和初始 owner 不能为空");
  }
  return { phase: "attached", content, owner, generation: 0 };
}

function ignored(
  state: WorkspaceContentLifecycleState,
): WorkspaceContentLifecycleTransition {
  return { state, outcome: "ignored" };
}

function changed(
  state: WorkspaceContentLifecycleState,
): WorkspaceContentLifecycleTransition {
  return { state, outcome: "changed" };
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function matchesTransfer(
  state: {
    transferId: string;
    generation: number;
    content: WorkspacePaneContentRef;
    source: WorkspaceContentOwner;
    target: WorkspaceContentOwner;
  },
  event: {
    transferId: string;
    generation: number;
  } & WorkspaceContentHandoffEventIdentity,
): boolean {
  return (
    state.transferId === event.transferId &&
    state.generation === event.generation &&
    sameContent(state.content, event.content) &&
    sameOwner(state.source, event.source) &&
    sameOwner(state.target, event.target)
  );
}

function sameContent(
  left: WorkspacePaneContentRef,
  right: WorkspacePaneContentRef,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pty")
    return (
      left.slotId ===
      (right as Extract<WorkspacePaneContentRef, { kind: "pty" }>).slotId
    );
  if (left.kind === "file")
    return (
      left.documentId ===
      (right as Extract<WorkspacePaneContentRef, { kind: "file" }>).documentId
    );
  return (
    left.originalKind ===
      (right as Extract<WorkspacePaneContentRef, { kind: "unknown" }>)
        .originalKind &&
    JSON.stringify(left.raw) ===
      JSON.stringify(
        (right as Extract<WorkspacePaneContentRef, { kind: "unknown" }>).raw,
      )
  );
}

function sameOwner(
  left: WorkspaceContentOwner,
  right: WorkspaceContentOwner,
): boolean {
  if (left.kind !== right.kind || left.windowLabel !== right.windowLabel)
    return false;
  return (
    left.kind === "window" ||
    left.paneId === (right as WorkspacePaneOwner).paneId
  );
}

export function transitionWorkspaceContentLifecycle(
  state: WorkspaceContentLifecycleState,
  event: WorkspaceContentLifecycleEvent,
): WorkspaceContentLifecycleTransition {
  switch (event.type) {
    case "paneOwnerChanged": {
      if (
        state.phase !== "attached" ||
        !sameOwner(state.owner, event.source) ||
        !hasText(event.target.windowLabel) ||
        !hasText(event.target.paneId) ||
        event.source.windowLabel !== event.target.windowLabel
      ) {
        return ignored(state);
      }
      return changed({ ...state, owner: event.target });
    }
    case "detachRequested": {
      if (
        state.phase !== "attached" ||
        !hasText(event.transferId) ||
        !hasText(event.target.windowLabel) ||
        event.target.windowLabel === state.owner.windowLabel
      ) {
        return ignored(state);
      }
      return changed({
        phase: "detaching",
        content: state.content,
        transferId: event.transferId,
        generation: state.generation + 1,
        source: state.owner,
        target: event.target,
      });
    }
    case "detachReady": {
      if (state.phase !== "detaching" || !matchesTransfer(state, event)) {
        return ignored(state);
      }
      return changed({
        phase: "detached",
        content: state.content,
        generation: state.generation,
        owner: state.target,
        windowToken: state.transferId,
        lastPaneId: state.source.paneId,
      });
    }
    case "detachFailed":
    case "detachCancelled": {
      if (state.phase !== "detaching" || !matchesTransfer(state, event)) {
        return ignored(state);
      }
      return changed({
        phase: "attached",
        content: state.content,
        generation: state.generation,
        owner: state.source,
      });
    }
    case "returnRequested": {
      if (
        state.phase !== "detached" ||
        !hasText(event.transferId) ||
        !hasText(event.targetWindowLabel) ||
        event.targetWindowLabel === state.owner.windowLabel
      ) {
        return ignored(state);
      }
      const targetPaneId = event.targetPaneId?.trim() || state.lastPaneId;
      if (!hasText(targetPaneId)) return ignored(state);
      return changed({
        phase: "returning",
        content: state.content,
        transferId: event.transferId,
        generation: state.generation + 1,
        source: state.owner,
        target: {
          kind: "pane",
          windowLabel: event.targetWindowLabel,
          paneId: targetPaneId,
        },
        windowToken: state.windowToken,
        lastPaneId: state.lastPaneId,
      });
    }
    case "returnReady": {
      if (state.phase !== "returning" || !matchesTransfer(state, event)) {
        return ignored(state);
      }
      return changed({
        phase: "attached",
        content: state.content,
        generation: state.generation,
        owner: state.target,
      });
    }
    case "returnFailed":
    case "returnCancelled": {
      if (state.phase !== "returning" || !matchesTransfer(state, event)) {
        return ignored(state);
      }
      return changed({
        phase: "detached",
        content: state.content,
        generation: state.generation,
        owner: state.source,
        windowToken: state.windowToken,
        lastPaneId: state.lastPaneId,
      });
    }
    case "closeApproved": {
      if (
        (state.phase !== "attached" && state.phase !== "detached") ||
        !hasText(event.requestId) ||
        !matchesCloseIdentity(state, event)
      ) {
        return ignored(state);
      }
      return changed({
        phase: "closing",
        content: state.content,
        generation: state.generation,
        requestId: event.requestId,
        closeStatus: "approved",
        owner: state.owner,
        ...(state.phase === "detached"
          ? { windowToken: state.windowToken }
          : {}),
        ...(state.phase === "detached" ? { lastPaneId: state.lastPaneId } : {}),
      });
    }
    case "closePending": {
      if (
        state.phase !== "closing" ||
        state.closeStatus !== "approved" ||
        state.requestId !== event.requestId ||
        !matchesCloseIdentity(state, event)
      ) {
        return ignored(state);
      }
      return changed({ ...state, closeStatus: "pending" });
    }
    case "disposeCompleted": {
      if (
        state.phase !== "closing" ||
        state.closeStatus !== "approved" ||
        state.requestId !== event.requestId ||
        !matchesCloseIdentity(state, event)
      ) {
        return ignored(state);
      }
      return changed({
        phase: "disposed",
        content: state.content,
        generation: state.generation,
      });
    }
    case "closeCancelled": {
      if (
        state.phase !== "closing" ||
        state.closeStatus !== "approved" ||
        state.requestId !== event.requestId ||
        !matchesCloseIdentity(state, event)
      ) {
        return ignored(state);
      }
      return changed({
        phase: state.owner.kind === "pane" ? "attached" : "detached",
        content: state.content,
        generation: state.generation,
        owner: state.owner,
        ...(state.owner.kind === "window"
          ? {
              windowToken: state.windowToken,
              lastPaneId: state.lastPaneId ?? "",
            }
          : {}),
      } as WorkspaceContentLifecycleState);
    }
    case "ownerEnded": {
      if (state.phase === "disposed" || !matchesOwnerEnd(state, event)) {
        return ignored(state);
      }
      return changed({
        phase: "disposed",
        content: state.content,
        generation: state.generation,
      });
    }
  }
}

function matchesCloseIdentity(
  state: {
    content: WorkspacePaneContentRef;
    owner: WorkspaceContentOwner;
    generation: number;
  },
  event: WorkspaceContentCloseEventIdentity,
): boolean {
  return (
    sameContent(state.content, event.content) &&
    sameOwner(state.owner, event.owner) &&
    state.generation === event.generation
  );
}

function matchesOwnerEnd(
  state: WorkspaceContentLifecycleState,
  event: WorkspaceContentOwnerEndEventIdentity,
): boolean {
  if (
    !sameContent(state.content, event.content) ||
    state.generation !== event.generation
  ) {
    return false;
  }
  if (
    state.phase === "attached" ||
    state.phase === "detached" ||
    state.phase === "closing"
  ) {
    return sameOwner(state.owner, event.owner);
  }
  if (state.phase === "detaching" || state.phase === "returning") {
    return (
      sameOwner(state.source, event.owner) ||
      sameOwner(state.target, event.owner)
    );
  }
  return false;
}
