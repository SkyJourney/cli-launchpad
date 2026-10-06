import { describe, expect, it, vi } from "vitest";
import { registerBuiltinContributions } from "../../bootstrap/registerBuiltinContributions";
import { getWorkspaceEditorEngine } from "../workspaceEditorEngineRegistry";
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
});
