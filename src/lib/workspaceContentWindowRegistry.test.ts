import { afterEach, describe, expect, it, vi } from "vitest";
import {
  promotePendingWorkspaceContentWindow,
  clearPendingWorkspaceContentWindows,
  registerPendingWorkspaceContentWindow,
  retainAsyncUnlisten,
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

  it("keeps only the window handle in the detached registry", () => {
    vi.useFakeTimers();
    const pending = new Map<
      string,
      { windowLabel: string; timer: number; token: string }
    >();
    const detached = new Map<string, { focus: () => void }>();
    const windowHandle = { focus: vi.fn() };
    registerPendingWorkspaceContentWindow({
      pending,
      key: "file:doc-1",
      timeoutMs: 100,
      record: { windowLabel: "workspace-content-1", token: "transfer-1" },
      onTimeout: vi.fn(),
    });

    promotePendingWorkspaceContentWindow({
      pending,
      detached,
      key: "file:doc-1",
      expectedWindowLabel: "workspace-content-1",
      toDetached: () => windowHandle,
    });

    expect(detached.get("file:doc-1")).toBe(windowHandle);
    expect(detached.get("file:doc-1")).not.toHaveProperty("token");
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

  it("cleans listener registrations when pending windows are taken or time out", () => {
    vi.useFakeTimers();
    const pending = new Map<
      string,
      { windowLabel: string; timer: number; cleanup: () => void }
    >();
    const cleanupAfterTake = vi.fn();
    const cleanupAfterTimeout = vi.fn();
    registerPendingWorkspaceContentWindow({
      pending,
      key: "ready-window",
      timeoutMs: 100,
      record: { windowLabel: "window-1", cleanup: cleanupAfterTake },
      onTimeout: vi.fn(),
    });
    registerPendingWorkspaceContentWindow({
      pending,
      key: "timed-out-window",
      timeoutMs: 100,
      record: { windowLabel: "window-2", cleanup: cleanupAfterTimeout },
      onTimeout: vi.fn(),
    });

    takePendingWorkspaceContentWindow(pending, "ready-window");
    vi.advanceTimersByTime(100);

    expect(cleanupAfterTake).toHaveBeenCalledOnce();
    expect(cleanupAfterTimeout).toHaveBeenCalledOnce();
  });

  it("unlistens when cleanup is requested before async registration resolves", async () => {
    let resolveRegistration: (unlisten: () => void) => void = () => undefined;
    const register = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveRegistration = resolve;
        }),
    );
    const cleanup = retainAsyncUnlisten(register);
    await Promise.resolve();
    cleanup();
    const unlisten = vi.fn();
    resolveRegistration(unlisten);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(register).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("forwards async listener registration failures to the owning workflow", async () => {
    const error = new Error("registration failed");
    const onError = vi.fn();
    const cleanup = retainAsyncUnlisten(() => Promise.reject(error), onError);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(error);
    cleanup();
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
