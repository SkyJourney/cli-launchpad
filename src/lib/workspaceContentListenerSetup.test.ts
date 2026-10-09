import { describe, expect, it, vi } from "vitest";
import {
  registerAllOrCleanup,
  setupWorkspaceContentListeners,
  WorkspaceListenerSetupError,
} from "./workspaceContentListenerSetup";

const instant = async () => undefined;

describe("setupWorkspaceContentListeners", () => {
  it("keeps successful registrations and reports only the failed one", async () => {
    const error = new Error("listener registration failed");
    const unlisten = vi.fn();
    const onFailed = vi.fn();
    const cleanup = await setupWorkspaceContentListeners({
      registrations: [
        { name: "healthy", register: async () => unlisten },
        {
          name: "broken",
          register: async () => {
            throw error;
          },
        },
      ],
      signal: new AbortController().signal,
      retryDelaysMs: [0],
      sleep: instant,
      onFailed,
    });

    expect(unlisten).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith([
      { name: "broken", attempts: 2, lastError: error },
    ]);
    cleanup();
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cleans registrations that resolve after the owner was disposed", async () => {
    const controller = new AbortController();
    const unlisten = vi.fn();
    let resolveRegistration: (stop: () => void) => void = () => undefined;
    const registration = new Promise<() => void>((resolve) => {
      resolveRegistration = resolve;
    });
    const setup = setupWorkspaceContentListeners({
      registrations: [{ name: "late", register: () => registration }],
      signal: controller.signal,
      onFailed: vi.fn(),
    });

    controller.abort();
    resolveRegistration(unlisten);
    const cleanup = await setup;

    expect(unlisten).toHaveBeenCalledOnce();
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("keeps successful listeners active until cleanup", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const cleanup = await setupWorkspaceContentListeners({
      registrations: [
        { name: "first", register: async () => first },
        { name: "second", register: async () => second },
      ],
      signal: new AbortController().signal,
      onFailed: vi.fn(),
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    cleanup();
    cleanup();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("retries a failed registration with the configured delays before reporting", async () => {
    const delays: number[] = [];
    const register = vi.fn(async () => {
      throw new Error("denied");
    });
    const onFailed = vi.fn();
    await setupWorkspaceContentListeners({
      registrations: [{ name: "event-x", register }],
      signal: new AbortController().signal,
      retryDelaysMs: [100, 300],
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      onFailed,
    });

    expect(register).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 300]);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it("does not report failures after the owner was disposed", async () => {
    const controller = new AbortController();
    const onFailed = vi.fn();
    await setupWorkspaceContentListeners({
      registrations: [
        {
          name: "broken",
          register: async () => {
            controller.abort();
            throw new Error("denied");
          },
        },
      ],
      signal: controller.signal,
      retryDelaysMs: [0],
      sleep: instant,
      onFailed,
    });

    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("registerAllOrCleanup", () => {
  it("returns every unlisten function when all registrations succeed", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stops = await registerAllOrCleanup([
      Promise.resolve(first),
      Promise.resolve(second),
    ]);
    expect(stops).toEqual([first, second]);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("cleans the successful registrations and throws an aggregate error when one fails", async () => {
    const unlisten = vi.fn();
    const failure = registerAllOrCleanup([
      Promise.resolve(unlisten),
      Promise.reject(new Error("denied")),
      Promise.reject(new Error("also denied")),
    ]);
    await expect(failure).rejects.toBeInstanceOf(WorkspaceListenerSetupError);
    await expect(failure).rejects.toThrow("denied; also denied");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
