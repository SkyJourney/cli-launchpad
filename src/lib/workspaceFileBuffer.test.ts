import { describe, expect, it } from "vitest";
import {
  completeWorkspaceFileSave,
  createWorkspaceFileBuffer,
  failWorkspaceFileSave,
} from "./workspaceFileBuffer";

describe("workspace file save transitions", () => {
  it("keeps edits typed while an earlier snapshot is being saved", () => {
    const submitted = {
      content: "first draft",
      savedContent: "original",
      revision: "old-revision",
      saving: true,
    };
    const current = { ...submitted, content: "newer draft" };

    expect(
      completeWorkspaceFileSave(current, submitted, {
        content: "first draft",
        revision: "new-revision",
      }),
    ).toEqual({
      content: "newer draft",
      savedContent: "first draft",
      revision: "new-revision",
      saving: false,
    });
  });

  it("preserves the current draft after a failed save", () => {
    const submitted = {
      content: "submitted",
      savedContent: "original",
      revision: "revision",
      saving: true,
    };
    const current = { ...submitted, content: "latest" };

    expect(failWorkspaceFileSave(current, submitted)).toEqual({
      ...current,
      saving: false,
    });
  });
});

describe("workspace file open results", () => {
  it("turns a bounded image result into an inert data URL preview", () => {
    expect(
      createWorkspaceFileBuffer({
        kind: "image",
        mimeType: "image/png",
        base64Data: "cG5n",
      }),
    ).toEqual({
      kind: "image",
      content: "",
      savedContent: "",
      revision: "",
      saving: false,
      previewDataUrl: "data:image/png;base64,cG5n",
    });
  });

  it("keeps unsupported files clean and safe to close", () => {
    const buffer = createWorkspaceFileBuffer({
      kind: "unsupported",
      reason: "binary",
    });

    expect(buffer.kind).toBe("unsupported");
    expect(buffer.content).toBe(buffer.savedContent);
    expect(buffer.unsupportedReason).toBe("binary");
  });
});
