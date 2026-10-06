import { describe, expect, it, vi } from "vitest";
import { completeWorkspaceFileWindowSetup } from "./workspaceFileWindowSetup";

describe("workspace file window setup", () => {
  it("stops listeners and does not send ready when unmounted during initialization", async () => {
    let disposed = false;
    let resolveListeners!: (value: Array<() => void>) => void;
    const registerListeners = vi.fn(
      () =>
        new Promise<Array<() => void>>((resolve) => {
          resolveListeners = resolve;
        }),
    );
    const stop = vi.fn();
    const sendReady = vi.fn(async () => undefined);
    const setup = completeWorkspaceFileWindowSetup({
      registerListeners,
      isDisposed: () => disposed,
      keepListeners: vi.fn(),
      sendReady,
    });

    disposed = true;
    resolveListeners([stop]);

    await expect(setup).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(sendReady).not.toHaveBeenCalled();
  });
});
