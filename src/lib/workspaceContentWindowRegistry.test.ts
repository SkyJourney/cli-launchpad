import { afterEach, describe, expect, it, vi } from "vitest";
import {
  promotePendingWorkspaceContentWindow,
  clearPendingWorkspaceContentWindows,
  registerPendingWorkspaceContentWindow,
  takePendingWorkspaceContentWindow,
} from "./workspaceContentWindowRegistry";

describe("workspace content pending window registry", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects duplicate registration and preserves the original timeout", () => {
    vi.useFakeTimers();
    const pending = new Map<string, { windowLabel: string; timer: number }>();
    const onTimeout = vi.fn();
    const first = registerPendingWorkspaceContentWindow({
      pending,
      key: "file-1",
      timeoutMs: 100,
      record: { windowLabel: "window-1" },
      onTimeout,
    });
    expect(() =>
      registerPendingWorkspaceContentWindow({
        pending,
        key: "file-1",
        timeoutMs: 200,
        record: { windowLabel: "window-2" },
        onTimeout,
      }),
    ).toThrow("工作区内容窗口正在启动: file-1");

    vi.advanceTimersByTime(100);
    expect(pending.get("file-1")).toBeUndefined();
    expect(onTimeout).toHaveBeenCalledWith(first);
  });

  it("promotes an accepted window and cancels its timeout", () => {
    vi.useFakeTimers();
    const pending = new Map<string, { windowLabel: string; timer: number }>();
    const detached = new Map<string, { windowLabel: string; timer: number }>();
    const onTimeout = vi.fn();
    const registered = registerPendingWorkspaceContentWindow({
      pending,
      key: "pty-1",
      timeoutMs: 100,
      record: { windowLabel: "window-1" },
      onTimeout,
    });

    expect(
      promotePendingWorkspaceContentWindow({
        pending,
        detached,
        key: "pty-1",
        expectedWindowLabel: "window-1",
        toDetached: (record) => record,
      }),
    ).toBe(registered);
    vi.advanceTimersByTime(100);
    expect(pending.size).toBe(0);
    expect(detached.get("pty-1")).toBe(registered);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not take a registration belonging to another window", () => {
    vi.useFakeTimers();
    const pending = new Map<string, { windowLabel: string; timer: number }>();
    const record = registerPendingWorkspaceContentWindow({
      pending,
      key: "file-1",
      timeoutMs: 100,
      record: { windowLabel: "window-1" },
      onTimeout: vi.fn(),
    });

    expect(takePendingWorkspaceContentWindow(pending, "file-1", "wrong")).toBe(
      undefined,
    );
    expect(pending.get("file-1")).toBe(record);
    expect(takePendingWorkspaceContentWindow(pending, "file-1")).toBe(record);
    vi.advanceTimersByTime(100);
    expect(pending.size).toBe(0);
  });

  it("clears every pending timer and delegates owner-specific settlement", () => {
    vi.useFakeTimers();
    const pending = new Map<string, { windowLabel: string; timer: number }>();
    const onTimeout = vi.fn();
    const onClear = vi.fn();
    const first = registerPendingWorkspaceContentWindow({
      pending,
      key: "pty-1",
      timeoutMs: 100,
      record: { windowLabel: "window-1" },
      onTimeout,
    });
    const second = registerPendingWorkspaceContentWindow({
      pending,
      key: "file-1",
      timeoutMs: 100,
      record: { windowLabel: "window-2" },
      onTimeout,
    });

    clearPendingWorkspaceContentWindows(pending, onClear);
    vi.advanceTimersByTime(100);
    expect(pending.size).toBe(0);
    expect(onClear.mock.calls).toEqual([[first], [second]]);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
