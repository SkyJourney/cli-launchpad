import { describe, expect, it } from "vitest";
import {
  canChangeWorkspaceContentPane,
  createWorkspaceContentLifecycle,
  transitionWorkspaceContentLifecycle,
  type WorkspaceContentLifecycleEvent,
  type WorkspaceContentLifecycleState,
} from "./workspaceContentLifecycle";

const content = { kind: "file", documentId: "doc-1" } as const;
const paneOwner = {
  kind: "pane",
  windowLabel: "main",
  paneId: "pane-1",
} as const;
const windowOwner = {
  kind: "window",
  windowLabel: "workspace-content-1",
} as const;

function transition(
  state: WorkspaceContentLifecycleState,
  event: WorkspaceContentLifecycleEvent,
) {
  return transitionWorkspaceContentLifecycle(state, event).state;
}

function transferEvent(
  state: WorkspaceContentLifecycleState,
  type:
    | "detachReady"
    | "detachFailed"
    | "detachCancelled"
    | "returnReady"
    | "returnFailed"
    | "returnCancelled",
  transferId = "transfer-1",
  generation = state.generation,
): WorkspaceContentLifecycleEvent {
  if (state.phase !== "detaching" && state.phase !== "returning") {
    throw new Error("Transfer event requires a pending handoff");
  }
  return {
    type,
    transferId,
    generation,
    content: state.content,
    source: state.source,
    target: state.target,
  } as WorkspaceContentLifecycleEvent;
}

function closeEvent(
  state: WorkspaceContentLifecycleState,
  type: "closeApproved" | "closeCancelled" | "disposeCompleted",
  requestId: string,
): WorkspaceContentLifecycleEvent {
  if (
    state.phase !== "attached" &&
    state.phase !== "detached" &&
    state.phase !== "closing"
  ) {
    throw new Error("Content state has no close owner");
  }
  return {
    type,
    requestId,
    content: state.content,
    owner: state.owner,
    generation: state.generation,
  } as WorkspaceContentLifecycleEvent;
}

function detachedState() {
  const attached = createWorkspaceContentLifecycle(content, paneOwner);
  const detaching = transition(attached, {
    type: "detachRequested",
    transferId: "detach-1",
    target: windowOwner,
  });
  return transition(
    detaching,
    transferEvent(detaching, "detachReady", "detach-1"),
  );
}

describe("workspace content lifecycle", () => {
  it("moves ownership to a standalone window only after its ready event", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    const pending = transitionWorkspaceContentLifecycle(attached, {
      type: "detachRequested",
      transferId: "detach-1",
      target: windowOwner,
    });

    expect(pending.state.phase).toBe("detaching");
    expect(pending.state).toMatchObject({
      source: paneOwner,
      target: windowOwner,
      generation: 1,
    });

    const result = transitionWorkspaceContentLifecycle(
      pending.state,
      transferEvent(pending.state, "detachReady", "detach-1"),
    );
    expect(result.state).toMatchObject({
      phase: "detached",
      owner: windowOwner,
      windowToken: "detach-1",
      lastPaneId: paneOwner.paneId,
    });
  });

  it("restores the original pane owner when detaching fails or is cancelled", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    const pending = transition(attached, {
      type: "detachRequested",
      transferId: "detach-1",
      target: windowOwner,
    });

    for (const type of ["detachFailed", "detachCancelled"] as const) {
      expect(
        transition(pending, transferEvent(pending, type, "detach-1")),
      ).toMatchObject({ phase: "attached", owner: paneOwner });
    }
  });

  it("returns content to a requested pane after the target accepts it", () => {
    const detached = detachedState();
    const returning = transition(detached, {
      type: "returnRequested",
      transferId: "return-1",
      targetWindowLabel: "main",
      targetPaneId: "pane-2",
    });
    expect(returning).toMatchObject({
      phase: "returning",
      source: windowOwner,
      target: { kind: "pane", windowLabel: "main", paneId: "pane-2" },
      generation: 2,
    });

    expect(
      transition(
        returning,
        transferEvent(returning, "returnReady", "return-1"),
      ),
    ).toMatchObject({
      phase: "attached",
      owner: { kind: "pane", windowLabel: "main", paneId: "pane-2" },
    });
  });

  it("keeps the standalone window as owner when returning fails or is cancelled", () => {
    const detached = detachedState();
    const returning = transition(detached, {
      type: "returnRequested",
      transferId: "return-1",
      targetWindowLabel: "main",
    });

    for (const type of ["returnFailed", "returnCancelled"] as const) {
      expect(
        transition(returning, transferEvent(returning, type, "return-1")),
      ).toMatchObject({
        phase: "detached",
        owner: windowOwner,
        windowToken: "detach-1",
      });
    }
  });

  it("keeps the detached window token when an approved close is cancelled", () => {
    const detached = detachedState();
    const closing = transition(
      detached,
      closeEvent(detached, "closeApproved", "close-1"),
    );

    expect(closing).toMatchObject({
      phase: "closing",
      owner: windowOwner,
      windowToken: "detach-1",
    });
    expect(
      transition(closing, closeEvent(closing, "closeCancelled", "close-1")),
    ).toMatchObject({
      phase: "detached",
      owner: windowOwner,
      windowToken: "detach-1",
    });
  });

  it("ignores duplicate, stale and mismatched handoff events", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    const pending = transition(attached, {
      type: "detachRequested",
      transferId: "detach-1",
      target: windowOwner,
    });

    expect(
      transitionWorkspaceContentLifecycle(
        pending,
        transferEvent(pending, "detachReady", "stale-transfer"),
      ),
    ).toEqual({ state: pending, outcome: "ignored" });
    expect(
      transitionWorkspaceContentLifecycle(
        pending,
        transferEvent(pending, "detachReady", "detach-1", 0),
      ),
    ).toEqual({ state: pending, outcome: "ignored" });

    const detached = transition(
      pending,
      transferEvent(pending, "detachReady", "detach-1"),
    );
    expect(
      transitionWorkspaceContentLifecycle(detached, {
        type: "detachReady",
        transferId: "detach-1",
        generation: 1,
        content,
        source: paneOwner,
        target: windowOwner,
      }),
    ).toEqual({ state: detached, outcome: "ignored" });
  });

  it("ignores events for another content identity or a different source/target window", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    const pending = transition(attached, {
      type: "detachRequested",
      transferId: "detach-1",
      target: windowOwner,
    });
    const validEvent = transferEvent(pending, "detachReady", "detach-1");

    for (const mismatchedEvent of [
      { ...validEvent, content: { kind: "file", documentId: "other-doc" } },
      { ...validEvent, source: { ...paneOwner, windowLabel: "another-main" } },
      {
        ...validEvent,
        target: { ...windowOwner, windowLabel: "workspace-content-2" },
      },
    ]) {
      expect(
        transitionWorkspaceContentLifecycle(
          pending,
          mismatchedEvent as WorkspaceContentLifecycleEvent,
        ),
      ).toEqual({ state: pending, outcome: "ignored" });
    }
  });

  it("rejects invalid owners and overlapping transfers", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    expect(
      transitionWorkspaceContentLifecycle(attached, {
        type: "detachRequested",
        transferId: "detach-1",
        target: { ...windowOwner, windowLabel: "main" },
      }).outcome,
    ).toBe("ignored");
    expect(
      transitionWorkspaceContentLifecycle(attached, {
        type: "detachRequested",
        transferId: " ",
        target: windowOwner,
      }).outcome,
    ).toBe("ignored");

    const pending = transition(attached, {
      type: "detachRequested",
      transferId: "detach-1",
      target: windowOwner,
    });
    expect(
      transitionWorkspaceContentLifecycle(pending, {
        type: "detachRequested",
        transferId: "detach-2",
        target: { ...windowOwner, windowLabel: "terminal-2" },
      }).outcome,
    ).toBe("ignored");
  });

  it("uses the prior pane when a return request omits a target pane", () => {
    const returning = transition(detachedState(), {
      type: "returnRequested",
      transferId: "return-1",
      targetWindowLabel: "main",
    });
    expect(returning).toMatchObject({
      phase: "returning",
      target: paneOwner,
    });
  });

  it("disposes exactly the content whose approved close request completed", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    const closing = transition(
      attached,
      closeEvent(attached, "closeApproved", "close-1"),
    );
    expect(closing).toMatchObject({ phase: "closing", owner: paneOwner });
    expect(
      transitionWorkspaceContentLifecycle(
        closing,
        closeEvent(closing, "disposeCompleted", "other-close"),
      ).outcome,
    ).toBe("ignored");
    expect(
      transition(closing, closeEvent(closing, "disposeCompleted", "close-1")),
    ).toMatchObject({ phase: "disposed", content });
  });

  it("allows pane moves only while the content is attached", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    const closing = transition(
      attached,
      closeEvent(attached, "closeApproved", "close-terminating"),
    );

    expect(canChangeWorkspaceContentPane(attached)).toBe(true);
    expect(canChangeWorkspaceContentPane(closing)).toBe(false);
    expect(canChangeWorkspaceContentPane(undefined)).toBe(false);
  });

  it("rejects close approvals and disposal events with stale owner identity", () => {
    const attached = createWorkspaceContentLifecycle(content, paneOwner);
    const mismatchedApproval = {
      ...closeEvent(attached, "closeApproved", "close-1"),
      owner: { ...paneOwner, paneId: "pane-2" },
    } as WorkspaceContentLifecycleEvent;
    expect(
      transitionWorkspaceContentLifecycle(attached, mismatchedApproval),
    ).toEqual({ state: attached, outcome: "ignored" });

    const closing = transition(
      attached,
      closeEvent(attached, "closeApproved", "close-1"),
    );
    const staleDisposal = {
      ...closeEvent(closing, "disposeCompleted", "close-1"),
      generation: closing.generation + 1,
    } as WorkspaceContentLifecycleEvent;
    expect(transitionWorkspaceContentLifecycle(closing, staleDisposal)).toEqual(
      { state: closing, outcome: "ignored" },
    );
  });

  it("does not create an owner lifecycle for an empty identity", () => {
    expect(() =>
      createWorkspaceContentLifecycle(
        { kind: "file", documentId: " " },
        paneOwner,
      ),
    ).toThrow("工作区内容身份和初始 owner 不能为空");
  });
});
