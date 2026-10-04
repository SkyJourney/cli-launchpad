import { describe, expect, it } from "vitest";
import {
  createWorkspacePane,
  findWorkspacePane,
  splitWorkspacePane,
} from "./ptyWorkspaceLayout";
import { addWorkspaceFileToPane } from "./ptyWorkspaceLayout";
import { closeWorkspaceFileState } from "./workspaceFileClose";

describe("workspace file close state", () => {
  it("closes a file in either pane and clears its document and buffer", () => {
    for (const ownerPaneId of ["first", "second"]) {
      const split = splitWorkspacePane(
        createWorkspacePane("first"),
        "first",
        "horizontal",
        "split",
        "second",
      );
      const tree = addWorkspaceFileToPane(split, ownerPaneId, "file-a");
      const document = {
        id: "file-a",
        directoryId: 1,
        directoryPath: "C:/project",
        relativePath: "README.md",
      };
      const buffer = {
        content: "contents",
        savedContent: "contents",
        revision: "revision-a",
        saving: false,
      };

      const closed = closeWorkspaceFileState(
        { tree, documents: [document], buffers: { "file-a": buffer } },
        ["file-a"],
      );

      expect(closed.closedDocumentIds).toEqual(["file-a"]);
      expect(closed.documents).toEqual([]);
      expect(closed.buffers).toEqual({});
      expect(findWorkspacePane(closed.tree, ownerPaneId)?.contents).toEqual([]);
    }
  });
});
