import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceLayoutDocument,
  isWorkspaceApplyStateCurrent,
  markWorkspaceSlotsRestored,
  removeEndedWorkspaceSlots,
  rehomeDetachedWorkspaceSlots,
  restoreWorkspaceLayoutApplyPlan,
  restoreWorkspaceRuntimeSnapshot,
  WorkspaceLayoutSaveQueue,
} from "./workspaceLayoutPersistence";
import {
  addSessionToWorkspacePane,
  listWorkspacePanes,
  setWorkspaceSplitRatio,
} from "./ptyWorkspaceLayout";
import type {
  WorkspaceLayoutApplyPlan,
  WorkspaceLayoutDocument,
} from "./tauri";

function createDocument(projectName = "Project"): WorkspaceLayoutDocument {
  return createWorkspaceLayoutDocument({
    tree: {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.63,
      first: {
        kind: "pane",
        id: "pane-1",
        paneNumber: 1,
        contents: [{ kind: "pty", slotId: "slot-1" }],
        activeContent: { kind: "pty", slotId: "slot-1" },
      },
      second: {
        kind: "pane",
        id: "pane-2",
        paneNumber: 2,
        contents: [],
        activeContent: null,
      },
    },
    focusedPaneId: "pane-2",
    slots: [
      {
        instanceId: "slot-1",
        directoryId: 42,
        directoryPath: "C:\\Projects\\sample",
        projectName,
        toolKey: "codex",
        sequence: 3,
        sessionId: "session-1",
        resumeSessionId: null,
        title: { kind: "custom", value: "Review" },
      },
    ],
    detachedSlotIds: [],
  });
}

describe("workspace layout persistence mapping", () => {
  it("rejects applying a layout plan after the active workspace changes", () => {
    const tree = createDocument().tree;
    const slots = [{ instanceId: "slot-1" }];
    const detachedSlotIds = new Set<string>();
    const expected = {
      tree,
      slots,
      focusedPaneId: "pane-2",
      detachedSlotIds,
    };

    expect(isWorkspaceApplyStateCurrent(expected, { ...expected })).toBe(true);
    expect(
      isWorkspaceApplyStateCurrent(expected, {
        ...expected,
        focusedPaneId: "pane-1",
      }),
    ).toBe(false);
    expect(
      isWorkspaceApplyStateCurrent(expected, {
        ...expected,
        tree: {
          kind: "pane",
          id: "changed",
          paneNumber: 1,
          contents: [],
          activeContent: null,
        },
      }),
    ).toBe(false);
    expect(
      isWorkspaceApplyStateCurrent(expected, {
        ...expected,
        slots: [...slots],
      }),
    ).toBe(false);
    expect(
      isWorkspaceApplyStateCurrent(expected, {
        ...expected,
        detachedSlotIds: new Set(detachedSlotIds),
      }),
    ).toBe(false);
  });

  it("round trips nested panes, ratios, slot snapshots, title and focus", () => {
    const document = createDocument();
    const restored = restoreWorkspaceRuntimeSnapshot(document);

    expect(restored).toEqual({
      tree: document.tree,
      focusedPaneId: "pane-2",
      slots: document.slots,
      documents: [],
      detachedSlotIds: [],
    });
  });

  it("persists file references beside PTY slots without storing editor content", () => {
    const document = createDocument();
    document.documents = [
      {
        id: "file-doc-1",
        directoryId: 42,
        directoryPath: "C:\\Projects\\sample",
        relativePath: "src/main.rs",
      },
    ];
    if (document.tree.kind !== "split") throw new Error("expected split");
    const pane = document.tree.first;
    if (pane.kind !== "pane") throw new Error("expected first pane");
    pane.contents.push({ kind: "file", documentId: "file-doc-1" });
    pane.activeContent = { kind: "file", documentId: "file-doc-1" };

    const restored = restoreWorkspaceRuntimeSnapshot(document);
    expect(restored.documents).toEqual(document.documents);
    expect(restored.tree).toEqual(document.tree);
    expect(JSON.stringify(document)).not.toContain("unsaved editor text");
  });

  it("stores the latest sash ratio in autosave and named-layout snapshots", () => {
    const original = createDocument();
    const resizedTree = setWorkspaceSplitRatio(
      original.tree,
      "split-root",
      0.71,
    );
    const saved = createWorkspaceLayoutDocument({
      ...restoreWorkspaceRuntimeSnapshot(original),
      tree: resizedTree,
    });

    expect(saved.tree).toMatchObject({ id: "split-root", ratio: 0.71 });
    expect(restoreWorkspaceRuntimeSnapshot(saved).tree).toEqual(resizedTree);
  });

  it("copies nested structures so callers cannot mutate the source snapshot", () => {
    const document = createDocument();
    const restored = restoreWorkspaceRuntimeSnapshot(document);
    restored.tree.kind === "split" &&
      restored.tree.first.kind === "pane" &&
      restored.tree.first.contents.push({ kind: "pty", slotId: "unexpected" });
    restored.slots[0].title.kind === "custom" &&
      (restored.slots[0].title.value = "Changed");

    expect(
      document.tree.kind === "split" && document.tree.first.kind === "pane"
        ? document.tree.first.contents
        : [],
    ).toEqual([{ kind: "pty", slotId: "slot-1" }]);
    expect(document.slots[0].title).toEqual({
      kind: "custom",
      value: "Review",
    });
  });

  it("returns detached slots to the first pane in their recorded order", () => {
    const snapshot = restoreWorkspaceRuntimeSnapshot(
      createWorkspaceLayoutDocument({
        tree: {
          kind: "split",
          id: "split-root",
          direction: "horizontal",
          ratio: 0.5,
          first: {
            kind: "pane",
            id: "pane-1",
            paneNumber: 1,
            contents: [{ kind: "pty", slotId: "slot-main" }],
            activeContent: { kind: "pty", slotId: "slot-main" },
          },
          second: {
            kind: "pane",
            id: "pane-2",
            paneNumber: 2,
            contents: [],
            activeContent: null,
          },
        },
        focusedPaneId: "pane-2",
        slots: ["slot-main", "slot-detached-a", "slot-detached-b"].map(
          (instanceId, index) => ({
            instanceId,
            directoryId: 42,
            directoryPath: "C:\\Projects\\sample",
            projectName: "Project",
            toolKey: "codex",
            sequence: index + 1,
            sessionId: null,
            resumeSessionId: null,
            title: { kind: "automatic" },
          }),
        ),
        detachedSlotIds: ["slot-detached-a", "slot-detached-b"],
      }),
    );

    const restored = rehomeDetachedWorkspaceSlots(snapshot);

    expect(restored.tree.kind).toBe("split");
    if (
      restored.tree.kind !== "split" ||
      restored.tree.first.kind !== "pane" ||
      restored.tree.second.kind !== "pane"
    ) {
      return;
    }
    expect(restored.tree.first).toMatchObject({
      id: "pane-1",
      contents: [
        { kind: "pty", slotId: "slot-main" },
        { kind: "pty", slotId: "slot-detached-a" },
        { kind: "pty", slotId: "slot-detached-b" },
      ],
      activeContent: { kind: "pty", slotId: "slot-detached-b" },
    });
    expect(restored.focusedPaneId).toBe("pane-2");
    expect(restored.detachedSlotIds).toEqual([]);
  });

  it("restores an apply plan while keeping detached sessions outside pane trees", () => {
    const slot = (instanceId: string) => ({
      instanceId,
      directoryId: 42,
      directoryPath: "C:\\Projects\\sample",
      projectName: "Project",
      toolKey: "codex" as const,
      sequence: 1,
      sessionId: `session-${instanceId}`,
      resumeSessionId: null,
      title: { kind: "automatic" as const },
    });
    const plan: WorkspaceLayoutApplyPlan = {
      layout: createWorkspaceLayoutDocument({
        tree: {
          kind: "split",
          id: "split-root",
          direction: "horizontal",
          ratio: 0.6,
          first: {
            kind: "pane",
            id: "pane-1",
            paneNumber: 1,
            contents: ["saved", "live-outside", "ended"].map((slotId) => ({
              kind: "pty" as const,
              slotId,
            })),
            activeContent: { kind: "pty", slotId: "live-outside" },
          },
          second: {
            kind: "pane",
            id: "pane-2",
            paneNumber: 2,
            contents: ["detached", "invalid"].map((slotId) => ({
              kind: "pty" as const,
              slotId,
            })),
            activeContent: { kind: "pty", slotId: "detached" },
          },
        },
        focusedPaneId: "pane-2",
        slots: ["saved", "live-outside", "detached", "ended", "invalid"].map(
          slot,
        ),
        detachedSlotIds: ["detached"],
      }),
      slotStates: ["saved", "live-outside", "detached", "ended", "invalid"].map(
        (instanceId) => ({
          instanceId,
          state:
            instanceId === "ended"
              ? ("ended" as const)
              : instanceId === "invalid"
                ? ("missingProject" as const)
                : ("running" as const),
          currentProjectName: null,
        }),
      ),
    };

    const restored = restoreWorkspaceLayoutApplyPlan(plan);

    expect(restored.tree.kind).toBe("split");
    if (
      restored.tree.kind !== "split" ||
      restored.tree.first.kind !== "pane" ||
      restored.tree.second.kind !== "pane"
    ) {
      return;
    }
    expect(restored.tree.first.contents).toEqual([
      { kind: "pty", slotId: "saved" },
      { kind: "pty", slotId: "live-outside" },
    ]);
    expect(restored.tree.second.contents).toEqual([
      { kind: "pty", slotId: "invalid" },
    ]);
    expect(restored.slots.map(({ instanceId }) => instanceId)).toEqual([
      "saved",
      "live-outside",
      "detached",
      "invalid",
    ]);
    expect(
      restored.slots.find(({ instanceId }) => instanceId === "saved"),
    ).not.toHaveProperty("restoredState");
    expect(
      restored.slots.find(({ instanceId }) => instanceId === "invalid"),
    ).toMatchObject({ restoredState: "missingProject" });
    expect(restored.detachedSlotIds).toEqual(["detached"]);
    expect(
      restored.slots.find(({ instanceId }) => instanceId === "detached"),
    ).toMatchObject({ sequence: 1, toolKey: "codex" });
  });

  it("marks restored running sessions ended and preserves invalid references", () => {
    const document = createDocument();
    const restored = markWorkspaceSlotsRestored(document.slots, [
      {
        instanceId: "slot-1",
        state: "running",
        currentProjectName: "Renamed project",
      },
    ]);

    expect(restored[0]).toMatchObject({
      restoredState: "ended",
      projectName: "Renamed project",
      sessionId: "session-1",
    });
    expect(
      markWorkspaceSlotsRestored(document.slots, [
        {
          instanceId: "slot-1",
          state: "missingProject",
          currentProjectName: null,
        },
      ])[0].restoredState,
    ).toBe("missingProject");
  });

  it("removes ended slots while preserving panes and targeted history restore", () => {
    const endedSlot = {
      instanceId: "slot-ended",
      directoryId: 42,
      directoryPath: "C:\\Projects\\sample",
      projectName: "Project",
      toolKey: "codex" as const,
      sequence: 1,
      sessionId: "session-ended",
      resumeSessionId: null,
      title: { kind: "automatic" as const },
    };
    const invalidSlot = {
      ...endedSlot,
      instanceId: "slot-invalid",
      sequence: 2,
      sessionId: "session-invalid",
    };
    const document = createWorkspaceLayoutDocument({
      tree: {
        kind: "split",
        id: "split-root",
        direction: "horizontal",
        ratio: 0.63,
        first: {
          kind: "pane",
          id: "pane-1",
          paneNumber: 1,
          contents: [endedSlot.instanceId, invalidSlot.instanceId].map(
            (slotId) => ({ kind: "pty" as const, slotId }),
          ),
          activeContent: { kind: "pty", slotId: endedSlot.instanceId },
        },
        second: {
          kind: "pane",
          id: "pane-2",
          paneNumber: 2,
          contents: [],
          activeContent: null,
        },
      },
      focusedPaneId: "pane-2",
      slots: [endedSlot, invalidSlot],
      detachedSlotIds: [],
    });
    const snapshot = {
      ...restoreWorkspaceRuntimeSnapshot(document),
      slots: markWorkspaceSlotsRestored(document.slots, [
        {
          instanceId: endedSlot.instanceId,
          state: "ended",
          currentProjectName: "Project",
        },
        {
          instanceId: invalidSlot.instanceId,
          state: "missingProject",
          currentProjectName: null,
        },
      ]),
    };

    const restored = removeEndedWorkspaceSlots(snapshot);

    expect(restored.slots.map((slot) => slot.instanceId)).toEqual([
      invalidSlot.instanceId,
    ]);
    expect(restored.focusedPaneId).toBe("pane-2");
    expect(restored.tree).toMatchObject({
      id: "split-root",
      ratio: 0.63,
      first: {
        id: "pane-1",
        paneNumber: 1,
        contents: [{ kind: "pty", slotId: invalidSlot.instanceId }],
        activeContent: { kind: "pty", slotId: invalidSlot.instanceId },
      },
      second: {
        id: "pane-2",
        paneNumber: 2,
        contents: [],
        activeContent: null,
      },
    });

    const afterHistoryRestore = addSessionToWorkspacePane(
      restored.tree,
      restored.focusedPaneId,
      "restored-live-session",
    );
    expect(
      listWorkspacePanes(afterHistoryRestore).find(
        (pane) => pane.id === "pane-2",
      ),
    ).toMatchObject({
      contents: [{ kind: "pty", slotId: "restored-live-session" }],
      activeContent: { kind: "pty", slotId: "restored-live-session" },
    });
  });
});

describe("WorkspaceLayoutSaveQueue", () => {
  it("serializes writes and coalesces intermediate pending snapshots", async () => {
    const calls: { revision: number; projectName: string }[] = [];
    let releaseFirst!: (result: { saved: boolean; revision: number }) => void;
    const firstSave = new Promise<{ saved: boolean; revision: number }>(
      (resolve) => {
        releaseFirst = resolve;
      },
    );
    const save = vi.fn((revision: number, layout: WorkspaceLayoutDocument) => {
      calls.push({ revision, projectName: layout.slots[0].projectName });
      return calls.length === 1
        ? firstSave
        : Promise.resolve({ saved: true, revision });
    });
    const queue = new WorkspaceLayoutSaveQueue(4, save, vi.fn());

    queue.enqueue(createDocument("First"));
    queue.enqueue(createDocument("Second"));
    queue.enqueue(createDocument("Latest"));
    releaseFirst({ saved: true, revision: 5 });
    await queue.flush();

    expect(calls).toEqual([
      { revision: 5, projectName: "First" },
      { revision: 6, projectName: "Latest" },
    ]);
  });

  it("rebases a stale write on the revision returned by SQLite", async () => {
    const revisions: number[] = [];
    const save = vi.fn((revision: number) => {
      revisions.push(revision);
      return Promise.resolve(
        revisions.length === 1
          ? { saved: false, revision: 12 }
          : { saved: true, revision },
      );
    });
    const queue = new WorkspaceLayoutSaveQueue(2, save, vi.fn());

    queue.enqueue(createDocument());
    await queue.flush();

    expect(revisions).toEqual([3, 13]);
  });

  it("reports a failed save without rejecting later workspace saves", async () => {
    const reportError = vi.fn();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementation((revision: number) =>
        Promise.resolve({ saved: true, revision }),
      );
    const queue = new WorkspaceLayoutSaveQueue(0, save, reportError);

    queue.enqueue(createDocument());
    await queue.flush();
    queue.enqueue(createDocument("Retry"));
    await queue.flush();

    expect(reportError).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[1].slots[0].projectName).toBe("Retry");
  });
});
