import { describe, expect, it } from "vitest";
import {
  defaultEngineId,
  getWorkspaceEditorEngine,
  resolveEditorEngine,
  registerWorkspaceEditorEngine,
} from "./workspaceEditorEngineRegistry";

describe("workspace editor engine registry", () => {
  it("registers and resolves engines by stable ID", () => {
    const engine = {
      id: "test.editor",
      apiVersion: 1 as const,
      releaseDocument: () => {},
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
      releaseDocument: () => {},
      View: () => null,
    });
    expect(() =>
      registerWorkspaceEditorEngine({
        id: "test.duplicate",
        apiVersion: 1,
        releaseDocument: () => {},
        View: () => null,
      }),
    ).toThrow("编辑器引擎 ID 已注册: test.duplicate");
    dispose();
  });

  it("rejects unsupported API versions", () => {
    expect(() =>
      registerWorkspaceEditorEngine({
        id: "test.unsupported-version",
        apiVersion: 2,
        releaseDocument: () => {},
        View: () => null,
      } as unknown as Parameters<typeof registerWorkspaceEditorEngine>[0]),
    ).toThrow("不支持编辑器引擎 API 版本: 2");
  });

  it("resolves a preferred engine and falls back to the registered default", () => {
    const unregisterDefault = registerWorkspaceEditorEngine({
      id: defaultEngineId,
      apiVersion: 1,
      releaseDocument: () => {},
      View: () => null,
    });
    const preferred = {
      id: "test.preferred",
      apiVersion: 1 as const,
      releaseDocument: () => {},
      View: () => null,
    };
    const unregisterPreferred = registerWorkspaceEditorEngine(preferred);

    expect(resolveEditorEngine(preferred.id)).toBe(preferred);
    expect(resolveEditorEngine("test.missing")).toBe(
      getWorkspaceEditorEngine(defaultEngineId),
    );

    unregisterPreferred();
    unregisterDefault();
  });

  it("returns undefined when the default engine is unavailable", () => {
    expect(resolveEditorEngine()).toBeUndefined();
  });
});
