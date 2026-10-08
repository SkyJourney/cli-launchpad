import { describe, expect, it } from "vitest";
import {
  addSessionToWorkspacePane,
  createWorkspacePane,
} from "./ptyWorkspaceLayout";
import type { WorkspacePaneContentRef } from "./tauri";
import { WorkspaceContentCoordinator } from "./workspaceContentCoordinator";
import {
  canChangeWorkspaceContentPane,
  type WorkspaceContentLifecycleState,
} from "./workspaceContentLifecycle";
import { createWorkspaceLayoutDocument } from "./workspaceLayoutPersistence";
import {
  canChangePane,
  isHandoffActive,
  isWindowOwned,
  listPersistedDetachedContents,
  ownerWindowOf,
  projectPersistedOwnership,
  type OwnerWindow,
} from "./workspaceOwnershipProjection";

const content = { kind: "pty", slotId: "s1" } as const;
const paneOwner = { kind: "pane", windowLabel: "main", paneId: "p1" } as const;
const windowOwner = { kind: "window", windowLabel: "terminal-x" } as const;

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

type Phase =
  | "attached"
  | "detaching"
  | "detached"
  | "returning"
  | "closing-window"
  | "closing-pane"
  | "disposed";

/** 用真实 coordinator 驱动出各阶段；只有 disposed 手写（它是 closing 之后的终态）。 */
function stateFor(phase: Phase): WorkspaceContentLifecycleState {
  const coordinator = new WorkspaceContentCoordinator();
  if (phase === "disposed") {
    return { phase: "disposed", content, generation: 1 };
  }
  coordinator.ensureAttached(content, paneOwner);
  if (phase === "attached") return coordinator.get(content)!;
  if (phase === "closing-pane") {
    coordinator.approveClose(content, "close-1");
    return coordinator.get(content)!;
  }
  coordinator.beginDetach(content, paneOwner, windowOwner, "t1");
  if (phase === "detaching") return coordinator.get(content)!;
  coordinator.completeHandoff(content, "detachReady", "t1");
  if (phase === "detached") return coordinator.get(content)!;
  if (phase === "closing-window") {
    coordinator.approveClose(content, "close-2");
    return coordinator.get(content)!;
  }
  coordinator.beginReturn(content, "t2", "main", "p1");
  return coordinator.get(content)!;
}

interface Expectation {
  isWindowOwned: boolean;
  isHandoffActive: boolean;
  owner: (state: WorkspaceContentLifecycleState) => OwnerWindow | null;
  persistedDetached: number;
  inTree: boolean;
}

const tokenOf = (state: WorkspaceContentLifecycleState) =>
  (state as { windowToken?: string }).windowToken;

// 与目标文档 2.1 节“阶段到位置的权威表”逐行对应。
const phaseTable: Array<[Phase, Expectation]> = [
  [
    "attached",
    {
      isWindowOwned: false,
      isHandoffActive: false,
      owner: () => null,
      persistedDetached: 0,
      inTree: true,
    },
  ],
  [
    "detaching",
    {
      isWindowOwned: true,
      isHandoffActive: true,
      owner: () => null,
      persistedDetached: 0,
      inTree: true,
    },
  ],
  [
    "detached",
    {
      isWindowOwned: true,
      isHandoffActive: false,
      owner: (state) => ({
        windowLabel: "terminal-x",
        windowToken: tokenOf(state) as string,
      }),
      persistedDetached: 1,
      inTree: false,
    },
  ],
  [
    "returning",
    {
      isWindowOwned: true,
      isHandoffActive: true,
      owner: (state) => ({
        windowLabel: "terminal-x",
        windowToken: tokenOf(state) as string,
      }),
      persistedDetached: 1,
      inTree: false,
    },
  ],
  [
    "closing-window",
    {
      isWindowOwned: true,
      isHandoffActive: false,
      owner: (state) => ({
        windowLabel: "terminal-x",
        windowToken: tokenOf(state) ?? null,
      }),
      persistedDetached: 1,
      inTree: false,
    },
  ],
  [
    "closing-pane",
    {
      isWindowOwned: false,
      isHandoffActive: false,
      owner: () => null,
      persistedDetached: 0,
      inTree: true,
    },
  ],
  [
    "disposed",
    {
      isWindowOwned: false,
      isHandoffActive: false,
      owner: () => null,
      persistedDetached: 0,
      inTree: false,
    },
  ],
];

describe("workspace ownership projection", () => {
  it.each(phaseTable)("classifies %s", (phase, expected) => {
    const state = stateFor(phase);

    expect(isWindowOwned(state)).toBe(expected.isWindowOwned);
    expect(isHandoffActive(state)).toBe(expected.isHandoffActive);
    expect(ownerWindowOf(state)).toEqual(expected.owner(state));
    if (phase === "detached" || phase === "returning") {
      // token 来自 coordinator 的真实状态，不是手写常量。
      expect(ownerWindowOf(state)?.windowToken).toBeTruthy();
    }
  });

  it("treats a missing lifecycle state as not owned by any window", () => {
    expect(ownerWindowOf(undefined)).toBeNull();
    expect(isWindowOwned(undefined)).toBe(false);
    expect(isHandoffActive(undefined)).toBe(false);
  });

  it("builds a valid layout document for every lifecycle phase", () => {
    for (const [phase, expected] of phaseTable) {
      const state = stateFor(phase);
      const base = createWorkspacePane("p1");
      const tree = expected.inTree
        ? addSessionToWorkspacePane(base, "p1", "s1")
        : base;
      const { detachedContents } = projectPersistedOwnership(tree, [state]);

      expect(detachedContents, phase).toHaveLength(expected.persistedDetached);
      if (phase === "disposed") continue;
      expect(
        () =>
          createWorkspaceLayoutDocument({
            tree,
            focusedPaneId: "p1",
            slots: [slot],
            documents: [],
            detachedContents,
          }),
        phase,
      ).not.toThrow();
    }
  });

  it("deduplicates repeated window-owned contents and keeps their order", () => {
    const windowOwned: WorkspacePaneContentRef[] = [
      { kind: "file", documentId: "d2" },
      { kind: "pty", slotId: "s1" },
      { kind: "file", documentId: "d2" },
    ];

    const result = listPersistedDetachedContents(
      windowOwned,
      createWorkspacePane("p1"),
    );

    expect(result).toEqual([
      { kind: "file", documentId: "d2" },
      { kind: "pty", slotId: "s1" },
    ]);
    expect(result[0]).not.toBe(windowOwned[0]);
    expect(result[1]).not.toBe(windowOwned[1]);
  });

  it("does not mutate the tree", () => {
    const tree = addSessionToWorkspacePane(
      createWorkspacePane("p1"),
      "p1",
      "s1",
    );
    const before = JSON.stringify(tree);

    const result = projectPersistedOwnership(tree, [stateFor("returning")]);

    expect(JSON.stringify(tree)).toBe(before);
    expect(result).not.toHaveProperty("tree");
  });

  it("exports canChangePane as the lifecycle predicate", () => {
    expect(canChangePane).toBe(canChangeWorkspaceContentPane);
    expect(canChangePane(stateFor("attached"))).toBe(true);
    expect(canChangePane(stateFor("closing-pane"))).toBe(false);
  });
});
