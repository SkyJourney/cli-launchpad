import { describe, expect, it } from "vitest";
import {
  addWorkspaceContentToPane,
  createWorkspacePane,
  findWorkspacePane,
  hasWorkspaceContent,
  listWorkspacePanes,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import type { WorkspacePaneContentRef } from "./tauri";
import {
  planWorkspaceReturn,
  reduceWorkspaceTree,
} from "./workspaceContentCommand";

function treeWithTwoPanes(): WorkspaceNode {
  return {
    kind: "split",
    id: "split-1",
    direction: "horizontal",
    ratio: 0.5,
    first: addWorkspaceContentToPane(createWorkspacePane("pane-1"), "pane-1", {
      kind: "pty",
      slotId: "slot-1",
    }),
    second: addWorkspaceContentToPane(createWorkspacePane("pane-2"), "pane-2", {
      kind: "file",
      documentId: "file-1",
    }),
  };
}

describe("reduceWorkspaceTree", () => {
  it("moves either content kind exclusively and honors an insertion index", () => {
    const tree = treeWithTwoPanes();
    const moved = reduceWorkspaceTree(tree, {
      type: "move",
      ref: { kind: "file", documentId: "file-1" },
      toPaneId: "pane-1",
      index: 0,
    });

    expect(findWorkspacePane(moved, "pane-2")?.contents).toEqual([]);
    expect(findWorkspacePane(moved, "pane-1")?.contents).toEqual([
      { kind: "file", documentId: "file-1" },
      { kind: "pty", slotId: "slot-1" },
    ]);
  });

  it("splits and activates through the generic content reference", () => {
    const split = reduceWorkspaceTree(treeWithTwoPanes(), {
      type: "split",
      ref: { kind: "file", documentId: "file-1" },
      toPaneId: "pane-3",
      direction: "vertical",
      splitId: "split-2",
    });
    const activated = reduceWorkspaceTree(split, {
      type: "activate",
      ref: { kind: "file", documentId: "file-1" },
      paneId: "pane-3",
    });

    expect(findWorkspacePane(activated, "pane-2")?.contents).toEqual([]);
    expect(findWorkspacePane(activated, "pane-3")?.activeContent).toEqual({
      kind: "file",
      documentId: "file-1",
    });
  });

  it("keeps unknown content in place when move or detach is requested", () => {
    const unknown = {
      kind: "unknown",
      originalKind: "markdownPreview",
      raw: { kind: "markdownPreview", source: "README.md" },
    } as const;
    const tree: WorkspaceNode = {
      kind: "pane",
      id: "pane-1",
      paneNumber: 1,
      contents: [unknown],
      activeContent: unknown,
    };

    expect(
      reduceWorkspaceTree(tree, {
        type: "move",
        ref: unknown,
        toPaneId: "pane-2",
      }),
    ).toBe(tree);
    expect(reduceWorkspaceTree(tree, { type: "detach", ref: unknown })).toBe(
      tree,
    );
    expect(
      reduceWorkspaceTree(tree, {
        type: "split",
        ref: unknown,
        toPaneId: "pane-2",
        direction: "horizontal",
        splitId: "split-1",
      }),
    ).toBe(tree);
    expect(
      reduceWorkspaceTree(tree, {
        type: "return",
        ref: unknown,
        toPaneId: "pane-1",
      }),
    ).toBe(tree);
  });

  it("closes mixed content and returns detached content to one pane", () => {
    const tree = treeWithTwoPanes();
    const detached = reduceWorkspaceTree(tree, {
      type: "detach",
      ref: { kind: "file", documentId: "file-1" },
    });
    const returned = reduceWorkspaceTree(detached, {
      type: "return",
      ref: { kind: "file", documentId: "file-1" },
      toPaneId: "pane-1",
    });
    const closed = reduceWorkspaceTree(returned, {
      type: "close",
      origin: "menu",
      refs: [
        { kind: "file", documentId: "file-1" },
        { kind: "pty", slotId: "slot-1" },
      ],
    });

    expect(listWorkspacePanes(closed).flatMap((pane) => pane.contents)).toEqual(
      [],
    );
  });
});

describe("planWorkspaceReturn", () => {
  const pty = { kind: "pty", slotId: "slot-ret" } as const;
  const file = { kind: "file", documentId: "doc-ret" } as const;
  const paneA = "pane-1";
  const paneB = "pane-2";

  /** 两个空 pane（内容尚未回到树里），与 treeWithTwoPanes 的内容互不干扰。 */
  function emptyTwoPanes(): WorkspaceNode {
    return {
      kind: "split",
      id: "split-ret",
      direction: "horizontal",
      ratio: 0.5,
      first: createWorkspacePane(paneA),
      second: createWorkspacePane(paneB, 2),
    };
  }
  const countPanesWith = (tree: WorkspaceNode, ref: WorkspacePaneContentRef) =>
    listWorkspacePanes(tree).filter((pane) => hasWorkspaceContent(pane, ref))
      .length;
  const place = (
    tree: WorkspaceNode,
    ref: WorkspacePaneContentRef,
    toPaneId: string,
  ) => reduceWorkspaceTree(tree, { type: "return", ref, toPaneId });

  it("returns a PTY into the requested pane when it is not in the tree", () => {
    const tree = emptyTwoPanes();

    const plan = planWorkspaceReturn(tree, {
      ref: pty,
      requestedPaneId: paneB,
      focusedPaneId: paneA,
      whenAlreadyInTree: "activate",
    });

    expect(plan).not.toBeNull();
    expect(plan!.focusPaneId).toBe(paneB);
    expect(findWorkspacePane(plan!.nextTree, paneB)?.contents).toContainEqual(
      pty,
    );
    expect(countPanesWith(plan!.nextTree, pty)).toBe(1);
    // 反向：没有放进焦点 pane。
    expect(
      findWorkspacePane(plan!.nextTree, paneA)?.contents ?? [],
    ).not.toContainEqual(pty);
  });

  it("activates a PTY that is already in the tree instead of moving it", () => {
    const tree = place(emptyTwoPanes(), pty, paneA);

    const plan = planWorkspaceReturn(tree, {
      ref: pty,
      requestedPaneId: paneB,
      focusedPaneId: paneB,
      whenAlreadyInTree: "activate",
    });

    expect(plan!.focusPaneId).toBe(paneA);
    expect(countPanesWith(plan!.nextTree, pty)).toBe(1);
    expect(findWorkspacePane(plan!.nextTree, paneA)?.activeContent).toEqual(
      pty,
    );
    // 反向：没有被请求的 pane 抢走。
    expect(
      findWorkspacePane(plan!.nextTree, paneB)?.contents ?? [],
    ).not.toContainEqual(pty);
  });

  it("falls back to the focused pane when the requested pane no longer exists", () => {
    const tree = emptyTwoPanes();

    const plan = planWorkspaceReturn(tree, {
      ref: pty,
      requestedPaneId: "missing-pane",
      focusedPaneId: paneB,
      whenAlreadyInTree: "activate",
    });

    expect(plan!.focusPaneId).toBe(paneB);
    expect(findWorkspacePane(plan!.nextTree, paneB)?.contents).toContainEqual(
      pty,
    );
    expect(countPanesWith(plan!.nextTree, pty)).toBe(1);
    // 反向：没有凭空创建 pane。
    expect(findWorkspacePane(plan!.nextTree, "missing-pane")).toBeNull();
  });

  it("falls back to the first pane when neither the requested nor the focused pane exists", () => {
    const tree = emptyTwoPanes();

    const plan = planWorkspaceReturn(tree, {
      ref: pty,
      requestedPaneId: null,
      focusedPaneId: "missing-pane",
      whenAlreadyInTree: "activate",
    });

    const first = listWorkspacePanes(tree)[0].id;
    expect(plan!.focusPaneId).toBe(first);
    expect(findWorkspacePane(plan!.nextTree, first)?.contents).toContainEqual(
      pty,
    );
    expect(countPanesWith(plan!.nextTree, pty)).toBe(1);
  });

  it("relocates a file into the pane that already holds it when no pane is requested", () => {
    const tree = place(emptyTwoPanes(), file, paneB);

    const plan = planWorkspaceReturn(tree, {
      ref: file,
      requestedPaneId: undefined,
      focusedPaneId: paneA,
      whenAlreadyInTree: "relocate",
    });

    expect(plan!.focusPaneId).toBe(paneB);
    expect(countPanesWith(plan!.nextTree, file)).toBe(1);
    expect(findWorkspacePane(plan!.nextTree, paneB)?.contents).toContainEqual(
      file,
    );
    // 反向：焦点 pane 不能抢先于已含该文档的 pane。
    expect(
      findWorkspacePane(plan!.nextTree, paneA)?.contents ?? [],
    ).not.toContainEqual(file);
  });

  it("relocates a file exclusively into the requested pane even when another pane holds it", () => {
    const tree = place(emptyTwoPanes(), file, paneB);

    const plan = planWorkspaceReturn(tree, {
      ref: file,
      requestedPaneId: paneA,
      focusedPaneId: paneB,
      whenAlreadyInTree: "relocate",
    });

    expect(plan!.focusPaneId).toBe(paneA);
    expect(countPanesWith(plan!.nextTree, file)).toBe(1);
    expect(findWorkspacePane(plan!.nextTree, paneA)?.contents).toContainEqual(
      file,
    );
    // 反向：placeContentExclusively 把它从旧 pane 移走。
    expect(
      findWorkspacePane(plan!.nextTree, paneB)?.contents ?? [],
    ).not.toContainEqual(file);
  });

  it("returns null for unknown content and never changes the tree", () => {
    const tree = emptyTwoPanes();
    const before = JSON.stringify(tree);
    const unknown: WorkspacePaneContentRef = {
      kind: "unknown",
      originalKind: "markdownPreview",
      raw: { kind: "markdownPreview" },
    };

    for (const whenAlreadyInTree of ["activate", "relocate"] as const) {
      expect(
        planWorkspaceReturn(tree, {
          ref: unknown,
          requestedPaneId: paneA,
          focusedPaneId: paneA,
          whenAlreadyInTree,
        }),
      ).toBeNull();
    }
    // 反向断言：未知内容不改变输入树。
    expect(JSON.stringify(tree)).toBe(before);
  });
});
