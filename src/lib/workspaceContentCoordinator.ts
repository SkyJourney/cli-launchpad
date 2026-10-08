import type { WorkspacePaneContentRef } from "./tauri";
import { workspaceContentKey } from "./workspaceContentKey";
import { isWindowOwned } from "./workspaceOwnershipProjection";
import {
  createWorkspaceContentLifecycle,
  transitionWorkspaceContentLifecycle,
  type WorkspaceContentLifecycleEvent,
  type WorkspaceContentLifecycleState,
  type WorkspaceContentOwner,
  type WorkspacePaneOwner,
} from "./workspaceContentLifecycle";

/** Owns frontend view ownership state; domain services remain authoritative. */
export class WorkspaceContentCoordinator {
  private readonly states = new Map<string, WorkspaceContentLifecycleState>();
  private readonly completedReturnIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision = () => this.revision;

  private notifyChanged() {
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
  }

  reset() {
    this.states.clear();
    this.completedReturnIds.clear();
    this.notifyChanged();
  }

  resetFromPanes(
    panes: Array<{ id: string; contents: WorkspacePaneContentRef[] }>,
    windowLabel: string,
  ) {
    this.states.clear();
    this.completedReturnIds.clear();
    for (const pane of panes) {
      for (const content of pane.contents) {
        if (content.kind === "unknown") continue;
        const owner = { kind: "pane" as const, windowLabel, paneId: pane.id };
        this.states.set(
          workspaceContentKey(content),
          createWorkspaceContentLifecycle(content, owner),
        );
      }
    }
    this.notifyChanged();
  }

  get(content: WorkspacePaneContentRef) {
    return this.states.get(workspaceContentKey(content));
  }

  listInPhases(
    ...phases: WorkspaceContentLifecycleState["phase"][]
  ): WorkspacePaneContentRef[] {
    const accepted = new Set(phases);
    return [...this.states.values()]
      .filter((state) => accepted.has(state.phase))
      .map((state) => ({ ...state.content }));
  }

  listByPhase(...phases: WorkspaceContentLifecycleState["phase"][]) {
    return this.listInPhases(...phases);
  }

  listWindowOwned(): WorkspacePaneContentRef[] {
    return [...this.states.values()]
      .filter((state) => isWindowOwned(state))
      .map((state) => ({ ...state.content }));
  }

  ensureAttached(
    content: WorkspacePaneContentRef,
    owner: WorkspacePaneOwner,
  ): WorkspaceContentLifecycleState {
    if (content.kind === "unknown") {
      throw new Error("未知工作区内容没有可管理的生命周期");
    }
    const key = workspaceContentKey(content);
    const state = this.states.get(key);
    if (!state) {
      const attached = createWorkspaceContentLifecycle(content, owner);
      this.states.set(key, attached);
      this.notifyChanged();
      return attached;
    }
    if (state.phase === "attached" && !this.sameOwner(state.owner, owner)) {
      return (
        this.dispatch(content, {
          type: "paneOwnerChanged",
          source: state.owner,
          target: owner,
        })?.state ?? state
      );
    }
    return state;
  }

  dispatch(
    content: WorkspacePaneContentRef,
    event: WorkspaceContentLifecycleEvent,
  ) {
    const key = workspaceContentKey(content);
    const state = this.states.get(key);
    if (!state) return null;
    const transition = transitionWorkspaceContentLifecycle(state, event);
    if (transition.outcome === "changed") {
      this.states.set(key, transition.state);
      this.notifyChanged();
    }
    return transition;
  }

  beginDetach(
    content: WorkspacePaneContentRef,
    source: WorkspacePaneOwner,
    target: Extract<WorkspaceContentOwner, { kind: "window" }>,
    transferId: string,
  ) {
    this.ensureAttached(content, source);
    return this.dispatch(content, {
      type: "detachRequested",
      transferId,
      target,
    });
  }

  reconcileDetached(
    content: WorkspacePaneContentRef,
    source: WorkspacePaneOwner,
    target: Extract<WorkspaceContentOwner, { kind: "window" }>,
    transferId: string,
  ) {
    const current = this.get(content);
    if (
      current?.phase === "detached" &&
      this.sameOwner(current.owner, target)
    ) {
      return current;
    }
    const begin = this.beginDetach(content, source, target, transferId);
    if (begin?.outcome !== "changed") return begin?.state ?? null;
    return (
      this.completeHandoff(content, "detachReady", transferId)?.state ?? null
    );
  }

  beginReturn(
    content: WorkspacePaneContentRef,
    transferId: string,
    targetWindowLabel: string,
    targetPaneId?: string,
  ) {
    if (this.completedReturnIds.has(transferId)) return null;
    return this.dispatch(content, {
      type: "returnRequested",
      transferId,
      targetWindowLabel,
      targetPaneId,
    });
  }

  completeHandoff(
    content: WorkspacePaneContentRef,
    type: "detachReady" | "returnReady",
    transferId: string,
  ) {
    const transition = this.dispatchHandoff(content, type, transferId);
    if (type === "returnReady" && transition?.outcome === "changed") {
      this.completedReturnIds.add(transferId);
      if (this.completedReturnIds.size > 256) {
        const oldest = this.completedReturnIds.values().next().value;
        if (oldest) this.completedReturnIds.delete(oldest);
      }
    }
    return transition;
  }

  failHandoff(
    content: WorkspacePaneContentRef,
    type:
      | "detachFailed"
      | "detachCancelled"
      | "returnFailed"
      | "returnCancelled",
    transferId: string,
  ) {
    return this.dispatchHandoff(content, type, transferId);
  }

  approveClose(content: WorkspacePaneContentRef, requestId: string) {
    const state = this.states.get(workspaceContentKey(content));
    if (!state || (state.phase !== "attached" && state.phase !== "detached")) {
      return null;
    }
    return this.dispatch(content, {
      type: "closeApproved",
      requestId,
      content: state.content,
      owner: state.owner,
      generation: state.generation,
    });
  }

  approveCloseBatch(contents: WorkspacePaneContentRef[], requestId: string) {
    const uniqueContents = [
      ...new Map(
        contents.map((content) => [workspaceContentKey(content), content]),
      ).values(),
    ];
    const priorStates = new Map<string, WorkspaceContentLifecycleState>();
    for (const content of uniqueContents) {
      const key = workspaceContentKey(content);
      const state = this.states.get(key);
      if (
        !state ||
        (state.phase !== "attached" && state.phase !== "detached")
      ) {
        return false;
      }
      priorStates.set(key, state);
    }
    for (const content of uniqueContents) {
      if (this.approveClose(content, requestId)?.outcome !== "changed") {
        priorStates.forEach((state, key) => this.states.set(key, state));
        this.notifyChanged();
        return false;
      }
    }
    return true;
  }

  cancelClose(content: WorkspacePaneContentRef, requestId: string) {
    const state = this.states.get(workspaceContentKey(content));
    if (
      !state ||
      state.phase !== "closing" ||
      state.closeStatus !== "approved"
    ) {
      return null;
    }
    return this.dispatch(content, {
      type: "closeCancelled",
      requestId,
      content: state.content,
      owner: state.owner,
      generation: state.generation,
    });
  }

  markClosePending(content: WorkspacePaneContentRef, requestId: string) {
    const state = this.states.get(workspaceContentKey(content));
    if (
      !state ||
      state.phase !== "closing" ||
      state.closeStatus !== "approved"
    ) {
      return null;
    }
    return this.dispatch(content, {
      type: "closePending",
      requestId,
      content: state.content,
      owner: state.owner,
      generation: state.generation,
    });
  }

  completeDispose(content: WorkspacePaneContentRef, requestId: string) {
    const state = this.states.get(workspaceContentKey(content));
    if (!state || state.phase !== "closing") return null;
    const transition = this.dispatch(content, {
      type: "disposeCompleted",
      requestId,
      content: state.content,
      owner: state.owner,
      generation: state.generation,
    });
    if (transition?.state.phase === "disposed") {
      this.states.delete(workspaceContentKey(content));
      this.notifyChanged();
    }
    return transition;
  }

  ownerEnded(content: WorkspacePaneContentRef) {
    const key = workspaceContentKey(content);
    const state = this.states.get(key);
    if (!state || state.phase === "disposed") return null;
    const owner =
      state.phase === "detaching" || state.phase === "returning"
        ? state.source
        : state.owner;
    const transition = this.dispatch(content, {
      type: "ownerEnded",
      content: state.content,
      owner,
      generation: state.generation,
    });
    if (transition?.state.phase === "disposed") {
      this.states.delete(key);
      this.notifyChanged();
    }
    return transition;
  }

  private dispatchHandoff(
    content: WorkspacePaneContentRef,
    type:
      | "detachReady"
      | "returnReady"
      | "detachFailed"
      | "detachCancelled"
      | "returnFailed"
      | "returnCancelled",
    transferId: string,
  ) {
    const state = this.states.get(workspaceContentKey(content));
    if (
      !state ||
      (state.phase !== "detaching" && state.phase !== "returning")
    ) {
      return null;
    }
    return this.dispatch(content, {
      type,
      transferId,
      generation: state.generation,
      content: state.content,
      source: state.source,
      target: state.target,
    } as WorkspaceContentLifecycleEvent);
  }

  private sameOwner(left: WorkspaceContentOwner, right: WorkspaceContentOwner) {
    return (
      left.kind === right.kind &&
      left.windowLabel === right.windowLabel &&
      (left.kind === "window" ||
        (right.kind === "pane" && left.paneId === right.paneId))
    );
  }
}
