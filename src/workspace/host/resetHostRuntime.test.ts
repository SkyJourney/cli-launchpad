import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_RESET_STEP_ORDER,
  resetHostRuntime,
  type HostRuntimeSteps,
} from "./resetHostRuntime";

function makeSteps(log: string[], failing?: string): HostRuntimeSteps {
  const step = (name: keyof HostRuntimeSteps) => () => {
    log.push(name);
    if (name === failing) throw new Error("boom");
  };
  return {
    rollbackPending: step("rollbackPending"),
    forgetWindowHandles: step("forgetWindowHandles"),
    releaseDocuments: step("releaseDocuments"),
    clearPtyRuntime: step("clearPtyRuntime"),
    rebuildCoordinator: step("rebuildCoordinator"),
  };
}

const FIXED_ORDER = [
  "rollbackPending",
  "forgetWindowHandles",
  "releaseDocuments",
  "clearPtyRuntime",
  "rebuildCoordinator",
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resetHostRuntime", () => {
  it("runs the steps in the fixed order for both reasons", () => {
    const log: string[] = [];

    expect(resetHostRuntime("hydrate", makeSteps(log))).toEqual(FIXED_ORDER);
    expect(log).toEqual(FIXED_ORDER);

    log.length = 0;
    resetHostRuntime("rehydrate", makeSteps(log));
    expect(log).toEqual(FIXED_ORDER);

    // 反向：顺序常量没有重复且长度为 5。
    expect(HOST_RESET_STEP_ORDER).toHaveLength(5);
    expect(new Set(HOST_RESET_STEP_ORDER).size).toBe(5);
  });

  it("a failing step is logged and does not prevent later steps", () => {
    const log: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(() =>
      resetHostRuntime("rehydrate", makeSteps(log, "releaseDocuments")),
    ).not.toThrow();
    expect(log).toEqual(FIXED_ORDER);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      "Workspace host reset step failed: releaseDocuments (rehydrate)",
    );
    expect(errorSpy.mock.calls[0]?.[1]).toEqual(new Error("boom"));

    // 反向：没有失败步骤时不记录错误。
    errorSpy.mockClear();
    resetHostRuntime("hydrate", makeSteps([]));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns the executed step names even when the first step fails", () => {
    const log: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const ran = resetHostRuntime("hydrate", makeSteps(log, "rollbackPending"));

    expect(ran).toHaveLength(5);
    expect(ran[0]).toBe("rollbackPending");
  });
});
