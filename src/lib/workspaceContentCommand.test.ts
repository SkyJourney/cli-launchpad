import { describe, expect, it } from "vitest";
import {
  addWorkspaceContentToPane,
  createWorkspacePane,
  findWorkspacePane,
  listWorkspacePanes,
  type WorkspaceNode,
} from "./ptyWorkspaceLayout";
import { executeWorkspaceCommand } from "./workspaceContentCommand";

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

describe("executeWorkspaceCommand", () => {
  it("moves either content kind exclusively and honors an insertion index", () => {
    const tree = treeWithTwoPanes();
    const moved = executeWorkspaceCommand(tree, {
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
    const split = executeWorkspaceCommand(treeWithTwoPanes(), {
      type: "split",
      ref: { kind: "file", documentId: "file-1" },
      toPaneId: "pane-3",
      direction: "vertical",
      splitId: "split-2",
    });
    const activated = executeWorkspaceCommand(split, {
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

  it("closes mixed content and returns detached content to one pane", () => {
    const tree = treeWithTwoPanes();
    const detached = executeWorkspaceCommand(tree, {
      type: "detach",
      ref: { kind: "file", documentId: "file-1" },
    });
    const returned = executeWorkspaceCommand(detached, {
      type: "return",
      ref: { kind: "file", documentId: "file-1" },
      toPaneId: "pane-1",
    });
    const closed = executeWorkspaceCommand(returned, {
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
