import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitToMock, listenMock } = vi.hoisted(() => ({
  emitToMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: emitToMock,
  listen: listenMock,
}));

import {
  emitWorkspaceContentWindowEvent,
  getWorkspaceContentWindowLabelPrefix,
  listenWorkspaceContentWindowEvent,
  WORKSPACE_CONTENT_WINDOW_EVENT,
} from "./workspaceContentWindowProtocol";

describe("workspace content window protocol", () => {
  beforeEach(() => {
    emitToMock.mockReset();
    listenMock.mockReset();
  });

  it("multiplexes typed events through one listener and releases it last", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_name, handler) => {
      deliver = handler;
      return unlisten;
    });
    const ready = vi.fn();
    const failed = vi.fn();
    const stopReady = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      ready,
    );
    const stopFailed = await listenWorkspaceContentWindowEvent(
      "pty-detached-failed",
      failed,
    );

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith(
      WORKSPACE_CONTENT_WINDOW_EVENT,
      expect.any(Function),
    );
    deliver?.({
      payload: {
        apiVersion: 1,
        type: "pty-detached-ready",
        payload: {
          instanceId: "slot-1",
          sessionId: "session-1",
          windowLabel: "terminal-1",
        },
      },
    });
    expect(ready).toHaveBeenCalledWith({
      payload: {
        instanceId: "slot-1",
        sessionId: "session-1",
        windowLabel: "terminal-1",
      },
    });
    expect(failed).not.toHaveBeenCalled();

    stopReady();
    expect(unlisten).not.toHaveBeenCalled();
    stopFailed();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("emits versioned envelopes and centralizes per-kind labels", async () => {
    emitToMock.mockResolvedValue(undefined);
    const payload = {
      instanceId: "slot-1",
      sessionId: "session-1",
      windowLabel: "terminal-1",
    };
    await emitWorkspaceContentWindowEvent(
      "main",
      "pty-detached-ready",
      payload,
    );

    expect(emitToMock).toHaveBeenCalledWith(
      "main",
      WORKSPACE_CONTENT_WINDOW_EVENT,
      {
        apiVersion: 1,
        type: "pty-detached-ready",
        payload,
      },
    );
    expect(getWorkspaceContentWindowLabelPrefix("pty")).toBe("terminal-");
    expect(getWorkspaceContentWindowLabelPrefix("file")).toBe(
      "workspace-content-",
    );
  });

  it("ignores invalid versions and isolates rejected async handlers", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_name, handler) => {
      deliver = handler;
      return unlisten;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejected = vi.fn(async () => {
      throw new Error("handler failed");
    });
    const laterHandler = vi.fn();
    const stopRejected = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      rejected,
    );
    const stopLater = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      laterHandler,
    );

    deliver?.({
      payload: {
        apiVersion: 2,
        type: "pty-detached-ready",
        payload: {
          instanceId: "slot-1",
          sessionId: "session-1",
          windowLabel: "terminal-1",
        },
      },
    });
    expect(rejected).not.toHaveBeenCalled();
    expect(laterHandler).not.toHaveBeenCalled();

    deliver?.({
      payload: {
        apiVersion: 1,
        type: "pty-detached-ready",
        payload: {
          instanceId: "slot-1",
          sessionId: "session-1",
          windowLabel: "terminal-1",
        },
      },
    });
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    expect(laterHandler).toHaveBeenCalledOnce();

    stopRejected();
    stopLater();
    log.mockRestore();
  });
});
