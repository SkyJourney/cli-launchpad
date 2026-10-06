import { describe, expect, it } from "vitest";
import {
  registerWorkspaceEditorModel,
  takeWorkspaceEditorModelUris,
} from "./workspaceEditorModelRegistry";

describe("workspace editor model registry", () => {
  it("tracks and drains every model URI for a document", () => {
    registerWorkspaceEditorModel("doc-1", "file:///doc-1?epoch=0");
    registerWorkspaceEditorModel("doc-1", "file:///doc-1?epoch=1");
    registerWorkspaceEditorModel("doc-2", "file:///doc-2?epoch=0");

    expect(takeWorkspaceEditorModelUris("doc-1")).toEqual([
      "file:///doc-1?epoch=0",
      "file:///doc-1?epoch=1",
    ]);
    expect(takeWorkspaceEditorModelUris("doc-1")).toEqual([]);
    expect(takeWorkspaceEditorModelUris("doc-2")).toEqual([
      "file:///doc-2?epoch=0",
    ]);
  });
});
