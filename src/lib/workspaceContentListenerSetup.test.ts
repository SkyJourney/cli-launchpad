import { describe, expect, it, vi } from "vitest";
import { setupWorkspaceContentListeners } from "./workspaceContentListenerSetup";

describe("setupWorkspaceContentListeners", () => {
  it("cleans successful registrations when another listener fails", async () => {
    const error = new Error("listener registration failed");
    const unlisten = vi.fn();
    const onError = vi.fn();
    const cleanup = await setupWorkspaceContentListeners({
      registrations: [Promise.resolve(unlisten), Promise.reject(error)],
      isDisposed: () => false,
      onError,
    });

    expect(unlisten).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith([error]);
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cleans registrations that resolve after the owner was disposed", async () => {
    let disposeOwner = false;
    const unlisten = vi.fn();
    let resolveRegistration: (stop: () => void) => void = () => undefined;
    const registration = new Promise<() => void>((resolve) => {
      resolveRegistration = resolve;
    });
    const setup = setupWorkspaceContentListeners({
      registrations: [registration],
      isDisposed: () => disposeOwner,
      onError: vi.fn(),
    });

    disposeOwner = true;
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
      registrations: [Promise.resolve(first), Promise.resolve(second)],
      isDisposed: () => false,
      onError: vi.fn(),
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    cleanup();
    cleanup();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
