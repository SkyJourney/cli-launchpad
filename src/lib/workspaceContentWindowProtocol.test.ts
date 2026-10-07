import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitToMock, listenMock, getCurrentWebviewWindowMock } = vi.hoisted(
  () => ({
    emitToMock: vi.fn(),
    listenMock: vi.fn(),
    getCurrentWebviewWindowMock: vi.fn(),
  }),
);

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: emitToMock,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: getCurrentWebviewWindowMock,
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
    getCurrentWebviewWindowMock.mockReset();
    getCurrentWebviewWindowMock.mockReturnValue({ listen: listenMock });
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

  it("rejects file buffer events without safe epoch and version fields", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (_name, handler) => {
      deliver = handler;
      return vi.fn();
    });
    const changed = vi.fn();
    const stop = await listenWorkspaceContentWindowEvent(
      "workspace-file-window-buffer-changed",
      changed,
    );
    const envelope = (fileBuffer: Record<string, unknown>) => ({
      payload: {
        apiVersion: 1,
        type: "workspace-file-window-buffer-changed",
        payload: {
          documentId: "doc-1",
          token: "transfer-1",
          windowLabel: "workspace-content-1",
          fileBuffer,
        },
      },
    });
    const validBase = {
      kind: "text",
      content: "text",
      savedContent: "text",
      revision: "rev-1",
      saving: false,
    };

    deliver?.(envelope({ ...validBase, version: 0 }));
    deliver?.(envelope({ ...validBase, epoch: 0 }));
    deliver?.(envelope({ ...validBase, epoch: -1, version: 0 }));
    deliver?.(envelope({ ...validBase, epoch: 0, version: 1.5 }));
    expect(changed).not.toHaveBeenCalled();

    deliver?.(envelope({ ...validBase, epoch: 0, version: 0 }));
    expect(changed).toHaveBeenCalledOnce();
    stop();
  });

  it("validates payloads and isolates sync and async subscriber failures", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_name, handler) => {
      deliver = handler;
      return unlisten;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const thrown = vi.fn(() => {
      throw new Error("synchronous handler failed");
    });
    const rejected = vi.fn(async () => {
      throw new Error("handler failed");
    });
    const laterHandler = vi.fn();
    const stopThrown = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      thrown,
    );
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
    expect(thrown).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    expect(laterHandler).not.toHaveBeenCalled();

    deliver?.({
      payload: {
        apiVersion: 1,
        type: "pty-detached-ready",
        payload: { instanceId: "slot-1", sessionId: "session-1" },
      },
    });
    expect(thrown).not.toHaveBeenCalled();
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
    expect(thrown).toHaveBeenCalledOnce();
    expect(laterHandler).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));

    stopThrown();
    stopRejected();
    stopLater();
    log.mockRestore();
  });
});
