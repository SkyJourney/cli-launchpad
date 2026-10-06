import { describe, expect, it, vi } from "vitest";
import { WorkspaceContentCoordinator } from "./workspaceContentCoordinator";
import {
  addWorkspaceFileToPane,
  findWorkspacePane,
  placeContentExclusively,
  removeWorkspaceContentFromTree,
  splitWorkspacePane,
} from "./ptyWorkspaceLayout";

describe("workspace content coordinator", () => {
  it("publishes phase changes for lifecycle-derived UI state", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "pty", slotId: "slot-closing" } as const;
    const owner = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const listener = vi.fn();
    const unsubscribe = coordinator.subscribe(listener);

    coordinator.ensureAttached(content, owner);
    coordinator.approveClose(content, "close-1");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(coordinator.getRevision()).toBe(2);
    expect(coordinator.listInPhases("closing")).toEqual([content]);
    unsubscribe();
  });

  it("rebuilds hydrated pane owners and selects detached window ownership", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "pty", slotId: "slot-1" } as const;
    coordinator.resetFromPanes([{ id: "pane-1", contents: [content] }], "main");
    expect(coordinator.get(content)?.phase).toBe("attached");

    coordinator.beginDetach(
      content,
      { kind: "pane", windowLabel: "main", paneId: "pane-1" },
      { kind: "window", windowLabel: "terminal-1" },
      "transfer-1",
    );
    coordinator.completeHandoff(content, "detachReady", "transfer-1");

    expect(coordinator.listByPhase("detached")).toEqual([content]);
    expect(coordinator.listWindowOwned()).toEqual([content]);

    coordinator.resetFromPanes([{ id: "pane-2", contents: [content] }], "main");
    expect(coordinator.get(content)).toMatchObject({ phase: "attached" });
    expect(coordinator.listByPhase("detached")).toEqual([]);
  });

  it("clears all content owners and completed transfers when workspace data is restored", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "file", documentId: "doc-1" } as const;
    const owner = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    coordinator.ensureAttached(content, owner);

    coordinator.reset();

    expect(coordinator.get(content)).toBeUndefined();
    expect(coordinator.ensureAttached(content, owner).phase).toBe("attached");
  });

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

  it("removes a file on detach-ready and returns it exclusively to another pane", () => {
    const coordinator = new WorkspaceContentCoordinator();
    const content = { kind: "file", documentId: "doc-1" } as const;
    const source = {
      kind: "pane",
      windowLabel: "main",
      paneId: "pane-1",
    } as const;
    const target = { kind: "window", windowLabel: "workspace-file-1" } as const;
    const withFile = addWorkspaceFileToPane(
      splitWorkspacePane(
        addWorkspaceFileToPane(
          {
            kind: "pane",
            id: "pane-1",
            paneNumber: 1,
            contents: [],
            activeContent: null,
          },
          "pane-1",
          content.documentId,
        ),
        "pane-1",
        "horizontal",
        "split-1",
        "pane-2",
      ),
      "pane-2",
      content.documentId,
    );

    coordinator.beginDetach(content, source, target, "detach-1");
    const detached = coordinator.completeHandoff(
      content,
      "detachReady",
      "detach-1",
    );
    const detachedTree = removeWorkspaceContentFromTree(withFile, content);
    expect(detached?.state.phase).toBe("detached");
    expect(
      findWorkspacePane(detachedTree, "pane-1")?.contents.some(
        (entry) =>
          entry.kind === "file" && entry.documentId === content.documentId,
      ),
    ).toBe(false);
    expect(
      findWorkspacePane(detachedTree, "pane-2")?.contents.some(
        (entry) =>
          entry.kind === "file" && entry.documentId === content.documentId,
      ),
    ).toBe(false);

    coordinator.beginReturn(content, "return-1", "main", "pane-2");
    const returnedTree = placeContentExclusively(
      detachedTree,
      "pane-2",
      content,
    );
    expect(
      coordinator.completeHandoff(content, "returnReady", "return-1")?.state
        .phase,
    ).toBe("attached");
    expect(findWorkspacePane(returnedTree, "pane-1")?.contents).toEqual([]);
    expect(findWorkspacePane(returnedTree, "pane-2")?.contents).toEqual([
      content,
    ]);
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
