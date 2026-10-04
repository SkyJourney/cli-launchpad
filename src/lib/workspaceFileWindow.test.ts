import { describe, expect, it } from "vitest";
import { matchesWorkspaceFileWindow } from "./workspaceFileWindow";

describe("workspace file window identity", () => {
  const identity = {
    documentId: "file-1",
    token: "handoff-token",
    windowLabel: "workspace-content-123e4567-e89b-12d3-a456-426614174000",
  };

  it("accepts a matching one-time window identity", () => {
    expect(matchesWorkspaceFileWindow(identity, { ...identity })).toBe(true);
  });

  it.each([
    { ...identity, documentId: "file-2" },
    { ...identity, token: "other-token" },
    { ...identity, windowLabel: "workspace-content-user-controlled" },
  ])("rejects mismatched or invalid window identity", (actual) => {
    expect(matchesWorkspaceFileWindow(identity, actual)).toBe(false);
  });
});
