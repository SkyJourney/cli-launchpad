// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { onInboxEvent } from "./windowInbox";
import {
  emitWorkspaceContentWindowEvent,
  getWorkspaceContentWindowLabelPrefix,
  listenWorkspaceContentWindowEvent,
} from "./workspaceContentWindowProtocol";

const TERMINAL = "terminal-8e783338-f464-4b10-b15e-b534748c6241";

function envelope(type: string, payload: unknown) {
  return { apiVersion: 1, type, payload };
}

/** Delivers a relayed message to the main window's inbox, stamped with `source`. */
function deliverToMain(
  type: string,
  payload: unknown,
  source: { label: string; kind: "main" | "terminal" | "workspaceContent" },
  apiVersion = 1,
) {
  tauriMock.deliverInbox(
    "main",
    "window-message",
    { ...envelope(type, payload), apiVersion },
    source,
  );
}

const terminalSource = (label: string) => ({
  label,
  kind: "terminal" as const,
});

describe("workspace content window protocol", () => {
  it("routes typed messages by type through the window inbox and stops delivering after unlisten", async () => {
    tauriMock.setCurrentWindowLabel("main");
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
    const payload = {
      instanceId: "slot-1",
      sessionId: "session-1",
      windowLabel: "terminal-1",
    };

    deliverToMain("pty-detached-ready", payload, terminalSource("terminal-1"));

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0].payload).toEqual(payload);
    expect(failed).not.toHaveBeenCalled();

    stopReady();
    deliverToMain("pty-detached-ready", payload, terminalSource("terminal-1"));
    expect(ready).toHaveBeenCalledTimes(1);
    stopFailed();
    // The inbox subscription lives as long as the window: one subscription for both handlers.
    expect(
      tauriMock.state.invokeCalls.filter(
        (call) => call.command === "subscribe_window_inbox",
      ),
    ).toHaveLength(1);
  });

  it("emits versioned envelopes and centralizes per-kind labels", async () => {
    tauriMock.setCurrentWindowLabel(TERMINAL);
    await onInboxEvent("window-message", vi.fn());
    tauriMock.setCurrentWindowLabel("main");
    const payload = {
      instanceId: "slot-1",
      sessionId: "session-1",
      windowLabel: "terminal-1",
    };

    await emitWorkspaceContentWindowEvent(
      TERMINAL,
      "pty-detached-ready",
      payload,
    );

    const calls = tauriMock.state.invokeCalls.filter(
      (call) => call.command === "send_window_message",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      target: TERMINAL,
      messageType: "pty-detached-ready",
      payload: {
        apiVersion: 1,
        type: "pty-detached-ready",
        payload,
      },
    });
    expect(getWorkspaceContentWindowLabelPrefix("pty")).toBe("terminal-");
    expect(getWorkspaceContentWindowLabelPrefix("file")).toBe(
      "workspace-content-",
    );
    // The relayed message no longer travels as a Tauri event of the old name.
    expect(
      tauriMock.state.emittedEvents.some(
        (event) => event.eventName === "workspace-content-window-event",
      ),
    ).toBe(false);
  });

  it("rejects file buffer events without safe epoch and version fields", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const changed = vi.fn();
    const stop = await listenWorkspaceContentWindowEvent(
      "workspace-file-window-buffer-changed",
      changed,
    );
    const source = {
      label: "workspace-content-1",
      kind: "workspaceContent" as const,
    };
    const deliverBuffer = (fileBuffer: Record<string, unknown>) =>
      deliverToMain(
        "workspace-file-window-buffer-changed",
        {
          documentId: "doc-1",
          token: "transfer-1",
          windowLabel: "workspace-content-1",
          fileBuffer,
        },
        source,
      );
    const validBase = {
      kind: "text",
      content: "text",
      savedContent: "text",
      revision: "rev-1",
      saving: false,
    };

    deliverBuffer({ ...validBase, version: 0 });
    deliverBuffer({ ...validBase, epoch: 0 });
    deliverBuffer({ ...validBase, epoch: -1, version: 0 });
    deliverBuffer({ ...validBase, epoch: 0, version: 1.5 });
    expect(changed).not.toHaveBeenCalled();

    deliverBuffer({ ...validBase, epoch: 0, version: 0 });
    expect(changed).toHaveBeenCalledOnce();
    stop();
  });

  it("validates payloads and isolates sync and async subscriber failures", async () => {
    tauriMock.setCurrentWindowLabel("main");
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
    const source = terminalSource("terminal-1");

    deliverToMain(
      "pty-detached-ready",
      {
        instanceId: "slot-1",
        sessionId: "session-1",
        windowLabel: "terminal-1",
      },
      source,
      2,
    );
    expect(thrown).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    expect(laterHandler).not.toHaveBeenCalled();

    deliverToMain(
      "pty-detached-ready",
      { instanceId: "slot-1", sessionId: "session-1" },
      source,
    );
    expect(thrown).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    expect(laterHandler).not.toHaveBeenCalled();

    deliverToMain(
      "pty-detached-ready",
      {
        instanceId: "slot-1",
        sessionId: "session-1",
        windowLabel: "terminal-1",
      },
      source,
    );
    expect(thrown).toHaveBeenCalledOnce();
    expect(laterHandler).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));

    stopThrown();
    stopRejected();
    stopLater();
    log.mockRestore();
  });

  it("drops messages whose claimed window label differs from the stamped source", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();
    const stop = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      handler,
    );
    const payload = {
      instanceId: "i",
      sessionId: "s",
      windowLabel: "terminal-a",
    };

    deliverToMain("pty-detached-ready", payload, terminalSource("terminal-b"));

    expect(handler).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toBe(
      "workspace_content_event.source_mismatch",
    );
    stop();
    warn.mockRestore();
  });

  it("accepts messages whose claimed window label equals the stamped source", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();
    const stop = await listenWorkspaceContentWindowEvent(
      "pty-detached-ready",
      handler,
    );
    const payload = {
      instanceId: "i",
      sessionId: "s",
      windowLabel: "terminal-a",
    };

    deliverToMain("pty-detached-ready", payload, terminalSource("terminal-a"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({
      payload,
      source: { label: "terminal-a", kind: "terminal" },
    });
    expect(warn).not.toHaveBeenCalled();
    stop();
    warn.mockRestore();
  });
});
