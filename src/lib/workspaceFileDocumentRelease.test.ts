import { describe, expect, it } from "vitest";
import type { WorkspaceFileDocument } from "./tauri";
import { droppedFileDocumentIds } from "./workspaceFileDocumentRelease";

function doc(id: string): WorkspaceFileDocument {
  return {
    id,
    directoryId: 1,
    directoryPath: "/p",
    relativePath: `${id}.txt`,
  };
}

describe("droppedFileDocumentIds", () => {
  it("returns ids present before and missing after in the previous order", () => {
    const previous = [doc("a"), doc("b"), doc("c")];
    const next = [doc("b")];

    const dropped = droppedFileDocumentIds(previous, next);

    expect(dropped).toEqual(["a", "c"]);
    expect(dropped).not.toContain("b");
  });

  it("keeps documents whose id survives even when their path or order changed", () => {
    const previous = [doc("a"), doc("b")];
    const next = [{ ...doc("b"), relativePath: "moved.txt" }, doc("a")];

    expect(droppedFileDocumentIds(previous, next)).toEqual([]);
  });

  it("handles empty inputs and duplicate ids without repeating a release", () => {
    expect(droppedFileDocumentIds([], [doc("a")])).toEqual([]);
    expect(droppedFileDocumentIds([doc("a"), doc("a")], [])).toEqual(["a"]);
    expect(droppedFileDocumentIds([doc("a")], [])).toEqual(["a"]);
  });
});
