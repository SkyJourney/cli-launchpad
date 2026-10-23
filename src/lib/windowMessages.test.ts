// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { tauriMock } from "../test/tauriMock";
import { onInboxEvent } from "./windowInbox";
import { onWindowMessage, sendWindowMessage } from "./windowMessages";

const T = "terminal-8e783338-f464-4b10-b15e-b534748c6241";
const OTHER_T = "terminal-3b9f2c1e-6d4a-4f7b-8a21-5c0e9d7a1b34";
const CONTENT = "workspace-content-8e783338-f464-4b10-b15e-b534748c6241";

function relayCalls() {
  return tauriMock.state.invokeCalls.filter(
    (call) => call.command === "send_window_message",
  );
}

function subscribeCalls() {
  return tauriMock.state.invokeCalls.filter(
    (call) => call.command === "subscribe_window_inbox",
  );
}

async function subscribeAs(label: string) {
  tauriMock.setCurrentWindowLabel(label);
  await onInboxEvent("window-message", vi.fn());
  tauriMock.setCurrentWindowLabel("main");
}

const envelope = (type: string, payload: unknown = {}) => ({
  apiVersion: 1,
  type,
  payload,
});

describe("window messages", () => {
  it("sends a versioned envelope through the relay command", async () => {
    tauriMock.setCurrentWindowLabel("main");
    await subscribeAs(T);

    await expect(
      sendWindowMessage(T, "pty-return-complete", {
        instanceId: "s",
        token: "t",
      }),
    ).resolves.toBe(true);

    expect(relayCalls()).toHaveLength(1);
    expect(relayCalls()[0].args).toEqual({
      target: T,
      messageType: "pty-return-complete",
      payload: {
        apiVersion: 1,
        type: "pty-return-complete",
        payload: { instanceId: "s", token: "t" },
      },
    });
    // Reverse: a target without an inbox reports "not delivered".
    await expect(
      sendWindowMessage(OTHER_T, "pty-return-complete", {}),
    ).resolves.toBe(false);
  });

  it("delivers a message to the handler of its type with the stamped source", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const handler = vi.fn();
    await onWindowMessage("pty-detached-ready", handler);

    tauriMock.deliverInbox(
      "main",
      "window-message",
      envelope("pty-detached-ready", { n: 1 }),
      { label: T, kind: "terminal" },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({
      payload: { n: 1 },
      source: { label: T, kind: "terminal" },
      seq: 1,
    });
    expect(handler.mock.calls[0][0].source).not.toBeUndefined();
  });

  it("routes by message type and ignores other types", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const ready = vi.fn();
    const failed = vi.fn();
    await onWindowMessage("pty-detached-ready", ready);
    await onWindowMessage("pty-detached-failed", failed);
    const source = { label: T, kind: "terminal" };

    tauriMock.deliverInbox(
      "main",
      "window-message",
      envelope("pty-detached-failed"),
      source,
    );
    expect(failed).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();

    tauriMock.deliverInbox(
      "main",
      "window-message",
      envelope("pty-return-requested"),
      source,
    );
    expect(failed).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    expect(subscribeCalls()).toHaveLength(1);
  });

  it("drops messages without a stamped source", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();
    await onWindowMessage("pty-detached-ready", handler);

    tauriMock.deliverInbox(
      "main",
      "window-message",
      envelope("pty-detached-ready"),
      null,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "window_message.missing_source",
      "pty-detached-ready",
    );
    tauriMock.deliverInbox(
      "main",
      "window-message",
      envelope("pty-detached-ready"),
      { label: T, kind: "terminal" },
    );
    expect(handler).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("drops envelopes with the wrong api version or a malformed shape", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();
    await onWindowMessage("pty-detached-ready", handler);
    const source = { label: T, kind: "terminal" };
    const type = "pty-detached-ready";

    for (const malformed of [
      { apiVersion: 2, type, payload: {} },
      { apiVersion: 1, type: "pty-detached-failed", payload: {} },
      "text",
      null,
      { apiVersion: 1, type },
    ]) {
      expect(() =>
        tauriMock.deliverInbox("main", "window-message", malformed, source),
      ).not.toThrow();
    }

    expect(handler).not.toHaveBeenCalled();
    tauriMock.deliverInbox("main", "window-message", envelope(type), source);
    expect(handler).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a message sent by a child reaches the main handler with the child as source", async () => {
    tauriMock.setCurrentWindowLabel("main");
    const handler = vi.fn();
    await onWindowMessage("pty-detached-ready", handler);
    tauriMock.setCurrentWindowLabel(T);
    await onInboxEvent("window-message", vi.fn());

    await sendWindowMessage("main", "pty-detached-ready", {
      instanceId: "i",
      sessionId: "s",
      windowLabel: OTHER_T,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.source).toEqual({ label: T, kind: "terminal" });
    expect(event.payload.windowLabel).toBe(OTHER_T);
    // The stamp does not follow the self-reported label of the payload.
    expect(event.source.label).not.toBe(event.payload.windowLabel);
  });

  it("reports an unavailable target as not delivered", async () => {
    tauriMock.setCurrentWindowLabel("main");

    await expect(
      sendWindowMessage(CONTENT, "workspace-file-window-init", {}),
    ).resolves.toBe(false);

    expect(relayCalls()).toHaveLength(1);
    expect(tauriMock.state.relayedMessages).toHaveLength(1);
    expect(tauriMock.state.relayedMessages[0].target).toBe(CONTENT);
  });
});
