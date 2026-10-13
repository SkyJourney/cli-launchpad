// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tauriMock } from "../../test/tauriMock";
import { parseWorkspaceContentDrag } from "../../lib/workspaceContentDrag";
import { useDetachedContentWindow } from "./useDetachedContentWindow";

const LABEL = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";

beforeEach(() => {
  tauriMock.setCurrentWindowLabel(LABEL);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(tauriMock.state.aclViolations).toEqual([]);
});

function renderKit(kind: "pty" | "file" = "file", id = "d1") {
  return renderHook(() => useDetachedContentWindow(kind, id));
}

function makeDataTransfer() {
  return { effectAllowed: "", setData: vi.fn() };
}

describe("useDetachedContentWindow", () => {
  it("returnTimer.arm fires the callback once after the delay", () => {
    vi.useFakeTimers();
    const { result } = renderKit();
    const cb = vi.fn();

    act(() => {
      result.current.returnTimer.arm(1000, cb);
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(cb).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("returnTimer.arm replaces a pending timer", () => {
    vi.useFakeTimers();
    const { result } = renderKit();
    const first = vi.fn();
    const second = vi.fn();

    act(() => {
      result.current.returnTimer.arm(1000, first);
    });
    act(() => {
      result.current.returnTimer.arm(1000, second);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("returnTimer.clear cancels a pending timer and is idempotent", () => {
    vi.useFakeTimers();
    const { result } = renderKit();
    const cb = vi.fn();

    act(() => {
      result.current.returnTimer.arm(1000, cb);
    });
    act(() => {
      result.current.returnTimer.clear();
      result.current.returnTimer.clear();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(cb).not.toHaveBeenCalled();
  });

  it("unmounting cancels a pending timer", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderKit();
    const cb = vi.fn();

    act(() => {
      result.current.returnTimer.arm(1000, cb);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(cb).not.toHaveBeenCalled();
  });

  it("setReturning updates the state and the ref synchronously", () => {
    const { result } = renderKit();
    const setReturning = result.current.setReturning;

    expect(result.current.returning).toBe(false);
    expect(result.current.isReturning()).toBe(false);

    act(() => {
      result.current.setReturning(true);
    });
    expect(result.current.returning).toBe(true);
    expect(result.current.isReturning()).toBe(true);
    expect(result.current.setReturning).toBe(setReturning);

    act(() => {
      result.current.setReturning(false);
    });
    expect(result.current.returning).toBe(false);
    expect(result.current.isReturning()).toBe(false);

    // 同一个 act 内，不等渲染即可读到 ref 的新值。
    act(() => {
      result.current.setReturning(true);
      expect(result.current.isReturning()).toBe(true);
    });
  });

  it("createDragStartHandler writes the content payload for the given kind and id", () => {
    const { result } = renderKit("pty", "slot-9");
    const dataTransfer = makeDataTransfer();
    const extra = vi.fn();
    const handler = result.current.createDragStartHandler(() => true, extra);

    handler({ dataTransfer, preventDefault: vi.fn() } as never);

    expect(dataTransfer.effectAllowed).toBe("move");
    expect(extra).toHaveBeenCalledTimes(1);
    expect(extra).toHaveBeenCalledWith(dataTransfer);
    const calls = dataTransfer.setData.mock.calls as Array<[string, string]>;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("application/x-cli-launchpad-workspace-content");
    expect(calls[1]).toEqual(["text/plain", calls[0][1]]);
    expect(parseWorkspaceContentDrag(calls[0][1])).toEqual({
      key: "pty:slot-9",
      sourceWindowLabel: LABEL,
    });
  });

  it("createDragStartHandler prevents the drag when disabled", () => {
    const { result } = renderKit("pty", "slot-9");
    const preventDefault = vi.fn();
    const dataTransfer = makeDataTransfer();
    const extra = vi.fn();

    result.current.createDragStartHandler(
      () => false,
      extra,
    )({
      dataTransfer,
      preventDefault,
    } as never);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(dataTransfer.setData).not.toHaveBeenCalled();
    expect(extra).not.toHaveBeenCalled();
  });

  it("destroyWindow destroys the current window and logs a failure instead of throwing", async () => {
    const { result } = renderKit();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await result.current.destroyWindow("destroy failed");
    expect(tauriMock.state.windowActions).toContainEqual(
      expect.objectContaining({ windowLabel: LABEL, action: "destroy" }),
    );
    expect(errorSpy).not.toHaveBeenCalled();

    const failure = new Error("boom");
    vi.mocked(getCurrentWindow).mockImplementationOnce(
      () =>
        ({
          label: LABEL,
          destroy: vi.fn(() => Promise.reject(failure)),
        }) as never,
    );
    await expect(
      result.current.destroyWindow("destroy failed"),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("destroy failed", failure);
  });

  it("windowLabel is the current window label and stays stable across renders", () => {
    const { result, rerender } = renderKit();
    expect(result.current.windowLabel).toBe(LABEL);

    rerender();
    expect(result.current.windowLabel).toBe(LABEL);
  });
});
