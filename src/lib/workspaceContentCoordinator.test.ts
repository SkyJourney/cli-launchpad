import { describe, expect, it } from "vitest";
import { WorkspaceContentCoordinator } from "./workspaceContentCoordinator";

describe("workspace content coordinator", () => {
  it("owns detach and return state transitions for mixed content kinds", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "file", documentId: "doc-1" } as const;
    const source = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const target = {
      kind: "window",
      windowLabel: "workspace-content-1",
    } as const;

    expect(
      coordinator.beginDetach(content, source, target, "detach-1")?.state.phase,
    ).toBe("detaching");
    expect(
      coordinator.completeHandoff(content, "detachReady", "detach-1")?.state,
    ).toMatchObject({ phase: "detached", owner: target });
    expect(
      coordinator.beginReturn(content, "return-1", "main")?.state.phase,
    ).toBe("returning");
    expect(
      coordinator.completeHandoff(content, "returnReady", "return-1")?.state,
    ).toMatchObject({ phase: "attached", owner: source });
    coordinator.reconcileDetached(
      content,
      source,
      target,
      "duplicate-recovery",
    );
    expect(coordinator.beginReturn(content, "return-1", "main")).toBeNull();
  });

  it("updates the pane owner when content moves within the workspace", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "pty", slotId: "slot-1" } as const;
    const first = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const second = { ...first, paneId: "pane-2" } as const;

    coordinator.ensureAttached(content, first);
    expect(coordinator.ensureAttached(content, second)).toMatchObject({
      phase: "attached",
      owner: second,
    });
  });

  it("reconciles a recovered standalone owner without mutating the pane tree", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "file", documentId: "doc-1" } as const;
    const source = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-2",
    } as const;
    const target = {
      kind: "window",
      windowLabel: "workspace-content-2",
    } as const;

    expect(
      coordinator.reconcileDetached(content, source, target, "recovered-1"),
    ).toMatchObject({ phase: "detached", owner: target, lastPaneId: "pane-2" });
  });

  it("ignores wrong transfer IDs and removes ownership only after disposal", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "pty", slotId: "slot-1" } as const;
    const source = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const target = { kind: "window", windowLabel: "terminal-1" } as const;

    coordinator.beginDetach(content, source, target, "detach-1");
    expect(
      coordinator.completeHandoff(content, "detachReady", "wrong")?.outcome,
    ).toBe("ignored");
    expect(coordinator.get(content)?.phase).toBe("detaching");
    coordinator.failHandoff(content, "detachCancelled", "detach-1");
    expect(coordinator.get(content)?.phase).toBe("attached");

    coordinator.approveClose(content, "close-1");
    expect(coordinator.get(content)?.phase).toBe("closing");
    coordinator.completeDispose(content, "close-1");
    expect(coordinator.get(content)).toBeUndefined();
  });

  it("rolls back an uncommitted batch close and retires ended content", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const first = { kind: "file", documentId: "doc-1" } as const;
    const second = { kind: "file", documentId: "doc-2" } as const;
    const pane = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    coordinator.ensureAttached(first, pane);
    coordinator.ensureAttached(second, pane);

    expect(coordinator.approveCloseBatch([first, second], "close-1")).toBe(
      true,
    );
    coordinator.cancelClose(first, "close-1");
    expect(coordinator.get(first)?.phase).toBe("attached");
    expect(coordinator.get(second)?.phase).toBe("closing");

    expect(coordinator.ownerEnded(second)?.state.phase).toBe("disposed");
    expect(coordinator.get(second)).toBeUndefined();
  });
});
