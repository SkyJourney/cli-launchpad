import { describe, expect, it } from "vitest";
import { createWorkspaceEditorModelUri } from "./workspaceEditorModel";

describe("workspace editor model identity", () => {
  it("uses the project identity and an encoded project-relative path", () => {
    expect(createWorkspaceEditorModelUri(42, "src/组件 file.tsx")).toBe(
      "file:///cli-launchpad/42/src/%E7%BB%84%E4%BB%B6%20file.tsx",
    );
  });
});
