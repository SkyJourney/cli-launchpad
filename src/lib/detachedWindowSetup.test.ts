import { describe, expect, it, vi } from "vitest";
import { completeDetachedWindowSetup } from "./detachedWindowSetup";

describe("detached window setup", () => {
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
    const afterListeners = vi.fn(async () => undefined);
    const setup = completeDetachedWindowSetup({
      registerListeners,
      isDisposed: () => disposed,
      keepListeners: vi.fn(),
      afterListeners,
    });

    disposed = true;
    resolveListeners([stop]);

    await expect(setup).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(afterListeners).not.toHaveBeenCalled();
  });

  it("keeps the listeners and then runs the continuation in order", async () => {
    const order: string[] = [];
    const stop = vi.fn();
    const keepListeners = vi.fn(() => order.push("keep"));
    const afterListeners = vi.fn(async () => {
      order.push("after");
    });

    const result = await completeDetachedWindowSetup({
      registerListeners: async () => {
        order.push("register");
        return [stop];
      },
      isDisposed: () => false,
      keepListeners,
      afterListeners,
    });

    expect(result).toBe(true);
    expect(order).toEqual(["register", "keep", "after"]);
    expect(keepListeners).toHaveBeenCalledWith([stop]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not run the continuation when the window is disposed right after the listeners were kept", async () => {
    let disposed = false;
    const stop = vi.fn();
    const afterListeners = vi.fn(async () => undefined);

    const result = await completeDetachedWindowSetup({
      registerListeners: async () => [stop],
      isDisposed: () => disposed,
      keepListeners: () => {
        disposed = true;
      },
      afterListeners,
    });

    expect(result).toBe(false);
    expect(afterListeners).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("propagates a listener registration failure without keeping or continuing", async () => {
    const keepListeners = vi.fn();
    const afterListeners = vi.fn(async () => undefined);

    await expect(
      completeDetachedWindowSetup({
        registerListeners: async () => {
          throw new Error("registration failed");
        },
        isDisposed: () => false,
        keepListeners,
        afterListeners,
      }),
    ).rejects.toThrow("registration failed");

    expect(keepListeners).not.toHaveBeenCalled();
    expect(afterListeners).not.toHaveBeenCalled();
  });
});
