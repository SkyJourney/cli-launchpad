import { describe, expect, it, vi } from "vitest";
import { registerBuiltinContributions } from "../../bootstrap/registerBuiltinContributions";
import {
  getWorkspaceEditorEngine,
  recordEditorEngineUse,
  registerWorkspaceEditorEngine,
} from "../workspaceEditorEngineRegistry";
import { getWorkspaceContentAdapter } from "../workspaceContentAdapterRegistry";

describe("built-in file content adapter", () => {
  it("releases the editor model when a file content is disposed", async () => {
    const unregisterContributions = registerBuiltinContributions();
    const engine = getWorkspaceEditorEngine("core.monaco");
    const releaseDocument = vi
      .spyOn(engine, "releaseDocument")
      .mockResolvedValue(undefined);

    try {
      const adapter = getWorkspaceContentAdapter("file");
      await adapter.lifecycle?.dispose?.({
        content: { kind: "file", documentId: "doc-1" },
        owner: { kind: "pane", windowLabel: "main", paneId: "pane-1" },
        generation: 1,
        reason: "closed",
      });

      expect(releaseDocument).toHaveBeenCalledOnce();
      expect(releaseDocument).toHaveBeenCalledWith("doc-1");
    } finally {
      releaseDocument.mockRestore();
      unregisterContributions();
    }
  });

  it("releases the document through the engine that recorded its use", async () => {
    const unregisterContributions = registerBuiltinContributions();
    const monaco = getWorkspaceEditorEngine("core.monaco");
    const monacoRelease = vi
      .spyOn(monaco, "releaseDocument")
      .mockResolvedValue(undefined);
    const alternateRelease = vi.fn();
    const disposeAlternate = registerWorkspaceEditorEngine({
      id: "test.alternate",
      apiVersion: 1,
      releaseDocument: alternateRelease,
      View: () => null,
    });

    try {
      recordEditorEngineUse("doc-alternate", "test.alternate");

      await getWorkspaceContentAdapter("file").lifecycle?.dispose?.({
        content: { kind: "file", documentId: "doc-alternate" },
        owner: { kind: "pane", windowLabel: "main", paneId: "pane-1" },
        generation: 1,
        reason: "closed",
      });

      expect(alternateRelease).toHaveBeenCalledOnce();
      expect(alternateRelease).toHaveBeenCalledWith("doc-alternate");
      expect(monacoRelease).not.toHaveBeenCalled();
    } finally {
      disposeAlternate();
      monacoRelease.mockRestore();
      unregisterContributions();
    }
  });
});
