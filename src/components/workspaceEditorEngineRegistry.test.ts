import { describe, expect, it } from "vitest";
import {
  getWorkspaceEditorEngine,
  registerWorkspaceEditorEngine,
} from "./workspaceEditorEngineRegistry";

describe("workspace editor engine registry", () => {
  it("registers and resolves engines by stable ID", () => {
    const engine = {
      id: "test.editor",
      apiVersion: 1 as const,
      View: () => null,
    };
    const dispose = registerWorkspaceEditorEngine(engine);
    expect(getWorkspaceEditorEngine(engine.id)).toBe(engine);
    dispose();
    expect(() => getWorkspaceEditorEngine(engine.id)).toThrow(
      "未注册编辑器引擎: test.editor",
    );
  });

  it("rejects duplicate engine IDs", () => {
    const dispose = registerWorkspaceEditorEngine({
      id: "test.duplicate",
      apiVersion: 1,
      View: () => null,
    });
    expect(() =>
      registerWorkspaceEditorEngine({
        id: "test.duplicate",
        apiVersion: 1,
        View: () => null,
      }),
    ).toThrow("编辑器引擎 ID 已注册: test.duplicate");
    dispose();
  });
});
