import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceLayoutDocument,
  isWorkspaceApplyStateCurrent,
  listPersistedDetachedContents,
  markWorkspaceSlotsRestored,
  migrateWorkspaceLayoutDocument,
  removeEndedWorkspaceSlots,
  rehomeDetachedWorkspaceContents,
  restoreCurrentWorkspaceFilesAfterPreset,
  restoreWorkspaceLayoutApplyPlan,
  restoreWorkspaceRuntimeSnapshot,
  UnsupportedWorkspaceLayoutVersionError,
  WorkspaceLayoutSaveError,
  WorkspaceLayoutSaveQueue,
} from "./workspaceLayoutPersistence";
import {
  addSessionToWorkspacePane,
  addWorkspaceFileToPane,
  createWorkspacePane,
  listWorkspacePanes,
  setWorkspaceSplitRatio,
} from "./ptyWorkspaceLayout";
import { WorkspaceContentCoordinator } from "./workspaceContentCoordinator";
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
    detachedContents: [],
  });
}

describe("workspace layout persistence mapping", () => {
  it("rejects applying a layout plan after the active workspace changes", () => {
    const tree = createDocument().tree;
    const slots = [{ instanceId: "slot-1" }];
    const detachedContents = [{ kind: "pty", slotId: "detached" }] as const;
    const expected = {
      tree,
      slots,
      focusedPaneId: "pane-2",
      detachedContents,
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
        detachedContents: [{ kind: "pty", slotId: "changed" }],
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
      detachedContents: [],
    });
  });

  it("migrates v3 detached slot IDs into v5 PTY content references", () => {
    const v3 = JSON.parse(JSON.stringify(createDocument())) as Record<
      string,
      unknown
    >;
    v3.schemaVersion = 3;
    v3.detachedSlotIds = ["slot-1"];
    if (
      typeof v3.tree === "object" &&
      v3.tree !== null &&
      "first" in v3.tree &&
      typeof v3.tree.first === "object" &&
      v3.tree.first !== null &&
      "contents" in v3.tree.first &&
      "activeContent" in v3.tree.first
    ) {
      v3.tree.first.contents = [];
      v3.tree.first.activeContent = null;
    }

    const migrated = migrateWorkspaceLayoutDocument(v3);

    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.detachedContents).toEqual([
      { kind: "pty", slotId: "slot-1" },
    ]);
    expect(migrated).not.toHaveProperty("detachedSlotIds");
  });

  it("migrates v4 layouts and preserves unknown content payloads", () => {
    const v4 = JSON.parse(JSON.stringify(createDocument())) as Record<
      string,
      unknown
    >;
    v4.schemaVersion = 4;
    const tree = v4.tree as {
      first: { contents: unknown[]; activeContent: unknown };
    };
    const unknownContent = {
      kind: "unknown",
      originalKind: "editor",
      raw: {
        kind: "editor",
        documentId: "doc-1",
        options: { wrap: true },
      },
    };
    tree.first.contents.push(unknownContent);

    const migrated = migrateWorkspaceLayoutDocument(v4);
    const roundTripped = migrateWorkspaceLayoutDocument(migrated);

    expect(migrated.schemaVersion).toBe(5);
    expect(roundTripped.tree).toEqual(migrated.tree);
    expect(roundTripped.tree).toMatchObject({
      first: {
        contents: expect.arrayContaining([unknownContent]),
      },
    });
  });

  it("rejects detached references that are also owned by a pane", () => {
    const current = createDocument();

    expect(() =>
      createWorkspaceLayoutDocument({
        tree: current.tree,
        focusedPaneId: current.focusedPaneId,
        slots: current.slots,
        documents: [],
        detachedContents: [{ kind: "pty", slotId: "slot-1" }],
      }),
    ).toThrow(/duplicate ownership/i);

    const file = {
      id: "file-1",
      directoryId: 42,
      directoryPath: "C:\\Projects\\sample",
      relativePath: "README.md",
    };
    const fileTree = addWorkspaceFileToPane(current.tree, "pane-1", file.id);
    expect(() =>
      createWorkspaceLayoutDocument({
        tree: fileTree,
        focusedPaneId: current.focusedPaneId,
        slots: current.slots,
        documents: [file],
        detachedContents: [{ kind: "file", documentId: file.id }],
      }),
    ).toThrow(/duplicate ownership/i);
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
        detachedContents: [
          { kind: "pty", slotId: "slot-detached-a" },
          { kind: "pty", slotId: "slot-detached-b" },
        ],
      }),
    );

    const restored = rehomeDetachedWorkspaceContents(snapshot);

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
    expect(restored.detachedContents).toEqual([]);
  });

  it("rehomes detached files into the focused pane for restart hydration", () => {
    const document = createWorkspaceLayoutDocument({
      tree: {
        kind: "split",
        id: "split-root",
        direction: "horizontal",
        ratio: 0.5,
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
      slots: createDocument().slots,
      documents: [
        {
          id: "file-detached",
          directoryId: 42,
          directoryPath: "C:\\Projects\\sample",
          relativePath: "src/main.rs",
        },
      ],
      detachedContents: [{ kind: "file", documentId: "file-detached" }],
    });

    const restored = rehomeDetachedWorkspaceContents(
      restoreWorkspaceRuntimeSnapshot(document),
    );

    expect(restored.tree.kind).toBe("split");
    if (
      restored.tree.kind !== "split" ||
      restored.tree.second.kind !== "pane"
    ) {
      return;
    }
    expect(restored.tree.second.contents).toContainEqual({
      kind: "file",
      documentId: "file-detached",
    });
    expect(restored.documents).toEqual(document.documents);
    expect(restored.detachedContents).toEqual([]);
  });

  it("keeps a detached file out of a newly applied named layout", () => {
    const current = createDocument();
    const file = {
      id: "file-detached",
      directoryId: 42,
      directoryPath: "C:\\Projects\\sample",
      relativePath: "src/main.rs",
    };
    const presetTree = addWorkspaceFileToPane(current.tree, "pane-1", file.id);

    const restored = restoreCurrentWorkspaceFilesAfterPreset({
      tree: presetTree,
      focusedPaneId: "pane-2",
      restoredDocuments: [file],
      currentDocuments: [file],
      detachedContents: [],
      currentlyDetachedContents: [{ kind: "file", documentId: file.id }],
      detachingContents: [],
    });

    expect(listWorkspacePanes(restored.tree)[0].contents).not.toContainEqual({
      kind: "file",
      documentId: file.id,
    });
    expect(restored.documents).toEqual([file]);
    expect(restored.detachedContents).toEqual([
      { kind: "file", documentId: file.id },
    ]);
    expect(() =>
      createWorkspaceLayoutDocument({
        tree: restored.tree,
        focusedPaneId: "pane-2",
        slots: current.slots,
        documents: restored.documents,
        detachedContents: restored.detachedContents,
      }),
    ).not.toThrow();
  });

  it("keeps a detaching file uniquely owned while a named layout applies", () => {
    const current = createDocument();
    const file = {
      id: "file-detaching",
      directoryId: 42,
      directoryPath: "C:\\Projects\\sample",
      relativePath: "src/main.rs",
    };
    const presetTree = addWorkspaceFileToPane(current.tree, "pane-1", file.id);

    const restored = restoreCurrentWorkspaceFilesAfterPreset({
      tree: presetTree,
      focusedPaneId: "pane-2",
      restoredDocuments: [file],
      currentDocuments: [file],
      detachedContents: [],
      currentlyDetachedContents: [],
      detachingContents: [{ kind: "file", documentId: file.id }],
    });

    expect(
      listWorkspacePanes(restored.tree).flatMap((pane) => pane.contents),
    ).toEqual(
      expect.arrayContaining([
        { kind: "pty", slotId: "slot-1" },
        { kind: "file", documentId: file.id },
      ]),
    );
    expect(
      listWorkspacePanes(restored.tree)
        .flatMap((pane) => pane.contents)
        .filter(
          (content) =>
            content.kind === "file" && content.documentId === file.id,
        ),
    ).toHaveLength(1);
    expect(restored.detachedContents).toEqual([]);
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
            contents: ["invalid"].map((slotId) => ({
              kind: "pty" as const,
              slotId,
            })),
            activeContent: { kind: "pty", slotId: "invalid" },
          },
        },
        focusedPaneId: "pane-2",
        slots: ["saved", "live-outside", "detached", "ended", "invalid"].map(
          slot,
        ),
        detachedContents: [{ kind: "pty", slotId: "detached" }],
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
    expect(restored.detachedContents).toEqual([
      { kind: "pty", slotId: "detached" },
    ]);
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
      detachedContents: [],
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

describe("layout save results", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebases once on a stale rejection and then succeeds", async () => {
    const onError = vi.fn();
    const save = vi
      .fn()
      .mockResolvedValueOnce({ saved: false, reason: "stale", revision: 7 })
      .mockResolvedValueOnce({ saved: true, revision: 8 });
    const queue = new WorkspaceLayoutSaveQueue(5, save, onError);

    queue.enqueue(createDocument());
    await queue.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[0]).toBe(6);
    expect(save.mock.calls[1]?.[0]).toBe(8);
    expect(onError).not.toHaveBeenCalled();
    expect(save.mock.calls.length).toBeLessThan(10);
  });

  it("stops without retrying and reports once on an incompatible schema rejection", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let calls = 0;
    const save = vi.fn(async () => {
      calls += 1;
      if (calls > 20) throw new Error("spin guard");
      return { saved: false, reason: "incompatible", revision: 3 } as const;
    });
    const queue = new WorkspaceLayoutSaveQueue(5, save, onError);

    queue.enqueue(createDocument());
    await queue.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(WorkspaceLayoutSaveError);
    expect(reported.code).toBe("layout.schema_incompatible");

    queue.enqueue(createDocument());
    await queue.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[1]?.[0].code).toBe("layout.schema_incompatible");
    expect(vi.getTimerCount()).toBe(0);
    expect(save.mock.calls.length).toBeLessThan(10);
  });

  it("does not spin when the backend keeps rejecting without a reason", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let calls = 0;
    const save = vi.fn(async () => {
      calls += 1;
      if (calls > 20) throw new Error("spin guard");
      return { saved: false, revision: 5 };
    });
    const queue = new WorkspaceLayoutSaveQueue(5, save, onError);

    queue.enqueue(createDocument());
    await queue.flush();

    expect(save.mock.calls.length).toBeLessThanOrEqual(3);
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0]?.[0];
    expect(reported.code).toBe("layout.save_rejected");
    expect(String(reported.message)).not.toContain("spin guard");

    const callsAfterFirstRound = save.mock.calls.length;
    queue.enqueue(createDocument());
    await queue.flush();

    expect(save.mock.calls.length).toBeGreaterThan(callsAfterFirstRound);
    expect(calls).toBeLessThan(21);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("unsupported layout versions", () => {
  it.each([1, 2, 6])(
    "rejects schema version %s with an explicit error",
    (version) => {
      const v5Doc = createDocument();
      const migrate = () =>
        migrateWorkspaceLayoutDocument({ ...v5Doc, schemaVersion: version });

      expect(migrate).toThrow(/Unsupported workspace layout version/);
      let thrown: unknown;
      try {
        migrate();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedWorkspaceLayoutVersionError);
      expect((thrown as UnsupportedWorkspaceLayoutVersionError).code).toBe(
        "layout.needs_reset",
      );
      expect(() =>
        migrateWorkspaceLayoutDocument({ ...v5Doc, schemaVersion: 5 }),
      ).not.toThrow();
    },
  );
});

describe("persisted detached contents", () => {
  const pty = { kind: "pty", slotId: "s1" } as const;
  const paneOwner = {
    kind: "pane",
    windowLabel: "main",
    paneId: "p1",
  } as const;
  const windowOwner = { kind: "window", windowLabel: "terminal-x" } as const;

  function returningCoordinator() {
    const coordinator = new WorkspaceContentCoordinator();
    coordinator.beginDetach(pty, paneOwner, windowOwner, "t1");
    coordinator.completeHandoff(pty, "detachReady", "t1");
    coordinator.beginReturn(pty, "t2", "main", "p1");
    return coordinator;
  }

  it("keeps returning and window-closing contents outside the tree as detached", () => {
    const coordinator = returningCoordinator();
    const tree = createWorkspacePane("p1");

    expect(
      listPersistedDetachedContents(coordinator.listWindowOwned(), tree),
    ).toEqual([pty]);

    // 反向：detaching 阶段的内容仍在源 pane 的树里，不能再进 detachedContents。
    const s2 = { kind: "pty", slotId: "s2" } as const;
    coordinator.beginDetach(s2, paneOwner, windowOwner, "t3");
    const treeWithS2 = addSessionToWorkspacePane(tree, "p1", "s2");
    const result = listPersistedDetachedContents(
      coordinator.listWindowOwned(),
      treeWithS2,
    );
    expect(result).toEqual([pty]);
    expect(result).toHaveLength(1);
  });

  it("omits window-owned contents that are already in the tree", () => {
    const coordinator = returningCoordinator();
    const tree = addSessionToWorkspacePane(
      createWorkspacePane("p1"),
      "p1",
      "s1",
    );

    expect(
      listPersistedDetachedContents(coordinator.listWindowOwned(), tree),
    ).toEqual([]);
  });

  it("lets createWorkspaceLayoutDocument accept a returning PTY snapshot", () => {
    const coordinator = returningCoordinator();
    const tree = createWorkspacePane("p1");
    const slot = {
      instanceId: "s1",
      directoryId: 1,
      directoryPath: "C:/project",
      projectName: "Project",
      toolKey: "claude",
      sequence: 1,
      sessionId: "session-1",
      resumeSessionId: null,
      title: { kind: "automatic" },
    } as const;
    const snapshot = {
      tree,
      focusedPaneId: "p1",
      slots: [slot],
      documents: [],
    };

    const document = createWorkspaceLayoutDocument({
      ...snapshot,
      detachedContents: listPersistedDetachedContents(
        coordinator.listWindowOwned(),
        tree,
      ),
    });

    expect(document.detachedContents).toHaveLength(1);
    // 反向：不带 detachedContents 时同一调用抛 unowned，证明修复的必要性。
    expect(() =>
      createWorkspaceLayoutDocument({ ...snapshot, detachedContents: [] }),
    ).toThrow(/unowned content or focus/);
  });
});
