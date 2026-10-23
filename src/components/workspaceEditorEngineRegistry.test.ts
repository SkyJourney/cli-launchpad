import { describe, expect, it, vi } from "vitest";
import {
  defaultEngineId,
  getWorkspaceEditorEngine,
  listWorkspaceEditorEngines,
  recordedEditorEngineId,
  recordEditorEngineUse,
  releaseEditorDocument,
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

  it("lists registered engines in registration order", () => {
    const make = (id: string) => ({
      id,
      apiVersion: 1 as const,
      releaseDocument: () => {},
      View: () => null,
    });
    const unregisterA = registerWorkspaceEditorEngine(make("test.list-a"));
    const unregisterB = registerWorkspaceEditorEngine(make("test.list-b"));
    try {
      expect(listWorkspaceEditorEngines().map((engine) => engine.id)).toEqual([
        "test.list-a",
        "test.list-b",
      ]);
    } finally {
      unregisterB();
      unregisterA();
    }
    // Reverse: both are gone after unregistering.
    const ids = listWorkspaceEditorEngines().map((engine) => engine.id);
    expect(ids).not.toContain("test.list-a");
    expect(ids).not.toContain("test.list-b");
  });

  it("releases a document through the engine that recorded its use, not the default engine", async () => {
    const releasedByDefault = vi.fn();
    const releasedByRecorded = vi.fn();
    const disposeDefault = registerWorkspaceEditorEngine({
      id: defaultEngineId,
      apiVersion: 1,
      releaseDocument: releasedByDefault,
      View: () => null,
    });
    const disposeRecorded = registerWorkspaceEditorEngine({
      id: "test.recorded",
      apiVersion: 1,
      releaseDocument: releasedByRecorded,
      View: () => null,
    });

    try {
      recordEditorEngineUse("doc-recorded", "test.recorded");
      expect(recordedEditorEngineId("doc-recorded")).toBe("test.recorded");

      await releaseEditorDocument("doc-recorded");

      expect(releasedByRecorded).toHaveBeenCalledOnce();
      expect(releasedByRecorded).toHaveBeenCalledWith("doc-recorded");
      expect(releasedByDefault).not.toHaveBeenCalled();
      expect(recordedEditorEngineId("doc-recorded")).toBeUndefined();

      await releaseEditorDocument("doc-recorded");
      expect(releasedByDefault).toHaveBeenCalledOnce();
    } finally {
      disposeRecorded();
      disposeDefault();
    }
  });

  it("falls back to the default engine when no engine use was recorded", async () => {
    const releasedByDefault = vi.fn();
    const disposeDefault = registerWorkspaceEditorEngine({
      id: defaultEngineId,
      apiVersion: 1,
      releaseDocument: releasedByDefault,
      View: () => null,
    });

    try {
      await releaseEditorDocument("doc-unrecorded");

      expect(releasedByDefault).toHaveBeenCalledOnce();
      expect(releasedByDefault).toHaveBeenCalledWith("doc-unrecorded");
    } finally {
      disposeDefault();
    }
  });

  it("does nothing and does not fall back when the recorded engine is no longer registered", async () => {
    const releasedByDefault = vi.fn();
    const disposeDefault = registerWorkspaceEditorEngine({
      id: defaultEngineId,
      apiVersion: 1,
      releaseDocument: releasedByDefault,
      View: () => null,
    });

    try {
      recordEditorEngineUse("doc-gone", "test.gone");

      await expect(
        Promise.resolve(releaseEditorDocument("doc-gone")),
      ).resolves.toBeUndefined();

      expect(releasedByDefault).not.toHaveBeenCalled();
      expect(recordedEditorEngineId("doc-gone")).toBeUndefined();
    } finally {
      disposeDefault();
    }
  });
});
